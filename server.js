import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import fetch from "node-fetch";
import { randomUUID } from "crypto";

dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;

const conversations = {};

const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || "https://ai-phone-mvp.onrender.com"
).replace(/\/$/, "");

const audioStore = new Map();
const callAudioIds = new Map();

function registerAudio(callId, buffer) {
  const id = randomUUID();
  const entry = {
    buffer,
    mimeType: "audio/mpeg",
    callId,
    timeout: null,
    cleanup: null
  };

  entry.cleanup = () => {
    if (entry.timeout) {
      clearTimeout(entry.timeout);
      entry.timeout = null;
    }
    audioStore.delete(id);
    const ids = callAudioIds.get(callId);
    if (ids) {
      ids.delete(id);
      if (ids.size === 0) {
        callAudioIds.delete(callId);
      }
    }
  };

  entry.timeout = setTimeout(() => {
    console.log(`🧹 Auto-cleaning audio for call ${callId} (${id})`);
    entry.cleanup();
  }, 10 * 60 * 1000);

  audioStore.set(id, entry);
  if (!callAudioIds.has(callId)) {
    callAudioIds.set(callId, new Set());
  }
  callAudioIds.get(callId).add(id);

  return { id, cleanup: entry.cleanup };
}

function cleanupAudioForCall(callId) {
  const ids = callAudioIds.get(callId);
  if (!ids) {
    return;
  }

  for (const audioId of Array.from(ids)) {
    const entry = audioStore.get(audioId);
    if (entry) {
      entry.cleanup();
    }
  }
}

function resolveCallId(payload = {}) {
  return (
    payload.call_control_id ||
    payload.call_session_id ||
    payload.call_leg_id ||
    payload.call_id ||
    "default"
  );
}

// ElevenLabs TTS → palauttaa MP3-bufferin
async function synthesizeWithElevenLabs(text) {
  console.log("🔊 Generating TTS with ElevenLabs voice=" + ELEVEN_VOICE_ID);

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        voice_settings: {
          stability: 0.3,
          similarity_boost: 0.8
        },
        output_format: "mp3_44100"
      })
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error("ElevenLabs error: " + error);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Healthcheck
app.get("/healthz", (req, res) => res.send("ok"));

app.get("/tts/:id", (req, res) => {
  const entry = audioStore.get(req.params.id);

  if (!entry) {
    return res.status(404).send("Audio not found");
  }

  res.setHeader("Content-Type", entry.mimeType);
  res.setHeader("Content-Length", entry.buffer.length);
  res.setHeader("Cache-Control", "no-store");
  res.write(entry.buffer);
  res.end();
});

// Telnyx webhook
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body.data?.event_type;
    const payload = req.body.data?.payload || {};
    const callId = resolveCallId(payload);

    console.log("Webhook event:", event, "CallID:", callId);

    if (event === "call.initiated") {
      conversations[callId] = [
        { role: "system", content: "Olet ystävällinen asiakaspalvelija suomeksi." }
      ];

      cleanupAudioForCall(callId);

      // Vastaa puheluun
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        }
      });

      // Luo TTS ja tallenna muistiin
      const greetingBuffer = await synthesizeWithElevenLabs(
        "Hei! Tervetuloa, kuinka voin auttaa?"
      );

      const { id: audioId } = registerAudio(callId, greetingBuffer);
      const greetingUrl = `${PUBLIC_BASE_URL}/tts/${audioId}`;

      // Toista URL:ista
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ audio_url: greetingUrl })
      });

      return res.json({ ok: true });
    }

    if (event === "call.playback.ended" || event === "call.playback.completed") {
      cleanupAudioForCall(callId);
    }

    if (event === "call.ended") {
      cleanupAudioForCall(callId);
      delete conversations[callId];
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Server error");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
