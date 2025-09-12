import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// OpenAI client
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Healthcheck route
app.get("/", (req, res) => {
  res.send("Telnyx AI Phone MVP is running ✅");
});

// Telnyx webhook route
app.post("/webhook", async (req, res) => {
  try {
    console.log("Incoming webhook:", JSON.stringify(req.body, null, 2));

    const eventType = req.body.data?.event_type;

    if (eventType === "call.initiated") {
      // Vastataan kun puhelu alkaa
      return res.json({
        data: {
          result: "actions",
          actions: [
            {
              "say": {
                "text": "Hei! Tämä on tekoälyvastaaja. Kuinka voin auttaa sinua tänään?"
              }
            }
          ]
        }
      });
    }

    if (eventType === "call.speech") {
      // Asiakas sanoo jotain, lähetetään OpenAI:lle
      const userSpeech = req.body.data.payload?.speech?.transcription || "";

      const aiResponse = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Olet asiakaspalvelija, joka auttaa ystävällisesti ja kirjaa tietoja." },
          { role: "user", content: userSpeech }
        ]
      });

      const reply = aiResponse.choices[0].message.content;

      return res.json({
        data: {
          result: "actions",
          actions: [
            {
              "say": { "text": reply }
            }
          ]
        }
      });
    }

    // Default: ignore other events
    res.json({ data: { result: "noop" } });

  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).send("Server error");
  }
});

// Renderin portti
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
