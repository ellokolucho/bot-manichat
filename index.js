
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
    const text = message.text?.body;
    const type = message.type;

    // Botones interactivos
    if (type === 'interactive' && message.interactive?.button_reply?.id) {
      const id = message.interactive.button_reply.id;
      console.log('🛠 Acción interactiva recibida:', id);
      switch (id) {
        case 'CABALLEROS':
        case 'DAMAS':
          await enviarSubmenuTipoReloj(from, id);
          break;
        case 'CABALLEROS_AUTO':
          await enviarCatalogo(from, 'caballeros_automaticos');
          break;
        case 'CABALLEROS_CUARZO':
          await enviarCatalogo(from, 'caballeros_cuarzo');
          break;
        case 'DAMAS_AUTO':
          await enviarCatalogo(from, 'damas_automaticos');
          break;
        case 'DAMAS_CUARZO':
          await enviarCatalogo(from, 'damas_cuarzo');
          break;
        case 'ASESOR':
          await enviarConsultaChatGPT(from, '');
          break;
        case 'SALIR':
          await enviarMenuPrincipal(from);
          break;
        default:
          await enviarMensajeTexto(from, '❓ No entendí tu selección, por favor intenta de nuevo.');
      }
    } else if (type === 'text' && text) {
      // Mensaje libre: ChatGPT
      await enviarConsultaChatGPT(from, text);
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
    console.log(`🔎 enviarCatalogo: key='${key}', productos disponibles=`, data[key]?.length);
    const productos = data[key];
    if (!productos || productos.length === 0) {
      return enviarMensajeTexto(to, '😔 Lo siento, no hay productos disponibles para esa categoría.');
    }
    for (const p of productos) {
      console.log('📤 Enviando producto:', p.codigo);
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

// Lógica de ChatGPT con memoria y triggers
async function enviarConsultaChatGPT(user, mensaje) {
  try {
    if (!memoriaConversacion[user]) memoriaConversacion[user] = [];
    memoriaConversacion[user].push({ role: 'user', content: mensaje });
    contadorMensajesAsesor[user] = (contadorMensajesAsesor[user] || 0) + 1;

    const contexto = [
      { role: 'system', content: `${systemPrompt}\nDatos catálogo: ${JSON.stringify(data)}` },
      ...memoriaConversacion[user]
    ];

    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model: 'gpt-4o', messages: contexto },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    const texto = resp.data.choices[0].message.content.trim();
    memoriaConversacion[user].push({ role: 'assistant', content: texto });

    if (texto.startsWith('MOSTRAR_MODELO:')) {
      const code = texto.split(':')[1].trim();
      const prod = Object.values(data).flat().find(x => x.codigo === code);
      return prod ? enviarInfoPromo(user, prod) : enviarMensajeTexto(user, '😔 No encontramos ese modelo.');
    }
    if (texto.startsWith('MOSTRAR_CATALOGO:')) {
      return enviarCatalogo(user, texto.split(':')[1].trim().toLowerCase());
    }
    if (texto === 'PEDIR_CATALOGO') {
      estadoUsuario[user] = 'ESPERANDO_GENERO';
      return enviarMensajeTexto(user, '😊 ¿Ver catálogo para caballeros o damas?');
    }
    if (texto.startsWith('PREGUNTAR_TIPO:')) {
      const gen = texto.split(':')[1].trim().toUpperCase();
      estadoUsuario[user] = `ESPERANDO_TIPO_${gen}`;
      return enviarSubmenuTipoReloj(user, gen);
    }
    return enviarMensajeConBotonSalir(user, texto);
  } catch (err) {
    console.error('❌ Error ChatGPT:', err);
    return enviarMensajeTexto(user, '⚠️ Hubo un problema con el asesor.');
  }
}

// Envío de promoción e info de producto
async function enviarInfoPromo(to, producto) {
  try {
    const promo = promoData[producto.codigo];
    if (promo) {
      await axios.post(
        `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to,
          type: 'image',
          image: { link: promo.imagen },
          caption: promo.descripcion
        },
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
      );
    }
    await enviarMensajeTexto(to, `*${producto.nombre}*\n${producto.descripcion}\n💲 ${producto.precio} soles\nCódigo: ${producto.codigo}`);
    await enviarMensajeConBotonSalir(to, '¿Necesitas algo más?');
  } catch (err) {
    console.error('❌ Error enviarInfoPromo:', err.response?.data || err.message);
  }
}

// Texto simple
async function enviarMensajeTexto(to, body) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, text: { body } },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    console.error('❌ Error enviarMensajeTexto:', err.response?.data || err.message);
  }
}

// Botón salir
async function enviarMensajeConBotonSalir(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text },
          action: { buttons: [{ type: 'reply', reply: { id: 'SALIR', title: '🔙 Salir' } }] }
        }
      },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    console.error('❌ Error enviarBotonSalir:', err.response?.data || err.message);
  }
}

app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
