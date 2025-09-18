import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(bodyParser.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

// Keskustelut tallennetaan puhelun mukaan
const conversations = {};

// Health check
app.get("/healthz", (req, res) => {
  res.send("ok");
});

// Funktio: luodaan suomenkielinen puhe OpenAI:lla
async function synthesizeSpeech(text) {
  const response = await client.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy", // tähän voi vaihtaa äänen, alloy on default
    input: text
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString("base64");
}

// Telnyx webhook
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body.data?.event_type;
    const callId = req.body.data?.payload?.call_control_id || "default";

    console.log("Webhook event:", event, "CallID:", callId);

    // Vastataan puheluun
    if (event === "call.initiated") {
      conversations[callId] = [
        { role: "system", content: "Olet ystävällinen asiakaspalvelija. Vastaat suomeksi ja kysyt lisätietoja tarvittaessa." }
      ];

      // Vastaa puheluun
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        }
      });

      // Tervehdys heti alkuun
      const audioBase64 = await synthesizeSpeech("Hei! Tervetuloa, kuinka voin auttaa?");
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          audio_url: `data:audio/mp3;base64,${audioBase64}`
        })
      });

      return res.status(200).json({ success: true });
    }

    // Asiakkaan puhe
    if (event === "call.speech") {
      const transcript = req.body.data.payload?.speech?.transcription || "";
      if (!transcript) {
        return res.json({ data: { result: "noop" } });
      }

      console.log("Asiakas sanoi:", transcript);

      conversations[callId].push({ role: "user", content: transcript });

      // OpenAI vastaus
      const aiResponse = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: conversations[callId]
      });

      const reply = aiResponse.choices[0].message.content;
      conversations[callId].push({ role: "assistant", content: reply });

      console.log("Botti vastaa:", reply);

      // Muunna ääneksi
      const audioBase64 = await synthesizeSpeech(reply);

      // Soita vastaus asiakkaalle
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/playback_start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          audio_url: `data:audio/mp3;base64,${audioBase64}`
        })
      });

      return res.status(200).json({ success: true });
    }

    // Kun puhelu loppuu
    if (event === "call.hangup") {
      delete conversations[callId];
    }

    return res.json({ data: { result: "noop" } });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Server error");
  }
});

// Renderin portti
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

