/**
 * In-memory progress store for long-running summarization jobs.
 * Tracks real-time progress with timing data for ETA estimates.
 */

export interface ProgressEntry {
  phase: "starting" | "fetching" | "chunking" | "summarizing" | "merging" | "done" | "error";
  message: string;
  current: number;
  total: number;
  startedAt: number;
  provider: string;
  totalMessages: number;
  /** Milliseconds each completed chunk took */
  chunkTimings: number[];
  /** When the current chunk started */
  currentChunkStartedAt: number;
  /** Result data (set when done) */
  result?: any;
  /** Error message (set on error) */
  errorMessage?: string;
}

const store = new Map<string, ProgressEntry>();

const CLEANUP_TTL_MS = 15 * 60 * 1000;

export function generateJobId(): string {
  return `job-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
}

export function setProgress(jobId: string, update: Partial<ProgressEntry>): void {
  const existing = store.get(jobId);
  const now = Date.now();

  const entry: ProgressEntry = {
    phase: "starting",
    message: "",
    current: 0,
    total: 1,
    startedAt: now,
    provider: "",
    totalMessages: 0,
    chunkTimings: [],
    currentChunkStartedAt: now,
    ...existing,
    ...update,
  };

  store.set(jobId, entry);
}

export function recordChunkCompletion(jobId: string): void {
  const entry = store.get(jobId);
  if (!entry) return;

  const chunkTime = Date.now() - entry.currentChunkStartedAt;
  entry.chunkTimings.push(chunkTime);
  entry.currentChunkStartedAt = Date.now();
}

export interface ProgressResponse {
  phase: string;
  message: string;
  current: number;
  total: number;
  elapsedMs: number;
  provider: string;
  totalMessages: number;
  /** Average milliseconds per chunk */
  avgChunkMs: number;
  /** Estimated milliseconds remaining */
  estimatedRemainingMs: number;
  /** Milliseconds the current chunk has been running */
  currentChunkElapsedMs: number;
  /** Whether the job has a result ready */
  hasResult: boolean;
  /** Error message if phase is "error" */
  errorMessage?: string;
}

export function getProgress(jobId: string): ProgressResponse | null {
  const entry = store.get(jobId);
  if (!entry) return null;

  const now = Date.now();
  const elapsedMs = now - entry.startedAt;

  const avgChunkMs = entry.chunkTimings.length > 0
    ? entry.chunkTimings.reduce((a, b) => a + b, 0) / entry.chunkTimings.length
    : 0;

  const remainingChunks = Math.max(0, entry.total - entry.current);
  const estimatedRemainingMs = avgChunkMs > 0
    ? Math.round(remainingChunks * avgChunkMs)
    : 0;

  return {
    phase: entry.phase,
    message: entry.message,
    current: entry.current,
    total: entry.total,
    elapsedMs,
    provider: entry.provider,
    totalMessages: entry.totalMessages,
    avgChunkMs: Math.round(avgChunkMs),
    estimatedRemainingMs,
    currentChunkElapsedMs: now - entry.currentChunkStartedAt,
    hasResult: !!entry.result,
    errorMessage: entry.errorMessage,
  };
}

export function getResult(jobId: string): any | null {
  return store.get(jobId)?.result ?? null;
}

export function removeProgress(jobId: string): void {
  store.delete(jobId);
}

export function cleanupOldEntries(): void {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (now - entry.startedAt > CLEANUP_TTL_MS) {
      store.delete(id);
    }
  }
}
