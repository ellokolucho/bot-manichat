
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const token = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;

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
    const text = message.text?.body;
    const type = message.type;

    console.log(`📨 Mensaje recibido de ${from}: ${text}`);

    if (text && text.toLowerCase().includes("hola")) {
      await enviarMenuPrincipal(from);
      return res.sendStatus(200);
    }

    if (type === 'interactive' && message.interactive?.button_reply?.id) {
      const buttonId = message.interactive.button_reply.id;

      switch (buttonId) {
        case "CABALLEROS":
          await enviarSubmenuTipoReloj(from, "CABALLEROS");
          break;
        case "DAMAS":
          await enviarSubmenuTipoReloj(from, "DAMAS");
          break;
        case "ASESOR":
          await enviarMensajeAsesor(from);
          break;
        case "CABALLEROS_AUTO":
          await enviarCatalogo(from, "caballeros_automaticos");
          break;
        case "CABALLEROS_CUARZO":
          await enviarCatalogo(from, "caballeros_cuarzo");
          break;
        case "DAMAS_AUTO":
          await enviarCatalogo(from, "damas_automaticos");
          break;
        case "DAMAS_CUARZO":
          await enviarCatalogo(from, "damas_cuarzo");
          break;
        default:
          await enviarMensajeTexto(from, "❓ No entendí tu selección, por favor intenta de nuevo.");
      }

      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;

async function enviarMenuPrincipal(to) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: "👋 ¡Hola! Bienvenido a Tiendas Megan\n⌚💎 Descubre tu reloj ideal o el regalo perfecto 🎁\nElige una opción para ayudarte 👇"
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: "CABALLEROS",
                title: "⌚ Para Caballeros"
              }
            },
            {
              type: "reply",
              reply: {
                id: "DAMAS",
                title: "🕒 Para Damas"
              }
            },
            {
              type: "reply",
              reply: {
                id: "ASESOR",
                title: "💬 Hablar con Asesor"
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

async function enviarSubmenuTipoReloj(to, genero) {
  const generoMayus = genero.toUpperCase();
  const isCaballero = generoMayus === "CABALLEROS";

  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: `📦 ¿Qué tipo de reloj deseas ver para ${genero.toLowerCase()}?`
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: `${generoMayus}_AUTO`,
                title: "⛓ Automáticos"
              }
            },
            {
              type: "reply",
              reply: {
                id: `${generoMayus}_CUARZO`,
                title: "⚙ Cuarzo"
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
    console.error('❌ Error enviando submenu:', error.response?.data || error.message);
  }
}

async function enviarCatalogo(to, tipo) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      text: {
        body: `📄 Aquí tienes el catálogo para: ${tipo.replace('_', ' ')}`
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });
  } catch (error) {
    console.error('❌ Error enviando catálogo:', error.response?.data || error.message);
  }
}

async function enviarMensajeAsesor(to) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      text: {
        body: "💬 Un asesor está disponible para ayudarte. En breve te contactaremos."
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });
  } catch (error) {
    console.error('❌ Error enviando mensaje al asesor:', error.response?.data || error.message);
  }
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
    console.error('❌ Error enviando mensaje de texto:', error.response?.data || error.message);
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://0.0.0.0:${PORT}`);
});
