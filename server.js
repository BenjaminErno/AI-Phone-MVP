import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();
const app = express();
app.use(bodyParser.json());

// 🔹 1. Vastaa Teniosin webhook-kutsuun kun puhelu alkaa
app.post("/voice", async (req, res) => {
  console.log("Tenios webhook:", req.body);

  // Asiakkaan puhe tekstiksi (STT): Tenios antaa sen automaattisesti webhookissa
  const userText = req.body.speechResult || "Hei, mitä asiaa?";

  // 🔹 2. Lähetä teksti OpenAI:lle
  const completion = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-5", // tai gpt-4o-mini jos haluat halvempaa
      input: userText
    })
  });
  const data = await completion.json();
  const aiText = data.output[0].content[0].text || "Pahoittelut, en ymmärtänyt.";

  console.log("AI vastasi:", aiText);

  // 🔹 3. Vastaa Teniosille TTS-ohjeilla
  res.json({
    "version": "1.0.0",
    "response": [
      {
        "action": "talk",
        "voice": "female",
        "text": aiText
      },
      {
        "action": "listen", // Jatka kuuntelemista
        "bargein": true
      }
    ]
  });
});

// Käynnistä serveri
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveri pyörii portissa ${PORT}`);
});
