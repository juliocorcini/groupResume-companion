import { whatsappClient } from "./client.js";
import { getGroupMessages } from "./messages.js";
import { sendMessage } from "./sender.js";
import { generateSummary, generateIncrementalSummary } from "../ai/summarizer.js";
import { GroqProvider } from "../ai/groq.js";
import { OllamaProvider } from "../ai/ollama.js";
import { loadConfig } from "../config/manager.js";
import { getAutoSummaryStatus } from "../scheduler/auto-summary.js";
import { handleDM } from "./dm-handler.js";
import { transcribeAudio } from "../ai/transcriber.js";
import type { AIProvider } from "../ai/provider.js";
import type { SummaryLevel } from "../types/index.js";
import { saveToHistory } from "../history/store.js";
import {
  generateMessagesHash,
  getCachedSummary,
  saveCachedSummary,
  getIncrementalMatch,
} from "../cache/summary-cache.js";
import { getUsageStats, GROQ_FREE_LIMITS } from "../usage/tracker.js";

/** Track rate limits per group: groupId → last trigger timestamp */
const lastTriggerMap = new Map<string, number>();

// ============================================================
// Audio Download Helper — tries multiple strategies
// ============================================================

function resolveExtFromMime(mime?: string): string {
  if (!mime) return "ogg";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "ogg";
}

