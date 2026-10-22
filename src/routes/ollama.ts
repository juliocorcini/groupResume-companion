import { Router } from "express";
import { loadConfig, updateConfig } from "../config/manager.js";

const router = Router();
const OLLAMA_BASE = "http://localhost:11434";

/** Track active pull progress per model */
const pullProgress = new Map<string, {
  status: string;
  completed: number;
  total: number;
  percent: number;
  error?: string;
  done: boolean;
}>();

/**
 * GET /api/ollama/status — Check if Ollama is running
 */
router.get("/status", async (_req, res) => {
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) throw new Error("Ollama not responding");
    res.json({ available: true });
  } catch {
    res.json({ available: false });
  }
});

/**
 * GET /api/ollama/models — List installed models
 */
router.get("/models", async (_req, res) => {
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error("Ollama not responding");

    const data = (await resp.json()) as {
      models?: Array<{
        name: string;
        size: number;
        modified_at: string;
        details?: { parameter_size?: string; family?: string; quantization_level?: string };
      }>;
    };

    const config = loadConfig();
    const activeModel = config.ai.ollama.model;

    const models = (data.models || []).map((m) => ({
      name: m.name,
      size: m.size,
      sizeFormatted: formatBytes(m.size),
      modifiedAt: m.modified_at,
      parameterSize: m.details?.parameter_size || "",
      family: m.details?.family || "",
      quantization: m.details?.quantization_level || "",
      isActive: m.name === activeModel || m.name.split(":")[0] === activeModel.split(":")[0],
    }));

    res.json({ models, activeModel });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Failed to list models" });
  }
});

/**
 * POST /api/ollama/pull — Start downloading a model
 */
router.post("/pull", async (req, res) => {
  const { model } = req.body;
  if (!model) {
    res.status(400).json({ error: "Missing model name" });
    return;
  }

  // Initialize progress
  pullProgress.set(model, {
    status: "starting",
    completed: 0,
    total: 0,
    percent: 0,
    done: false,
  });

  res.json({ started: true, model });

  // Run pull in background
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model, stream: true }),
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });

    if (!resp.ok || !resp.body) {
      pullProgress.set(model, {
        status: "error",
        completed: 0,
        total: 0,
        percent: 0,
        error: `HTTP ${resp.status}`,
        done: true,
      });
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          const progress = pullProgress.get(model);
          if (progress) {
            progress.status = data.status || "downloading";
            if (data.total && data.completed !== undefined) {
              progress.total = data.total;
              progress.completed = data.completed;
              progress.percent = Math.round((data.completed / data.total) * 100);
            }
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    pullProgress.set(model, {
      status: "success",
      completed: 1,
      total: 1,
      percent: 100,
      done: true,
    });

    console.log(`[Ollama] Model ${model} downloaded successfully`);
  } catch (err: any) {
    pullProgress.set(model, {
      status: "error",
      completed: 0,
      total: 0,
      percent: 0,
      error: err.message,
      done: true,
    });
    console.error(`[Ollama] Failed to pull ${model}:`, err.message);
  }

  // Cleanup after 5 minutes
  setTimeout(() => pullProgress.delete(model), 5 * 60 * 1000);
});

/**
 * GET /api/ollama/pull/:model/progress — Get download progress
 */
router.get("/pull/:model/progress", (req, res) => {
  const model = req.params.model;
  const progress = pullProgress.get(model);

  if (!progress) {
    res.json({ status: "unknown", percent: 0, done: false });
    return;
  }

  res.json(progress);
});

/**
 * DELETE /api/ollama/models/:model — Delete a model
 */
router.delete("/models/:model", async (req, res) => {
  const model = req.params.model;

  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(errText || `HTTP ${resp.status}`);
    }

    console.log(`[Ollama] Model ${model} deleted`);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Failed to delete model" });
  }
});

/**
 * POST /api/ollama/active — Set the active model
 */
router.post("/active", (req, res) => {
  const { model } = req.body;
  if (!model) {
    res.status(400).json({ error: "Missing model name" });
    return;
  }

  try {
    updateConfig({
      ai: { ollama: { model } } as any,
    });
    res.json({ success: true, model });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export default router;
