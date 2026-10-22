/**
 * Ollama local AI provider.
 * Communicates with Ollama's REST API at localhost:11434.
 */
import type { AIProvider } from "./provider.js";
import type { SummaryOptions, AIProviderStatus } from "../types/index.js";

const OLLAMA_BASE_URL = "http://localhost:11434";

const MODELS = {
  "gemma3:4b": { maxMessages: 100, contextWindow: 32768 },
  "qwen3:8b": { maxMessages: 100, contextWindow: 32768 },
  "qwen3:4b": { maxMessages: 100, contextWindow: 32768 },
  "llama3.2:3b": { maxMessages: 80, contextWindow: 8192 },
  "mistral:7b": { maxMessages: 100, contextWindow: 32768 },
} as const;

type OllamaModelName = keyof typeof MODELS;

export class OllamaProvider implements AIProvider {
  readonly name = "ollama" as const;
  private model: string;
  private baseUrl: string;

  constructor(model: string = "gemma3:4b", baseUrl?: string) {
    this.model = model;
    this.baseUrl = baseUrl || OLLAMA_BASE_URL;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<AIProviderStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error("Ollama not responding");

      const data = await res.json() as { models?: Array<{ name: string }> };
      const installed = data.models?.map((m: any) => m.name) ?? [];

      return {
        name: "ollama",
        available: true,
        models: installed,
        activeModel: this.model,
      };
    } catch (err: any) {
      return {
        name: "ollama",
        available: false,
        models: [],
        activeModel: this.model,
        error: err.message ?? "Ollama not available",
      };
    }
  }

  getModelConfig(): { id: string; maxMessages: number } {
    const config = MODELS[this.model as OllamaModelName];
    return {
      id: this.model,
      maxMessages: config?.maxMessages ?? 100,
    };
  }

  setModel(model: string): void {
    this.model = model;
  }

  async summarize(
    messagesText: string,
    systemPrompt: string,
    options: SummaryOptions
  ): Promise<{ summary: string; tokensUsed: number }> {
    const startMs = Date.now();
    console.log(`[Ollama] Starting summarize (model: ${this.model})...`);

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(600_000),
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Resuma esta conversa do grupo:\n\n${messagesText}` },
        ],
        stream: false,
        keep_alive: "30m",
        options: {
          num_predict: options.maxTokens ?? 1500,
          temperature: 0.3,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama error: ${res.status} — ${errText}`);
    }

    const data = await res.json() as {
      message?: { content?: string };
      eval_count?: number;
      prompt_eval_count?: number;
    };

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    const content = data.message?.content ?? "";
    console.log(`[Ollama] Summarize done in ${elapsed}s (${content.length} chars)`);

    return {
      summary: content.trim(),
      tokensUsed: (data.eval_count ?? 0) + (data.prompt_eval_count ?? 0),
    };
  }

  async mergeSummaries(
    partialSummaries: string[],
    systemPrompt: string,
    maxTokens: number
  ): Promise<{ summary: string; tokensUsed: number }> {
    const startMs = Date.now();
    console.log(`[Ollama] Starting merge of ${partialSummaries.length} parts...`);

    const combined = partialSummaries
      .map((s, i) => `--- Parte ${i + 1} ---\n${s}`)
      .join("\n\n");

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(600_000),
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Combine estes resumos parciais em um resumo final cobrindo TODAS as partes:\n\n${combined}`,
          },
        ],
        stream: false,
        keep_alive: "30m",
        options: {
          num_predict: Math.max(maxTokens * 3, 2000),
          temperature: 0.3,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama merge error: ${res.status} — ${errText}`);
    }

    const data = await res.json() as {
      message?: { content?: string };
      eval_count?: number;
      prompt_eval_count?: number;
    };

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    const content = data.message?.content ?? "";
    console.log(`[Ollama] Merge done in ${elapsed}s (${content.length} chars)`);

    return {
      summary: content.trim(),
      tokensUsed: (data.eval_count ?? 0) + (data.prompt_eval_count ?? 0),
    };
  }

  async chat(
    systemPrompt: string,
    userMessage: string,
    maxTokens: number = 1500
  ): Promise<{ response: string; tokensUsed: number }> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        stream: false,
        keep_alive: "30m",
        options: {
          num_predict: maxTokens,
          temperature: 0.4,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama chat error: ${res.status} — ${errText}`);
    }

    const data = await res.json() as {
      message?: { content?: string };
      eval_count?: number;
      prompt_eval_count?: number;
    };

    return {
      response: (data.message?.content ?? "").trim(),
      tokensUsed: (data.eval_count ?? 0) + (data.prompt_eval_count ?? 0),
    };
  }
}