async function downloadAudioMedia(msg: any): Promise<{ buffer: Buffer; ext: string } | null> {
  // Build message ID — msg.id._serialized may be empty for @lid contacts
  const idObj = msg.id || {};
  let msgId: string = idObj._serialized || "";
  if (!msgId && idObj.id) {
    // Manually reconstruct serialized ID
    const remote = typeof idObj.remote === "object"
      ? (idObj.remote._serialized || idObj.remote.$1 || "")
      : (idObj.remote || "");
    const participant = idObj.participant
      ? (typeof idObj.participant === "object"
        ? (idObj.participant._serialized || idObj.participant.$1 || "")
        : idObj.participant)
      : "";
    msgId = `${idObj.fromMe ? "true" : "false"}_${remote}_${idObj.id}${participant ? "_" + participant : ""}`;
  }

  const rawData = msg.rawData || msg._data || {};
  console.log(
    `[Bot] Audio: type=${msg.type}, hasMedia=${msg.hasMedia}, ` +
    `id=${msgId || "(empty)"}, idKeys=${Object.keys(idObj).join(",")}, ` +
    `mime=${rawData.mimetype || "?"}, ` +
    `directPath=${rawData.directPath ? "yes" : "no"}, ` +
    `bodyLen=${rawData.body ? String(rawData.body).length : 0}`
  );

  // Strategy 1: standard downloadMedia()
  try {
    const media = await msg.downloadMedia();
    if (media?.data) {
      const buf = Buffer.from(media.data, "base64");
      console.log(`[Bot] Audio OK (downloadMedia): ${(buf.length / 1024).toFixed(1)} KB`);
      return { buffer: buf, ext: resolveExtFromMime(media.mimetype) };
    }
  } catch (e: any) {
    console.warn(`[Bot] downloadMedia error: ${e.message}`);
  }

  // Strategy 2: wait 3s then retry (media might not be fully loaded yet)
  try {
    console.log("[Bot] Audio retry: waiting 3s...");
    await new Promise((r) => setTimeout(r, 3000));
    const media = await msg.downloadMedia();
    if (media?.data) {
      const buf = Buffer.from(media.data, "base64");
      console.log(`[Bot] Audio OK (retry): ${(buf.length / 1024).toFixed(1)} KB`);
      return { buffer: buf, ext: resolveExtFromMime(media.mimetype) };
    }
  } catch (e: any) {
    console.warn(`[Bot] Audio retry error: ${e.message}`);
  }

  // Strategy 3: fetch fresh message by ID then download
  if (msgId) {
    try {
      console.log("[Bot] Audio: fetching fresh message...");
      const rawClient = whatsappClient.getRawClient();
      const freshMsg = await (rawClient as any).getMessageById(msgId);
      if (freshMsg?.hasMedia) {
        const media = await freshMsg.downloadMedia();
        if (media?.data) {
          const buf = Buffer.from(media.data, "base64");
          console.log(`[Bot] Audio OK (fresh msg): ${(buf.length / 1024).toFixed(1)} KB`);
          return { buffer: buf, ext: resolveExtFromMime(media.mimetype) };
        }
      }
    } catch (e: any) {
      console.warn(`[Bot] Audio fresh msg error: ${e.message}`);
    }
  }

  // Strategy 4: custom puppeteer evaluate (bypass library's downloadMedia)
  try {
    console.log("[Bot] Audio: trying direct puppeteer download...");
    const rawClient = whatsappClient.getRawClient();
    const page = (rawClient as any).pupPage;
    if (page) {
      const result = await page.evaluate(async (id: string) => {
        const w = window as any;
        try {
          const WACol = w.require("WAWebCollections");
          const m = WACol.Msg.get(id) ||
            (await WACol.Msg.getMessagesById([id]))?.messages?.[0];
          if (!m) return { error: "msg_not_found" };

          // Detailed diagnostic info
          const diag: Record<string, any> = {
            type: m.type,
            mimetype: m.mimetype,
            directPath: m.directPath ? "present" : "missing",
            mediaKey: m.mediaKey ? "present" : "missing",
            encFilehash: m.encFilehash ? "present" : "missing",
            filehash: m.filehash ? "present" : "missing",
            mediaKeyTimestamp: m.mediaKeyTimestamp,
            size: m.size,
            mediaStage: m.mediaData?.mediaStage,
            mediaBlob: m.mediaBlob ? "present" : "missing",
            deprecatedMms3Url: m.deprecatedMms3Url ? "present" : "missing",
          };

          // Try to resolve if not resolved yet
          if (m.mediaData && m.mediaData.mediaStage !== "RESOLVED") {
            try {
              await m.downloadMedia({
                downloadEvenIfExpensive: true,
                rmrReason: 1,
              });
              diag.mediaStageAfterResolve = m.mediaData?.mediaStage;
            } catch (re: any) {
              diag.resolveError = String(re?.message || re);
            }
          }

          // Force download if not resolved
          if (m.mediaData && m.mediaData.mediaStage !== "RESOLVED") {
            try {
              await m.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
            } catch { /* ignore */ }
          }
          diag.mediaStageAfter = m.mediaData?.mediaStage;

          // Method A: download encrypted data directly from CDN and decrypt manually
          // (bypasses InvalidMediaFileType mime validation)
          try {
            const directPath = m.directPath;
            const mediaKey = m.mediaKey;
            if (!directPath || !mediaKey) throw new Error("missing_media_fields");

            // Download encrypted file from CDN
            const cdnUrl = `https://mmg.whatsapp.net${directPath}`;
            const resp = await fetch(cdnUrl);
            if (!resp.ok) throw new Error(`cdn_${resp.status}`);
            const encryptedBuffer = await resp.arrayBuffer();

            // Decrypt using WhatsApp's crypto module
            const cryptoModule = w.require("WAWebMediaCrypto") || w.require("WASmaxDecrypt");
            let decrypted: ArrayBuffer;
            if (cryptoModule?.decryptMedia) {
              decrypted = await cryptoModule.decryptMedia(
                new Uint8Array(encryptedBuffer), mediaKey, m.type
              );
            } else {
              // Fallback: use downloadAndMaybeDecrypt but bypass the type check
              // by setting type to empty
              const DM = w.require("WAWebDownloadManager");
              const mockQpl = {
                addAnnotations() { return this; },
                addPoint() { return this; },
              };
              decrypted = await DM.downloadManager.downloadAndMaybeDecrypt({
                directPath, encFilehash: m.encFilehash,
                filehash: m.filehash, mediaKey,
                mediaKeyTimestamp: m.mediaKeyTimestamp,
                type: "document",  // "document" accepts any mimetype
                signal: new AbortController().signal,
                downloadQpl: mockQpl,
              });
            }

            const b64 = await w.WWebJS.arrayBufferToBase64Async(decrypted);
            return { data: b64, mimetype: m.mimetype, diag };
          } catch (eA: any) {
            diag.methodAError = String(eA?.message || eA);
          }

          // Method B: try downloadAndMaybeDecrypt with type "document" to skip mime check
          try {
            const DM = w.require("WAWebDownloadManager");
            const mockQpl = {
              addAnnotations() { return this; },
              addPoint() { return this; },
            };
            const decrypted = await DM.downloadManager.downloadAndMaybeDecrypt({
              directPath: m.directPath,
              encFilehash: m.encFilehash,
              filehash: m.filehash,
              mediaKey: m.mediaKey,
              mediaKeyTimestamp: m.mediaKeyTimestamp,
              type: "document",
              signal: new AbortController().signal,
              downloadQpl: mockQpl,
            });
            const b64 = await w.WWebJS.arrayBufferToBase64Async(decrypted);
            return { data: b64, mimetype: m.mimetype, diag };
          } catch (eB: any) {
            diag.methodBError = String(eB?.message || eB);
            try {
              diag.methodBFull = JSON.stringify(
                eB, Object.getOwnPropertyNames(eB || {}).slice(0, 10)
              );
            } catch { diag.methodBFull = "serialize_failed"; }
            return { error: "all_methods_failed", diag };
          }
        } catch (e: any) {
          return { error: `general: ${e?.message || e}` };
        }
      }, msgId);

      if (result && "data" in result && result.data) {
        const buf = Buffer.from(result.data, "base64");
        console.log(`[Bot] Audio OK (puppeteer): ${(buf.length / 1024).toFixed(1)} KB`);
        return { buffer: buf, ext: resolveExtFromMime(result.mimetype) };
      } else {
        console.warn(`[Bot] Puppeteer download result:`, result);
      }
    }
  } catch (e: any) {
    console.warn(`[Bot] Audio puppeteer error: ${e.message}`);
  }

  // Strategy 5: raw body from _data (sometimes PTT body is inline base64)
  if (rawData.body && typeof rawData.body === "string" && rawData.body.length > 100) {
    try {
      console.log("[Bot] Audio: trying raw _data.body...");
      const buf = Buffer.from(rawData.body, "base64");
      if (buf.length > 100) {
        console.log(`[Bot] Audio OK (raw body): ${(buf.length / 1024).toFixed(1)} KB`);
        return { buffer: buf, ext: resolveExtFromMime(rawData.mimetype) };
      }
    } catch (e: any) {
      console.warn(`[Bot] Audio raw body error: ${e.message}`);
    }
  }

  console.error("[Bot] All audio download strategies failed");
  return null;
}

