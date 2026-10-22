import { sendMessage } from "./sender.js";
import { getGroupMessages, getGroups } from "./messages.js";
import { generateSummary, sanitizeDisplayName } from "../ai/summarizer.js";
import { transcribeAudio } from "../ai/transcriber.js";
import { GroqProvider } from "../ai/groq.js";
import { OllamaProvider } from "../ai/ollama.js";
import { loadConfig } from "../config/manager.js";
import type { AIProvider } from "../ai/provider.js";
import type { WhatsAppGroup, SummaryLevel, WhatsAppMessage } from "../types/index.js";

// ============================================================
// DM Session State
// ============================================================

type DMState =
  | "idle"
  | "selecting_group"
  | "selecting_action"
  | "selecting_date"
  | "qa_selecting_date"
  | "qa_active"
  | "audio_qa";

interface AudioEntry {
  transcription: string;
  duration?: number;
  index: number;
}

interface DMSession {
  userId: string;
  state: DMState;
  groups: WhatsAppGroup[];
  selectedGroup?: WhatsAppGroup;
  selectedDate?: string;
  messagesContext?: WhatsAppMessage[];
  audioTranscription?: string;
  audioEntries: AudioEntry[];
  pendingAudioBuffers: Array<{ buffer: Buffer; ext: string }>;
  pendingAudioData?: { buffer: Buffer; ext: string };
  lastActivity: number;
}

const sessions = new Map<string, DMSession>();
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

// ============================================================
// Session Management
// ============================================================

function getSession(userId: string): DMSession | null {
  const session = sessions.get(userId);
  if (!session) return null;

  if (Date.now() - session.lastActivity > SESSION_TIMEOUT_MS) {
    sessions.delete(userId);
    return null;
  }

  session.lastActivity = Date.now();
  return session;
}

function createSession(userId: string, groups: WhatsAppGroup[]): DMSession {
  const session: DMSession = {
    userId,
    state: "idle",
    groups,
    audioEntries: [],
    pendingAudioBuffers: [],
    lastActivity: Date.now(),
  };
  sessions.set(userId, session);
  return session;
}

function clearSession(userId: string): void {
  sessions.delete(userId);
}

// ============================================================
// Main DM Handler
// ============================================================

export async function handleDM(
  userId: string,
  message: string,
  audioData?: { buffer: Buffer; ext: string } | null
): Promise<void> {
  const text = message.trim();

  // Handle audio messages
  if (audioData !== undefined) {
    await handleAudioMessage(userId, audioData);
    return;
  }

  if (text === "0" || text.toLowerCase() === "sair" || text.toLowerCase() === "cancelar" || text.toLowerCase() === "menu") {
    clearSession(userId);
    await sendMessage(userId, "👋 Sessão encerrada! Me manda mensagem quando precisar de novo.");
    return;
  }

  // "voltar" resets to main menu too (unless in Q&A mode where it means "back to options")
  const session0 = getSession(userId);
  if (text.toLowerCase() === "voltar" && session0 && !["qa_active", "audio_qa"].includes(session0.state)) {
    clearSession(userId);
    await startNewSession(userId);
    return;
  }

  let session = getSession(userId);

  if (!session) {
    await startNewSession(userId);
    return;
  }

  try {
    switch (session.state) {
      case "selecting_group":
        await handleGroupSelection(session, text);
        break;
      case "selecting_action":
        await handleActionSelection(session, text);
        break;
      case "selecting_date":
        await handleDateSelection(session, text);
        break;
      case "qa_selecting_date":
        await handleQADateSelection(session, text);
        break;
      case "qa_active":
        await handleQAQuestion(session, text);
        break;
      case "audio_qa":
        await handleAudioQA(session, text);
        break;
      default:
        await startNewSession(userId);
    }
  } catch (err: any) {
    console.error("[DM] Error:", err);
    await sendMessage(userId, `❌ Ops, algo deu errado: ${err.message}\n\nDigite *0* pra recomeçar.`);
    clearSession(userId);
  }
}

// ============================================================
// Flow Steps
// ============================================================

