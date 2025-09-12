import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(bodyParser.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Pidetään keskustelut muistissa puhelun ID:n mukaan
const conversations = {};

// Healthcheck (testaa selaimella https://...onrender.com/healthz)
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

      return res.json({
        data: {
          result: "actions",
          actions: [
            { say: { text: "Hei! Tervetuloa, kuinka voin auttaa?" } }
          ]
        }
      });
    }

    // Jos puhetta tulee webhookista
    if (event === "call.speech") {
      const transcript = req.body.data.payload?.speech?.transcription || "";

      if (!transcript) {
        return res.json({ data: { result: "noop" } });
      }

      // Lisää käyttäjän viesti keskusteluun
      conversations[callId].push({ role: "user", content: transcript });

      // Kutsu OpenAI:ta
      const aiResponse = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: conversations[callId]
      });

      const reply = aiResponse.choices[0].message.content;

      // Lisää botin vastaus muistiin
      conversations[callId].push({ role: "assistant", content: reply });

      return res.json({
        data: {
          result: "actions",
          actions: [
            { say: { text: reply } }
          ]
        }
      });
    }

    // Kun puhelu päättyy, tyhjennetään muisti
    if (event === "call.ended") {
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