// ============================================================
// Help Message (friendly, for group members)
// ============================================================

const HELP_MESSAGE = `👋 *Oi! Eu sou o GroupResume Bot!*

Eu leio as mensagens do grupo e faço um *resumo* pra você não perder nada! 📋

━━━━━━━━━━━━━━━━━━

📋 *Quer um resumo? É fácil:*

• *!resumo* → Resumo de hoje
• *!resumo ontem* → O que rolou ontem
• *!resumo semana* → Resumo da semana
• *!resumo 3dias* → Últimos 3 dias
• *!resumo 15/10* → Data específica

⚡ *Tipos de resumo:*
• *!resumo flash* → Rapidinho, 2 frases
• *!resumo tópicos* → Lista por assunto
• *!resumo completo* → Bem detalhado

💡 *Dica: combine período + tipo!*
_!resumo ontem flash_
_!resumo semana tópicos_

━━━━━━━━━━━━━━━━━━

📊 *Outros comandos:*
• *!status* → Status do sistema
• *!usage* → Uso da API (tokens, limites)

💬 *Quer conversar comigo no privado?*
Me chama direto! Manda uma mensagem pra mim que eu te ajudo a ver resumos e *responder perguntas* sobre o grupo.

⏳ _Pra não lotar o grupo, só 1 resumo a cada alguns minutos, tá?_

_GroupResume By Julio Corcini_`;