async function startNewSession(userId: string): Promise<void> {
  const allGroups = await getGroups();
  const userGroups = allGroups.filter(
    (g) => g.chatType === "group" || g.chatType === "community-group"
  );

  if (userGroups.length === 0) {
    await sendMessage(
      userId,
      "😕 Não encontrei nenhum grupo em comum com você.\n\nPra eu funcionar, você precisa estar em um grupo onde eu também estou."
    );
    return;
  }

  const session = createSession(userId, userGroups);

  if (userGroups.length === 1) {
    session.selectedGroup = userGroups[0];
    session.state = "selecting_action";
    await sendMessage(
      userId,
      `👋 *Oi! Eu sou o GroupResume Bot!*\n\n` +
      `Encontrei que estamos juntos no grupo:\n` +
      `📱 *${userGroups[0].name}*\n\n` +
      `O que você quer fazer?\n\n` +
      `*1* 📋 Resumo do grupo\n` +
      `*2* ❓ Perguntar algo sobre o grupo\n\n` +
      `_Digite o número da opção ou *0* pra sair_`
    );
    return;
  }

  session.state = "selecting_group";
  let groupList = `👋 *Oi! Eu sou o GroupResume Bot!*\n\n`;
  groupList += `Encontrei que estamos juntos em ${userGroups.length} grupos:\n\n`;

  userGroups.forEach((g, i) => {
    groupList += `*${i + 1}* 📱 ${g.name}\n`;
  });

  groupList += `\nDigite o *número* do grupo que quer consultar\n`;
  groupList += `_ou *0* pra sair_`;

  await sendMessage(userId, groupList);
}

async function handleGroupSelection(session: DMSession, text: string): Promise<void> {
  const num = parseInt(text);
  if (isNaN(num) || num < 1 || num > session.groups.length) {
    await sendMessage(
      session.userId,
      `⚠️ Digite um número de *1* a *${session.groups.length}* pra escolher o grupo.\n_ou *0* pra sair_`
    );
    return;
  }

  session.selectedGroup = session.groups[num - 1];
  session.state = "selecting_action";

  await sendMessage(
    session.userId,
    `✅ Grupo: *${session.selectedGroup.name}*\n\n` +
    `O que você quer fazer?\n\n` +
    `*1* 📋 Resumo do grupo\n` +
    `*2* ❓ Perguntar algo sobre o grupo\n` +
    `*3* 🔄 Trocar de grupo\n\n` +
    `_Digite o número ou *0* pra sair_`
  );
}

async function handleActionSelection(session: DMSession, text: string): Promise<void> {
  const num = parseInt(text);

  if (num === 3) {
    session.state = "selecting_group";
    session.selectedGroup = undefined;
    let groupList = `📱 Escolha outro grupo:\n\n`;
    session.groups.forEach((g, i) => {
      groupList += `*${i + 1}* ${g.name}\n`;
    });
    groupList += `\n_Digite o número ou *0* pra sair_`;
    await sendMessage(session.userId, groupList);
    return;
  }

  if (num === 1) {
    session.state = "selecting_date";
    await sendMessage(
      session.userId,
      `📅 *Resumo de qual período?*\n\n` +
      `*1* 📋 Hoje\n` +
      `*2* 📋 Ontem\n` +
      `*3* 📋 Últimos 3 dias\n` +
      `*4* 📋 Última semana\n` +
      `*5* 📅 Data específica (DD/MM)\n\n` +
      `_Digite o número ou *0* pra sair_`
    );
    return;
  }

  if (num === 2) {
    session.state = "qa_selecting_date";
    await sendMessage(
      session.userId,
      `❓ *Perguntar sobre qual dia?*\n\n` +
      `Primeiro escolha o dia, depois você pode perguntar o que quiser sobre o que foi conversado!\n\n` +
      `*1* 📅 Hoje\n` +
      `*2* 📅 Ontem\n` +
      `*3* 📅 Data específica (DD/MM)\n\n` +
      `_Digite o número ou *0* pra sair_`
    );
    return;
  }

  await sendMessage(
    session.userId,
    `⚠️ Opção inválida. Digite *1*, *2* ou *3*.\n_ou *0* pra sair_`
  );
}

