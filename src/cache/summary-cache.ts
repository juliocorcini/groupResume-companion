import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { WhatsAppMessage } from "../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = resolve(__dirname, "..", "..", "data", "summary-cache.json");
const MAX_ENTRIES = 100;

export interface CachedSummary {
  groupId: string;
  dateFrom: string;
  dateTo: string;
  level: number;
  privacy: string;
  messagesHash: string;
  messageCount: number;
  summary: string;
  provider: string;
  processingTime: number;
  chunks: number;
  participants: number;
  cachedAt: string;
}

export interface IncrementalMatch {
  cachedSummary: CachedSummary;
  newMessageStartIndex: number;
}

/**
 * Generate a fast fingerprint for a set of messages.
 * If the hash matches, the messages are the same — no need to reprocess.
 */
export function generateMessagesHash(messages: WhatsAppMessage[]): string {
  if (messages.length === 0) return "empty";

  const fingerprint = messages
    .map((m) => `${m.date}|${m.time}|${m.senderName}|${m.content?.slice(0, 50) ?? ""}`)
    .join("\n");

  return createHash("md5").update(fingerprint).digest("hex");
}

/**
 * Look up a cached summary for the given parameters and message hash.
 * Returns null if no cache hit.
 */
export function getCachedSummary(
  groupId: string,
  dateFrom: string,
  dateTo: string,
  level: number,
  privacy: string,
  messagesHash: string
): CachedSummary | null {
  const cache = loadCache();

  const entry = cache.find(
    (e) =>
      e.groupId === groupId &&
      e.dateFrom === dateFrom &&
      e.dateTo === dateTo &&
      e.level === level &&
      e.privacy === privacy &&
      e.messagesHash === messagesHash
  );

  if (entry) {
    console.log(
      `[Cache] HIT for ${groupId} (${dateFrom}→${dateTo}, L${level}) — cached at ${entry.cachedAt}`
    );
  }

  return entry ?? null;
}

/**
 * Save a summary to the cache.
 */
export function saveCachedSummary(entry: Omit<CachedSummary, "cachedAt">): void {
  const cache = loadCache();

  // Remove existing entry for the same parameters (different hash = new messages)
  const idx = cache.findIndex(
    (e) =>
      e.groupId === entry.groupId &&
      e.dateFrom === entry.dateFrom &&
      e.dateTo === entry.dateTo &&
      e.level === entry.level &&
      e.privacy === entry.privacy
  );

  if (idx !== -1) {
    cache.splice(idx, 1);
  }

  cache.unshift({
    ...entry,
    cachedAt: new Date().toISOString(),
  });

  // Trim to max size
  if (cache.length > MAX_ENTRIES) {
    cache.length = MAX_ENTRIES;
  }

  saveCache(cache);
  console.log(
    `[Cache] SAVED for ${entry.groupId} (${entry.dateFrom}→${entry.dateTo}, L${entry.level}, ${entry.messageCount} msgs)`
  );
}

/**
 * Check if we have a partial cache match — the first N messages are already
 * summarized, and only the newer messages need processing.
 * Returns the cached summary and the index where new messages begin.
 */
export function getIncrementalMatch(
  groupId: string,
  dateFrom: string,
  dateTo: string,
  level: number,
  privacy: string,
  messages: WhatsAppMessage[]
): IncrementalMatch | null {
  const cache = loadCache();

  // Find a cache entry for the same group/date/level/privacy
  const entry = cache.find(
    (e) =>
      e.groupId === groupId &&
      e.dateFrom === dateFrom &&
      e.dateTo === dateTo &&
      e.level === level &&
      e.privacy === privacy
  );

  if (!entry) return null;

  // Only useful if we have MORE messages than what was cached
  if (messages.length <= entry.messageCount) return null;

  // Verify the first N messages are the same by hashing only those
  const oldMessages = messages.slice(0, entry.messageCount);
  const oldHash = generateMessagesHash(oldMessages);

  if (oldHash !== entry.messagesHash) {
    // Messages were edited/deleted — can't do incremental, need full reprocess
    return null;
  }

  console.log(
    `[Cache] INCREMENTAL match for ${groupId}: ` +
      `${entry.messageCount} cached + ${messages.length - entry.messageCount} new messages`
  );

  return {
    cachedSummary: entry,
    newMessageStartIndex: entry.messageCount,
  };
}

/**
 * Clear the entire cache.
 */
export function clearSummaryCache(): void {
  saveCache([]);
  console.log("[Cache] Cleared");
}

// ── Internal ─────────────────────────────────────────────

function loadCache(): CachedSummary[] {
  try {
    if (!existsSync(CACHE_FILE)) return [];
    const raw = readFileSync(CACHE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveCache(cache: CachedSummary[]): void {
  const dir = dirname(CACHE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}
