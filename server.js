import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// === DEBUG ENV VARS ===
console.log("✅ OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "Loaded" : "Missing");
console.log("✅ TELNYX_API_KEY:", process.env.TELNYX_API_KEY ? "Loaded" : "Missing");
console.log("✅ ELEVEN_API_KEY:", process.env.ELEVEN_API_KEY ? process.env.ELEVEN_API_KEY.slice(0, 6) + "..." : "Missing");
console.log("✅ ELEVEN_VOICE_ID:", process.env.ELEVEN_VOICE_ID || "Missing");
console.log("✅ PUBLIC_BASE_URL:", process.env.PUBLIC_BASE_URL || "Missing");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "Jussi"; // esim. Jussi, Lumi
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

// Keskustelut muistiin
const conversations = {};

// TTS ElevenLabsilla
async function synthesizeWithElevenLabs(text, callId) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
  console.log(`🔊 Sending TTS to ElevenLabs voice=${ELEVEN_VOICE_ID}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.9
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs error: ${errText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const fileName = `response_${callId}.mp3`;
  const filePath = path.join("/tmp", fileName);
  fs.writeFileSync(filePath, buffer);
  return `${PUBLIC_BASE_URL}/audio/${fileName}`;
}

// Staattinen kansio audiolle
app.use("/audio", express.static("/tmp"));

// Healthcheck
app.get("/healthz", (req, res) => {
  res.send("ok");
});

// Telnyx webhook
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body.data?.event_type;
    const callId = req.body.data?.payload?.call_control_id || "default";

    console.log("Webhook event:", event, "CallID:", callId);

    if (event === "call.initiated") {
      conversations[callId] = [
        { role: "system", content: "Olet ystävällinen asiakaspalvelija. Vastaat suomeksi ja selkeästi." }
      ];

      // Vastaa puheluun
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" }
      });

      // Ensitervehdys
      const audioUrl = await synthesizeWithElevenLabs("Hei! Tervetuloa, kuinka voin auttaa?", callId);

      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ audio_url: audioUrl })
      });

      return res.status(200).json({ success: true });
    }

    if (event === "call.speech") {
      const transcript = req.body.data.payload?.speech?.transcription || "";
      if (!transcript) return res.json({ data: { result: "noop" } });

      conversations[callId].push({ role: "user", content: transcript });

      const aiResponse = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: conversations[callId]
      });

      const reply = aiResponse.choices[0].message.content;
      conversations[callId].push({ role: "assistant", content: reply });

      const audioUrl = await synthesizeWithElevenLabs(reply, callId);

      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ audio_url: audioUrl })
      });

      return res.status(200).json({ success: true });
    }

    if (event === "call.hangup") {
      delete conversations[callId];
    }

    res.json({ data: { result: "noop" } });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Server error");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