async function handleDateSelection(session: DMSession, text: string): Promise<void> {
  const num = parseInt(text);

  if (num === 5) {
    await sendMessage(
      session.userId,
      `📅 Digite a data no formato *DD/MM* (ex: 15/10)\n_ou *0* pra sair_`
    );
    return;
  }

  const { dateFrom, dateTo, label } = parseDateInput(text);

  if (!dateFrom) {
    await sendMessage(
      session.userId,
      `⚠️ Não entendi. Digite um número de *1* a *4*, *5* pra data específica, ou a data no formato *DD/MM*.\n_ou *0* pra sair_`
    );
    return;
  }

  await sendMessage(
    session.userId,
    `⏳ Preparando resumo ${label} do grupo *${session.selectedGroup!.name}*...\n_Isso pode levar alguns segundos._`
  );

  const messages = await getGroupMessages(session.selectedGroup!.id, { dateFrom, dateTo });

  if (messages.length === 0) {
    await sendMessage(session.userId, `📋 Nenhuma mensagem encontrada ${label}.`);
    session.state = "selecting_action";
    await sendMessage(
      session.userId,
      `\nO que mais posso fazer?\n*1* 📋 Outro resumo\n*2* ❓ Fazer uma pergunta\n*3* 🔄 Trocar de grupo\n_ou *0* pra sair_`
    );
    return;
  }

  const config = loadConfig();
  const provider = createProvider(config);
  provider.setTrackingMeta?.({ source: "dm", groupId: session.selectedGroup!.id });
  const groupRules = config.groupRules ?? {};
  const groupCustomRule = groupRules[session.selectedGroup!.id];

  const result = await generateSummary(messages, provider, {
    level: 5 as SummaryLevel,
    privacy: "smart",
    maxMessagesPerChunk: provider.getModelConfig().maxMessages,
    mode: messages.length > 500 ? "quick" : "full",
    groupCustomRule,
  });

  const participants = new Set(messages.map((m) => m.senderName));

  let response = `📋 *Resumo ${label}*\n`;
  response += `📱 *${session.selectedGroup!.name}*\n`;
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
  response += `\n⚡ ${(result.processingTime / 1000).toFixed(1)}s · ${result.provider}`;

  await sendMessage(session.userId, response);

  session.state = "selecting_action";
  await sendMessage(
    session.userId,
    `\n✅ Pronto! O que mais posso fazer?\n\n*1* 📋 Outro resumo\n*2* ❓ Fazer uma pergunta\n*3* 🔄 Trocar de grupo\n_ou *0* pra sair_`
  );
}

async function handleQADateSelection(session: DMSession, text: string): Promise<void> {
  const num = parseInt(text);

  if (num === 3) {
    await sendMessage(
      session.userId,
      `📅 Digite a data no formato *DD/MM* (ex: 15/10)\n_ou *0* pra sair_`
    );
    return;
  }

  const { dateFrom, dateTo, label } = parseQADateInput(text);

  if (!dateFrom) {
    await sendMessage(
      session.userId,
      `⚠️ Não entendi. Digite *1*, *2*, *3* pra data específica, ou a data no formato *DD/MM*.\n_ou *0* pra sair_`
    );
    return;
  }

  await sendMessage(session.userId, `⏳ Carregando mensagens ${label}...`);

  const messages = await getGroupMessages(session.selectedGroup!.id, { dateFrom, dateTo });

  if (messages.length === 0) {
    await sendMessage(session.userId, `📋 Nenhuma mensagem encontrada ${label}.`);
    session.state = "selecting_action";
    await sendMessage(
      session.userId,
      `\nO que mais posso fazer?\n*1* 📋 Resumo\n*2* ❓ Outra pergunta\n*3* 🔄 Trocar grupo\n_ou *0* pra sair_`
    );
    return;
  }

  session.messagesContext = messages;
  session.selectedDate = label;
  session.state = "qa_active";

  const participants = new Set(messages.map((m) => m.senderName));

  await sendMessage(
    session.userId,
    `✅ Pronto! Carreguei *${messages.length} mensagens* ${label} do grupo *${session.selectedGroup!.name}*\n` +
    `👥 ${participants.size} participantes\n\n` +
    `🔍 *Agora pode perguntar o que quiser!*\n\n` +
    `Exemplos:\n` +
    `• _"Alguém falou sobre a assembleia?"_\n` +
    `• _"O que decidiram sobre o condomínio?"_\n` +
    `• _"Teve alguma reclamação?"_\n` +
    `• _"Quais foram os assuntos principais?"_\n\n` +
    `💡 _Digite sua pergunta, ou *voltar* pra voltar ao menu_`
  );
}