// ============================================================
// Bot Presentation Message
// ============================================================

const BOT_PRESENTATION = `👋 *Fala, galera!*

Eu sou o *GroupResume Bot* e fui criado pra facilitar a vida de vocês! 🤖

━━━━━━━━━━━━━━━━━━

*O que eu faço?*

📋 *Resumo as conversas* do grupo pra quem não tem tempo de ler tudo
❓ *Respondo perguntas* sobre o que aconteceu no grupo
⏰ Posso enviar *resumos automáticos* todo dia

━━━━━━━━━━━━━━━━━━

*Como me usar?*

É super fácil! Digita aqui no grupo:
• *!resumo* → Resumo do dia
• *!ajuda* → Todos os comandos

Ou *me manda uma mensagem no privado* que eu te ajudo! 💬
No privado você pode escolher o dia, fazer perguntas sobre o grupo, e mais!

━━━━━━━━━━━━━━━━━━

⚡ _Antes de pedir um resumo, dá uma olhada se já não tem um recente aqui no grupo._

_Desenvolvido por Julio Corcini_`;

// ============================================================
// Bot Initialization
// ============================================================

/**
 * Initialize the bot listener.
 * Listens for commands in groups AND private messages (DM).
 */
export function initBot(): void {
  const client = whatsappClient.getRawClient();

  client.on("message_create", async (msg: any) => {
    const isAudioType = msg.type === "ptt" || msg.type === "audio";

    // Skip messages without body UNLESS it's an audio (handled by DM)
    if (!msg.body && !isAudioType) return;

    const chatId = msg.fromMe ? (msg.to || "") : (msg.from || "");
    const isGroup = chatId.endsWith("@g.us");
    const isDM = !isGroup && (chatId.endsWith("@c.us") || chatId.endsWith("@lid"));

    // Handle DMs (private messages)
    if (isDM && !msg.fromMe) {
      const isAudio = msg.type === "ptt" || msg.type === "audio";
      const isForwarded = msg.isForwarded || msg.forwardingScore > 0;
      const isVoiceCommand = isAudio && !isForwarded && msg.type === "ptt";
      const isMediaAudio = isAudio && (isForwarded || msg.type === "audio");

      console.log(
        `[Bot] DM from ${chatId}: ${isVoiceCommand ? "[voice-cmd]" : isMediaAudio ? "[audio-fwd]" : `"${(msg.body || "").substring(0, 50)}..."`}` +
        (isAudio ? ` (type=${msg.type}, fwd=${isForwarded})` : "")
      );

      try {
        if (isVoiceCommand) {
          // Voice note recorded directly in DM → transcribe and use as text command
          const audioData = await downloadAudioMedia(msg);
          if (audioData) {
            await sendMessage(chatId, "🎤 _Processando seu áudio..._");
            try {
              const result = await transcribeAudio(audioData.buffer, `audio.${audioData.ext}`, "dm");
              if (result.text && result.text.trim().length > 0) {
                console.log(`[Bot] Voice command transcribed: "${result.text.substring(0, 80)}..."`);
                // Use transcription as text command
                await handleDM(chatId, result.text.trim());
              } else {
                await sendMessage(chatId, "🤔 Não consegui entender o áudio. Tente novamente ou digite o comando.");
              }
            } catch (err: any) {
              console.error("[Bot] Voice command transcription error:", err);
              await sendMessage(chatId, `❌ Erro ao processar áudio: ${err.message}`);
            }
          } else {
            await sendMessage(chatId, "❌ Não consegui baixar o áudio. Tente novamente.");
          }
        } else if (isMediaAudio) {
          // Forwarded audio or audio file → treat as media to analyze
          const audioData = await downloadAudioMedia(msg);
          await handleDM(chatId, "", audioData);
        } else {
          await handleDM(chatId, msg.body || "");
        }
      } catch (err: any) {
        console.error("[Bot] DM error:", err);
        await sendMessage(chatId, "❌ Ops, algo deu errado. Tente novamente!").catch(() => {});
      }
      return;
    }

    // Group commands must start with !
    if (!msg.body && !msg.type) return;
    if (!msg.body?.startsWith("!")) return;
    if (!isGroup) return;

    console.log(`[Bot] Command received: "${msg.body}" from ${chatId}`);

    const config = loadConfig();
    if (!config.bot.enabled) {
      console.log("[Bot] Bot is disabled in config, ignoring");
      return;
    }

    if (
      config.bot.allowedGroups.length > 0 &&
      !config.bot.allowedGroups.includes(chatId)
    ) {
      console.log(`[Bot] Group ${chatId} not in allowedGroups`);
      return;
    }

    const command = msg.body.toLowerCase().trim();

    try {
      if (command === "!help" || command === "!ajuda") {
        await sendMessage(chatId, HELP_MESSAGE);
        return;
      }

      if (command === "!bot") {
        await sendMessage(chatId, BOT_PRESENTATION);
        return;
      }

      if (command === "!status") {
        await handleStatusCommand(chatId);
        return;
      }

      if (command === "!usage" || command === "!uso") {
        await handleUsageCommand(chatId);
        return;
      }

      if (command.startsWith("!resumo")) {
        await handleResumoCommand(chatId, command, config);
        return;
      }
    } catch (err: any) {
      console.error("[Bot] Error handling command:", err);
      await sendMessage(
        chatId,
        `❌ Erro ao processar comando: ${err.message || "Erro desconhecido"}`
      ).catch(() => {});
    }
  });

  console.log("[Bot] Command listener initialized (groups + DM)");
}

