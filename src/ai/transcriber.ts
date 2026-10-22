import Groq from "groq-sdk";
import { trackUsage } from "../usage/tracker.js";

const WHISPER_MODEL = "whisper-large-v3-turbo";

/**
 * Transcribe an audio buffer using Groq's Whisper API.
 * Supports common audio formats: ogg/opus (WhatsApp default), mp3, wav, m4a, webm.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  fileName: string = "audio.ogg",
  source: string = "dm"
): Promise<{ text: string; duration?: number; language?: string }> {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) throw new Error("GROQ_API_KEY not configured for transcription");

  const client = new Groq({ apiKey: groqKey });
  const startTime = Date.now();

  console.log(`[Transcriber] Starting transcription (${(audioBuffer.length / 1024).toFixed(1)} KB, ${fileName})...`);

  const uint8 = new Uint8Array(audioBuffer);
  const file = new File([uint8], fileName, {
    type: getAudioMimeType(fileName),
  });

  const transcription = await client.audio.transcriptions.create({
    file,
    model: WHISPER_MODEL,
    language: "pt",
    response_format: "verbose_json",
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const text = transcription.text || "";
  const duration = (transcription as any).duration;

  console.log(`[Transcriber] Done in ${elapsed}s — ${text.length} chars, ${duration ? duration.toFixed(1) + "s audio" : "unknown duration"}`);

  // Track usage — Whisper uses audio seconds, not tokens
  try {
    trackUsage({
      timestamp: new Date().toISOString(),
      model: WHISPER_MODEL,
      tokensUsed: 0,
      audioSeconds: duration ?? 0,
      source: source as any,
      operation: "transcription",
      processingTime: Date.now() - startTime,
    });
  } catch {
    // Non-critical
  }

  return {
    text,
    duration: duration ? Math.round(duration) : undefined,
    language: (transcription as any).language,
  };
}

function getAudioMimeType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  const mimeTypes: Record<string, string> = {
    ogg: "audio/ogg",
    opus: "audio/ogg",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    webm: "audio/webm",
    flac: "audio/flac",
  };
  return mimeTypes[ext] || "audio/ogg";
}
