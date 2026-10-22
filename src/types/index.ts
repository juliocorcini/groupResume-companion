// ============================================================
// WhatsApp Types
// ============================================================

export interface WhatsAppGroup {
  id: string;
  name: string;
  participantCount: number;
  lastMessage?: string;
  lastMessageTime?: number;
  isAdmin: boolean;
  chatType?: "group" | "community" | "community-group" | "announcement";
  parentId?: string | null;
}

export interface WhatsAppMessage {
  id: string;
  date: string;       // YYYY-MM-DD
  time: string;       // HH:MM
  timestamp: number;
  sender: string;
  senderName: string;
  content: string;
  isMedia: boolean;
  isFromMe: boolean;
}

export interface WhatsAppContact {
  id: string;
  name: string;
  number: string;
  isGroup: boolean;
  isMyContact: boolean;
  chatType?: "contact" | "group" | "community" | "community-group" | "announcement" | "channel";
  timestamp?: number;
}

export type ConnectionStatus = "disconnected" | "qr" | "connecting" | "connected";

// ============================================================
// AI Types
// ============================================================

export type SummaryLevel = 1 | 2 | 3 | 4 | 5;
export type PrivacyMode = "anonymous" | "with-names" | "smart";
export type AIProviderName = "groq" | "ollama";
export type GroqModel = "fast" | "balanced" | "powerful";

export interface SummaryOptions {
  level: SummaryLevel;
  privacy: PrivacyMode;
  model?: string;
  maxTokens?: number;
}

export interface SummaryResult {
  summary: string;
  tokensUsed: number;
  processingTime: number;
  provider: string;
  model: string;
  chunks: number;
}

export interface AIProviderStatus {
  name: AIProviderName;
  available: boolean;
  models: string[];
  activeModel?: string;
  error?: string;
}

export interface SummaryLevelConfig {
  name: string;
  description: string;
  maxTokens: number;
  systemPrompt: string;
}

// ============================================================
// Configuration Types
// ============================================================

export interface AppConfig {
  server: {
    port: number;
    autoStartWithWindows: boolean;
  };
  whatsapp: {
    sessionName: string;
  };
  ai: {
    defaultProvider: AIProviderName;
    groq: {
      model: string;
      fallbackModel: string;
    };
    ollama: {
      baseUrl: string;
      model: string;
    };
    autoFallback: boolean;
  };
  summary: {
    defaultLevel: SummaryLevel;
    defaultPrivacy: PrivacyMode;
  };
  autoSummary: {
    enabled: boolean;
    time: string;
    groups: string[];
    sendTo: string;
    level: SummaryLevel;
    privacy: PrivacyMode;
    perGroup?: Record<string, { time: string; level?: SummaryLevel; enabled?: boolean }>;
  };
  bot: {
    enabled: boolean;
    prefix: string;
    allowedGroups: string[];
    rateLimitMinutes: number;
    level: SummaryLevel;
    privacy: PrivacyMode;
  };
  groupRules?: Record<string, string>;
}

// ============================================================
// API Types
// ============================================================

export interface SummarizeRequest {
  groupId: string;
  date?: string;
  dateFrom?: string;
  dateTo?: string;
  level?: SummaryLevel;
  privacy?: PrivacyMode;
  provider?: AIProviderName;
}

export interface SendMessageRequest {
  to: string;
  message: string;
}

export interface DateInfo {
  date: string;
  messageCount: number;
  participants: number;
  preview: string;
}
