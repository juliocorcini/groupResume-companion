import { whatsappClient } from "./client.js";
import type {
  WhatsAppGroup,
  WhatsAppMessage,
  WhatsAppContact,
  DateInfo,
} from "../types/index.js";

/**
 * Fetch all WhatsApp groups the connected account belongs to.
 */
export async function getGroups(): Promise<WhatsAppGroup[]> {
  const client = whatsappClient.getRawClient();
  const page = (client as any).pupPage;

  if (!page) {
    throw new Error("WhatsApp Web page not available");
  }

  // Workaround for whatsapp-web.js _serialized → $1 rename bug.
  // Bypass client.getChats() and read WAWebCollections directly.
  // Reference: https://github.com/wwebjs/whatsapp-web.js/issues/201845
  const rawGroups: any[] = await page.evaluate(() => {
    try {
      const chats = (window as any)
        .require("WAWebCollections")
        .Chat.getModelsArray();

      return chats
        .filter(
          (c: any) =>
            c.id &&
            (c.id._serialized || c.id.$1 || "").endsWith("@g.us")
        )
        .map((c: any) => {
          const gm = c.groupMetadata || {};
          const isParent = gm.isParentGroup === true;
          const isAnnounce = gm.announce === true;
          const parentId = gm.parentGroup?._serialized || gm.parentGroup?.$1 || null;

          let chatType = "group";
          if (isParent) chatType = "community";
          else if (parentId && isAnnounce) chatType = "announcement";
          else if (parentId) chatType = "community-group";

          return {
            id: c.id._serialized || c.id.$1 || "",
            name: c.name || c.formattedTitle || (c.contact && c.contact.name) || "Unknown",
            participants: gm.participants?.length ?? 0,
            chatType,
            parentId,
            timestamp: c.t || 0,
          };
        });
    } catch (err: any) {
      return { error: err?.message ?? "Unknown error" };
    }
  });

  if (!Array.isArray(rawGroups)) {
    throw new Error(`Failed to load groups: ${(rawGroups as any).error}`);
  }

  const groups: WhatsAppGroup[] = rawGroups.map((g: any) => ({
    id: g.id,
    name: g.name,
    participantCount: g.participants,
    lastMessage: undefined,
    lastMessageTime: g.timestamp || undefined,
    isAdmin: false,
    chatType: g.chatType,
    parentId: g.parentId,
  }));

  return groups;
}

/**
 * Fetch messages from a specific group chat.
 * Optionally filter by date range.
 */
export async function getGroupMessages(
  groupId: string,
  options: {
    limit?: number;
    dateFrom?: string; // YYYY-MM-DD
    dateTo?: string;   // YYYY-MM-DD
  } = {}
): Promise<WhatsAppMessage[]> {
  const client = whatsappClient.getRawClient();
  const page = (client as any).pupPage;

  if (!page) {
    throw new Error("WhatsApp Web page not available");
  }

  const limit = options.limit ?? 1000;
  const MAX_LOAD_ITERATIONS = 25;

  // Use WAWebChatLoadMessages module to load messages, then read from chat.msgs.
  // The loadEarlierMsgs function lives in a separate module, NOT on the chat object.
  const rawMessages: any[] = await page.evaluate(
    async (gId: string, msgLimit: number, maxIter: number) => {
      try {
        const WAWeb = (window as any).require("WAWebCollections");
        const loader = (window as any).require("WAWebChatLoadMessages");
        const chat = WAWeb.Chat.get(gId);

        if (!chat) return { error: `Chat not found: ${gId}` };

        let prevCount = 0;
        let currentCount = chat.msgs.getModelsArray().length;

        // Progressively load earlier messages using the dedicated loader module.
        // CRITICAL: pass { chat } (object with chat prop), NOT the chat directly.
        // This matches whatsapp-web.js internal fetchMessages() behavior.
        for (let i = 0; i < maxIter && currentCount < msgLimit; i++) {
          prevCount = currentCount;
          try {
            const loaded = await loader.loadEarlierMsgs({ chat });
            if (!loaded || !loaded.length) break;
          } catch {
            break;
          }
          currentCount = chat.msgs.getModelsArray().length;
          if (currentCount <= prevCount) break;
        }

        const allMsgs = chat.msgs.getModelsArray();
        const VALID_TYPES = new Set(["chat", "image", "video", "ptt", "audio", "document", "sticker"]);

        return allMsgs
          .filter((m: any) => VALID_TYPES.has(m.type))
          .slice(-msgLimit)
          .map((m: any) => {
            try {
              const authorJid = m.author || m.from || "";
              const senderId = typeof authorJid === "object"
                ? (authorJid._serialized || authorJid.$1 || "")
                : String(authorJid);

              return {
                id: m.id?._serialized || m.id?.$1 || String(Math.random()),
                timestamp: m.t || 0,
                sender: senderId.split("@")[0],
                senderName: m.notifyName || m.senderObj?.pushname || m.senderObj?.name || senderId.split("@")[0] || "Unknown",
                body: m.body || (m.type !== "chat" ? `[${m.type}]` : ""),
                isMedia: m.type !== "chat",
                fromMe: m.id?.fromMe || false,
              };
            } catch {
              return null;
            }
          })
          .filter((m: any) => m !== null);
      } catch (err: any) {
        return { error: err?.message ?? "Unknown error" };
      }
    },
    groupId,
    limit,
    MAX_LOAD_ITERATIONS
  );

  if (!Array.isArray(rawMessages)) {
    throw new Error(
      `Failed to load messages: ${(rawMessages as any).error}`
    );
  }

  const messages: WhatsAppMessage[] = [];

  for (const msg of rawMessages) {
    if (!msg.body && !msg.isMedia) continue;

    const msgDate = new Date(msg.timestamp * 1000);
    const dateStr = formatDate(msgDate);
    const timeStr = formatTime(msgDate);

    // Date filtering
    if (options.dateFrom && dateStr < options.dateFrom) continue;
    if (options.dateTo && dateStr > options.dateTo) continue;

    messages.push({
      id: msg.id,
      date: dateStr,
      time: timeStr,
      timestamp: msg.timestamp,
      sender: msg.sender,
      senderName: msg.senderName || "Unknown",
      content: msg.body ?? "",
      isMedia: msg.isMedia,
      isFromMe: msg.fromMe,
    });
  }

  // Sort by timestamp ascending
  messages.sort((a, b) => a.timestamp - b.timestamp);

  return messages;
}

