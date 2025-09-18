import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import fetch from "node-fetch";

dotenv.config();

const app = express();

// 🔧 Sallitaan isommat webhook-payloadit (Telnyx lähettää isoja)
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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

    console.log("Webhook event:", event, "CallID:", callId);

    // Vastaa puheluun kun se alkaa
    if (event === "call.initiated") {
      conversations[callId] = [
        {
          role: "system",
          content:
            "Olet ystävällinen asiakaspalvelija. Vastaat selkeästi ja kysyt tarvittaessa lisätietoja."
        }
      ];

      console.log("Answering call:", callId);

      // Vastaa puheluun Telnyxin kautta
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        }
      }).then(r => r.json())
        .then(resp => console.log("Telnyx answer response:", resp));

      // Puhu heti kun vastattu
      console.log("Speaking greeting...");
      await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/speak`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          voice: "female",
          language: "en-US",   // Telnyx ei tue suomea, täältä pitää vaihtaa jos lisätään TTS workaround
          payload: "Hei! Tervetuloa, kuinka voin auttaa?"
        })
      }).then(r => r.json())
        .then(resp => console.log("Telnyx speak response:", resp));

      return res.status(200).json({ success: true });
    }

    // Jos puhetta tulee webhookista
    if (event === "call.speech") {
      const transcript = req.body.data.payload?.speech?.transcription || "";

      if (!transcript) {
        return res.json({ data: { result: "noop" } });
      }

      console.log("User said:", transcript);

      conversations[callId].push({ role: "user", content: transcript });

      const aiResponse = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: conversations[callId]
      });

      const reply = aiResponse.choices[0].message.content;
      console.log("AI replied:", reply);

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
          language: "en-US",
          payload: reply
        })
      }).then(r => r.json())
        .then(resp => console.log("Telnyx speak response:", resp));

      return res.status(200).json({ success: true });
    }

    if (event === "call.ended") {
      console.log("Call ended, clearing memory for:", callId);
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