// ============================================================
// Group Command Handlers
// ============================================================

async function handleStatusCommand(groupId: string): Promise<void> {
  const config = loadConfig();
  const autoStatus = getAutoSummaryStatus();

  let ollamaStatus = "❌ Não disponível";
  try {
    const ollama = new OllamaProvider();
    if (await ollama.isAvailable()) {
      ollamaStatus = `✅ Online (${config.ai.ollama.model})`;
    }
  } catch {
    // Keep default
  }

  const groqStatus = process.env.GROQ_API_KEY
    ? "✅ Configurado"
    : "❌ API key não definida";

  let status = `📊 *Status do GroupResume Bot*\n\n`;
  status += `🤖 *Bot:* ✅ Ativo\n`;
  status += `☁️ *Groq:* ${groqStatus}\n`;
  status += `🖥️ *Ollama:* ${ollamaStatus}\n`;
  status += `⏱️ *Cooldown:* ${config.bot.rateLimitMinutes} min\n`;
  status += `📊 *Nível padrão:* ${config.bot.level}\n\n`;

  if (autoStatus.enabled) {
    status += `📅 *Auto-resumo:* ✅ Ativo\n`;
    if (autoStatus.nextRun) status += `⏰ *Próximo:* ${autoStatus.nextRun}\n`;
    if (autoStatus.lastRun) status += `📝 *Último:* ${autoStatus.lastRun}\n`;
  } else {
    status += `📅 *Auto-resumo:* ❌ Desativado\n`;
  }

  status += `\n💬 _Quer mais? Me manda mensagem no privado!_`;
  status += `\n_GroupResume Companion v1.0.0_`;

  await sendMessage(groupId, status);
}