async function handleQAQuestion(session: DMSession, text: string): Promise<void> {
  if (text.toLowerCase() === "voltar" || text.toLowerCase() === "menu") {
    session.state = "selecting_action";
    session.messagesContext = undefined;
    await sendMessage(
      session.userId,
      `📱 *${session.selectedGroup!.name}*\n\nO que mais posso fazer?\n\n*1* 📋 Resumo\n*2* ❓ Outra pergunta (outro dia)\n*3* 🔄 Trocar grupo\n_ou *0* pra sair_`
    );
    return;
  }

  if (!session.messagesContext || session.messagesContext.length === 0) {
    await sendMessage(session.userId, "⚠️ Sem mensagens carregadas. Digite *voltar* pra escolher outro dia.");
    return;
  }

  await sendMessage(session.userId, "🔍 _Analisando as mensagens..._");

  const config = loadConfig();
  const provider = createProvider(config);
  provider.setTrackingMeta?.({ source: "qa", groupId: session.selectedGroup!.id });

  const formattedMessages = formatMessagesForQA(session.messagesContext);

  const systemPrompt =
    `Você é um assistente que responde perguntas sobre conversas de um grupo de WhatsApp.\n` +
    `Abaixo estão as mensagens do grupo "${session.selectedGroup!.name}" ${session.selectedDate}.\n` +
    `Responda a pergunta do usuário com base APENAS nas mensagens fornecidas.\n` +
    `Se a informação não está nas mensagens, diga que não encontrou.\n` +
    `Seja claro, direto e cite nomes quando relevante.\n` +
    `Responda em português brasileiro.\n` +
    `Use formatação WhatsApp: *negrito*, _itálico_, • para listas.`;

  const userMessage = `MENSAGENS DO GRUPO:\n\n${formattedMessages}\n\n---\n\nPERGUNTA: ${text}`;

  const { response } = await provider.chat(systemPrompt, userMessage, 1500);

  let answer = `🔍 *Resposta:*\n\n${response}`;
  answer += `\n\n━━━━━━━━━━━━━━━━━━`;
  answer += `\n💡 _Pode fazer outra pergunta, ou digite *voltar* pro menu_`;

  await sendMessage(session.userId, answer);
}

// ============================================================
// Audio Handling
// ============================================================

async function handleAudioMessage(
  userId: string,
  audioData: { buffer: Buffer; ext: string } | null
): Promise<void> {
  if (!audioData || !audioData.buffer || audioData.buffer.length === 0) {
    await sendMessage(userId, "❌ Não consegui baixar o áudio. Tente enviar de outra forma.");
    return;
  }

  const sizeKB = (audioData.buffer.length / 1024).toFixed(1);
  console.log(`[DM] Audio received: ${sizeKB} KB, format: ${audioData.ext}`);

  let session = getSession(userId);
  if (!session) {
    session = createSession(userId, []);
  }

  // Always accumulate audio buffers
  session.pendingAudioBuffers.push(audioData);
  session.state = "audio_qa";
  session.lastActivity = Date.now();

  const total = session.pendingAudioBuffers.length + session.audioEntries.length;
  const pending = session.pendingAudioBuffers.length;
  const alreadyTranscribed = session.audioEntries.length;

  if (pending === 1 && alreadyTranscribed === 0) {
    // First audio ever — show full menu
    await sendMessage(
      userId,
      `🎤 *Áudio recebido!* (${sizeKB} KB)\n\n` +
      `*1* 📝 Transcrever\n` +
      `*0* ❌ Cancelar\n\n` +
      `💡 _Pode enviar mais áudios antes de transcrever — eles serão acumulados automaticamente!_`
    );
  } else {
    // Additional audio — short confirmation, no questions
    await sendMessage(
      userId,
      `✅ +1 áudio (${sizeKB} KB) — *${pending} pendente${pending > 1 ? "s" : ""}*` +
      (alreadyTranscribed > 0 ? ` + ${alreadyTranscribed} já transcrito${alreadyTranscribed > 1 ? "s" : ""}` : "") +
      `\n\n_Envie mais ou digite *1* pra transcrever todos_`
    );
  }
}

