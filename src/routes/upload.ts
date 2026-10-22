import { Router } from "express";
import { parseWhatsAppExport, buildDateIndex } from "../whatsapp/parser.js";
import { generateSummary } from "../ai/summarizer.js";
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
import type { SummaryLevel, PrivacyMode, WhatsAppMessage } from "../types/index.js";
import { saveToHistory } from "../history/store.js";

const router = Router();

const uploadStore = new Map<
  string,
  { messages: WhatsAppMessage[]; uploadedAt: number }
>();

const STORE_TTL_MS = 30 * 60 * 1000;

function cleanupStore(): void {
  const now = Date.now();
  for (const [id, data] of uploadStore) {
    if (now - data.uploadedAt > STORE_TTL_MS) {
      uploadStore.delete(id);
    }
  }
}

/** POST /api/upload — Upload and parse a WhatsApp chat export .txt file */
router.post("/", (req, res) => {
  try {
    cleanupStore();
    const { content } = req.body;
    if (!content || typeof content !== "string") {
      res.status(400).json({ error: "Missing 'content' field" });
      return;
    }

    const messages = parseWhatsAppExport(content);
    if (messages.length === 0) {
      res.status(400).json({ error: "No messages found in file." });
      return;
    }

    const id = `upload-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    uploadStore.set(id, { messages, uploadedAt: Date.now() });

    const dates = buildDateIndex(messages);
    const senders = new Set(messages.map((m) => m.senderName));

    res.json({
      id,
      totalMessages: messages.length,
      totalDays: dates.length,
      participants: senders.size,
      oldestDate: dates[dates.length - 1]?.date,
      newestDate: dates[0]?.date,
      dates,
    });
  } catch (err: any) {
    console.error("[Upload] Error:", err);
    res.status(500).json({ error: err.message ?? "Failed to parse file" });
  }
});

/** POST /api/upload/:id/summarize — Start summary job for uploaded file */
router.post("/:id/summarize", async (req, res) => {
  const { id } = req.params;
  const data = uploadStore.get(id);

  if (!data) {
    res.status(404).json({ error: "Upload not found or expired. Please upload the file again." });
    return;
  }

  const { dateFrom, dateTo, level, privacy, aiProvider } = req.body;
  const config = loadConfig();
  const jobId = generateJobId();
  cleanupOldEntries();

  // Filter by date
  let messages = data.messages;
  if (dateFrom) messages = messages.filter((m) => m.date >= dateFrom);
  if (dateTo) messages = messages.filter((m) => m.date <= dateTo);

  if (messages.length === 0) {
    res.json({
      jobId,
      summary: "Nenhuma mensagem encontrada para o período selecionado.",
      stats: { totalMessages: 0, participants: 0, tokensUsed: 0, processingTime: 0, chunks: 0, provider: "none" },
    });
    return;
  }

  setProgress(jobId, {
    phase: "starting",
    message: `Preparando ${messages.length} mensagens...`,
    startedAt: Date.now(),
    currentChunkStartedAt: Date.now(),
    totalMessages: messages.length,
  });

  // Return immediately with jobId
  res.json({ jobId });

  // Run in background
  runUploadSummarizeJob(jobId, messages, {
    level: level ?? config.summary.defaultLevel,
    privacy: privacy ?? config.summary.defaultPrivacy,
    aiProvider: aiProvider ?? "groq",
    dateFrom,
    dateTo,
  }).catch((err) => {
    console.error(`[Upload Summarize] Job ${jobId} fatal error:`, err);
    setProgress(jobId, {
      phase: "error",
      message: err.message ?? "Unknown error",
      errorMessage: err.message,
    });
  });
});

async function runUploadSummarizeJob(
  jobId: string,
  messages: WhatsAppMessage[],
  opts: { level: SummaryLevel; privacy: PrivacyMode; aiProvider: string; dateFrom?: string; dateTo?: string }
): Promise<void> {
  let provider: AIProvider;
  const useOllama = opts.aiProvider === "ollama";

  if (useOllama) {
    provider = new OllamaProvider();
    const available = await provider.isAvailable();
    if (!available) {
      setProgress(jobId, { phase: "error", message: "Ollama não está rodando.", errorMessage: "Ollama not running" });
      return;
    }
  } else {
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      setProgress(jobId, { phase: "error", message: "GROQ_API_KEY não configurada.", errorMessage: "No API key" });
      return;
    }
    provider = new GroqProvider(groqKey, "balanced");
  }

  const providerName = useOllama ? "ollama" : "groq";
  console.log(`[Upload Summarize] Job ${jobId}: ${messages.length} messages → ${providerName}`);

  // Set tracking metadata for usage
  if (provider.setTrackingMeta) {
    provider.setTrackingMeta({ source: "upload", groupId: "upload", groupName: "Arquivo importado" });
  }

  setProgress(jobId, { provider: providerName });

  const result = await generateSummary(
    messages,
    provider,
    {
      level: opts.level,
      privacy: opts.privacy,
      maxMessagesPerChunk: provider.getModelConfig().maxMessages,
      mode: "full",
    },
    (progress) => {
      console.log(
        `[Upload Summarize] ${progress.phase}: ${progress.message} (${progress.current}/${progress.total})`
      );
      setProgress(jobId, {
        phase: progress.phase as any,
        message: progress.message,
        current: progress.current,
        total: progress.total,
      });
      if (progress.phase === "summarizing" && progress.current > 1) {
        recordChunkCompletion(jobId);
      }
    }
  );

  const participants = new Set(messages.map((m) => m.senderName));

  const effectiveDateFrom = opts.dateFrom ?? messages[0]?.date;
  const effectiveDateTo = opts.dateTo ?? messages[messages.length - 1]?.date;

  setProgress(jobId, {
    phase: "done",
    message: "Resumo concluído!",
    result: {
      summary: result.summary,
      stats: {
        totalMessages: messages.length,
        participants: participants.size,
        tokensUsed: result.tokensUsed,
        processingTime: result.processingTime,
        chunks: result.chunks,
        provider: result.provider,
        dateFrom: effectiveDateFrom,
        dateTo: effectiveDateTo,
        source: "upload",
      },
    },
  });

  // Save to history
  try {
    saveToHistory({
      groupName: "Arquivo importado",
      groupId: "upload",
      dateFrom: effectiveDateFrom,
      dateTo: effectiveDateTo,
      level: opts.level,
      privacy: opts.privacy,
      provider: result.provider,
      summary: result.summary,
      totalMessages: messages.length,
      participants: participants.size,
      processingTime: result.processingTime,
      chunks: result.chunks,
      source: "upload",
    });
  } catch (err) {
    console.error("[History] Failed to save upload entry:", err);
  }

  setTimeout(() => removeProgress(jobId), 10 * 60 * 1000);
}

export default router;
