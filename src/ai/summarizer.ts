import type { AIProvider } from "./provider.js";
import {
  SUMMARY_CONFIGS,
  buildSummarySystemPrompt,
  getMergeSystemPrompt,
} from "./prompts.js";
import type {
  WhatsAppMessage,
  SummaryLevel,
  PrivacyMode,
  SummaryResult,
  SummaryOptions,
} from "../types/index.js";

// ============================================================
// Constants — ported from groupResume engineering
// ============================================================

/** Approximate chars per token for Portuguese text. */
const CHARS_PER_TOKEN = 4;

/** Max tokens per chunk (Groq context = 32K, use 8K to be safe). */
const MAX_TOKENS_PER_CHUNK = 8000;

/** Groq free-tier TPM limit. */
const TPM_LIMIT = 70000;

/** Threshold for "large" message sets that need chunking. */
const FULL_MODE_THRESHOLD = 250;

/** Minutes of gap that defines a conversation block boundary. */
const CONVERSATION_GAP_MINUTES = 5;

// ============================================================
// Token Estimation
// ============================================================

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ============================================================
// Message Formatting
// ============================================================

/**
 * Sanitize a WhatsApp display name by removing emojis and symbols.
 * "Glauciana 💕" → "Glauciana"
 * "~ 🏆🏆 nobre" → "nobre"
 * "❤️" → "Participante"
 * "." → "Participante"
 */
export function sanitizeDisplayName(name: string): string {
  // Remove emojis (Unicode emoji ranges + variation selectors)
  const cleaned = name
    .replace(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu,
      ""
    )
    // Remove leading/trailing special characters
    .replace(/^[~.*•\-_\s]+/, "")
    .replace(/[~.*•\-_\s]+$/, "")
    .trim();

  // If nothing readable is left, return a generic name
  if (!cleaned || cleaned.length < 2) {
    return "Participante";
  }

  return cleaned;
}

function formatMessagesForAI(
  messages: WhatsAppMessage[],
  includeNames: boolean
): string {
  return messages
    .filter((msg) => msg.content || msg.isMedia)
    .map((msg) => {
      const name = sanitizeDisplayName(msg.senderName);
      if (msg.isMedia) {
        return includeNames
          ? `[${msg.time}] ${name}: [mídia]`
          : `[${msg.time}] [mídia]`;
      }
      return includeNames
        ? `[${msg.time}] ${name}: ${msg.content}`
        : `[${msg.time}] ${msg.content}`;
    })
    .join("\n");
}

// ============================================================
// Chunking — ported from groupResume
// ============================================================

function chunkMessages(
  messages: WhatsAppMessage[],
  maxMessages: number
): WhatsAppMessage[][] {
  if (messages.length === 0) return [];
  if (messages.length <= maxMessages) return [messages];

  const chunks: WhatsAppMessage[][] = [];
  for (let i = 0; i < messages.length; i += maxMessages) {
    chunks.push(messages.slice(i, i + maxMessages));
  }
  return chunks;
}

// ============================================================
// Smart Sampling — ported from groupResume
// ============================================================

function groupIntoConversationBlocks(
  messages: WhatsAppMessage[]
): WhatsAppMessage[][] {
  const blocks: WhatsAppMessage[][] = [];
  let currentBlock: WhatsAppMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (currentBlock.length === 0) {
      currentBlock.push(messages[i]);
      continue;
    }

    const prevTime = messages[i - 1].timestamp;
    const currTime = messages[i].timestamp;
    const gapMinutes = (currTime - prevTime) / 60;

    if (gapMinutes > CONVERSATION_GAP_MINUTES) {
      blocks.push(currentBlock);
      currentBlock = [messages[i]];
    } else {
      currentBlock.push(messages[i]);
    }
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock);
  }

  return blocks;
}

