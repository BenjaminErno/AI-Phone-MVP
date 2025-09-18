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

const conversations = {};
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

// Healthcheck
app.get("/healthz", (req, res) => {
  res.send("ok");
});

// Telnyx webhook
app.post("/webhook", async (req, res) => {
  try {
    console.log("=== Incoming Webhook ===");
    console.log(JSON.stringify(req.body, null, 2));

    const event = req.body.data?.event_type;
    const callId = req.body.data?.payload?.call_control_id || "default";

    console.log("Webhook event:", event, "CallID:", callId);

    if (event === "call.initiated") {
      conversations[callId] = [
        { role: "system", content: "Olet ystävällinen asiakaspalvelija. Vastaat selkeästi ja kysyt tarvittaessa lisätietoja." }
      ];

      // Vastaa puheluun
      console.log("Answering call:", callId);
      const answerResp = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/answer`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        }
      });
      const answerData = await answerResp.json();
      console.log("Telnyx answer response:", answerData);

      // Puhu heti
      console.log("Speaking greeting...");
      const speakResp = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/speak`, {
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
      const speakData = await speakResp.json();
      console.log("Telnyx speak response:", speakData);

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

      console.log("AI reply:", reply);

      const speakResp = await fetch(`https://api.telnyx.com/v2/calls/${callId}/actions/speak`, {
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
      const speakData = await speakResp.json();
      console.log("Telnyx speak response:", speakData);

      return res.status(200).json({ success: true });
    }

    if (event === "call.ended") {
      delete conversations[callId];
      console.log("Call ended, memory cleared:", callId);
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
