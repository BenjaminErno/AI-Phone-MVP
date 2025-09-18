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

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;

// Tallennetaan äänitiedostot ./public/audio/ -kansioon
const AUDIO_DIR = path.join(process.cwd(), "public", "audio");
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

// Palvellaan mp3 tiedostot
app.use("/audio", express.static(AUDIO_DIR));

// Muisti keskusteluille
const conversations = {};

// ElevenLabs TTS
async function synthesizeWithElevenLabs(text, callId) {
  const url = "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM"; 
  // yllä voice_id = Rachel, mutta voit vaihtaa jos löydät paremman suomi-äänen

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "audio/mpeg",
      "Content-Type": "application/json",
      "xi-api-key": ELEVEN_API_KEY,
    },
    body: JSON.stringify({
      text: text,
      model_id: "eleven_multilingual_v2", // tukee suomea
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.9
      }
    }),
  });

  if (!response.ok) {
    throw new Error(`ElevenLabs error: ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const filePath = path.join(AUDIO_DIR, `${callId}.mp3`);
  fs.writeFileSync(filePath, buffer);

  // Palauta URL, josta Telnyx voi hakea sen
  return `${process.env.PUBLIC_BASE_URL}/audio/${callId}.mp3`;
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

    if (event === "call.initiated") {
      conversations[callId] = [
        { role: "system", content: "Olet ystävällinen asiakaspalvelija, joka puhuu suomea." }
      ];

      // Vastaa puheluun
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        }
      });

      // Luo tervehdys ElevenLabsilla
      const audioUrl = await synthesizeWithElevenLabs("Hei! Tervetuloa, kuinka voin auttaa?", callId);

      // Soita asiakkaalle mp3
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        },
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

      // Generoi suomenkielinen mp3
      const audioUrl = await synthesizeWithElevenLabs(reply, `${callId}-${Date.now()}`);

      // Soita asiakkaalle
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ audio_url: audioUrl })
      });

      return res.status(200).json({ success: true });
    }

    if (event === "call.ended") {
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
