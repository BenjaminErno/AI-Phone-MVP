import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import fetch from "node-fetch";   // tämä pitää olla mukana!

dotenv.config();

const app = express();
app.use(bodyParser.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Pidetään keskustelut muistissa puhelun ID:n mukaan
const conversations = {};

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

// Healthcheck
app.get("/healthz", (req, res) => {
  res.send("ok");
});

// Telnyx webhook
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body.data?.event_type;
    const callId = req.body.data?.payload?.call_control_id || "default";

    console.log("Webhook:", event);

    // Alku: vastaa kun puhelu alkaa
    if (event === "call.initiated") {
      conversations[callId] = [
        { role: "system", content: "Olet ystävällinen asiakaspalvelija. Vastaat selkeästi ja kysyt tarvittaessa lisätietoja." }
      ];

      // Vastaa puheluun Telnyxin kautta
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        }
      });

      // Puhu heti kun vastattu
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/speak`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          voice: "female",
          language: "fi-FI",
          payload: "Hei! Tervetuloa, kuinka voin auttaa?"
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

      // Lähetetään vastaus Telnyxille
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/speak`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          voice: "female",
          language: "fi-FI",
          payload: reply
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