async function handleAudioQA(session: DMSession, text: string): Promise<void> {
  const num = parseInt(text);

  // "voltar" in audio context → go back to main menu
  if (text.toLowerCase() === "voltar") {
    session.audioEntries = [];
    session.pendingAudioBuffers = [];
    session.audioTranscription = undefined;
    session.state = "idle";
    clearSession(session.userId);
    await startNewSession(session.userId);
    return;
  }

  // Cancel pending (before any transcription)
  if (num === 2 && session.pendingAudioBuffers.length > 0 && session.audioEntries.length === 0) {
    session.pendingAudioBuffers = [];
    session.state = "idle";
    await sendMessage(session.userId, "✅ Cancelado! Me manda mensagem quando precisar.");
    clearSession(session.userId);
    return;
  }

  // Transcribe ALL pending buffers
  if (num === 1 && session.pendingAudioBuffers.length > 0) {
    const buffers = [...session.pendingAudioBuffers];
    session.pendingAudioBuffers = [];
    const total = buffers.length;

    await sendMessage(session.userId, `🎤 _Transcrevendo ${total} áudio${total > 1 ? "s" : ""}..._`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < buffers.length; i++) {
      const { buffer, ext } = buffers[i];
      try {
        if (total > 1) {
          await sendMessage(session.userId, `🔄 _Áudio ${i + 1}/${total}..._`);
        }

        const result = await transcribeAudio(buffer, `audio.${ext}`, "dm");

        if (!result.text || result.text.trim().length === 0) {
          failCount++;
          continue;
        }

        session.audioEntries.push({
          transcription: result.text,
          duration: result.duration,
          index: session.audioEntries.length + 1,
        });
        successCount++;
      } catch (err: any) {
        console.error(`[DM] Transcription error (audio ${i + 1}):`, err);
        failCount++;
      }
    }

    if (successCount === 0) {
      await sendMessage(session.userId, "🤔 Não consegui transcrever nenhum áudio. Pode ser que estejam muito baixos ou sem voz.");
      return;
    }

    // Update combined transcription
    session.audioTranscription = session.audioEntries
      .map((e) => e.transcription)
      .join("\n\n");

    const totalDuration = session.audioEntries.reduce((s, e) => s + (e.duration ?? 0), 0);
    const count = session.audioEntries.length;
    const plural = count > 1;

    let response = `📝 *${successCount} áudio${successCount > 1 ? "s" : ""} transcrito${successCount > 1 ? "s" : ""}!*`;
    if (failCount > 0) response += ` (${failCount} falhou)`;
    response += `\n\n`;

    // Show transcriptions (abbreviated if multiple)
    for (const entry of session.audioEntries.slice(-3)) {
      const preview = entry.transcription.length > 150
        ? entry.transcription.substring(0, 150) + "..."
        : entry.transcription;
      response += `🎤 *Áudio ${entry.index}*${entry.duration ? ` (${entry.duration}s)` : ""}:\n`;
      response += `_"${preview}"_\n\n`;
    }
    if (count > 3) {
      response += `_(+ ${count - 3} áudio${count - 3 > 1 ? "s" : ""} anterior${count - 3 > 1 ? "es" : ""})_\n\n`;
    }

    response += `📊 Total: ${count} áudio${plural ? "s" : ""}, ${totalDuration}s\n`;
    response += `━━━━━━━━━━━━━━━━━━\n\n`;
    response += `*1* 📋 Resumir ${plural ? "todos os áudios" : "o áudio"}\n`;
    response += `*2* ❓ Fazer perguntas\n`;
    response += `*3* 📝 Ver todas as transcrições\n`;
    response += `*0* Sair · *voltar* Menu\n\n`;
    response += `🎤 _Pode enviar mais áudios para acumular_`;

    await sendMessage(session.userId, response);
    return;
  }

  // ---- Post-transcription actions ----
  const hasAudio = session.audioEntries.length > 0;
  if (!hasAudio) {
    await sendMessage(session.userId, "⚠️ Envie um áudio pra começar, ou *0* pra sair.");
    return;
  }

  const allTranscriptions = session.audioEntries
    .map((e, i) => session.audioEntries.length > 1
      ? `[Áudio ${i + 1}${e.duration ? ` - ${e.duration}s` : ""}]\n${e.transcription}`
      : e.transcription)
    .join("\n\n---\n\n");
  const count = session.audioEntries.length;
  const plural = count > 1;

  // Option 3: show all transcriptions / exit
  if (num === 3) {
    if (plural) {
      let msg = `📝 *Todas as transcrições (${count} áudios):*\n\n`;
      for (const entry of session.audioEntries) {
        msg += `🎤 *Áudio ${entry.index}*${entry.duration ? ` (${entry.duration}s)` : ""}:\n`;
        msg += `_"${entry.transcription}"_\n\n`;
      }
      msg += `━━━━━━━━━━━━━━━━━━\n`;
      msg += `*1* 📋 Resumir · *2* ❓ Perguntar · *0* Sair\n`;
      msg += `🎤 _ou envie mais áudios_`;
      await sendMessage(session.userId, msg);
    } else {
      session.audioEntries = [];
      session.audioTranscription = undefined;
      session.state = "idle";
      await sendMessage(session.userId, "✅ Ok! Me manda outra mensagem quando precisar.");
      clearSession(session.userId);
    }
    return;
  }

  // Exit
  if (text.toLowerCase() === "voltar" || text.toLowerCase() === "menu") {
    session.audioEntries = [];
    session.audioTranscription = undefined;
    session.state = "idle";
    await sendMessage(session.userId, "✅ Ok! Me manda outra mensagem quando precisar.");
    clearSession(session.userId);
    return;
  }

  // Option 1: summarize all audios
  if (num === 1) {
    await sendMessage(session.userId, `⏳ _Gerando resumo de ${count} áudio${plural ? "s" : ""}..._`);

    const config = loadConfig();
    const provider = createProvider(config);
    provider.setTrackingMeta?.({ source: "dm" });

    const prompt = plural
      ? `Você é um assistente que resume transcrições de múltiplos áudios. Faça um resumo claro, organizado e conciso em português brasileiro. Integre as informações de todos os áudios em um texto coeso. Use formatação WhatsApp: *negrito*, _itálico_, • para listas.`
      : `Você é um assistente que resume transcrições de áudio. Faça um resumo claro e conciso em português brasileiro. Use formatação WhatsApp: *negrito*, _itálico_, • para listas.`;

    const { response } = await provider.chat(
      prompt,
      `Resuma ${plural ? "estas transcrições de áudio" : "esta transcrição de áudio"}:\n\n${allTranscriptions}`,
      1500
    );

    let msg = `📋 *Resumo${plural ? ` de ${count} áudios` : ""}:*\n\n${response}`;
    msg += `\n\n━━━━━━━━━━━━━━━━━━`;
    msg += `\n💡 _Faça perguntas, envie mais áudios, ou *0* pra sair_`;

    await sendMessage(session.userId, msg);
    return;
  }

  // Option 2: activate Q&A mode
  if (num === 2) {
    await sendMessage(
      session.userId,
      `🔍 *Modo perguntas${plural ? ` (${count} áudios)` : ""} ativado!*\n\nDigite sua pergunta sobre o conteúdo ${plural ? "dos áudios" : "do áudio"}.\n\n_ou *voltar* pra voltar ao menu_`
    );
    return;
  }

  // Free-form question about the audio(s)
  await sendMessage(session.userId, "🔍 _Analisando..._");

  const config = loadConfig();
  const provider = createProvider(config);
  provider.setTrackingMeta?.({ source: "qa" });

  const sysPrompt = plural
    ? `Você é um assistente que responde perguntas sobre transcrições de ${count} áudios. Responda com base APENAS no conteúdo dos áudios. Se a informação não está nas transcrições, diga que não encontrou. Responda em português brasileiro.`
    : `Você é um assistente que responde perguntas sobre transcrições de áudio. Responda com base APENAS no conteúdo do áudio. Se a informação não está na transcrição, diga que não encontrou. Responda em português brasileiro.`;

  const { response } = await provider.chat(
    sysPrompt,
    `TRANSCRIÇÕES:\n${allTranscriptions}\n\n---\n\nPERGUNTA: ${text}`,
    1000
  );

  let msg = `🔍 *Resposta:*\n\n${response}`;
  msg += `\n\n━━━━━━━━━━━━━━━━━━`;
  msg += `\n💡 _Faça outra pergunta, envie mais áudios, ou *0* pra sair_`;

  await sendMessage(session.userId, msg);
}

