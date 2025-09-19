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

function trimTrailingSlash(value) {
  return value ? value.replace(/\/$/, "") : value;
}

function toWebSocketBase(url) {
  if (!url) return url;
  if (url.startsWith("wss://") || url.startsWith("ws://")) {
    return trimTrailingSlash(url);
  }
  if (url.startsWith("https://")) {
    return `wss://${url.slice("https://".length)}`;
  }
  if (url.startsWith("http://")) {
    return `ws://${url.slice("http://".length)}`;
  }
  return trimTrailingSlash(url);
}

const PUBLIC_BASE_URL = trimTrailingSlash(
  process.env.PUBLIC_BASE_URL || "https://ai-phone-mvp.onrender.com"
);

const RELAY_BASE_URL = trimTrailingSlash(process.env.RELAY_BASE_URL || "");
const RELAY_WS_URL = trimTrailingSlash(
  process.env.RELAY_WS_URL ||
    (RELAY_BASE_URL ? `${toWebSocketBase(RELAY_BASE_URL)}/media` : "")
);
const RELAY_CONTROL_URL = trimTrailingSlash(
  process.env.RELAY_CONTROL_URL ||
    (RELAY_BASE_URL ? `${RELAY_BASE_URL}/sessions` : "")
);
const RELAY_AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN || "";

const audioStore = new Map();
const callAudioIds = new Map();
const relayCleanups = new Map();

function registerRelayCleanup(callId, cleanup) {
  if (!callId || typeof cleanup !== "function") return;
  if (!relayCleanups.has(callId)) {
    relayCleanups.set(callId, new Set());
  }
  relayCleanups.get(callId).add(cleanup);
}

function runRelayCleanups(callId) {
  const cleanups = relayCleanups.get(callId);
  if (!cleanups) return;
  for (const cleanup of cleanups) {
    try {
      const result = cleanup();
      if (result && typeof result.then === "function") {
        result.catch(err =>
          console.error(`Relay cleanup failed for call ${callId}:`, err)
        );
      }
    } catch (err) {
      console.error(`Relay cleanup failed for call ${callId}:`, err);
    }
  }
  relayCleanups.delete(callId);
}

async function notifyRelayStop(callId) {
  if (!RELAY_CONTROL_URL) return;
  const url = `${RELAY_CONTROL_URL}/${encodeURIComponent(callId)}`;
  const headers = { "Content-Type": "application/json" };
  if (RELAY_AUTH_TOKEN) headers["X-Relay-Token"] = RELAY_AUTH_TOKEN;
  try {
    const response = await fetch(url, { method: "DELETE", headers });
    if (!response.ok && response.status !== 404) {
      const text = await response.text().catch(() => "");
      console.error(
        `Relay stop failed for call ${callId}: ${response.status} ${text}`
      );
    }
  } catch (err) {
    console.error(`Failed to notify relay stop for call ${callId}:`, err);
  }
}

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
    if (entry.timeout) clearTimeout(entry.timeout);
    audioStore.delete(id);
    const ids = callAudioIds.get(callId);
    if (ids) {
      ids.delete(id);
      if (ids.size === 0) callAudioIds.delete(callId);
    }
  };

  entry.timeout = setTimeout(() => {
    console.log(`🧹 Auto-cleaning audio for call ${callId} (${id})`);
    entry.cleanup();
  }, 10 * 60 * 1000);

  audioStore.set(id, entry);
  if (!callAudioIds.has(callId)) callAudioIds.set(callId, new Set());
  callAudioIds.get(callId).add(id);

  return { id, cleanup: entry.cleanup };
}

