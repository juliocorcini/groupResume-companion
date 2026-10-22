import { Router } from "express";
import { whatsappClient } from "../whatsapp/client.js";
import { sendMessage, formatSummaryForWhatsApp } from "../whatsapp/sender.js";
import { toDataURL } from "qrcode";

const router = Router();

/**
 * GET /api/status — WhatsApp connection status
 */
router.get("/status", (_req, res) => {
  res.json({
    status: whatsappClient.getStatus(),
    hasQr: whatsappClient.getQrCode() !== null,
  });
});

/**
 * GET /api/qr — Get QR code as base64 image
 */
router.get("/qr", async (_req, res) => {
  const qr = whatsappClient.getQrCode();

  if (!qr) {
    const status = whatsappClient.getStatus();
    if (status === "connected") {
      res.json({ status: "connected", message: "Already connected" });
    } else {
      res.json({ status, message: "No QR code available. Wait for initialization." });
    }
    return;
  }

  try {
    const qrDataUrl = await toDataURL(qr, {
      width: 300,
      margin: 2,
    });
    res.json({ status: "qr", qrCode: qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: "Failed to generate QR code image" });
  }
});

/**
 * POST /api/send — Send a message via WhatsApp
 */
router.post("/send", async (req, res) => {
  try {
    const { to, message, groupName, date } = req.body;

    if (!to || !message) {
      res.status(400).json({ error: "Missing 'to' or 'message'" });
      return;
    }

    const formatted =
      groupName && date
        ? formatSummaryForWhatsApp(message, groupName, date)
        : message;

    await sendMessage(to, formatted);
    res.json({ sent: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Failed to send message" });
  }
});

export default router;
