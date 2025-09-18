import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));
app.use("/audio", express.static(path.join(__dirname, "public")));

// ==== ENV variables ====
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "3OArekHEkHv5XvmZirVD";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://ai-phone-mvp.onrender.com";

// ==== Luo public-kansio jos puuttuu ====
const publicDir = path.join(__dirname, "public");
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir);
}

// ==== ElevenLabs TTS ====
async function synthesizeWithElevenLabs(text, filename) {
  console.log(`🔊 Generating TTS with ElevenLabs voice=${ELEVEN_VOICE_ID}`);

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": ELEVEN_API_KEY,
      },
      body: JSON.stringify({
        text,
        voice_settings: {
          stability: 0.3,
          similarity_boost: 0.7,
        },
        output_format: "mp3_44100_128", // Telnyx ymmärtää yleensä tämän
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs error: ${err}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const filePath = path.join(publicDir, filename);
  fs.writeFileSync(filePath, buffer);

  const url = `${PUBLIC_BASE_URL}/audio/${filename}`;
  console.log(`✅ Audio ready at: ${url}`);
  return url;
}

// ==== Telnyx: Answer ====
async function answerCall(callControlId) {
  console.log(`📞 Answering call: ${callControlId}`);
  const res = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/answer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  return res.json();
}

// ==== Telnyx: Play audio ====
async function playAudio(callControlId, audioUrl) {
  console.log(`▶️ Playing audio: ${audioUrl}`);
  const res = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/playback_start`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ audio_url: audioUrl }),
  });
  const data = await res.json();
  console.log("▶️ Telnyx playback_start response:", data);
  return data;
}

// ==== Webhook ====
app.post("/webhook", async (req, res) => {
  const event = req.body?.data?.event_type;
  const callControlId = req.body?.data?.payload?.call_control_id;

  console.log("Webhook event:", event, "CallID:", callControlId);

  if (event === "call.initiated") {
    try {
      await answerCall(callControlId);
      const audioUrl = await synthesizeWithElevenLabs(
        "Hei, tervetuloa testaamaan suomenkielistä puhetta!",
        "greeting.mp3"
      );
      await playAudio(callControlId, audioUrl);
    } catch (err) {
      console.error("Webhook error:", err);
    }
  }

  res.sendStatus(200);
});

// ==== Start server ====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
