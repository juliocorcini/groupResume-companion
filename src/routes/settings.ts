import { Router } from "express";
import { loadConfig, updateConfig } from "../config/manager.js";
import { OllamaProvider } from "../ai/ollama.js";
import {
  getAutoSummaryStatus,
  runAutoSummary,
  rescheduleAutoSummary,
} from "../scheduler/auto-summary.js";

const router = Router();

/**
 * GET /api/settings — Get current settings
 */
router.get("/", (_req, res) => {
  const config = loadConfig();
  res.json(config);
});

/**
 * PUT /api/settings — Update settings
 */
router.put("/", (req, res) => {
  try {
    const updates = req.body;
    const updated = updateConfig(updates);

    // Reschedule auto-summary if its settings changed
    if (updates.autoSummary) {
      rescheduleAutoSummary();
    }

    res.json({ success: true, config: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Failed to save settings" });
  }
});

/**
 * GET /api/settings/ai-status — Get AI providers status
 */
router.get("/ai-status", async (_req, res) => {
  try {
    const ollama = new OllamaProvider();
    const ollamaStatus = await ollama.getStatus();

    const groqAvailable = !!process.env.GROQ_API_KEY;

    res.json({
      groq: {
        available: groqAvailable,
        error: groqAvailable ? undefined : "GROQ_API_KEY not set",
      },
      ollama: ollamaStatus,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/settings/auto-summary/status — Get auto-summary scheduler status
 */
router.get("/auto-summary/status", (_req, res) => {
  res.json(getAutoSummaryStatus());
});

/**
 * POST /api/settings/auto-summary/run — Manually trigger auto-summary now
 */
router.post("/auto-summary/run", async (_req, res) => {
  try {
    const result = await runAutoSummary();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Failed to run auto-summary" });
  }
});

export default router;