async function handleUsageCommand(groupId: string): Promise<void> {
  const config = loadConfig();
  const primaryModel = config.ai.groq?.model || "openai/gpt-oss-120b";

  const modelKey = Object.keys(GROQ_FREE_LIMITS).find(
    (k) => k === primaryModel || primaryModel.includes(k.split("/").pop()!)
  ) || "openai/gpt-oss-120b";

  const stats = getUsageStats(modelKey);
  const p = stats.projections;
  const limits = p.primaryModelLimits;

  const tokensPct = limits.tpd > 0
    ? Math.round((p.tokensUsedToday / limits.tpd) * 100)
    : 0;
  const requestsPct = limits.rpd > 0
    ? Math.round((p.requestsUsedToday / limits.rpd) * 100)
    : 0;

  const tokenBar = makeProgressBar(tokensPct);
  const requestBar = makeProgressBar(requestsPct);

  let msg = `📊 *Uso da API — Groq Free Tier*\n\n`;
  msg += `🤖 *Modelo:* ${limits.modelLabel}\n`;
  msg += `━━━━━━━━━━━━━━━━━━\n\n`;

  msg += `🔤 *Tokens hoje:*\n`;
  msg += `${tokenBar} ${tokensPct}%\n`;
  msg += `${p.tokensUsedToday.toLocaleString("pt-BR")} / ${limits.tpd.toLocaleString("pt-BR")}\n`;
  msg += `Restam: *${p.tokensRemainingToday.toLocaleString("pt-BR")}*\n\n`;

  msg += `📨 *Requisições hoje:*\n`;
  msg += `${requestBar} ${requestsPct}%\n`;
  msg += `${p.requestsUsedToday} / ${limits.rpd.toLocaleString("pt-BR")}\n`;
  msg += `Restam: *${p.requestsRemainingToday}*\n\n`;

  msg += `⚡ *Limites por minuto:*\n`;
  msg += `• ${limits.rpm} requisições/min\n`;
  msg += `• ${limits.tpm.toLocaleString("pt-BR")} tokens/min\n\n`;

  msg += `📈 *Projeções:*\n`;
  msg += `• Média por chamada: ~${p.avgTokensPerCall.toLocaleString("pt-BR")} tokens\n`;
  msg += `• Resumos restantes hoje: ~*${p.estimatedRemainingCalls}*\n`;
  msg += p.canFinishDay
    ? `• ✅ Uso dentro do esperado\n`
    : `• ⚠️ Limite quase atingido!\n`;

  // Whisper / Audio section
  const w = stats.whisper;
  if (w.requestsUsedToday > 0 || w.audioSecondsUsedToday > 0) {
    msg += `\n🎤 *Whisper (Áudio):*\n`;
    msg += `• Transcrições hoje: ${w.requestsUsedToday} / ${w.requestsLimitPerDay.toLocaleString("pt-BR")}\n`;
    msg += `• Áudio processado: ${w.audioSecondsUsedToday}s\n`;
    msg += `• Limite: ${w.audioSecondsLimitPerHour.toLocaleString("pt-BR")}s/hora\n`;
  }

  if (stats.today.totalRequests > 0) {
    msg += `\n📋 *Por fonte hoje:*\n`;
    for (const [source, data] of Object.entries(stats.today.bySource)) {
      const icon = source === "bot" ? "🤖" : source === "dashboard" ? "🖥️" : source === "auto" ? "⏰" : source === "dm" ? "💬" : source === "qa" ? "❓" : "📱";
      const audioInfo = data.audioSeconds > 0 ? `, ${data.audioSeconds}s áudio` : "";
      msg += `• ${icon} ${source}: ${data.requests} chamadas, ${data.tokens.toLocaleString("pt-BR")} tokens${audioInfo}\n`;
    }
  }

  msg += `\n_GroupResume Companion v1.0.0_`;

  await sendMessage(groupId, msg);
}

function makeProgressBar(pct: number): string {
  const filled = Math.round(pct / 10);
  const empty = 10 - filled;
  return "▓".repeat(filled) + "░".repeat(empty);
}

