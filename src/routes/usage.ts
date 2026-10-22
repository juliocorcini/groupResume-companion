import { Router } from "express";
import {
  getUsageStats,
  getTodayUsage,
  getLast7DaysUsage,
  GROQ_FREE_LIMITS,
} from "../usage/tracker.js";
import { loadConfig } from "../config/manager.js";

const router = Router();

/**
 * GET /api/usage — Full usage stats with projections
 */
router.get("/", (_req, res) => {
  try {
    const config = loadConfig();
    const primaryModel = config.ai.groq?.model || "openai/gpt-oss-120b";

    const modelKey = Object.keys(GROQ_FREE_LIMITS).find(
      (k) => k === primaryModel || primaryModel.includes(k.split("/").pop()!)
    ) || "openai/gpt-oss-120b";

    const stats = getUsageStats(modelKey);
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Failed to get usage stats" });
  }
});

/**
 * GET /api/usage/today — Today's usage only
 */
router.get("/today", (_req, res) => {
  try {
    const today = getTodayUsage();
    res.json(today);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Failed to get today's usage" });
  }
});

/**
 * GET /api/usage/limits — Groq free tier limits reference
 */
router.get("/limits", (_req, res) => {
  res.json(GROQ_FREE_LIMITS);
});

export default router;
