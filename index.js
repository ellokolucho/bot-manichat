
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

// Carga de datos de catálogos y promociones y prompt del sistema
const data = require('./data.json');
const promoData = require('./promoData.json');
const systemPrompt = fs.readFileSync('./SystemPrompt.txt', 'utf-8');

// Memoria de conversaciones y estados de flujo
const memoriaConversacion = {};
const contadorMensajesAsesor = {};
const estadoUsuario = {};

const app = express();
app.use(bodyParser.json());

const token = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;
const PORT = process.env.PORT || 3000;

// Verificación de webhook
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

// Recepción de mensajes
app.post('/webhook', async (req, res) => {
  console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2));
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const text = message.text?.body?.trim();
    const type = message.type;

    // 1) Manejo de botones interactivos
    if (type === 'interactive' && message.interactive?.button_reply?.id) {
      const id = message.interactive.button_reply.id;
      console.log('🛠 Acción interactiva recibida:', id);
      switch (id) {
        case 'CABALLEROS':
        case 'DAMAS':
          estadoUsuario[from] = `ESPERANDO_TIPO_${id}`; // Guardamos género
          await enviarSubmenuTipoReloj(from, id);
          break;
        case 'CABALLEROS_AUTO':
          await enviarCatalogo(from, 'caballeros_automaticos');
          delete estadoUsuario[from];
          break;
        case 'CABALLEROS_CUARZO':
          await enviarCatalogo(from, 'caballeros_cuarzo');
          delete estadoUsuario[from];
          break;
        case 'DAMAS_AUTO':
          await enviarCatalogo(from, 'damas_automaticos');
          delete estadoUsuario[from];
          break;
        case 'DAMAS_CUARZO':
          await enviarCatalogo(from, 'damas_cuarzo');
          delete estadoUsuario[from];
          break;
        case 'ASESOR':
          await enviarConsultaChatGPT(from, '');
          break;
        case 'SALIR':
          delete estadoUsuario[from];
          await enviarMenuPrincipal(from);
          break;
        default:
          await enviarMensajeTexto(from, '❓ No entendí tu selección, por favor intenta de nuevo.');
      }
      return res.sendStatus(200);
    }

    // 2) Manejo de texto para selección de catálogo (si esperaba tipo)
    if (type === 'text' && estadoUsuario[from]?.startsWith('ESPERANDO_TIPO_')) {
      const genero = estadoUsuario[from].split('_')[2].toLowerCase(); // 'caballeros' o 'DAMAS'
      const tipoSeleccion = text.toLowerCase().includes('auto') ? 'automaticos' : text.toLowerCase().includes('cuarzo') ? 'cuarzo' : null;
      if (tipoSeleccion) {
        const key = `${genero}_${tipoSeleccion}`;
        await enviarCatalogo(from, key);
        delete estadoUsuario[from];
        return res.sendStatus(200);
      }
    }

    // 3) Mensajes de texto libres: ChatGPT
    if (type === 'text' && text) {
      await enviarConsultaChatGPT(from, text);
      return res.sendStatus(200);
    }
  } catch (err) {
    console.error('❌ Error en webhook:', err);
  }
  res.sendStatus(200);
});

// Menú principal
async function enviarMenuPrincipal(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: '👋 ¡Hola! Bienvenido a Tiendas Megan\n⌚💎 Descubre tu reloj ideal o el regalo perfecto 🎁' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'CABALLEROS', title: '⌚ Para Caballeros' } },
              { type: 'reply', reply: { id: 'DAMAS', title: '🕒 Para Damas' } },
              { type: 'reply', reply: { id: 'ASESOR', title: '💬 Hablar con Asesor' } }
            ]
          }
        }
      },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    console.error('❌ Error enviando menú principal:', err.response?.data || err.message);
  }
}

// Submenú tipo de reloj
async function enviarSubmenuTipoReloj(to, genero) {
  const label = genero === 'CABALLEROS' ? 'caballeros' : 'damas';
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: `📦 ¿Qué tipo de reloj deseas ver para ${label}?` },
          action: {
            buttons: [
              { type: 'reply', reply: { id: `${genero}_AUTO`, title: '⛓ Automáticos' } },
              { type: 'reply', reply: { id: `${genero}_CUARZO`, title: '⚙ Cuarzo' } }
            ]
          }
        }
      },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    console.error('❌ Error enviando submenu:', err.response?.data || err.message);
  }
}

// Envío de catálogo
async function enviarCatalogo(to, key) {
  try {
    console.log(`🔎 enviarCatalogo: key='${key}', disponibles=`, data[key]?.length);
    const productos = data[key];
    if (!productos || productos.length === 0) {
      return enviarMensajeTexto(to, '😔 Lo siento, no hay productos disponibles para esa categoría.');
    }
    for (const p of productos) {
      await axios.post(
        `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to,
          type: 'image',
          image: { link: p.imagen },
          caption: `*${p.nombre}*\n${p.descripcion}\n💲 ${p.precio} soles\nCódigo: ${p.codigo}`
        },
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
      );
    }
    await enviarMensajeConBotonSalir(to, '¿Deseas ver otra sección?');
  } catch (err) {
    console.error('❌ Error enviando catálogo:', err.response?.data || err.message);
  }
}

// Resto de funciones (ChatGPT, promociones e info, mensajes de texto y botón salir)
// ... (idénticas a tu versión anterior) ...

app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
