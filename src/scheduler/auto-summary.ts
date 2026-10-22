import { loadConfig } from "../config/manager.js";
import { getGroupMessages, getGroups } from "../whatsapp/messages.js";
import { generateSummary, generateIncrementalSummary } from "../ai/summarizer.js";
import { GroqProvider } from "../ai/groq.js";
import { OllamaProvider } from "../ai/ollama.js";
import { sendMessage } from "../whatsapp/sender.js";
import { whatsappClient } from "../whatsapp/client.js";
import type { AIProvider } from "../ai/provider.js";
import { saveToHistory } from "../history/store.js";
import {
  generateMessagesHash,
  getCachedSummary,
  saveCachedSummary,
  getIncrementalMatch,
} from "../cache/summary-cache.js";

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;

/**
 * Initialize the auto-summary scheduler.
 * Reads the config to determine when and what to summarize.
 */
export function initAutoSummaryScheduler(): void {
  const config = loadConfig();

  if (!config.autoSummary.enabled) {
    console.log("[AutoSummary] Disabled in config");
    return;
  }

  console.log(`[AutoSummary] Enabled — daily at ${config.autoSummary.time}`);
  scheduleNextRun();
}

/**
 * Stop the auto-summary scheduler.
 */
export function stopAutoSummaryScheduler(): void {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  console.log("[AutoSummary] Scheduler stopped");
}

/**
 * Reschedule after config changes.
 */
export function rescheduleAutoSummary(): void {
  stopAutoSummaryScheduler();
  initAutoSummaryScheduler();
}

/**
 * Get the status of the auto-summary scheduler.
 */
export function getAutoSummaryStatus(): {
  enabled: boolean;
  nextRun: string | null;
  lastRun: string | null;
  isRunning: boolean;
} {
  return {
    enabled: !!schedulerTimer,
    nextRun: nextRunTime,
    lastRun: lastRunTime,
    isRunning,
  };
}

let nextRunTime: string | null = null;
let lastRunTime: string | null = null;

/** Track which groups already ran today to avoid duplicates */
const ranToday = new Set<string>();

function scheduleNextRun(): void {
  const config = loadConfig();

  // Clear ranToday set at midnight
  const now = new Date();
  const midnight = new Date(now);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 0, 0, 0);

  // Collect all unique scheduled times
  const times = new Set<string>();
  times.add(config.autoSummary.time);
  if (config.autoSummary.perGroup) {
    for (const pg of Object.values(config.autoSummary.perGroup)) {
      if (pg.enabled !== false && pg.time) times.add(pg.time);
    }
  }

  // Find the next scheduled time
  let nearestTarget: Date | null = null;

  for (const timeStr of times) {
    const [h, m] = timeStr.split(":").map(Number);
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);

    if (!nearestTarget || target < nearestTarget) {
      nearestTarget = target;
    }
  }

  if (!nearestTarget) {
    nearestTarget = new Date(now);
    const [h, m] = config.autoSummary.time.split(":").map(Number);
    nearestTarget.setHours(h, m, 0, 0);
    if (nearestTarget <= now) nearestTarget.setDate(nearestTarget.getDate() + 1);
  }

  const delay = nearestTarget.getTime() - now.getTime();
  const delayMin = Math.round(delay / 60000);
  nextRunTime = nearestTarget.toLocaleString("pt-BR");

  console.log(`[AutoSummary] Next check at ${nextRunTime} (in ${delayMin} min). Schedules: ${[...times].join(", ")}`);

  if (schedulerTimer) clearTimeout(schedulerTimer);

  schedulerTimer = setTimeout(async () => {
    // Reset ranToday if a new day
    const currentDate = formatDate(new Date());
    if (lastRunDate !== currentDate) {
      ranToday.clear();
      lastRunDate = currentDate;
    }

    await runAutoSummary();
    scheduleNextRun();
  }, delay);
}

let lastRunDate = formatDate(new Date());

/**
 * Manually trigger auto-summary (can be called from API).
 */
