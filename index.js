const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();
const OpenAI = require('openai');

// Carga de datos de catálogos y promociones y prompt del sistema
const data = require('./data.json');
const promoData = require('./promoData.json');
const systemPrompt = fs.readFileSync('./SystemPrompt.txt', 'utf-8');

// Memoria de conversaciones y estados de flujo
const memoriaConversacion = {};
const contadorMensajesAsesor = {};
const estadoUsuario = {};
let primerMensaje = {};
let timersInactividad = {};

const app = express();
app.use(bodyParser.json());

const token = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

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

// ✅ Funciones para gestionar la inactividad del usuario
function reiniciarTimerInactividad(senderId) {
  if (timersInactividad[senderId]) {
    clearTimeout(timersInactividad[senderId].timer10);
    clearTimeout(timersInactividad[senderId].timer12);
  }

  timersInactividad[senderId] = {};

  timersInactividad[senderId].timer10 = setTimeout(() => {
    enviarAvisoInactividad(senderId);
  }, 10 * 60 * 1000);

  timersInactividad[senderId].timer12 = setTimeout(() => {
    finalizarSesion(senderId);
  }, 12 * 60 * 1000);
}

async function enviarAvisoInactividad(senderId) {
  try {
    const text = "¿Podemos ayudarte en algo más? 😊 También puedes continuar tu pedido por WhatsApp:";
    await enviarMensajeConBotonSalir(senderId, text);
  } catch (error) {
    console.error('❌ Error enviando aviso de inactividad:', error.response?.data || error.message);
  }
}

async function finalizarSesion(senderId) {
  try {
    delete estadoUsuario[senderId];
    delete memoriaConversacion[senderId];
    delete contadorMensajesAsesor[senderId];

    await enviarMensajeTexto(senderId, "⏳ Tu sesión ha terminado. ¡Gracias por visitar Tiendas Megan!");
  } catch (error) {
    console.error('❌ Error finalizando sesión:', error.response?.data || error.message);
  }
}


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
    const type = message.type;

    reiniciarTimerInactividad(from);

    // --- MANEJO DE BOTONES (SIN CAMBIOS) ---
    if (type === 'interactive' && message.interactive?.button_reply?.id) {
      const buttonId = message.interactive.button_reply.id;
      switch (buttonId) {
        case 'CABALLEROS':
        case 'DAMAS':
          await enviarSubmenuTipoReloj(from, buttonId);
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
          estadoUsuario[from] = 'ASESOR';
          memoriaConversacion[from] = [];
          contadorMensajesAsesor[from] = 0;
          await enviarMensajeConBotonSalir(from, "😊 ¡Claro que sí! Estamos listos para responder todas sus dudas y consultas. Por favor, escríbenos qué te gustaría saber ✍️");
          break;
        case 'SALIR':
          delete estadoUsuario[from];
          delete memoriaConversacion[from];
          delete contadorMensajesAsesor[from];
          await enviarMensajeTexto(from, "🚪 Has salido del chat con asesor. Volviendo al menú principal...");
          await enviarMenuPrincipal(from);
          break;
        case 'COMPRAR_LIMA':
          estadoUsuario[from] = 'ESPERANDO_DATOS_LIMA';
          await enviarMensajeTexto(from, "😊 Claro que sí. Por favor, para enviar su pedido indíquenos los siguientes datos:\n\n✅ Nombre completo ✍️\n✅ Número de WhatsApp 📱\n✅ Dirección exacta 📍\n✅ Una referencia de cómo llegar a su domicilio 🏠");
          break;
        case 'COMPRAR_PROVINCIA':
          estadoUsuario[from] = 'ESPERANDO_DATOS_PROVINCIA';
          await enviarMensajeTexto(from, "😊 Claro que sí. Por favor, permítanos los siguientes datos para programar su pedido:\n\n✅ Nombre completo ✍️\n✅ DNI 🪪\n✅ Número de WhatsApp 📱\n✅ Agencia Shalom que le queda más cerca 🚚");
          break;
        case 'COMPRAR_PRODUCTO':
          await enviarPreguntaUbicacion(from);
          break;
        default:
          await enviarMensajeTexto(from, '❓ No entendí tu selección, por favor intenta de nuevo.');
      }
      return res.sendStatus(200);
    }

    // --- NUEVA LÓGICA PARA MENSAJES DE TEXTO ---
    if (type === 'text') {
      const text = message.text.body;
      const mensaje = text.trim().toLowerCase();

      // PRIORIDAD 1: Flujos activos (el bot espera datos)
      if (estadoUsuario[from] === 'ESPERANDO_DATOS_LIMA' || estadoUsuario[from] === 'ESPERANDO_DATOS_PROVINCIA') {
        await manejarFlujoCompra(from, text);
        return res.sendStatus(200);
      }
      if (estadoUsuario[from] === 'ASESOR') {
        if (mensaje === 'salir') {
            delete estadoUsuario[from];
            delete memoriaConversacion[from];
            delete contadorMensajesAsesor[from];
            await enviarMensajeTexto(from, "🚪 Has salido del chat con asesor.");
            await enviarMenuPrincipal(from);
        } else {
            await enviarConsultaChatGPT(from, text);
        }
        return res.sendStatus(200);
      }

      // PRIORIDAD 2: Comandos específicos (ej. "gracias")
      if (/^(gracias|muchas gracias|mil gracias)$/i.test(mensaje)) {
        await enviarMensajeTexto(from, "😄 ¡De nada! Estamos para servirle.");
        return res.sendStatus(200);
      }

      // PRIORIDAD 3: Lógica por defecto (Primera interacción vs. ChatGPT)
      if (primerMensaje[from]) {
        // Si no es la primera interacción, cualquier texto libre va a ChatGPT
        await enviarConsultaChatGPT(from, text);
      } else {
        // Si es la primera interacción del usuario, le mostramos el menú principal
        primerMensaje[from] = true; // Marcamos que ya tuvimos la primera interacción
        await enviarMenuPrincipal(from);
      }
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
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: '👋 ¡Hola! Bienvenido a Tiendas Megan\n💎 Descubre tu reloj ideal o el regalo perfecto 🎁' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'CABALLEROS', title: 'Para Caballeros' } },
              { type: 'reply', reply: { id: 'DAMAS', title: 'Para Damas' } },
              { type: 'reply', reply: { id: 'ASESOR', title: 'Hablar con Asesor' } }
            ]
          }
        }
      },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );
  } catch (error) {
    console.error('❌ Error enviando menú principal:', JSON.stringify(error.response.data));
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
        recipient_type: 'individual',
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
    console.error('❌ Error enviando submenu:', JSON.stringify(error.response.data));
  }
}

