import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: "10mb" })); // ✅ Sallitaan isompi payload

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const conversations = {};

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "3OArekHEkHv5XvmZirVD"; // joku default ääni

// ElevenLabs TTS-funktio
async function synthesizeWithElevenLabs(text) {
  console.log("🔊 Sending TTS to ElevenLabs voice=" + ELEVEN_VOICE_ID);

  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.8
      },
      model_id: "eleven_multilingual_v2"
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error("ElevenLabs error: " + err);
  }

  const arrayBuffer = await resp.arrayBuffer();
  const audioBase64 = Buffer.from(arrayBuffer).toString("base64");
  return audioBase64;
}

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

    // Alku: vastaa kun puhelu alkaa
    if (event === "call.initiated") {
      conversations[callId] = [
        { role: "system", content: "Olet ystävällinen asiakaspalvelija. Vastaat selkeästi ja kysyt tarvittaessa lisätietoja." }
      ];

      // Vastaa puheluun
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        }
      });

      // Tervehdys ElevenLabsin kautta
      const greetingAudio = await synthesizeWithElevenLabs("Hei! Tervetuloa, kuinka voin auttaa?");

      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          audio_url: `data:audio/wav;base64,${greetingAudio}`
        })
      });

      return res.status(200).json({ success: true });
    }

    // Jos puhetta tulee webhookista
    if (event === "call.speech") {
      const transcript = req.body.data.payload?.speech?.transcription || "";

      if (!transcript) {
        return res.json({ data: { result: "noop" } });
      }

      conversations[callId].push({ role: "user", content: transcript });

      const aiResponse = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: conversations[callId]
      });

      const reply = aiResponse.choices[0].message.content;
      conversations[callId].push({ role: "assistant", content: reply });

      const replyAudio = await synthesizeWithElevenLabs(reply);

      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          audio_url: `data:audio/wav;base64,${replyAudio}`
        })
      });

      return res.status(200).json({ success: true });
    }

    if (event === "call.ended") {
      delete conversations[callId];
    }

    return res.json({ data: { result: "noop" } });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Server error");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
