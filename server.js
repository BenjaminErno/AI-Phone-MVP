import express from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post("/webhook", async (req, res) => {
  const userMessage = req.body?.speechText || "En kuullut mitään";

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Olet ystävällinen puhelinassistentti suomeksi." },
      { role: "user", content: userMessage },
    ],
  });

  const reply = completion.choices[0].message.content;

  res.json({
    action: "talk",
    text: reply,
    language: "fi-FI",
  });
});

app.listen(3000, () => {
  console.log("Serveri käynnissä portissa 3000");
});
