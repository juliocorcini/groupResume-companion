import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// ============================================================
// Groq Free Tier Limits (October 2026)
// Per model, per organization
// ============================================================

export interface ModelLimits {
  modelId: string;
  modelLabel: string;
  rpm: number;
  rpd: number;
  tpm: number;
  tpd: number;
}

export const GROQ_FREE_LIMITS: Record<string, ModelLimits> = {
  "openai/gpt-oss-120b": {
    modelId: "openai/gpt-oss-120b",
    modelLabel: "GPT-OSS 120B (Powerful)",
    rpm: 30,
    rpd: 1000,
    tpm: 8000,
    tpd: 200000,
  },
  "openai/gpt-oss-20b": {
    modelId: "openai/gpt-oss-20b",
    modelLabel: "GPT-OSS 20B (Fast/Merge)",
    rpm: 30,
    rpd: 1000,
    tpm: 8000,
    tpd: 200000,
  },
  "qwen/qwen3.8-27b": {
    modelId: "qwen/qwen3.8-27b",
    modelLabel: "Qwen 3.8 27B (Balanced)",
    rpm: 30,
    rpd: 1000,
    tpm: 8000,
    tpd: 200000,
  },
  "meta-llama/llama-4-scout-17b-16e-instruct": {
    modelId: "meta-llama/llama-4-scout-17b-16e-instruct",
    modelLabel: "Llama 4 Scout 17B",
    rpm: 30,
    rpd: 1000,
    tpm: 30000,
    tpd: 500000,
  },
  "llama-3.1-8b-instant": {
    modelId: "llama-3.1-8b-instant",
    modelLabel: "Llama 3.1 8B (Fallback)",
    rpm: 30,
    rpd: 14400,
    tpm: 6000,
    tpd: 500000,
  },
  "whisper-large-v3-turbo": {
    modelId: "whisper-large-v3-turbo",
    modelLabel: "Whisper v3 Turbo (Audio)",
    rpm: 20,
    rpd: 2000,
    tpm: 0,
    tpd: 0,
  },
};

// ============================================================
// Usage Entry
// ============================================================

export interface UsageEntry {
  timestamp: string;
  model: string;
  tokensUsed: number;
  inputTokens?: number;
  outputTokens?: number;
  audioSeconds?: number;
  source: "bot" | "dashboard" | "auto" | "upload" | "dm" | "qa";
  groupId?: string;
  groupName?: string;
  operation: "summarize" | "merge" | "chat" | "incremental" | "transcription";
  processingTime?: number;
  rateLimitHeaders?: {
    remainingRequests?: number;
    remainingTokens?: number;
    limitRequests?: number;
    limitTokens?: number;
  };
}

export interface DailyUsage {
  date: string;
  totalTokens: number;
  totalRequests: number;
  totalAudioSeconds: number;
  entries: UsageEntry[];
  byModel: Record<string, { tokens: number; requests: number; audioSeconds: number }>;
  bySource: Record<string, { tokens: number; requests: number; audioSeconds: number }>;
}

export interface WhisperStats {
  audioSecondsUsedToday: number;
  audioSecondsLimitPerHour: number;
  requestsUsedToday: number;
  requestsLimitPerDay: number;
}

export interface UsageStats {
  today: DailyUsage;
  last7Days: DailyUsage[];
  limits: Record<string, ModelLimits>;
  whisper: WhisperStats;
  projections: {
    canFinishDay: boolean;
    estimatedRemainingCalls: number;
    avgTokensPerCall: number;
    tokensUsedToday: number;
    tokensRemainingToday: number;
    requestsUsedToday: number;
    requestsRemainingToday: number;
    primaryModel: string;
    primaryModelLimits: ModelLimits;
  };
}

// ============================================================
// File Storage
// ============================================================

const DATA_DIR = join(process.cwd(), "data");
const USAGE_FILE = join(DATA_DIR, "usage-history.json");

interface UsageStore {
  days: Record<string, UsageEntry[]>;
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadStore(): UsageStore {
  ensureDataDir();
  if (!existsSync(USAGE_FILE)) {
    return { days: {} };
  }
  try {
    return JSON.parse(readFileSync(USAGE_FILE, "utf-8"));
  } catch {
    return { days: {} };
  }
}

function saveStore(store: UsageStore): void {
  ensureDataDir();

  // Keep only last 30 days
  const sortedDays = Object.keys(store.days).sort().reverse();
  const trimmedDays: Record<string, UsageEntry[]> = {};
  for (const day of sortedDays.slice(0, 30)) {
    trimmedDays[day] = store.days[day];
  }
  store.days = trimmedDays;

  writeFileSync(USAGE_FILE, JSON.stringify(store, null, 2), "utf-8");
}

// ============================================================
// Track Usage
// ============================================================

export function trackUsage(entry: UsageEntry): void {
  const store = loadStore();
  const date = entry.timestamp.split("T")[0];

  if (!store.days[date]) {
    store.days[date] = [];
  }

  store.days[date].push(entry);
  saveStore(store);

  const metric = entry.audioSeconds
    ? `${entry.audioSeconds}s audio`
    : `${entry.tokensUsed} tokens`;
  console.log(`[Usage] Tracked: ${entry.operation} via ${entry.source} — ${metric} (${entry.model})`);
}

// ============================================================
// Query Usage
// ============================================================

function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}