export async function runAutoSummary(): Promise<{
  success: boolean;
  results: Array<{ groupId: string; groupName: string; sent: boolean; error?: string }>;
}> {
  if (isRunning) {
    console.log("[AutoSummary] Already running, skipping");
    return { success: false, results: [] };
  }

  isRunning = true;
  lastRunTime = new Date().toLocaleString("pt-BR");
  const results: Array<{ groupId: string; groupName: string; sent: boolean; error?: string }> = [];

  try {
    const config = loadConfig();

    if (!whatsappClient.isConnected()) {
      console.log("[AutoSummary] WhatsApp not connected, skipping");
      return { success: false, results: [] };
    }

    // Get today's date
    const today = new Date();
    const dateStr = formatDate(today);

    // Determine which groups to summarize
    const allGroups = await getGroups();
    let groupIds = config.autoSummary.groups;

    if (groupIds.length === 0) {
      groupIds = allGroups
        .filter((g: any) => g.chatType === "group" || g.chatType === "community-group")
        .map((g: any) => g.id);
    }

    // Filter by per-group schedule: only process groups whose time has arrived
    const nowTime = `${String(today.getHours()).padStart(2, "0")}:${String(today.getMinutes()).padStart(2, "0")}`;
    const perGroup = config.autoSummary.perGroup || {};

    groupIds = groupIds.filter((gId) => {
      if (ranToday.has(gId)) return false;

      const pgConfig = perGroup[gId];
      if (pgConfig && pgConfig.enabled === false) return false;

      const targetTime = pgConfig?.time || config.autoSummary.time;
      // Allow 5-minute window for the schedule
      const [th, tm] = targetTime.split(":").map(Number);
      const targetMinutes = th * 60 + tm;
      const nowMinutes = today.getHours() * 60 + today.getMinutes();
      return nowMinutes >= targetMinutes && nowMinutes < targetMinutes + 5;
    });

    if (groupIds.length === 0) {
      console.log("[AutoSummary] No groups to summarize");
      return { success: true, results: [] };
    }

    // Initialize AI provider
    const provider = createProvider(config);

    console.log(
      `[AutoSummary] Processing ${groupIds.length} groups for ${dateStr}...`
    );

    for (const groupId of groupIds) {
      const groupInfo = allGroups.find((g: any) => g.id === groupId);
      const groupName = groupInfo?.name || groupId;

      try {
        provider.setTrackingMeta?.({ source: "auto", groupId, groupName });

        const messages = await getGroupMessages(groupId, {
          dateFrom: dateStr,
          dateTo: dateStr,
        });

        if (messages.length === 0) {
          console.log(`[AutoSummary] ${groupName}: No messages today, skipping`);
          results.push({ groupId, groupName, sent: false, error: "No messages" });
          continue;
        }

        const participants = new Set(messages.map((m) => m.senderName));

        // Check cache — avoid reprocessing if messages haven't changed
        const messagesHash = generateMessagesHash(messages);
        const cached = getCachedSummary(
          groupId,
          dateStr,
          dateStr,
          config.autoSummary.level,
          config.autoSummary.privacy,
          messagesHash
        );

        if (cached) {
          const cachedTime = new Date(cached.cachedAt).toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
          });
          console.log(`[AutoSummary] ${groupName}: Using cached summary (from ${cachedTime})`);

          const header =
            `📋 *Resumo automático — ${groupName}*\n` +
            `📅 ${formatDateBR(dateStr)}\n` +
            `💬 ${cached.messageCount} msgs · 👥 ${cached.participants} participantes\n` +
            `━━━━━━━━━━━━━━━━━━\n\n`;
          const footer =
            `\n\n━━━━━━━━━━━━━━━━━━` +
            `\n📦 _Da memória · Processado às ${cachedTime} · Sem novas mensagens_` +
            `\n_Gerado por GroupResume By Julio Corcini_`;

          const formatted = toWhatsAppMarkdown(cached.summary);
          const destination = config.autoSummary.sendTo || groupId;
          await sendMessage(destination, header + formatted + footer);
          results.push({ groupId, groupName, sent: true });
          continue;
        }

        // Check for incremental match
        const incrementalMatch = getIncrementalMatch(
          groupId,
          dateStr,
          dateStr,
          config.autoSummary.level,
          config.autoSummary.privacy,
          messages
        );

        let result;

        const groupRules = config.groupRules ?? {};
        const groupCustomRule = groupRules[groupId];

        if (incrementalMatch) {
          const { cachedSummary, newMessageStartIndex } = incrementalMatch;
          const newMessages = messages.slice(newMessageStartIndex);
          console.log(
            `[AutoSummary] ${groupName}: Incremental — ${newMessages.length} new msgs (${cachedSummary.messageCount} cached)`
          );

          result = await generateIncrementalSummary(
            cachedSummary.summary,
            newMessages,
            provider,
            {
              level: config.autoSummary.level,
              privacy: config.autoSummary.privacy,
              maxMessagesPerChunk: provider.getModelConfig().maxMessages,
              mode: "full",
              groupCustomRule,
            }
          );
        } else {
          console.log(
            `[AutoSummary] ${groupName}: ${messages.length} messages, generating summary...`
          );

          result = await generateSummary(messages, provider, {
            level: config.autoSummary.level,
            privacy: config.autoSummary.privacy,
            maxMessagesPerChunk: provider.getModelConfig().maxMessages,
            mode: messages.length > 500 ? "quick" : "full",
            groupCustomRule,
          });
        }

        // Format and send with WhatsApp-compatible markdown
        const header =
          `📋 *Resumo automático — ${groupName}*\n` +
          `📅 ${formatDateBR(dateStr)}\n` +
          `💬 ${messages.length} msgs · 👥 ${participants.size} participantes\n` +
          `━━━━━━━━━━━━━━━━━━\n\n`;
        const footer = `\n\n━━━━━━━━━━━━━━━━━━\n_Gerado por GroupResume By Julio Corcini_`;

        const formatted = toWhatsAppMarkdown(result.summary);
        const destination = config.autoSummary.sendTo || groupId;
        await sendMessage(destination, header + formatted + footer);

        // Save to cache
        saveCachedSummary({
          groupId,
          dateFrom: dateStr,
          dateTo: dateStr,
          level: config.autoSummary.level,
          privacy: config.autoSummary.privacy,
          messagesHash,
          messageCount: messages.length,
          summary: result.summary,
          provider: result.provider,
          processingTime: result.processingTime,
          chunks: result.chunks,
          participants: participants.size,
        });

        // Save to history
        saveToHistory({
          groupName,
          groupId,
          dateFrom: dateStr,
          dateTo: dateStr,
          level: config.autoSummary.level,
          privacy: config.autoSummary.privacy,
          provider: result.provider,
          summary: result.summary,
          totalMessages: messages.length,
          participants: participants.size,
          processingTime: result.processingTime,
          chunks: result.chunks,
          source: "auto",
        });

        console.log(`[AutoSummary] ✅ ${groupName}: Sent (${result.processingTime}ms)`);
        ranToday.add(groupId);
        results.push({ groupId, groupName, sent: true });

        // Small delay between groups to avoid rate limits
        await sleep(3000);
      } catch (err: any) {
        console.error(`[AutoSummary] ❌ ${groupName}:`, err.message);
        results.push({ groupId, groupName, sent: false, error: err.message });
      }
    }

    console.log(`[AutoSummary] Done — ${results.filter((r) => r.sent).length}/${results.length} sent`);
    return { success: true, results };
  } finally {
    isRunning = false;
  }
}

function createProvider(config: ReturnType<typeof loadConfig>): AIProvider {
  const providerName = config.ai.defaultProvider;

  if (providerName === "ollama") {
    return new OllamaProvider(config.ai.ollama.model, config.ai.ollama.baseUrl);
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    throw new Error("GROQ_API_KEY not configured for auto-summary");
  }
  return new GroqProvider(groqKey, "powerful");
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDateBR(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Convert AI markdown output to WhatsApp-compatible formatting.
 */
function toWhatsAppMarkdown(text: string): string {
  return text
    .replace(/^#{1,3} (.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^- (.+)$/gm, "• $1")
    .replace(/\n{3,}/g, "\n\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
