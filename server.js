import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import fetch from "node-fetch";

dotenv.config();

const app = express();
// Sallitaan isompi payload ettei tule PayloadTooLargeError
app.use(bodyParser.json({ limit: "10mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;

const conversations = {};

// ElevenLabs TTS → palauttaa data:audio/mp3;base64
async function synthesizeWithElevenLabs(text) {
  console.log("🔊 Sending TTS to ElevenLabs voice=" + ELEVEN_VOICE_ID);

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
  const buffer = Buffer.from(arrayBuffer);
  const audioBase64 = buffer.toString("base64");

  return "data:audio/mp3;base64," + audioBase64;
}

// Healthcheck
app.get("/healthz", (req, res) => res.send("ok"));

// Telnyx webhook
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body.data?.event_type;
    const callId = req.body.data?.payload?.call_control_id || "default";

    console.log("Webhook event:", event, "CallID:", callId);

    if (event === "call.initiated") {
      conversations[callId] = [
        { role: "system", content: "Olet ystävällinen asiakaspalvelija suomeksi." }
      ];

      // Vastaa puheluun
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        }
      });

      // Luo TTS
      const greetingUrl = await synthesizeWithElevenLabs("Hei! Tervetuloa, kuinka voin auttaa?");

      // Toista se
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

    if (event === "call.ended") {
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
