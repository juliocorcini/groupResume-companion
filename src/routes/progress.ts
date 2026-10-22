import { Router } from "express";
import { getProgress, getResult } from "../progress/store.js";

const router = Router();

/** GET /api/progress/:jobId — Poll progress of a summarization job */
router.get("/:jobId", (req, res) => {
  const entry = getProgress(req.params.jobId);
  if (!entry) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(entry);
});

/** GET /api/progress/:jobId/result — Fetch the final result when done */
router.get("/:jobId/result", (req, res) => {
  const result = getResult(req.params.jobId);
  if (!result) {
    res.status(404).json({ error: "Result not ready yet" });
    return;
  }
  res.json(result);
});

export default router;
