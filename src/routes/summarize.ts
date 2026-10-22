import { Router } from "express";
import { getGroupMessages } from "../whatsapp/messages.js";
import { generateSummary, generateIncrementalSummary } from "../ai/summarizer.js";
import { GroqProvider } from "../ai/groq.js";
import { OllamaProvider } from "../ai/ollama.js";
import { loadConfig } from "../config/manager.js";
import {
  generateJobId,
  setProgress,
  recordChunkCompletion,
  removeProgress,
  cleanupOldEntries,
} from "../progress/store.js";
import type { AIProvider } from "../ai/provider.js";
import type { SummaryLevel, PrivacyMode } from "../types/index.js";
import { saveToHistory } from "../history/store.js";
import {
  generateMessagesHash,
  getCachedSummary,
  saveCachedSummary,
  getIncrementalMatch,
} from "../cache/summary-cache.js";

const router = Router();

/**
 * POST /api/summarize — Start a summary job (returns immediately with jobId)
 */
router.post("/", async (req, res) => {
  const {
    groupId,
    date,
    dateFrom,
    dateTo,
    level,
    privacy,
    mode = "full",
    forceNew = false,
  } = req.body;

  if (!groupId) {
    res.status(400).json({ error: "Missing 'groupId'" });
    return;
  }

  const config = loadConfig();
  const jobId = generateJobId();
  cleanupOldEntries();

  const resolvedDateFrom = date ?? dateFrom ?? getTodayDate();
  const resolvedDateTo = date ?? dateTo ?? getTodayDate();

  console.log(`[Summarize] Job ${jobId}: Group ${groupId}, ${resolvedDateFrom} → ${resolvedDateTo}`);

  setProgress(jobId, {
    phase: "fetching",
    message: "Buscando mensagens do WhatsApp...",
    startedAt: Date.now(),
    currentChunkStartedAt: Date.now(),
  });

  // Return immediately with jobId so the frontend can poll
  res.json({ jobId });

  // Run the summarization in the background
  runSummarizeJob(jobId, {
    groupId,
    dateFrom: resolvedDateFrom,
    dateTo: resolvedDateTo,
    level: level ?? config.summary.defaultLevel,
    privacy: privacy ?? config.summary.defaultPrivacy,
    mode,
    aiProvider: req.body.aiProvider,
    forceNew: forceNew === true,
  }).catch((err) => {
    console.error(`[Summarize] Job ${jobId} fatal error:`, err);
    setProgress(jobId, {
      phase: "error",
      message: err.message ?? "Unknown error",
      errorMessage: err.message,
    });
  });
});