async function handleResumoCommand(
  groupId: string,
  command: string,
  config: ReturnType<typeof loadConfig>
): Promise<void> {
  const now = Date.now();
  const lastTrigger = lastTriggerMap.get(groupId) ?? 0;
  const cooldownMs = config.bot.rateLimitMinutes * 60 * 1000;

  if (now - lastTrigger < cooldownMs) {
    const remainingMin = Math.ceil(
      (cooldownMs - (now - lastTrigger)) / 60000
    );
    await sendMessage(
      groupId,
      `⏳ Aguarde ${remainingMin} minuto(s) para solicitar outro resumo.\n\n💡 _Dica: veja se já tem um resumo recente aqui no grupo!_`
    );
    return;
  }

  const args = command.replace("!resumo", "").trim();
  const { dateFrom, dateTo, label } = parseDateArgument(args);
  const level = parseLevelArgument(args, config.bot.level);
  const levelNames: Record<number, string> = {
    1: "Flash ⚡",
    2: "Resumido 📝",
    3: "Padrão 📋",
    4: "Completo 📖",
    5: "Tópicos 📌",
  };

  await sendMessage(
    groupId,
    `✅ *Entendido!* Preparando resumo ${label}...\n📊 ${levelNames[level] || "Padrão"}\n⏳ _Aguarde um momento..._`
  );
  lastTriggerMap.set(groupId, now);

  const messages = await getGroupMessages(groupId, { dateFrom, dateTo });

  if (messages.length === 0) {
    await sendMessage(
      groupId,
      `📋 Nenhuma mensagem encontrada ${label}.`
    );
    return;
  }

  const participants = new Set(messages.map((m) => m.senderName));

  const messagesHash = generateMessagesHash(messages);
  const cached = getCachedSummary(
    groupId,
    dateFrom,
    dateTo,
    level,
    config.bot.privacy,
    messagesHash
  );

  if (cached) {
    const cachedTime = new Date(cached.cachedAt).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });

    let response = `📋 *Resumo ${label}*\n`;
    response += `📅 ${dateFrom === dateTo ? formatDateBR(dateFrom) : `${formatDateBR(dateFrom)} a ${formatDateBR(dateTo)}`}\n`;
    response += `💬 ${cached.messageCount} msgs · 👥 ${cached.participants} participantes\n`;
    response += `━━━━━━━━━━━━━━━━━━\n\n`;

    let summaryText = cached.summary
      .replace(/^#{1,3} (.+)$/gm, "*$1*")
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/^- (.+)$/gm, "• $1")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    response += summaryText;
    response += `\n\n━━━━━━━━━━━━━━━━━━`;
    response += `\n📦 _Da memória · Processado às ${cachedTime} · Sem novas mensagens_`;
    response += `\n_Gerado por GroupResume By Julio Corcini_`;

    await sendMessage(groupId, response);
    console.log(`[Bot] Sent cached summary for ${groupId}`);
    return;
  }

  const incrementalMatch = getIncrementalMatch(
    groupId,
    dateFrom,
    dateTo,
    level,
    config.bot.privacy,
    messages
  );

  const provider = createProvider(config);
  provider.setTrackingMeta?.({ source: "bot", groupId });
  let result;

  const groupRules = config.groupRules ?? {};
  const groupCustomRule = groupRules[groupId];

  if (incrementalMatch) {
    const { cachedSummary, newMessageStartIndex } = incrementalMatch;
    const newMessages = messages.slice(newMessageStartIndex);
    console.log(
      `[Bot] Incremental: ${newMessages.length} new msgs (${cachedSummary.messageCount} cached)`
    );

    result = await generateIncrementalSummary(
      cachedSummary.summary,
      newMessages,
      provider,
      {
        level: level as SummaryLevel,
        privacy: config.bot.privacy,
        maxMessagesPerChunk: provider.getModelConfig().maxMessages,
        mode: "full",
        groupCustomRule,
      }
    );
  } else {
    result = await generateSummary(messages, provider, {
      level: level as SummaryLevel,
      privacy: config.bot.privacy,
      maxMessagesPerChunk: provider.getModelConfig().maxMessages,
      mode: messages.length > 500 ? "quick" : "full",
      groupCustomRule,
    });
  }

  let response = `📋 *Resumo ${label}*\n`;
  response += `📅 ${dateFrom === dateTo ? formatDateBR(dateFrom) : `${formatDateBR(dateFrom)} a ${formatDateBR(dateTo)}`}\n`;
  response += `💬 ${messages.length} msgs · 👥 ${participants.size} participantes\n`;
  response += `━━━━━━━━━━━━━━━━━━\n\n`;

  let summaryText = result.summary
    .replace(/^#{1,3} (.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^- (.+)$/gm, "• $1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  response += summaryText;

  response += `\n\n━━━━━━━━━━━━━━━━━━`;
  if (incrementalMatch) {
    response += `\n🔄 _Incremental · ${incrementalMatch.cachedSummary.messageCount} msgs do cache + ${messages.length - incrementalMatch.newMessageStartIndex} novas_`;
  }
  response += `\n⚡ ${(result.processingTime / 1000).toFixed(1)}s · ${result.chunks} parte(s) · ${result.provider}`;
  response += `\n_Gerado por GroupResume By Julio Corcini_`;

  await sendMessage(groupId, response);

  saveCachedSummary({
    groupId,
    dateFrom,
    dateTo,
    level,
    privacy: config.bot.privacy,
    messagesHash,
    messageCount: messages.length,
    summary: result.summary,
    provider: result.provider,
    processingTime: result.processingTime,
    chunks: result.chunks,
    participants: participants.size,
  });

  try {
    const groups = await import("./messages.js").then((m) => m.getGroups());
    const groupInfo = groups.find((g: any) => g.id === groupId);
    saveToHistory({
      groupName: groupInfo?.name || groupId,
      groupId,
      dateFrom,
      dateTo,
      level: level as SummaryLevel,
      privacy: config.bot.privacy,
      provider: result.provider,
      summary: result.summary,
      totalMessages: messages.length,
      participants: participants.size,
      processingTime: result.processingTime,
      chunks: result.chunks,
      source: "bot",
    });
  } catch (err) {
    console.error("[History] Failed to save bot entry:", err);
  }
}