// ============================================================
// Helpers
// ============================================================

function formatMessagesForQA(messages: WhatsAppMessage[]): string {
  return messages
    .map((m) => {
      const name = sanitizeDisplayName(m.senderName);
      const content = m.isMedia ? "[mídia]" : m.content;
      return `[${m.date} ${m.time}] ${name}: ${content}`;
    })
    .join("\n");
}

function parseDateInput(text: string): { dateFrom: string | undefined; dateTo: string | undefined; label: string } {
  const today = new Date();
  const num = parseInt(text);

  if (num === 1 || text.toLowerCase() === "hoje") {
    const d = fmtDate(today);
    return { dateFrom: d, dateTo: d, label: "de hoje" };
  }

  if (num === 2 || text.toLowerCase() === "ontem") {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const d = fmtDate(yesterday);
    return { dateFrom: d, dateTo: d, label: "de ontem" };
  }

  if (num === 3) {
    const from = new Date(today);
    from.setDate(from.getDate() - 2);
    return { dateFrom: fmtDate(from), dateTo: fmtDate(today), label: "dos últimos 3 dias" };
  }

  if (num === 4) {
    const from = new Date(today);
    from.setDate(from.getDate() - 6);
    return { dateFrom: fmtDate(from), dateTo: fmtDate(today), label: "da última semana" };
  }

  const dateMatch = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (num === 5) {
    return { dateFrom: undefined, dateTo: undefined, label: "" };
  }
  if (dateMatch) {
    const day = dateMatch[1].padStart(2, "0");
    const month = dateMatch[2].padStart(2, "0");
    const year = dateMatch[3] ?? today.getFullYear().toString();
    const d = `${year}-${month}-${day}`;
    return { dateFrom: d, dateTo: d, label: `de ${day}/${month}` };
  }

  return { dateFrom: undefined, dateTo: undefined, label: "" };
}

