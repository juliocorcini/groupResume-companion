import type {
  SummaryOptions,
  SummaryResult,
  AIProviderStatus,
  AIProviderName,
} from "../types/index.js";

/**
 * Abstract AI provider interface.
 * Implemented by GroqProvider and OllamaProvider.
 */
export interface AIProvider {
  readonly name: AIProviderName;

  /** Check if the provider is available and ready to use. */
  isAvailable(): Promise<boolean>;

  /** Get provider status with available models. */
  getStatus(): Promise<AIProviderStatus>;

  /** Get the current model configuration. */
  getModelConfig(): { id: string; maxMessages: number };

  /** Change the active model. */
  setModel(model: string): void;

  /** Generate a summary from formatted message text. */
  summarize(
    messagesText: string,
    systemPrompt: string,
    options: SummaryOptions
  ): Promise<{ summary: string; tokensUsed: number }>;

  /** Merge multiple partial summaries into one. */
  mergeSummaries(
    partialSummaries: string[],
    systemPrompt: string,
    maxTokens: number
  ): Promise<{ summary: string; tokensUsed: number }>;

  /** General-purpose chat for Q&A, conversations, etc. */
  chat(
    systemPrompt: string,
    userMessage: string,
    maxTokens?: number
  ): Promise<{ response: string; tokensUsed: number }>;

  /** Set metadata for usage tracking (optional — Groq only) */
  setTrackingMeta?(meta: { source?: string; groupId?: string; groupName?: string }): void;
}