/**
 * Get available dates with message counts for a specific group.
 */
export async function getGroupDates(
  groupId: string,
  limit: number = 1000
): Promise<DateInfo[]> {
  const messages = await getGroupMessages(groupId, { limit });

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

  // Sort by date descending (most recent first)
  dates.sort((a, b) => b.date.localeCompare(a.date));

  return dates;
}

/**
 * Get contacts for sending messages.
 * When fetchAll is true, also includes contacts without recent chats.
 */
export async function getContacts(fetchAll: boolean = false): Promise<WhatsAppContact[]> {
  const client = whatsappClient.getRawClient();
  const page = (client as any).pupPage;

  if (!page) {
    throw new Error("WhatsApp Web page not available");
  }

  const rawChats: any[] = await page.evaluate((loadAll: boolean) => {
    try {
      const WAWeb = (window as any).require("WAWebCollections");
      const chats = WAWeb.Chat.getModelsArray();

      const results: any[] = chats
        .filter((c: any) => {
          const cId = c.id?._serialized || c.id?.$1 || "";
          return cId !== "status@broadcast" && cId.length > 0;
        })
        .map((c: any) => {
          const cId = c.id?._serialized || c.id?.$1 || "";
          const isGroup = cId.endsWith("@g.us");
          const isNewsletter = cId.endsWith("@newsletter");

          const isParent = c.groupMetadata?.isParentGroup === true;
          const isAnnounce = c.groupMetadata?.announce === true;
          const isCommunityChild = !!c.groupMetadata?.parentGroup;

          let chatType = "contact";
          if (isNewsletter) chatType = "channel";
          else if (isParent) chatType = "community";
          else if (isCommunityChild && isAnnounce) chatType = "announcement";
          else if (isCommunityChild) chatType = "community-group";
          else if (isGroup) chatType = "group";

          return {
            id: cId,
            name: c.formattedTitle || c.name || c.pushname || c.contact?.pushname || "",
            number: isGroup || isNewsletter ? "" : cId.split("@")[0] || "",
            isGroup,
            isMyContact: c.contact?.isMyContact || false,
            chatType,
            timestamp: c.t || 0,
            unreadCount: c.unreadCount || 0,
          };
        });

      if (loadAll) {
        const seenIds = new Set(results.map((r: any) => r.id));

        // Load contacts from the Contact collection (includes contacts without chats)
        try {
          const contacts = WAWeb.Contact.getModelsArray();
          for (const ct of contacts) {
            const ctId = ct.id?._serialized || ct.id?.$1 || "";
            if (seenIds.has(ctId)) continue;
            if (!ctId.endsWith("@c.us")) continue;
            if (ctId === "status@broadcast") continue;

            const name = ct.pushname || ct.name || ct.formattedName || ct.shortName || "";
            if (!name || name === ctId.split("@")[0]) continue;

            results.push({
              id: ctId,
              name,
              number: ctId.split("@")[0] || "",
              isGroup: false,
              isMyContact: ct.isMyContact || ct.isUser || false,
              chatType: "contact",
              timestamp: 0,
              unreadCount: 0,
            });
          }
        } catch {
          // Contact collection may not be available, skip gracefully
        }
      }

      return results;
    } catch (err: any) {
      return { error: err?.message ?? "Unknown error" };
    }
  }, fetchAll);

  if (!Array.isArray(rawChats)) {
    throw new Error(`Failed to load contacts: ${(rawChats as any).error}`);
  }

  return rawChats
    .filter((c: any) => c.name && c.name !== "")
    .map((c: any) => ({
      id: c.id,
      name: c.name,
      number: c.number,
      isGroup: c.isGroup,
      isMyContact: c.isMyContact,
      chatType: c.chatType,
      timestamp: c.timestamp,
    }))
    .sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));
}

// ============================================================
// Helpers
// ============================================================

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${min}`;
}
