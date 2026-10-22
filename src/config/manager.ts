import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { AppConfig } from "../types/index.js";

const CONFIG_PATH = resolve(process.cwd(), "config.json");

const DEFAULT_CONFIG: AppConfig = {
  server: {
    port: 3000,
    autoStartWithWindows: true,
  },
  whatsapp: {
    sessionName: "groupresume-companion",
  },
  ai: {
    defaultProvider: "groq",
    groq: {
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      fallbackModel: "llama-3.1-8b-instant",
    },
    ollama: {
      baseUrl: "http://localhost:11434",
      model: "qwen3:4b",
    },
    autoFallback: true,
  },
  summary: {
    defaultLevel: 3,
    defaultPrivacy: "smart",
  },
  autoSummary: {
    enabled: false,
    time: "20:00",
    groups: [],
    sendTo: "",
    level: 3,
    privacy: "smart",
  },
  bot: {
    enabled: true,
    prefix: "!",
    allowedGroups: [],
    rateLimitMinutes: 60,
    level: 3,
    privacy: "smart",
  },
  groupRules: {},
};

let cachedConfig: AppConfig | null = null;

/**
 * Load configuration from file. Creates default if not exists.
 */
export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  if (!existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULT_CONFIG);
    cachedConfig = DEFAULT_CONFIG;
    return cachedConfig;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const loaded = JSON.parse(raw) as Partial<AppConfig>;
    cachedConfig = deepMerge(DEFAULT_CONFIG, loaded) as AppConfig;
    return cachedConfig;
  } catch (err) {
    console.error("[Config] Failed to load config, using defaults:", err);
    cachedConfig = DEFAULT_CONFIG;
    return cachedConfig;
  }
}

/**
 * Save configuration to file.
 */
export function saveConfig(config: AppConfig): void {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    cachedConfig = config;
    console.log("[Config] Configuration saved");
  } catch (err) {
    console.error("[Config] Failed to save config:", err);
    throw err;
  }
}

/**
 * Update specific config fields and save.
 */
export function updateConfig(updates: Partial<AppConfig>): AppConfig {
  const current = loadConfig();

  // groupRules must be replaced entirely (not merged) so removals take effect
  if ("groupRules" in updates) {
    current.groupRules = updates.groupRules ?? {};
    delete (updates as any).groupRules;
  }

  const updated = deepMerge(current, updates) as AppConfig;
  saveConfig(updated);
  return updated;
}

/**
 * Deep merge two objects. Source values override target values.
 */
function deepMerge(target: any, source: any): any {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object"
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}
