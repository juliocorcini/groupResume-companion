import { whatsappClient } from "./client.js";

/**
 * Send a text message to a WhatsApp chat (contact or group).
 */
export async function sendMessage(
  chatId: string,
  message: string
): Promise<void> {
  const client = whatsappClient.getRawClient();

  if (!whatsappClient.isConnected()) {
    throw new Error("WhatsApp is not connected");
  }

  await client.sendMessage(chatId, message);
  console.log(`[WhatsApp] Message sent to ${chatId}`);
}

/**
 * Format a summary for WhatsApp (with WhatsApp-friendly markdown).
 */
export function formatSummaryForWhatsApp(
  summary: string,
  groupName: string,
  date: string
): string {
  // Convert standard markdown to WhatsApp formatting
  let formatted = summary
    .replace(/^## (.+)$/gm, "*$1*")       // ## Header → *Header*
    .replace(/^### (.+)$/gm, "_$1_")      // ### Header → _Header_
    .replace(/\*\*(.+?)\*\*/g, "*$1*")    // **bold** → *bold*
    .replace(/^- /gm, "• ");              // - item → • item

  const header = `📋 *Resumo — ${groupName}*\n📅 ${formatDateBR(date)}\n\n`;
  const footer = `\n\n_Gerado por GroupResume By Julio Corcini_`;

  return header + formatted + footer;
}

function formatDateBR(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}
