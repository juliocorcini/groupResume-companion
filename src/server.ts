import "dotenv/config";

// Disable TLS certificate verification for local desktop app.
// Required when antivirus/proxy intercepts HTTPS (SELF_SIGNED_CERT_IN_CHAIN).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import express from "express";
import cors from "cors";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

import { whatsappClient } from "./whatsapp/client.js";
import { initBot } from "./whatsapp/bot.js";
import { loadConfig } from "./config/manager.js";
import { initAutoSummaryScheduler, stopAutoSummaryScheduler } from "./scheduler/auto-summary.js";

import whatsappRoutes from "./routes/whatsapp.js";
import groupRoutes from "./routes/groups.js";
import summarizeRoutes from "./routes/summarize.js";
import settingsRoutes from "./routes/settings.js";
import uploadRoutes from "./routes/upload.js";
import progressRoutes from "./routes/progress.js";
import ollamaRoutes from "./routes/ollama.js";
import historyRoutes from "./routes/history.js";
import usageRoutes from "./routes/usage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   💬 GroupResume Companion v1.0.0        ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log();

  const config = loadConfig();
  const port = config.server.port;

  // ── Express Server ──────────────────────────────────
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  // Serve dashboard static files
  const dashboardPath = resolve(__dirname, "..", "dashboard");
  app.use(express.static(dashboardPath));

  // API routes
  app.use("/api", whatsappRoutes);
  app.use("/api/groups", groupRoutes);
  app.use("/api/summarize", summarizeRoutes);
  app.use("/api/settings", settingsRoutes);
  app.use("/api/upload", uploadRoutes);
  app.use("/api/progress", progressRoutes);
  app.use("/api/ollama", ollamaRoutes);
  app.use("/api/history", historyRoutes);
  app.use("/api/usage", usageRoutes);

  // Fallback: serve dashboard
  app.get("*", (_req, res) => {
    res.sendFile(resolve(dashboardPath, "index.html"));
  });

  // ── Start HTTP Server ───────────────────────────────
  const server = app.listen(port, () => {
    console.log(`[Server] Dashboard running at http://localhost:${port}`);
    console.log();
  });

  // Allow long-running requests (Ollama local AI can take 30+ minutes)
  server.timeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;

  // ── Initialize WhatsApp ─────────────────────────────
  console.log("[WhatsApp] Connecting...");

  whatsappClient.on("status", (status) => {
    console.log(`[WhatsApp] Status: ${status}`);
  });

  whatsappClient.on("qr", () => {
    console.log(`[WhatsApp] QR code ready — open http://localhost:${port} to scan`);
  });

  whatsappClient.on("ready", () => {
    console.log("[WhatsApp] Connected and ready!");
    console.log();
    console.log("  ✅ Dashboard:  http://localhost:" + port);
    console.log("  ✅ WhatsApp:   Connected");
    console.log("  ✅ Bot:        " + (config.bot.enabled ? "Listening for !resumo" : "Disabled"));
    console.log();

    // Initialize bot listener
    if (config.bot.enabled) {
      initBot();
    }

    // Initialize auto-summary scheduler
    initAutoSummaryScheduler();

    // Auto-open dashboard on first run (if not running hidden)
    if (!process.env.GROUPRESUME_HIDDEN) {
      import("open")
        .then((mod) => mod.default(`http://localhost:${port}`))
        .catch(() => {});
    }
  });

  try {
    await whatsappClient.initialize();
  } catch (err) {
    console.error("[WhatsApp] Failed to initialize:", err);
    console.log("[WhatsApp] The dashboard is still accessible — try refreshing the QR code.");
  }

  // ── Graceful Shutdown ───────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n[Server] ${signal} received. Shutting down...`);

    stopAutoSummaryScheduler();

    try {
      await whatsappClient.destroy();
    } catch {
      // Ignore
    }

    server.close(() => {
      console.log("[Server] Goodbye! 👋");
      process.exit(0);
    });

    // Force exit after 5 seconds
    setTimeout(() => process.exit(1), 5000);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
