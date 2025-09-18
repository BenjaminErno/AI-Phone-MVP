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
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

const conversations = {};

// tarjoa mp3 tiedostot julkisesti
app.use("/audio", express.static(path.join(process.cwd(), "audio")));

// varmista että kansio on olemassa
if (!fs.existsSync("./audio")) {
  fs.mkdirSync("./audio");
}

// ElevenLabs TTS → MP3
async function synthesizeFinnish(text, filePath) {
  const response = await fetch("https://api.elevenlabs.io/v1/text-to-speech/TpyeU8d9Xe5Lqg0cd4Fb", {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.4, similarity_boost: 0.8 },
    }),
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// Healthcheck
app.get("/healthz", (req, res) => {
  res.send("ok");
});

// Telnyx webhook
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body.data?.event_type;
    const callId = req.body.data?.payload?.call_control_id;

    console.log("Webhook event:", event, "CallID:", callId);

    if (!callId) return res.json({});

    // Vastaa puheluun
    if (event === "call.initiated") {
      conversations[callId] = [
        {
          role: "system",
          content: "Olet ystävällinen asiakaspalvelija ja puhut selkeällä suomen kielellä.",
        },
      ];

      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
      });

      // tee heti tervetuliaisäänne
      const greetingText = "Hei! Tervetuloa, kuinka voin auttaa?";
      const audioFile = `./audio/${callId}-greeting.mp3`;
      await synthesizeFinnish(greetingText, audioFile);

      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          audio_url: `${PUBLIC_BASE_URL}/audio/${callId}-greeting.mp3`,
        }),
      });

      return res.json({ ok: true });
    }

    // Kun tulee puhetta (speech event → transcript)
    if (event === "call.speech") {
      const transcript = req.body.data.payload?.speech?.transcription || "";
      if (!transcript) return res.json({});

      conversations[callId].push({ role: "user", content: transcript });

      const aiResponse = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: conversations[callId],
      });

      const reply = aiResponse.choices[0].message.content;
      conversations[callId].push({ role: "assistant", content: reply });

      // tee vastaus mp3
      const audioFile = `./audio/${callId}-${Date.now()}.mp3`;
      await synthesizeFinnish(reply, audioFile);

      // soita asiakkaalle
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          audio_url: `${PUBLIC_BASE_URL}/audio/${path.basename(audioFile)}`,
        }),
      });

      return res.json({ ok: true });
    }

    if (event === "call.ended") {
      delete conversations[callId];
    }

    res.json({});
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Server error");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