function cleanupAudioForCall(callId, options = {}) {
  const { includeRelay = false } = options;
  const ids = callAudioIds.get(callId);
  if (ids) {
    for (const audioId of Array.from(ids)) {
      const entry = audioStore.get(audioId);
      if (entry) entry.cleanup();
    }
  }
  if (includeRelay) {
    runRelayCleanups(callId);
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

async function handleTranscriptForCall(callId, transcript) {
  const text = (transcript || "").trim();
  if (!text) return;

  if (!conversations[callId]) {
    console.warn(
      `⚠️ Received transcript for unknown call ${callId}; ignoring.`
    );
    return;
  }

  console.log("🎤 User said:", text);

  conversations[callId].push({ role: "user", content: text });

  const aiResponse = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: conversations[callId]
  });

  const rawReply = aiResponse.choices?.[0]?.message?.content || "";
  const reply = rawReply.trim() || "Pahoittelut, en ymmärtänyt.";
  conversations[callId].push({ role: "assistant", content: reply });

  const replyBuffer = await synthesizeWithElevenLabs(reply);
  const { id: audioId } = registerAudio(callId, replyBuffer);
  const replyUrl = `${PUBLIC_BASE_URL}/tts/${audioId}`;

  await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ audio_url: replyUrl })
  });
}

// Healthcheck
app.get("/healthz", (req, res) => res.send("ok"));

app.get("/tts/:id", (req, res) => {
  const entry = audioStore.get(req.params.id);
  if (!entry) return res.status(404).send("Audio not found");
  res.setHeader("Content-Type", entry.mimeType);
  res.setHeader("Content-Length", entry.buffer.length);
  res.setHeader("Cache-Control", "no-store");
  res.write(entry.buffer);
  res.end();
});

app.post("/transcription", async (req, res) => {
  try {
    if (RELAY_AUTH_TOKEN && req.headers["x-relay-token"] !== RELAY_AUTH_TOKEN) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const { callId, transcript } = req.body || {};
    if (!callId) {
      return res
        .status(400)
        .json({ ok: false, message: "Missing callId" });
    }

    const text = (transcript || "").trim();
    if (!text) {
      return res.json({ ok: true });
    }

    if (!conversations[callId]) {
      console.warn(
        `⚠️ Transcript received for inactive call ${callId}; ignoring.`
      );
      return res
        .status(202)
        .json({ ok: false, message: "Call not active" });
    }

    await handleTranscriptForCall(callId, text);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Transcription webhook error:", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
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
      cleanupAudioForCall(callId, { includeRelay: true });

      // Vastaa puheluun
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        }
      });

      if (RELAY_WS_URL) {
        const params = new URLSearchParams({ callId });
        if (RELAY_AUTH_TOKEN) params.set("token", RELAY_AUTH_TOKEN);
        const streamUrl = `${RELAY_WS_URL}?${params.toString()}`;
        try {
          const forkResponse = await fetch(
            `https://api.telnyx.com/v2/calls/${callId}/actions/fork_start`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${TELNYX_API_KEY}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                stream_url: streamUrl,
                stream_key: callId,
                audio_track: "inbound",
                channels: ["inbound"],
                chunk_length_ms: 20,
                sample_rate: 8000
              })
            }
          );
          if (!forkResponse.ok) {
            const errorText = await forkResponse.text();
            console.error(
              `Telnyx fork_start failed for ${callId}: ${forkResponse.status} ${errorText}`
            );
          } else {
            registerRelayCleanup(callId, () => notifyRelayStop(callId));
          }
        } catch (forkErr) {
          console.error(`Failed to initiate media fork for ${callId}:`, forkErr);
        }
      } else {
        console.warn(
          "Relay WebSocket URL not configured; skipping Telnyx fork_start"
        );
      }

      // Ensitervehdys
      const greetingBuffer = await synthesizeWithElevenLabs(
        "Hei! Tervetuloa, kuinka voin auttaa?"
      );
      const { id: audioId } = registerAudio(callId, greetingBuffer);
      const greetingUrl = `${PUBLIC_BASE_URL}/tts/${audioId}`;
      await fetch(
        `https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TELNYX_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ audio_url: greetingUrl })
        }
      );

      return res.json({ ok: true });
    }

    if (event === "call.speech") {
      const transcript = payload.speech?.transcription || "";
      if (transcript && conversations[callId]) {
        await handleTranscriptForCall(callId, transcript);
      }
    }

    if (event === "call.playback.ended" || event === "call.playback.completed") {
      cleanupAudioForCall(callId);
    }

    if (event === "call.ended") {
      cleanupAudioForCall(callId, { includeRelay: true });
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

