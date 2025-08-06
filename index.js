const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// Ruta de prueba
app.get("/", (req, res) => {
  res.send("✅ Bot de WhatsApp en funcionamiento.");
});

// Ruta para verificación del webhook
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("🟢 Webhook verificado correctamente.");
    res.status(200).send(challenge);
  } else {
    console.log("🔴 Falló la verificación del webhook.");
    res.sendStatus(403);
  }
});

// Ruta para recibir mensajes de WhatsApp
app.post("/webhook", async (req, res) => {
  const body = req.body;

  console.log("📩 Recibido en POST /webhook:", JSON.stringify(body, null, 2));

  if (body.object === "whatsapp_business_account") {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    const phoneNumberId = change?.value?.metadata?.phone_number_id;

    if (message && message.type === "text") {
      const from = message.from;
      const msgBody = message.text.body;

      console.log(`📨 Mensaje recibido de ${from}: ${msgBody}`);

      // Enviar respuesta
      try {
        await axios({
          method: "POST",
          url: `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
          headers: {
            "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json"
          },
          data: {
            messaging_product: "whatsapp",
            to: from,
            text: {
              body: "Hola, ¿cómo estás? Estoy para ayudarte 😊"
            }
          }
        });

        console.log("✅ Respuesta enviada con éxito.");
      } catch (error) {
        console.error("❌ Error al enviar respuesta:", error.response?.data || error.message);
      }
    }
  }

  res.sendStatus(200);
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});