function parseQADateInput(text: string): { dateFrom: string | undefined; dateTo: string | undefined; label: string } {
  const today = new Date();
  const num = parseInt(text);

  if (num === 1 || text.toLowerCase() === "hoje") {
    const d = fmtDate(today);
    return { dateFrom: d, dateTo: d, label: "de hoje" };
  }

  if (num === 2 || text.toLowerCase() === "ontem") {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const d = fmtDate(yesterday);
    return { dateFrom: d, dateTo: d, label: "de ontem" };
  }

  const dateMatch = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (dateMatch) {
    const day = dateMatch[1].padStart(2, "0");
    const month = dateMatch[2].padStart(2, "0");
    const year = dateMatch[3] ?? today.getFullYear().toString();
    const d = `${year}-${month}-${day}`;
    return { dateFrom: d, dateTo: d, label: `de ${day}/${month}` };
  }

  return { dateFrom: undefined, dateTo: undefined, label: "" };
}

function createProvider(config: ReturnType<typeof loadConfig>): AIProvider {
  if (config.ai.defaultProvider === "ollama") {
    return new OllamaProvider(config.ai.ollama.model, config.ai.ollama.baseUrl);
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) throw new Error("GROQ_API_KEY not configured");
  return new GroqProvider(groqKey, "powerful");
}

function fmtDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