// ✅✅✅ --- FUNCIÓN CON PAUSA AÑADIDA --- ✅✅✅
async function enviarCatalogo(to, tipo) {
  try {
    const productos = data[tipo];
    if (!productos || !productos.length) {
      await enviarMensajeTexto(to, '😔 Lo siento, no hay productos disponibles para esa categoría.');
      return;
    }

    for (const producto of productos) {
      try {
        // PASO 1: Enviar la imagen
        await axios.post(
          `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
          {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: to,
            type: 'image',
            image: { link: producto.imagen }
          },
          { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
        );

        // Añadimos una pausa de 1.5 segundos (1500 milisegundos)
        await new Promise(resolve => setTimeout(resolve, 1500)); 

      } catch (imageError) {
        console.error(`❌ Fallo al enviar imagen para producto ${producto.codigo}:`, imageError.response ? JSON.stringify(imageError.response.data) : imageError.message);
        await enviarMensajeTexto(to, `⚠️ No se pudo cargar la imagen para *${producto.nombre}*.`);
      }

      // PASO 2: Enviar el texto y botón
      const detallesProducto =
        `*${producto.nombre}*\n` +
        `${producto.descripcion}\n` +
        `💲 ${producto.precio} soles\n` +
        `Código: ${producto.codigo}`;
      
      await enviarMensajeConBotonComprar(to, detallesProducto);
    }
    
  } catch (error) {
    console.error(`❌ Error fatal en la función enviarCatalogo para el tipo "${tipo}":`, error.message);
    if (error.response) {
      console.error('❌ Datos del error de la API de Meta:', JSON.stringify(error.response.data, null, 2));
    }
    await enviarMensajeTexto(to, '⚠️ Tuvimos un problema al mostrar el catálogo. Por favor, intenta de nuevo más tarde.');
  }
}

// Lógica de ChatGPT con memoria y triggers
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

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: contexto
    });

    const respuesta = response.choices[0].message.content.trim();
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
    
    // Si no hay trigger, enviamos la respuesta normal
    if (!contadorMensajesAsesor[senderId] || contadorMensajesAsesor[senderId] < 6) {
      await enviarMensajeTexto(senderId, respuesta);
    } else {
      await enviarMensajeConBotonSalir(senderId, respuesta);
    }

  } catch (error) {
    console.error('❌ Error en consulta a ChatGPT:', error);
    await enviarMensajeTexto(senderId, '⚠️ Lo siento, hubo un problema al conectarme con el asesor. Intenta nuevamente en unos minutos.');
  }
}


async function manejarFlujoCompra(senderId, mensaje) {
  const tieneCelular = /\b9\d{8}\b/.test(mensaje);
  const tieneNombre = /^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)(\s+[A-ZÁÉÍÓÚÑ]?[a-záéíóúñ]+){1,3}$/.test(mensaje);
  const tieneDireccion = /(jirón|jr\.|avenida|av\.|calle|pasaje|mz|mza|lote|urb\.|urbanización)/i.test(mensaje);
  const tieneDNI = /\b\d{8}\b/.test(mensaje);

  if (estadoUsuario[senderId] === 'ESPERANDO_DATOS_PROVINCIA') {
    if (!tieneNombre) return await enviarMensajeTexto(senderId, "📌 Por favor envíe su nombre completo.");
    if (!tieneDNI) return await enviarMensajeTexto(senderId, "📌 Su DNI debe tener 8 dígitos. Por favor, envíelo correctamente.");
    if (!tieneCelular) return await enviarMensajeTexto(senderId, "📌 Su número de WhatsApp debe tener 9 dígitos y comenzar con 9.");

    await enviarMensajeTexto(senderId,
      "✅ Su orden ha sido confirmada ✔\nEnvío de: 1 Reloj Premium\n" +
      "👉 Forma: Envío a recoger en Agencia Shalom\n" +
      "👉 Datos recibidos correctamente.\n");

    await enviarMensajeTexto(senderId,
      "😊 Estimado cliente, para enviar su pedido necesitamos un adelanto simbólico de 20 soles por motivo de seguridad.\n\n" +
      "📱 YAPE: 979 434 826 (Paulina Gonzales Ortega)\n" +
      "🏦 BCP: 19303208489096\n" +
      "🏦 CCI: 00219310320848909613\n\n" +
      "📤 Envíe la captura de su pago aquí para registrar su adelanto.");
    delete estadoUsuario[senderId];
    return;
  }

  if (estadoUsuario[senderId] === 'ESPERANDO_DATOS_LIMA') {
    if (!tieneNombre) return await enviarMensajeTexto(senderId, "📌 Por favor envíe su nombre completo.");
    if (!tieneCelular) return await enviarMensajeTexto(senderId, "📌 Su número de WhatsApp debe tener 9 dígitos y comenzar con 9.");
    if (!tieneDireccion) return await enviarMensajeTexto(senderId, "📌 Su dirección debe incluir calle, avenida, jirón o pasaje.");

    await enviarMensajeTexto(senderId,
      "✅ Su orden ha sido confirmada ✔\nEnvío de: 1 Reloj Premium\n" +
      "👉 Forma: Envío express a domicilio\n" +
      "👉 Datos recibidos correctamente.\n" +
      "💰 El costo incluye S/10 adicionales por envío a domicilio.");

    delete estadoUsuario[senderId];
    return;
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
          recipient_type: 'individual',
          to,
          type: 'image',
          image: { link: promo.imagen, caption: `${promo.descripcion}` }
        },
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
      );
    }
    const productInfo = `*${producto.nombre}*\n${producto.descripcion}\n💲 ${producto.precio} soles\nCódigo: ${producto.codigo}`;
    await enviarMensajeTexto(to, productInfo);
    await enviarMensajeConBotonSalir(to, '¿Necesitas algo más?');
  } catch (error) {
    console.error('❌ Error enviando promoción:', JSON.stringify(error.response.data));
  }
}

// Envía mensaje simple de texto
async function enviarMensajeTexto(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to, text: { body: text } },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );
  } catch (error) {
    console.error('❌ Error enviando mensaje de texto:', JSON.stringify(error.response.data));
  }
}

// Envía texto con botón para volver al inicio
async function enviarMensajeConBotonSalir(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
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
    console.error('❌ Error enviando botón salir:', JSON.stringify(error.response.data));
  }
}

// 🆕 Nueva función para enviar el botón de comprar
async function enviarMensajeConBotonComprar(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text },
          action: { buttons: [{ type: 'reply', reply: { id: 'COMPRAR_PRODUCTO', title: '🛍️ Comprar' } }] }
        }
      },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );
  } catch (error) {
    console.error('❌ Error enviando botón de comprar:', JSON.stringify(error.response.data));
  }
}

// Pregunta si el pedido es para Lima o Provincia
async function enviarPreguntaUbicacion(senderId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: senderId,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: "😊 Por favor indíquenos, ¿su pedido es para Lima o para Provincia?" },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'COMPRAR_LIMA', title: '🏙 Lima' } },
              { type: 'reply', reply: { id: 'COMPRAR_PROVINCIA', title: '🏞 Provincia' } }
            ]
          }
        }
      },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );
  } catch (error) {
    console.error('❌ Error enviando pregunta de ubicación:', JSON.stringify(error.response.data));
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://0.0.0.0:${PORT}`);
});