const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

// Carga de datos de catálogos y promociones y prompt del sistema
const data = require('./data.json');
const promoData = require('./promoData.json');
const systemPrompt = fs.readFileSync('./SystemPrompt.txt', 'utf-8');

// Logueo de categorías disponibles (debug)
console.log('📦 Categorías cargadas en data.json:', Object.keys(data));

// Memoria de conversaciones y estados de flujo
const memoriaConversacion = {};
const contadorMensajesAsesor = {};
const estadoUsuario = {};

const app = express();
app.use(bodyParser.json());

const token = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;
const PORT = process.env.PORT || 3000;

// Endpoint de verificación del webhook
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

// Recepción de mensajes y flujos interactivos
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

    // Manejo de botones interactivos
    if (type === 'interactive' && message.interactive?.button_reply?.id) {
      const buttonId = message.interactive.button_reply.id;
      console.log('🛠 Botón recibido:', buttonId);
      switch (buttonId) {
        case 'CABALLEROS':
          await enviarSubmenuTipoReloj(from, 'CABALLEROS');
          break;
        case 'DAMAS':
          await enviarSubmenuTipoReloj(from, 'DAMAS');
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
      return res.sendStatus(200);
    }

    // Manejo de mensajes de texto libres: ChatGPT
    if (type === 'text' && text) {
      await enviarConsultaChatGPT(from, text);
      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

// Función para enviar menú principal
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
  } catch (error) {
    console.error('❌ Error enviando menú principal:', error.response?.data || error.message);
  }
}

// Submenú de tipo de reloj según género
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
  } catch (error) {
    console.error('❌ Error enviando submenu:', error.response?.data || error.message);
  }
}

// Función para enviar catálogo de productos
// Envía catálogo de productos
async function enviarCatalogo(to, tipo) {
  // Debug: invocación y comprobación de clave
  console.log(`🔎 enviarCatalogo invocado con tipo='${tipo}', existe?`, data.hasOwnProperty(tipo));
  await enviarMensajeTexto(to, `⚠️ Debug: enviarCatalogo('${tipo}') invocado`);

  try {
    // Lectura del array de productos
    const productos = data[tipo];

    // Debug: conteo y códigos de productos disponibles
    console.log(`🔎 Productos a enviar (${tipo}):`, productos.length, productos.map(p => p.codigo));
    await enviarMensajeTexto(to, `🔔 Debug: ${productos.length} productos detectados: ${productos.map(p => p.nombre).join(', ')}`);

    if (!productos || productos.length === 0) {
      await enviarMensajeTexto(to, '😔 Lo siento, no hay productos disponibles para esa categoría.');
      return;
    }

    // Envío de cada producto con manejo de errores individual
    for (const producto of productos) {
      try {
        console.log('📤 Enviando imagen de:', producto.codigo, producto.imagen);
        await axios.post(
          `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
          {
            messaging_product: 'whatsapp',
            to,
            type: 'image',
            image: { link: producto.imagen },
            caption:
              `*${producto.nombre}*
` +
              `${producto.descripcion}
` +
              `💲 ${producto.precio} soles
` +
              `Código: ${producto.codigo}`
          },
          { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
        );
        console.log('✅ Imagen enviada:', producto.codigo);
      } catch (err) {
        console.error('❌ Falló al enviar imagen', producto.codigo, err.response?.data || err.message);
        await enviarMensajeTexto(to, `⚠️ Error enviando ${producto.nombre}: ${err.message}`);
      }
    }

    // Botón de regreso al inicio
    await enviarMensajeConBotonSalir(to, '¿Deseas ver otra sección?');
  } catch (error) {
    console.error('❌ Error enviando catálogo:', error.response?.data || error.message);
  }
}

// Resto de funciones (ChatGPT, promociones e info, mensajes)...
// (se mantienen igual)

app.listen(PORT, () => console.log(`🚀 Servidor escuchando en puerto ${PORT}`));
