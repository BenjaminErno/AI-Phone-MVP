import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();

// 🔧 Telnyx voi lähettää isoja payload-eja (STT yms.), nosta rajaa
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

// 🔊 Palvellaan mp3-tiedostot /audio-reitistä (Renderissa /tmp on kirjoitettava)
app.use("/audio", express.static("/tmp"));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // esim. https://ai-phone-mvp.onrender.com

// Puhelukohtainen muisti
const conversations = {};

// Pieni apuri uniikkeihin tiedostonimiin
const safeName = (s) => s.replace(/[^a-zA-Z0-9-_]/g, "_");

// 🔈 TTS: OpenAI -> MP3 /tmp-kansioon, palauttaa julkisen URL:n
async function ttsToMp3Url(text, callId, label = "reply") {
  const fileBase = `${safeName(callId)}-${label}-${Date.now()}.mp3`;
  const absPath = path.resolve("/tmp", fileBase);

  // Luo suomenkielinen puhe
  const speech = await client.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy", // voit testata myös esim. "verse", "aria" jne.
    input: text
  });

  const buffer = Buffer.from(await speech.arrayBuffer());
  fs.writeFileSync(absPath, buffer);

  if (!PUBLIC_BASE_URL) {
    throw new Error("PUBLIC_BASE_URL puuttuu env-muuttujista.");
  }
  // Julkinen URL, jonka Telnyx voi noutaa
  return `${PUBLIC_BASE_URL}/audio/${fileBase}`;
}

// Healthcheck
app.get("/healthz", (req, res) => res.send("ok"));

// Telnyx webhook
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body?.data?.event_type;
    const callId = req.body?.data?.payload?.call_control_id;

    console.log("Webhook event:", event, "CallID:", callId);

    if (!event || !callId) {
      return res.status(200).json({ data: { result: "noop" } });
    }

    // 1) Puhelu alkaa -> vastaa + toivota tervetulleeksi SUOMEKSI (OpenAI TTS)
    if (event === "call.initiated") {
      conversations[callId] = [
        {
          role: "system",
          content:
            "Puhu aina suomea. Olet ystävällinen asiakaspalvelija: tervehdi, kysy tarvittaessa tarkentavia kysymyksiä, ja pysy lyhytsanaisena."
        }
      ];

      console.log("Answering call…");
      const ansResp = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        }
      });
      const ansJson = await ansResp.json();
      console.log("Telnyx answer response:", ansJson);

      // Luo tervetuliais-ääni ja soita se
      const greetText = "Hei! Tervetuloa, kuinka voin auttaa?";
      const greetUrl = await ttsToMp3Url(greetText, callId, "greet");

      console.log("Playing greeting from:", greetUrl);
      const playResp = await fetch(
        `https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TELNYX_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ audio_url: greetUrl })
        }
      );
      const playJson = await playResp.json();
      console.log("Telnyx playback_start (greet) response:", playJson);

      return res.status(200).json({ success: true });
    }

    // 2) Puhetta tullut (STT) -> vastaa suomeksi + toista TTS:llä
    if (event === "call.speech") {
      const transcript = req.body?.data?.payload?.speech?.transcription || "";
      if (!transcript) return res.status(200).json({ data: { result: "noop" } });

      console.log("👤 Asiakas:", transcript);
      conversations[callId] = conversations[callId] || [];
      conversations[callId].push({ role: "user", content: transcript });

      const ai = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: conversations[callId]
      });

      const reply = ai.choices[0]?.message?.content?.trim() || "Selvä, miten voin auttaa?";
      console.log("🤖 Botti:", reply);
      conversations[callId].push({ role: "assistant", content: reply });

      // Muunna suomeksi puheeksi ja toista
      const replyUrl = await ttsToMp3Url(reply, callId, "answer");
      const speakResp = await fetch(
        `https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TELNYX_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ audio_url: replyUrl })
        }
      );
      const speakJson = await speakResp.json();
      console.log("Telnyx playback_start (reply) response:", speakJson);

      return res.status(200).json({ success: true });
    }

    // 3) Puhelu loppui -> siivotaan muisti
    if (event === "call.hangup") {
      console.log("Call ended, clearing memory:", callId);
      delete conversations[callId];
      return res.status(200).json({ success: true });
    }

    return res.status(200).json({ data: { result: "noop" } });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("Server error");
  }
});

// Render-portti
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