function smartSample(
  messages: WhatsAppMessage[],
  targetCount: number
): WhatsAppMessage[] {
  if (messages.length <= targetCount) return messages;

  const blocks = groupIntoConversationBlocks(messages);
  const sortedBlocks = [...blocks].sort((a, b) => b.length - a.length);

  const result: WhatsAppMessage[] = [];
  let totalMsgs = 0;

  // Always include beginning and end of day
  const firstBlock = blocks[0];
  const lastBlock = blocks[blocks.length - 1];

  if (firstBlock && totalMsgs + firstBlock.length <= targetCount) {
    result.push(...firstBlock);
    totalMsgs += firstBlock.length;
  }

  if (
    lastBlock &&
    lastBlock !== firstBlock &&
    totalMsgs + lastBlock.length <= targetCount
  ) {
    result.push(...lastBlock);
    totalMsgs += lastBlock.length;
  }

  // Fill with largest blocks (most active conversations)
  for (const block of sortedBlocks) {
    if (block === firstBlock || block === lastBlock) continue;
    if (totalMsgs + block.length <= targetCount) {
      result.push(...block);
      totalMsgs += block.length;
    } else if (totalMsgs < targetCount) {
      result.push(...block.slice(0, targetCount - totalMsgs));
      break;
    }
  }

  // Restore chronological order
  return result.sort((a, b) => a.timestamp - b.timestamp);
}

// ============================================================
// Rate Limit Handling — ported from groupResume
// ============================================================

function parseWaitTime(errorMessage: string): number {
  const patterns = [
    /(\d+)h(\d+)m(\d+\.?\d*)s/,
    /(\d+)h(\d+)m/,
    /(\d+)m(\d+\.?\d*)s/,
    /(\d+\.?\d*)s/,
    /retry.after.*?(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = errorMessage.match(pattern);
    if (match) {
      if (pattern.source.includes("h") && pattern.source.includes("s")) {
        return (
          parseInt(match[1]) * 3600 +
          parseInt(match[2]) * 60 +
          parseFloat(match[3])
        );
      } else if (pattern.source.includes("h")) {
        return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60;
      } else if (pattern.source.includes("m")) {
        return parseInt(match[1]) * 60 + parseFloat(match[2]);
      } else {
        return parseFloat(match[1]);
      }
    }
  }

  return 60; // Default 1 minute
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  onWait?: (waitSeconds: number) => void
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const errMsg = err?.message ?? err?.toString() ?? "";
      const isRateLimit =
        errMsg.includes("rate") ||
        errMsg.includes("429") ||
        errMsg.includes("Rate limit") ||
        err?.status === 429;

      const isConnectionError =
        errMsg.includes("Connection error") ||
        errMsg.includes("ECONNRESET") ||
        errMsg.includes("CERT") ||
        errMsg.includes("fetch") ||
        errMsg.includes("ETIMEDOUT") ||
        errMsg.includes("socket");

      if (isRateLimit && attempt < maxRetries) {
        const waitTime = parseWaitTime(errMsg);
        console.log(
          `[AI] Rate limit hit. Waiting ${waitTime.toFixed(1)}s (attempt ${attempt + 1}/${maxRetries})...`
        );
        onWait?.(waitTime);
        await sleep(waitTime * 1000 + 500);
        continue;
      }

      if (isConnectionError && attempt < maxRetries) {
        const waitTime = 3 + attempt * 2;
        console.log(
          `[AI] Connection error. Retrying in ${waitTime}s (attempt ${attempt + 1}/${maxRetries})...`
        );
        onWait?.(waitTime);
        await sleep(waitTime * 1000);
        continue;
      }

      throw err;
    }
  }
  throw new Error("Max retries exceeded");
}

// ============================================================
// Main Summarizer
// ============================================================

export interface SummarizerProgress {
  phase: "chunking" | "summarizing" | "merging" | "done";
  current: number;
  total: number;
  message: string;
}

export type ProgressCallback = (progress: SummarizerProgress) => void;

/**
 * Generate a summary for a set of WhatsApp messages.
 * Handles chunking, smart sampling, rate limits, and merging.
 */
