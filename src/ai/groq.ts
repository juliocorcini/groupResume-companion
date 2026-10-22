import Groq from "groq-sdk";
import type { AIProvider } from "./provider.js";
import type {
  SummaryOptions,
  AIProviderStatus,
  GroqModel,
} from "../types/index.js";
import { trackUsage } from "../usage/tracker.js";

/** Callback set by callers to attach source/group metadata to usage tracking */
let pendingMeta: { source?: string; groupId?: string; groupName?: string } = {};

/**
 * Model configurations — ported from groupResume.
 * Tested for performance and token limits.
 */
const MODELS: Record<GroqModel, { id: string; maxMessages: number }> = {
  fast: { id: "openai/gpt-oss-20b", maxMessages: 200 },
  balanced: { id: "qwen/qwen3.8-27b", maxMessages: 200 },
  powerful: { id: "openai/gpt-oss-120b", maxMessages: 300 },
};

const MERGE_MODEL = "openai/gpt-oss-20b";

export class GroqProvider implements AIProvider {
  readonly name = "groq" as const;
  private client: Groq;
  private activeModel: GroqModel;

  constructor(apiKey: string, model: GroqModel = "powerful") {
    this.client = new Groq({ apiKey });
    this.activeModel = model;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<AIProviderStatus> {
    const available = await this.isAvailable();
    return {
      name: "groq",
      available,
      models: Object.keys(MODELS),
      activeModel: this.activeModel,
      error: available ? undefined : "Cannot connect to Groq API",
    };
  }

  getModelConfig(): { id: string; maxMessages: number } {
    return MODELS[this.activeModel];
  }

  setModel(model: GroqModel): void {
    this.activeModel = model;
  }

  /** Set metadata for usage tracking on the next call(s) */
  setTrackingMeta(meta: { source?: string; groupId?: string; groupName?: string }): void {
    this._trackingMeta = meta;
  }

  private _trackingMeta: { source?: string; groupId?: string; groupName?: string } = {};

  private trackCall(operation: string, model: string, tokensUsed: number, processingTime?: number): void {
    try {
      trackUsage({
        timestamp: new Date().toISOString(),
        model,
        tokensUsed,
        source: (this._trackingMeta.source || "dashboard") as any,
        groupId: this._trackingMeta.groupId,
        groupName: this._trackingMeta.groupName,
        operation: operation as any,
        processingTime,
      });
    } catch (err) {
      console.error("[Usage] Failed to track:", err);
    }
  }

  async summarize(
    messagesText: string,
    systemPrompt: string,
    options: SummaryOptions
  ): Promise<{ summary: string; tokensUsed: number }> {
    const modelConfig = MODELS[this.activeModel];
    const startTime = Date.now();

    const completion = await this.client.chat.completions.create({
      model: modelConfig.id,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Resuma esta conversa do grupo:\n\n${messagesText}` },
      ],
      max_tokens: options.maxTokens ?? 500,
      temperature: 0.3,
    });

    const content = completion.choices[0]?.message?.content ?? "";
    const tokensUsed = completion.usage?.total_tokens ?? 0;

    if (!content) {
      const finishReason = completion.choices[0]?.finish_reason ?? "unknown";
      const refusal = (completion.choices[0]?.message as any)?.refusal;
      console.warn(
        `[Groq] Empty response! finish_reason=${finishReason}, refusal=${refusal || "none"}, model=${modelConfig.id}`
      );
    }

    this.trackCall("summarize", modelConfig.id, tokensUsed, Date.now() - startTime);

    return { summary: content, tokensUsed };
  }

  async mergeSummaries(
    partialSummaries: string[],
    systemPrompt: string,
    maxTokens: number
  ): Promise<{ summary: string; tokensUsed: number }> {
    const startTime = Date.now();
    const combined = partialSummaries
      .map((s, i) => `--- Parte ${i + 1} ---\n${s}`)
      .join("\n\n");

    const truncatedInput = combined.slice(0, 60000);

    const completion = await this.client.chat.completions.create({
      model: MERGE_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Combine estes resumos parciais em um resumo final cobrindo TODAS as partes:\n\n${truncatedInput}`,
        },
      ],
      max_tokens: Math.max(maxTokens * 3, 2000),
      temperature: 0.3,
    });

    const tokensUsed = completion.usage?.total_tokens ?? 0;
    this.trackCall("merge", MERGE_MODEL, tokensUsed, Date.now() - startTime);

    return {
      summary: completion.choices[0]?.message?.content ?? "",
      tokensUsed,
    };
  }

  async chat(
    systemPrompt: string,
    userMessage: string,
    maxTokens: number = 1500
  ): Promise<{ response: string; tokensUsed: number }> {
    const startTime = Date.now();
    const modelId = MODELS[this.activeModel].id;

    const completion = await this.client.chat.completions.create({
      model: modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      max_tokens: maxTokens,
      temperature: 0.4,
    });

    const tokensUsed = completion.usage?.total_tokens ?? 0;
    this.trackCall("chat", modelId, tokensUsed, Date.now() - startTime);

    return {
      response: completion.choices[0]?.message?.content ?? "",
      tokensUsed,
    };
  }
}
