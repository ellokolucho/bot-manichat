const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

// Carga de datos de catálogos y promociones y prompt del sistema
const data = require('./data.json');
console.log('📦 Categorías cargadas en data.json:', Object.keys(data));
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

// Inicia conversación principal
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

// Submenú tipo de reloj según género
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

// Envía catálogo de productos
async function enviarCatalogo(to, tipo) {
  console.log(`🔎 enviarCatalogo invocado con tipo='${tipo}', existe?`, data.hasOwnProperty(tipo));
  try {
    const productos = data[tipo];
    if (!productos || productos.length === 0) {
      await enviarMensajeTexto(to, '😔 Lo siento, no hay productos disponibles para esa categoría.');
      return;
    }
    for (const producto of productos) {
      await axios.post(
        `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          to,
          type: 'image',
          image: { link: producto.imagen },
          caption:
            `*${producto.nombre}*\n` +
            `${producto.descripcion}\n` +
            `💲 ${producto.precio} soles\n` +
            `Código: ${producto.codigo}`
        },
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
      );
    }
    await enviarMensajeConBotonSalir(to, '¿Deseas ver otra sección?');
  } catch (error) {
    console.error('❌ Error enviando catálogo:', error.response?.data || error.message);
  }
}

// Lógica de ChatGPT con memoria y triggers usando axios
async function enviarConsultaChatGPT(senderId, mensajeCliente) {
  try {
    if (!memoriaConversacion[senderId]) memoriaConversacion[senderId] = [];
    memoriaConversacion[senderId].push({ role: 'user', content: mensajeCliente });
    if (!contadorMensajesAsesor[senderId]) contadorMensajesAsesor[senderId] = 0;
    contadorMensajesAsesor[senderId]++;

    const contexto = [
      { role: 'system', content: `${systemPrompt}\nAquí tienes los datos del catálogo: ${JSON.stringify(data, null, 2)}` },
      ...memoriaConversacion[senderId]
    ];

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model: 'gpt-4o', messages: contexto },
      { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    const respuesta = response.data.choices[0].message.content.trim();
    memoriaConversacion[senderId].push({ role: 'assistant', content: respuesta });

    if (respuesta.startsWith('MOSTRAR_MODELO:')) {
      const codigo = respuesta.split(':')[1].trim();
      const producto = Object.values(data).flat().find(p => p.codigo === codigo);
      if (producto) {
        await enviarInfoPromo(senderId, producto);
      } else {
        await enviarMensajeTexto(senderId, '😔 Lo siento, no encontramos ese modelo en nuestra base de datos.');
      }
      return;
    }

    if (respuesta.startsWith('MOSTRAR_CATALOGO:')) {
      const categoria = respuesta.split(':')[1].trim().toLowerCase();
      await enviarCatalogo(senderId, categoria);
      return;
    }

    if (respuesta === 'PEDIR_CATALOGO') {
      await enviarMensajeTexto(senderId, '😊 Claro que sí. ¿El catálogo que deseas ver es para caballeros o para damas?');
      estadoUsuario[senderId] = 'ESPERANDO_GENERO';
      return;
    }

    if (respuesta.startsWith('PREGUNTAR_TIPO:')) {
      const genero = respuesta.split(':')[1].trim().toUpperCase();
      estadoUsuario[senderId] = `ESPERANDO_TIPO_${genero}`;
      await enviarSubmenuTipoReloj(senderId, genero);
      return;
    }

    await enviarMensajeConBotonSalir(senderId, respuesta);
  } catch (error) {
    console.error('❌ Error en consulta a ChatGPT:', error);
    await enviarMensajeTexto(senderId, '⚠️ Lo siento, hubo un problema al conectarme con el asesor. Intenta nuevamente en unos minutos.');
  }
}

// Envía promociones e info de producto
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
          caption: `${promo.descripcion}`
        },
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
      );
    }
    await enviarMensajeTexto(to, `*${producto.nombre}*\n${producto.descripcion}\n💲 ${producto.precio} soles\nCódigo: ${producto.codigo}`);
    await enviarMensajeConBotonSalir(to, '¿Necesitas algo más?');
  } catch (error) {
    console.error('❌ Error enviando promoción:', error.response?.data || error.message);
  }
}

// Envía mensaje simple de texto
async function enviarMensajeTexto(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, text: { body: text } },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );
  } catch (error) {
    console.error('❌ Error enviando mensaje de texto:', error.response?.data || error.message);
  }
}

// Envía texto con botón para volver al inicio
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
  } catch (error) {
    console.error('❌ Error enviando botón salir:', error.response?.data || error.message);
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://0.0.0.0:${PORT}`);
});