export async function generateSummary(
  messages: WhatsAppMessage[],
  provider: AIProvider,
  options: {
    level: SummaryLevel;
    privacy: PrivacyMode;
    maxMessagesPerChunk?: number;
    mode?: "quick" | "full";
    groupCustomRule?: string;
  },
  onProgress?: ProgressCallback
): Promise<SummaryResult> {
  const startTime = Date.now();
  const { level, privacy, mode = "full", groupCustomRule } = options;
  const includeNames = privacy !== "anonymous";
  const config = SUMMARY_CONFIGS[level];
  const summaryOpts: SummaryOptions = {
    level,
    privacy,
    maxTokens: config.maxTokens,
  };

  // Determine max messages per chunk from provider
  const maxPerChunk = options.maxMessagesPerChunk ?? FULL_MODE_THRESHOLD;

  onProgress?.({
    phase: "chunking",
    current: 0,
    total: 1,
    message: "Preparando mensagens...",
  });

  let messagesToProcess = messages;

  // Quick mode: use smart sampling
  if (mode === "quick" && messages.length > maxPerChunk) {
    messagesToProcess = smartSample(messages, maxPerChunk);
  }

  // Chunk messages
  const chunks = chunkMessages(messagesToProcess, maxPerChunk);

  if (chunks.length === 0) {
    return {
      summary: "Nenhuma mensagem encontrada para resumir.",
      tokensUsed: 0,
      processingTime: Date.now() - startTime,
      provider: provider.name,
      model: "",
      chunks: 0,
    };
  }

  // Single chunk — direct summarization
  if (chunks.length === 1) {
    onProgress?.({
      phase: "summarizing",
      current: 1,
      total: 1,
      message: "Gerando resumo...",
    });

    const text = formatMessagesForAI(chunks[0], includeNames);
    const systemPrompt = buildSummarySystemPrompt(level, privacy, false, groupCustomRule);

    const result = await callWithRetry(
      () => provider.summarize(text, systemPrompt, summaryOpts),
      3,
      (wait) =>
        onProgress?.({
          phase: "summarizing",
          current: 1,
          total: 1,
          message: `Aguardando rate limit... ${wait.toFixed(0)}s`,
        })
    );

    let finalSummary = result.summary;
    if (mode === "quick" && messages.length > messagesToProcess.length) {
      finalSummary += `\n\n---\n_Resumo de ${messagesToProcess.length} de ${messages.length} mensagens (amostra inteligente)_`;
    }

    onProgress?.({
      phase: "done",
      current: 1,
      total: 1,
      message: "Resumo concluído!",
    });

    return {
      summary: finalSummary,
      tokensUsed: result.tokensUsed,
      processingTime: Date.now() - startTime,
      provider: provider.name,
      model: "",
      chunks: 1,
    };
  }

  // Multiple chunks — process sequentially with TPM monitoring
  const partialSummaries: string[] = [];
  let totalTokensUsed = 0;
  let tokensInCurrentMinute = 0;

  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({
      phase: "summarizing",
      current: i + 1,
      total: chunks.length + 1,
      message: `Processando parte ${i + 1}/${chunks.length}...`,
    });

    const text = formatMessagesForAI(chunks[i], includeNames);
    const systemPrompt = buildSummarySystemPrompt(level, privacy, true, groupCustomRule);

    const result = await callWithRetry(
      () => provider.summarize(text, systemPrompt, summaryOpts),
      3,
      (wait) =>
        onProgress?.({
          phase: "summarizing",
          current: i + 1,
          total: chunks.length + 1,
          message: `Aguardando rate limit... ${wait.toFixed(0)}s`,
        })
    );

    console.log(
      `[AI] Chunk ${i + 1}/${chunks.length}: ${result.tokensUsed} tokens, ${(result.summary || "").length} chars`
    );
    partialSummaries.push(result.summary);
    totalTokensUsed += result.tokensUsed;
    tokensInCurrentMinute += result.tokensUsed;

    // Small delay between chunks to avoid RPM rate limits
    if (i < chunks.length - 1) {
      await sleep(1500);
    }

    // TPM throttling: wait for reset when approaching 90%
    if (
      tokensInCurrentMinute > TPM_LIMIT * 0.9 &&
      i < chunks.length - 1
    ) {
      onProgress?.({
        phase: "summarizing",
        current: i + 1,
        total: chunks.length + 1,
        message: "Aguardando reset de tokens (60s)...",
      });
      await sleep(60000);
      tokensInCurrentMinute = 0;
    }
  }

  // Merge partial summaries
  onProgress?.({
    phase: "merging",
    current: chunks.length,
    total: chunks.length + 1,
    message: "Combinando resumos...",
  });

  let finalSummary: string;
  const validSummaries = partialSummaries.filter((s) => s && s.trim().length > 10);

  if (validSummaries.length === 0) {
    finalSummary = "Não foi possível gerar resumos para as partes processadas.";
  } else if (validSummaries.length === 1) {
    finalSummary = validSummaries[0];
  } else if (validSummaries.length <= 3) {
    // Small number of parts — try AI merge
    try {
      const mergePrompt = getMergeSystemPrompt(level, privacy);
      const mergeResult = await callWithRetry(
        () =>
          provider.mergeSummaries(
            validSummaries,
            mergePrompt,
            config.maxTokens
          ),
        3,
        (wait) =>
          onProgress?.({
            phase: "merging",
            current: chunks.length,
            total: chunks.length + 1,
            message: `Aguardando rate limit... ${wait.toFixed(0)}s`,
          })
      );
      finalSummary = mergeResult.summary;
      totalTokensUsed += mergeResult.tokensUsed;
    } catch {
      // Fallback: concatenate if merge fails
      console.log("[AI] Merge failed, using concatenation fallback");
      finalSummary = validSummaries
        .map((s, i) => `## Parte ${i + 1}\n\n${s}`)
        .join("\n\n---\n\n");
    }
  } else {
    // Many parts — concatenate directly (more reliable than AI merge)
    console.log(`[AI] ${validSummaries.length} parts — using concatenation`);
    finalSummary = validSummaries
      .map((s, i) => `## Parte ${i + 1}\n\n${s}`)
      .join("\n\n---\n\n");
  }

  onProgress?.({
    phase: "done",
    current: chunks.length + 1,
    total: chunks.length + 1,
    message: "Resumo concluído!",
  });

  return {
    summary: finalSummary,
    tokensUsed: totalTokensUsed,
    processingTime: Date.now() - startTime,
    provider: provider.name,
    model: "",
    chunks: chunks.length,
  };
}

