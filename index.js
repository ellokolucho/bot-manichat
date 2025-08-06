const express = require("express");
const bodyParser = require("body-parser");
const app = express();
require("dotenv").config();

app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "botwhatsapp2025";

// Verificación del webhook
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado correctamente.");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Verificación del webhook fallida.");
    res.sendStatus(403);
  }
});

// Recepción de mensajes de WhatsApp
app.post("/webhook", (req, res) => {
  console.log("📩 Recibido en POST /webhook:", JSON.stringify(req.body, null, 2));

  const body = req.body;

  if (body.object === "whatsapp_business_account") {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (messages && messages.length > 0) {
      const message = messages[0];
      const from = message.from;
      const text = message.text?.body;

      console.log("📨 Mensaje recibido:", text);

      if (text && text.toLowerCase().includes("hola")) {
        // Enviar respuesta
        const axios = require("axios");
        const token = process.env.WHATSAPP_TOKEN; // Asegúrate de tener esto en tu archivo .env

        axios({
          method: "POST",
          url: `https://graph.facebook.com/v18.0/${value.metadata.phone_number_id}/messages`,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          data: {
            messaging_product: "whatsapp",
            to: from,
            text: {
              body: "Hola, ¿cómo estás? Estoy para ayudarte. 🤖",
            },
          },
        })
          .then((response) => {
            console.log("✅ Respuesta enviada correctamente:", response.data);
          })
          .catch((error) => {
            console.error("❌ Error al enviar el mensaje:", error.response?.data || error.message);
          });
      }
    }

    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Puerto corregido para Railway
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://0.0.0.0:${PORT}`);
});