function buildDailyUsage(date: string, entries: UsageEntry[]): DailyUsage {
  const byModel: Record<string, { tokens: number; requests: number; audioSeconds: number }> = {};
  const bySource: Record<string, { tokens: number; requests: number; audioSeconds: number }> = {};
  let totalTokens = 0;
  let totalRequests = 0;
  let totalAudioSeconds = 0;

  for (const e of entries) {
    totalTokens += e.tokensUsed;
    totalRequests += 1;
    const audio = e.audioSeconds ?? 0;
    totalAudioSeconds += audio;

    if (!byModel[e.model]) byModel[e.model] = { tokens: 0, requests: 0, audioSeconds: 0 };
    byModel[e.model].tokens += e.tokensUsed;
    byModel[e.model].requests += 1;
    byModel[e.model].audioSeconds += audio;

    if (!bySource[e.source]) bySource[e.source] = { tokens: 0, requests: 0, audioSeconds: 0 };
    bySource[e.source].tokens += e.tokensUsed;
    bySource[e.source].requests += 1;
    bySource[e.source].audioSeconds += audio;
  }

  return { date, totalTokens, totalRequests, totalAudioSeconds, entries, byModel, bySource };
}

export function getTodayUsage(): DailyUsage {
  const store = loadStore();
  const today = getTodayDate();
  const entries = store.days[today] || [];
  return buildDailyUsage(today, entries);
}

export function getLast7DaysUsage(): DailyUsage[] {
  const store = loadStore();
  const days: DailyUsage[] = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    const entries = store.days[dateStr] || [];
    days.push(buildDailyUsage(dateStr, entries));
  }

  return days;
}

export function getUsageStats(primaryModel: string = "openai/gpt-oss-120b"): UsageStats {
  const today = getTodayUsage();
  const last7Days = getLast7DaysUsage();

  // Find the most-used model today for accurate limit reference
  let mostUsedModel = primaryModel;
  let maxModelTokens = 0;
  for (const [model, data] of Object.entries(today.byModel)) {
    if (data.tokens > maxModelTokens) {
      maxModelTokens = data.tokens;
      mostUsedModel = model;
    }
  }

  const modelLimits = GROQ_FREE_LIMITS[mostUsedModel]
    || GROQ_FREE_LIMITS[primaryModel]
    || GROQ_FREE_LIMITS["openai/gpt-oss-120b"];

  // Aggregate all model usage today (limits are per-model, but we track total for projections)
  // Each model has its OWN limits, so sum per-model remaining
  let totalTokensUsedToday = today.totalTokens;
  let totalRequestsUsedToday = today.totalRequests;

  // Use the primary model's limits for projection (conservative estimate)
  const tokensRemainingToday = Math.max(0, modelLimits.tpd - totalTokensUsedToday);
  const requestsRemainingToday = Math.max(0, modelLimits.rpd - totalRequestsUsedToday);

  // Average tokens per call
  let avgTokensPerCall = 0;
  if (today.totalRequests > 0) {
    avgTokensPerCall = Math.round(today.totalTokens / today.totalRequests);
  } else {
    const total7 = last7Days.reduce((sum, d) => sum + d.totalTokens, 0);
    const requests7 = last7Days.reduce((sum, d) => sum + d.totalRequests, 0);
    avgTokensPerCall = requests7 > 0 ? Math.round(total7 / requests7) : 2000;
  }

  const estimatedRemainingCalls = avgTokensPerCall > 0
    ? Math.min(
        Math.floor(tokensRemainingToday / avgTokensPerCall),
        requestsRemainingToday
      )
    : requestsRemainingToday;

  const canFinishDay = estimatedRemainingCalls > 5;

  // Whisper stats
  const whisperModelData = today.byModel["whisper-large-v3-turbo"];
  const whisper: WhisperStats = {
    audioSecondsUsedToday: whisperModelData?.audioSeconds ?? today.totalAudioSeconds,
    audioSecondsLimitPerHour: 7200,
    requestsUsedToday: whisperModelData?.requests ?? 0,
    requestsLimitPerDay: GROQ_FREE_LIMITS["whisper-large-v3-turbo"]?.rpd ?? 2000,
  };

  return {
    today,
    last7Days,
    limits: GROQ_FREE_LIMITS,
    whisper,
    projections: {
      canFinishDay,
      estimatedRemainingCalls,
      avgTokensPerCall,
      tokensUsedToday: totalTokensUsedToday,
      tokensRemainingToday,
      requestsUsedToday: totalRequestsUsedToday,
      requestsRemainingToday,
      primaryModel: mostUsedModel,
      primaryModelLimits: modelLimits,
    },
  };
}

/**
 * Parse rate limit headers from Groq API response.
 */
export function parseRateLimitHeaders(headers: Record<string, string>): UsageEntry["rateLimitHeaders"] {
  return {
    remainingRequests: headers["x-ratelimit-remaining-requests"]
      ? parseInt(headers["x-ratelimit-remaining-requests"])
      : undefined,
    remainingTokens: headers["x-ratelimit-remaining-tokens"]
      ? parseInt(headers["x-ratelimit-remaining-tokens"])
      : undefined,
    limitRequests: headers["x-ratelimit-limit-requests"]
      ? parseInt(headers["x-ratelimit-limit-requests"])
      : undefined,
    limitTokens: headers["x-ratelimit-limit-tokens"]
      ? parseInt(headers["x-ratelimit-limit-tokens"])
      : undefined,
  };
}
