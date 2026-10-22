/**
 * WhatsApp chat export file parser.
 * Ported from groupResume — handles the BR date format (DD/MM/YYYY HH:MM).
 */
import type { WhatsAppMessage, DateInfo } from "../types/index.js";

/**
 * Regex: DD/MM/YYYY HH:MM - Sender: Message
 */
const MESSAGE_REGEX =
  /^(\d{2}\/\d{2}\/\d{4}) (\d{2}:\d{2}) - ([^:]+): (.*)$/;

/**
 * System message: DD/MM/YYYY HH:MM - <text without colon>
 */
const SYSTEM_MESSAGE_REGEX =
  /^(\d{2}\/\d{2}\/\d{4}) (\d{2}:\d{2}) - (.+)$/;

function convertBrDateToIso(brDate: string): string {
  const [day, month, year] = brDate.split("/");
  return `${year}-${month}-${day}`;
}

function dateTimeToTimestamp(brDate: string, time: string): number {
  const iso = convertBrDateToIso(brDate);
  return Math.floor(new Date(`${iso}T${time}:00`).getTime() / 1000);
}

function isMediaMessage(content: string): boolean {
  const patterns = [
    "<mídia oculta>",
    "<media omitted>",
    "imagem ocultada",
    "vídeo ocultado",
    "áudio ocultado",
    "figurinha omitida",
    "sticker omitted",
  ];
  const lower = content.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

/**
 * Parse a WhatsApp chat export .txt file into WhatsAppMessage[].
 * Handles multi-line messages and system messages.
 */
export function parseWhatsAppExport(fileContent: string): WhatsAppMessage[] {
  const lines = fileContent.split("\n");
  const messages: WhatsAppMessage[] = [];
  let current: WhatsAppMessage | null = null;
  let msgIndex = 0;

  for (const line of lines) {
    if (!line.trim() && !current) continue;

    const match = line.match(MESSAGE_REGEX);

    if (match) {
      if (current) messages.push(current);

      const [, brDate, time, sender, content] = match;
      current = {
        id: `upload-${msgIndex++}`,
        date: convertBrDateToIso(brDate),
        time,
        timestamp: dateTimeToTimestamp(brDate, time),
        sender: sender.trim(),
        senderName: sender.trim(),
        content,
        isMedia: isMediaMessage(content),
        isFromMe: false,
      };
    } else {
      const sysMatch = line.match(SYSTEM_MESSAGE_REGEX);
      if (sysMatch && !current) {
        // System message — skip (group notifications etc.)
        continue;
      } else if (current && line.trim()) {
        // Multi-line continuation
        current.content += "\n" + line;
      }
    }
  }

  if (current) messages.push(current);

  // Filter out system messages (sender = __system__)
  return messages.filter((m) => m.sender !== "__system__");
}

/**
 * Build a date summary from parsed messages.
 */
export function buildDateIndex(messages: WhatsAppMessage[]): DateInfo[] {
  const dateMap = new Map<
    string,
    { count: number; senders: Set<string>; preview: string }
  >();

  for (const msg of messages) {
    const entry = dateMap.get(msg.date) ?? {
      count: 0,
      senders: new Set<string>(),
      preview: "",
    };

    entry.count++;
    entry.senders.add(msg.senderName);

    if (!entry.preview && !msg.isMedia && msg.content) {
      entry.preview =
        msg.content.length > 50
          ? msg.content.substring(0, 50) + "..."
          : msg.content;
    }

    dateMap.set(msg.date, entry);
  }

  const dates: DateInfo[] = [];
  for (const [date, info] of dateMap) {
    dates.push({
      date,
      messageCount: info.count,
      participants: info.senders.size,
      preview: info.preview,
    });
  }

  return dates.sort((a, b) => b.date.localeCompare(a.date));
}