async function runSummarizeJob(
  jobId: string,
  opts: {
    groupId: string;
    dateFrom: string;
    dateTo: string;
    level: SummaryLevel;
    privacy: PrivacyMode;
    mode: string;
    aiProvider?: string;
    forceNew?: boolean;
  }
): Promise<void> {
  // Fetch messages
  const messages = await getGroupMessages(opts.groupId, {
    dateFrom: opts.dateFrom,
    dateTo: opts.dateTo,
  });

  if (messages.length === 0) {
    setProgress(jobId, {
      phase: "done",
      message: "Nenhuma mensagem encontrada.",
      result: {
        summary: "Nenhuma mensagem encontrada para o período selecionado.",
        stats: { totalMessages: 0, participants: 0, tokensUsed: 0, processingTime: 0, chunks: 0, provider: "none" },
      },
    });
    return;
  }

  // Check cache — avoid reprocessing if messages haven't changed
  const messagesHash = generateMessagesHash(messages);
  const cached = opts.forceNew ? null : getCachedSummary(
    opts.groupId,
    opts.dateFrom,
    opts.dateTo,
    opts.level,
    opts.privacy,
    messagesHash
  );

  if (cached) {
    const cachedTime = new Date(cached.cachedAt).toLocaleString("pt-BR");
    console.log(`[Summarize] Job ${jobId}: Using cached summary from ${cachedTime}`);

    setProgress(jobId, {
      phase: "done",
      message: "Resumo recuperado da memória (sem novas mensagens).",
      result: {
        summary: cached.summary,
        stats: {
          totalMessages: cached.messageCount,
          participants: cached.participants,
          tokensUsed: 0,
          processingTime: 0,
          chunks: cached.chunks,
          provider: cached.provider,
          dateFrom: opts.dateFrom,
          dateTo: opts.dateTo,
        },
        fromCache: true,
        cachedAt: cached.cachedAt,
      },
    });

    setTimeout(() => removeProgress(jobId), 10 * 60 * 1000);
    return;
  }

  // Initialize AI provider
  let provider: AIProvider;
  const providerName = opts.aiProvider === "ollama" ? "ollama" : "groq";

  if (opts.aiProvider === "ollama") {
    provider = new OllamaProvider();
    const available = await provider.isAvailable();
    if (!available) {
      setProgress(jobId, {
        phase: "error",
        message: "Ollama não está rodando. Inicie com: ollama serve",
        errorMessage: "Ollama not running",
      });
      return;
    }
  } else {
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      setProgress(jobId, {
        phase: "error",
        message: "GROQ_API_KEY não configurada",
        errorMessage: "GROQ_API_KEY not configured",
      });
      return;
    }
    provider = new GroqProvider(groqKey, "powerful");
  }

  provider.setTrackingMeta?.({ source: "dashboard", groupId: opts.groupId });

  setProgress(jobId, {
    provider: providerName,
    totalMessages: messages.length,
    phase: "chunking",
    message: `Preparando ${messages.length} mensagens...`,
  });

  // Get group-specific custom rules from config
  const groupRules = loadConfig().groupRules ?? {};
  const groupCustomRule = groupRules[opts.groupId];

  // Check for incremental match (partial cache — only new messages need processing)
  const incrementalMatch = opts.forceNew ? null : getIncrementalMatch(
    opts.groupId,
    opts.dateFrom,
    opts.dateTo,
    opts.level,
    opts.privacy,
    messages
  );

  if (incrementalMatch) {
    const { cachedSummary, newMessageStartIndex } = incrementalMatch;
    const newMessages = messages.slice(newMessageStartIndex);
    const participants = new Set(messages.map((m) => m.senderName));

    console.log(
      `[Summarize] Job ${jobId}: Incremental mode — ${newMessages.length} new msgs (${cachedSummary.messageCount} cached)`
    );

    setProgress(jobId, {
      phase: "summarizing",
      message: `Resumo incremental: ${newMessages.length} novas mensagens...`,
    });

    const result = await generateIncrementalSummary(
      cachedSummary.summary,
      newMessages,
      provider,
      {
        level: opts.level,
        privacy: opts.privacy,
        maxMessagesPerChunk: provider.getModelConfig().maxMessages,
        mode: "full",
        groupCustomRule,
      },
      (progress) => {
        setProgress(jobId, {
          phase: progress.phase as any,
          message: progress.message,
          current: progress.current,
          total: progress.total,
        });
      }
    );

    const cachedTime = new Date(cachedSummary.cachedAt).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });

    setProgress(jobId, {
      phase: "done",
      message: "Resumo incremental concluído!",
      result: {
        summary: result.summary,
        stats: {
          totalMessages: messages.length,
          participants: participants.size,
          tokensUsed: result.tokensUsed,
          processingTime: result.processingTime,
          chunks: result.chunks,
          provider: result.provider,
          dateFrom: opts.dateFrom,
          dateTo: opts.dateTo,
        },
        incremental: true,
        cachedMessages: cachedSummary.messageCount,
        newMessages: newMessages.length,
        cachedAt: cachedSummary.cachedAt,
      },
    });

    // Update cache with merged result
    saveCachedSummary({
      groupId: opts.groupId,
      dateFrom: opts.dateFrom,
      dateTo: opts.dateTo,
      level: opts.level,
      privacy: opts.privacy,
      messagesHash: generateMessagesHash(messages),
      messageCount: messages.length,
      summary: result.summary,
      provider: result.provider,
      processingTime: result.processingTime,
      chunks: result.chunks,
      participants: participants.size,
    });

    // Save to history
    try {
      const allGroups = await import("../whatsapp/messages.js").then((m) => m.getGroups());
      const groupInfo = allGroups.find((g: any) => g.id === opts.groupId);
      saveToHistory({
        groupName: groupInfo?.name || opts.groupId,
        groupId: opts.groupId,
        dateFrom: opts.dateFrom,
        dateTo: opts.dateTo,
        level: opts.level,
        privacy: opts.privacy,
        provider: result.provider,
        summary: result.summary,
        totalMessages: messages.length,
        participants: participants.size,
        processingTime: result.processingTime,
        chunks: result.chunks,
        source: "live",
      });
    } catch (err) {
      console.error("[History] Failed to save:", err);
    }

    setTimeout(() => removeProgress(jobId), 10 * 60 * 1000);
    return;
  }

  // Generate summary with real-time progress (full processing)
  const result = await generateSummary(
    messages,
    provider,
    {
      level: opts.level,
      privacy: opts.privacy,
      maxMessagesPerChunk: provider.getModelConfig().maxMessages,
      mode: opts.mode as "quick" | "full",
      groupCustomRule,
    },
    (progress) => {
      console.log(
        `[Summarize] ${progress.phase}: ${progress.message} (${progress.current}/${progress.total})`
      );

      const prevPhase = progress.phase;
      setProgress(jobId, {
        phase: progress.phase as any,
        message: progress.message,
        current: progress.current,
        total: progress.total,
      });

      // Record chunk completion for ETA
      if (progress.phase === "summarizing" && progress.current > 1) {
        recordChunkCompletion(jobId);
      }
    }
  );

  const participants = new Set(messages.map((m) => m.senderName));

  const summaryStats = {
    totalMessages: messages.length,
    participants: participants.size,
    tokensUsed: result.tokensUsed,
    processingTime: result.processingTime,
    chunks: result.chunks,
    provider: result.provider,
    dateFrom: opts.dateFrom,
    dateTo: opts.dateTo,
  };

  setProgress(jobId, {
    phase: "done",
    message: "Resumo concluído!",
    result: {
      summary: result.summary,
      stats: summaryStats,
    },
  });

  // Save to cache for future deduplication
  saveCachedSummary({
    groupId: opts.groupId,
    dateFrom: opts.dateFrom,
    dateTo: opts.dateTo,
    level: opts.level,
    privacy: opts.privacy,
    messagesHash,
    messageCount: messages.length,
    summary: result.summary,
    provider: result.provider,
    processingTime: result.processingTime,
    chunks: result.chunks,
    participants: participants.size,
  });

  // Save to history
  try {
    const allGroups = await import("../whatsapp/messages.js").then((m) => m.getGroups());
    const groupInfo = allGroups.find((g: any) => g.id === opts.groupId);
    saveToHistory({
      groupName: groupInfo?.name || opts.groupId,
      groupId: opts.groupId,
      dateFrom: opts.dateFrom,
      dateTo: opts.dateTo,
      level: opts.level,
      privacy: opts.privacy,
      provider: result.provider,
      summary: result.summary,
      totalMessages: messages.length,
      participants: participants.size,
      processingTime: result.processingTime,
      chunks: result.chunks,
      source: "live",
    });
  } catch (err) {
    console.error("[History] Failed to save:", err);
  }

  // Cleanup after 10 minutes
  setTimeout(() => removeProgress(jobId), 10 * 60 * 1000);
}

function getTodayDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default router;