/**
 * Incremental summary: merge an existing summary with a summary of only new messages.
 * Much cheaper than re-processing all messages.
 */
export async function generateIncrementalSummary(
  existingSummary: string,
  newMessages: WhatsAppMessage[],
  provider: AIProvider,
  options: {
    level: SummaryLevel;
    privacy: PrivacyMode;
    maxMessagesPerChunk: number;
    mode: "quick" | "full";
    groupCustomRule?: string;
  },
  onProgress?: (progress: {
    phase: string;
    current: number;
    total: number;
    message: string;
  }) => void
): Promise<SummaryResult> {
  const startTime = Date.now();
  let totalTokensUsed = 0;

  onProgress?.({
    phase: "summarizing",
    current: 1,
    total: 2,
    message: `Resumindo ${newMessages.length} novas mensagens...`,
  });

  // Step 1: Summarize only the new messages
  const newResult = await generateSummary(newMessages, provider, {
    level: options.level,
    privacy: options.privacy,
    maxMessagesPerChunk: options.maxMessagesPerChunk,
    mode: options.mode,
    groupCustomRule: options.groupCustomRule,
  });

  totalTokensUsed += newResult.tokensUsed;

  onProgress?.({
    phase: "merging",
    current: 2,
    total: 2,
    message: "Mesclando com resumo anterior...",
  });

  // Step 2: Merge the existing summary with the new one
  const mergePrompt = getMergeSystemPrompt(options.level, options.privacy);
  const mergeContent =
    `## Resumo anterior (mensagens mais antigas):\n\n${existingSummary}\n\n` +
    `---\n\n## Resumo das mensagens novas:\n\n${newResult.summary}`;

  const mergeResponse = await provider.mergeSummaries(
    [mergeContent],
    mergePrompt,
    4000
  );
  totalTokensUsed += mergeResponse.tokensUsed;

  onProgress?.({
    phase: "done",
    current: 2,
    total: 2,
    message: "Resumo incremental concluído!",
  });

  return {
    summary: mergeResponse.summary,
    tokensUsed: totalTokensUsed,
    processingTime: Date.now() - startTime,
    provider: provider.name,
    model: "",
    chunks: newResult.chunks + 1,
  };
}
