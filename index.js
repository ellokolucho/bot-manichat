const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const token = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;

// Endpoint para verificar el webhook (usado por Meta)
app.get('/webhook', (req, res) => {
  const verifyToken = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const tokenFromMeta = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && tokenFromMeta === verifyToken) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Endpoint para recibir mensajes
app.post('/webhook', async (req, res) => {
  console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2));

  const body = req.body;

  if (
    body.object &&
    body.entry &&
    body.entry[0].changes &&
    body.entry[0].changes[0].value.messages &&
    body.entry[0].changes[0].value.messages[0]
  ) {
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from;
    const text = message.text?.body?.trim();

    console.log(`📨 Mensaje recibido de ${from}: ${text}`);

    if (!text) return res.sendStatus(200);

    const mensaje = text.toLowerCase();

    // 🔹 MANEJO DE RESPUESTAS DE BOTONES EN WHATSAPP
    if (mensaje === "para caballeros") {
      await enviarSubmenuTipoReloj(from, "CABALLEROS");
      return res.sendStatus(200);
    }
    if (mensaje === "para damas") {
      await enviarSubmenuTipoReloj(from, "DAMAS");
      return res.sendStatus(200);
    }
    if (mensaje === "hablar con asesor") {
      await enviarMensajeConBotonSalir(from,
        "😊 ¡Claro que sí! Estamos listos para responder todas sus dudas y consultas. Por favor, escríbenos qué te gustaría saber ✍️");
      return res.sendStatus(200);
    }
    if (mensaje === "ver otros modelos") {
      await enviarMenuPrincipal(from);
      return res.sendStatus(200);
    }
    if (mensaje === "salir del asesor") {
      await enviarMensajeTexto(from, "🚪 Has salido del chat con asesor.");
      await enviarMenuPrincipal(from);
      return res.sendStatus(200);
    }

    // ✅ Primer saludo
    if (mensaje.includes("hola")) {
      await enviarMenuPrincipal(from);
      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;

// Enviar menú principal con botones
async function enviarMenuPrincipal(to) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: "👋 ¡Hola! Bienvenido a Tiendas Megan
⌚💎 Descubre tu reloj ideal o el regalo perfecto 🎁
Elige una opción para ayudarte 👇"
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: "CABALLEROS",
                title: "Para Caballeros"
              }
            },
            {
              type: "reply",
              reply: {
                id: "DAMAS",
                title: "Para Damas"
              }
            },
            {
              type: "reply",
              reply: {
                id: "ASESOR",
                title: "Hablar con Asesor"
              }
            }
          ]
        }
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });
  } catch (error) {
    console.error('❌ Error enviando menú principal:', error.response?.data || error.message);
  }
}

// Placeholder: Submenú y otras funciones
async function enviarSubmenuTipoReloj(to, tipo) {
  await enviarMensajeTexto(to, `🕐 Modelos disponibles para ${tipo.toLowerCase()}.`);
}

async function enviarMensajeConBotonSalir(to, texto) {
  await enviarMensajeTexto(to, texto + " (escribe 'Salir del Asesor' para finalizar)");
}

async function enviarMensajeTexto(to, text) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      text: { body: text }
    }, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });
  } catch (error) {
    console.error("❌ Error al enviar mensaje:", error.response?.data || error.message);
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://0.0.0.0:${PORT}`);
});