// ============================================================
// Argument Parsers
// ============================================================

function parseLevelArgument(args: string, defaultLevel: number): number {
  const lower = args.toLowerCase();
  if (lower.includes("flash")) return 1;
  if (lower.includes("resumido")) return 2;
  if (lower.includes("padrao") || lower.includes("padrão")) return 3;
  if (lower.includes("completo")) return 4;
  if (lower.includes("topicos") || lower.includes("tópicos")) return 5;
  return defaultLevel;
}

function parseDateArgument(args: string): {
  dateFrom: string;
  dateTo: string;
  label: string;
} {
  const today = new Date();

  const dateArgs = args
    .replace(/(flash|resumido|padr[aã]o|completo|t[oó]picos)/gi, "")
    .trim();

  if (!dateArgs || dateArgs === "hoje") {
    const date = formatDate(today);
    return { dateFrom: date, dateTo: date, label: "de hoje" };
  }

  if (dateArgs === "ontem") {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const date = formatDate(yesterday);
    return { dateFrom: date, dateTo: date, label: "de ontem" };
  }

  if (dateArgs === "semana") {
    const from = new Date(today);
    from.setDate(from.getDate() - 6);
    return {
      dateFrom: formatDate(from),
      dateTo: formatDate(today),
      label: "da semana",
    };
  }

  const daysMatch = dateArgs.match(/^(\d+)\s*dias?$/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1]);
    const from = new Date(today);
    from.setDate(from.getDate() - days + 1);
    return {
      dateFrom: formatDate(from),
      dateTo: formatDate(today),
      label: `dos últimos ${days} dias`,
    };
  }

  const dateMatch = dateArgs.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (dateMatch) {
    const day = dateMatch[1].padStart(2, "0");
    const month = dateMatch[2].padStart(2, "0");
    const year = dateMatch[3] ?? today.getFullYear().toString();
    const date = `${year}-${month}-${day}`;
    return {
      dateFrom: date,
      dateTo: date,
      label: `de ${day}/${month}/${year}`,
    };
  }

  const date = formatDate(today);
  return { dateFrom: date, dateTo: date, label: "de hoje" };
}

// ============================================================
// Utilities
// ============================================================

function createProvider(config: ReturnType<typeof loadConfig>): AIProvider {
  if (config.ai.defaultProvider === "ollama") {
    return new OllamaProvider(config.ai.ollama.model, config.ai.ollama.baseUrl);
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    throw new Error("GROQ_API_KEY não configurada");
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
