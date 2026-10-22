import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { randomBytes } from "crypto";

const HISTORY_DIR = resolve(process.cwd(), "data");
const HISTORY_FILE = resolve(HISTORY_DIR, "history.json");
const MAX_ENTRIES = 200;

export interface HistoryEntry {
  id: string;
  groupName: string;
  groupId: string;
  dateFrom: string;
  dateTo: string;
  level: number;
  privacy: string;
  provider: string;
  summary: string;
  totalMessages: number;
  participants: number;
  processingTime: number;
  chunks: number;
  source: "live" | "upload" | "auto" | "bot";
  createdAt: string;
}

function ensureDir(): void {
  if (!existsSync(HISTORY_DIR)) {
    mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

function loadHistory(): HistoryEntry[] {
  ensureDir();
  if (!existsSync(HISTORY_FILE)) return [];

  try {
    const raw = readFileSync(HISTORY_FILE, "utf-8");
    return JSON.parse(raw) as HistoryEntry[];
  } catch {
    return [];
  }
}

function persistHistory(entries: HistoryEntry[]): void {
  ensureDir();
  writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2), "utf-8");
}

/**
 * Save a summary to history.
 */
export function saveToHistory(entry: Omit<HistoryEntry, "id" | "createdAt">): HistoryEntry {
  const history = loadHistory();

  const fullEntry: HistoryEntry = {
    ...entry,
    id: randomBytes(8).toString("hex"),
    createdAt: new Date().toISOString(),
  };

  // Add to beginning (most recent first)
  history.unshift(fullEntry);

  // Trim old entries
  if (history.length > MAX_ENTRIES) {
    history.splice(MAX_ENTRIES);
  }

  persistHistory(history);
  console.log(`[History] Saved: ${fullEntry.groupName} (${fullEntry.id})`);

  return fullEntry;
}

/**
 * Get all history entries (metadata only, no full summary text).
 */
export function getHistoryList(): Array<Omit<HistoryEntry, "summary">> {
  const history = loadHistory();
  return history.map(({ summary, ...rest }) => rest);
}

/**
 * Get a single history entry with full summary.
 */
export function getHistoryEntry(id: string): HistoryEntry | null {
  const history = loadHistory();
  return history.find((e) => e.id === id) || null;
}

/**
 * Delete a history entry.
 */
export function deleteHistoryEntry(id: string): boolean {
  const history = loadHistory();
  const idx = history.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  history.splice(idx, 1);
  persistHistory(history);
  return true;
}

/**
 * Search history entries by text query.
 * Searches in summary text, group name, and dates.
 */
export function searchHistory(query: string): HistoryEntry[] {
  const history = loadHistory();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  return history.filter((entry) => {
    const searchable = `${entry.summary} ${entry.groupName} ${entry.dateFrom} ${entry.dateTo}`.toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

/**
 * Clear all history.
 */
export function clearHistory(): void {
  persistHistory([]);
}
