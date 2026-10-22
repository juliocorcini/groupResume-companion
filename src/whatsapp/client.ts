import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import { EventEmitter } from "events";
import type { ConnectionStatus } from "../types/index.js";

class WhatsAppClient extends EventEmitter {
  private client: InstanceType<typeof Client>;
  private status: ConnectionStatus = "disconnected";
  private qrCode: string | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;

  constructor() {
    super();

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: "./.wwebjs_auth",
      }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--disable-gpu",
        ],
      },
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on("qr", (qr: string) => {
      this.qrCode = qr;
      this.setStatus("qr");
      this.emit("qr", qr);
      console.log("[WhatsApp] QR code received — scan with your phone");
    });

    this.client.on("authenticated", () => {
      console.log("[WhatsApp] Authenticated successfully");
      this.qrCode = null;
    });

    this.client.on("auth_failure", (message: string) => {
      console.error("[WhatsApp] Authentication failed:", message);
      this.setStatus("disconnected");
      this.emit("auth_failure", message);
    });

    this.client.on("ready", async () => {
      console.log("[WhatsApp] Client is ready!");
      this.reconnectAttempts = 0;
      this.setStatus("connected");

      // Enable auto-download for audio (needed for DM audio transcription)
      try {
        await (this.client as any).setAutoDownloadAudio(true);
        console.log("[WhatsApp] Auto-download audio enabled");
      } catch {
        console.warn("[WhatsApp] Could not enable auto-download audio");
      }

      this.emit("ready");
    });

    this.client.on("disconnected", (reason: string) => {
      console.warn("[WhatsApp] Disconnected:", reason);
      this.setStatus("disconnected");
      this.emit("disconnected", reason);
      this.attemptReconnect();
    });

    this.client.on("loading_screen", (percent: number) => {
      console.log(`[WhatsApp] Loading... ${percent}%`);
      // Don't regress from "connected" back to "connecting"
      if (this.status !== "connected") {
        this.setStatus("connecting");
      }
    });
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.emit("status", status);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error(
        "[WhatsApp] Max reconnect attempts reached. Manual restart needed."
      );
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(
      `[WhatsApp] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})...`
    );

    setTimeout(async () => {
      try {
        this.setStatus("connecting");
        await this.client.initialize();
      } catch (err) {
        console.error("[WhatsApp] Reconnect failed:", err);
        this.attemptReconnect();
      }
    }, delay);
  }

  async initialize(): Promise<void> {
    console.log("[WhatsApp] Initializing client...");
    this.setStatus("connecting");

    try {
      await this.client.initialize();
    } catch (err) {
      console.error("[WhatsApp] Initialization failed:", err);
      this.setStatus("disconnected");
      throw err;
    }
  }

  async destroy(): Promise<void> {
    console.log("[WhatsApp] Shutting down...");
    try {
      await this.client.destroy();
    } catch {
      // Ignore destroy errors during shutdown
    }
    this.setStatus("disconnected");
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getQrCode(): string | null {
    return this.qrCode;
  }

  getRawClient(): InstanceType<typeof Client> {
    return this.client;
  }

  isConnected(): boolean {
    return this.status === "connected";
  }
}

// Singleton instance
export const whatsappClient = new WhatsAppClient();
