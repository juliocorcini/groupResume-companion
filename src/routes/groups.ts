import { Router } from "express";
import {
  getGroups,
  getGroupMessages,
  getGroupDates,
  getContacts,
} from "../whatsapp/messages.js";

const router = Router();

/**
 * GET /api/groups — List all WhatsApp groups
 */
router.get("/", async (_req, res) => {
  try {
    const groups = await getGroups();
    res.json({ groups });
  } catch (err: any) {
    console.error("[API /groups] Error:", err);
    res.status(500).json({ error: err.message ?? "Failed to fetch groups" });
  }
});

/**
 * GET /api/groups/:id/messages — Get messages from a specific group
 * Query params: dateFrom, dateTo, limit
 */
router.get("/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const { dateFrom, dateTo, limit } = req.query;

    const messages = await getGroupMessages(id, {
      dateFrom: dateFrom as string | undefined,
      dateTo: dateTo as string | undefined,
      limit: limit ? parseInt(limit as string) : undefined,
    });

    res.json({
      messages,
      count: messages.length,
      groupId: id,
    });
  } catch (err: any) {
    console.error("[API /groups/:id/messages] Error:", err);
    res.status(500).json({ error: err.message ?? "Failed to fetch messages" });
  }
});

/**
 * GET /api/groups/:id/dates — Get available dates for a group
 */
router.get("/:id/dates", async (req, res) => {
  try {
    const { id } = req.params;
    const { limit } = req.query;

    const dates = await getGroupDates(id, limit ? parseInt(limit as string) : undefined);

    res.json({ dates, groupId: id });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Failed to fetch dates" });
  }
});

/**
 * GET /api/groups/list/contacts — List contacts for sending messages
 * (prefixed with "list/" to avoid collision with /:id route)
 */
router.get("/list/contacts", async (req, res) => {
  try {
    const fetchAll = req.query.all === "true";
    const contacts = await getContacts(fetchAll);
    res.json({ contacts });
  } catch (err: any) {
    console.error("[API /contacts] Error:", err);
    res.status(500).json({ error: err.message ?? "Failed to fetch contacts" });
  }
});

export default router;
