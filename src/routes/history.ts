import { Router } from "express";
import {
  getHistoryList,
  getHistoryEntry,
  deleteHistoryEntry,
  clearHistory,
  searchHistory,
} from "../history/store.js";

const router = Router();

/**
 * GET /api/history — List all summary history (metadata only)
 */
router.get("/", (_req, res) => {
  const entries = getHistoryList();
  res.json({ entries, total: entries.length });
});

/**
 * GET /api/history/search?q=... — Search history entries
 */
router.get("/search", (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) {
    res.status(400).json({ error: "Missing search query parameter 'q'" });
    return;
  }
  const results = searchHistory(query);
  res.json({
    query,
    results: results.map(({ summary, ...rest }) => ({
      ...rest,
      summaryPreview: summary.substring(0, 200) + (summary.length > 200 ? "..." : ""),
    })),
    total: results.length,
  });
});

/**
 * GET /api/history/:id — Get a single history entry with full summary
 */
router.get("/:id", (req, res) => {
  const entry = getHistoryEntry(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }
  res.json(entry);
});

/**
 * DELETE /api/history/:id — Delete a single history entry
 */
router.delete("/:id", (req, res) => {
  const deleted = deleteHistoryEntry(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }
  res.json({ success: true });
});

/**
 * DELETE /api/history — Clear all history
 */
router.delete("/", (_req, res) => {
  clearHistory();
  res.json({ success: true });
});

export default router;
