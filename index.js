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
const primerMensaje = {};
const avisoEnviado = {};
const provinciaPagosEnviados = {};
const timersInactividad = {};

// Credenciales y configuración
const token = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;
const PORT = process.env.PORT || 3000;

const app = express();
app.use(bodyParser.json());

// Funciones de gestión de inactividad
function limpiarTimers(senderId) {
  if (timersInactividad[senderId]) {
    clearTimeout(timersInactividad[senderId].timer10);
    clearTimeout(timersInactividad[senderId].timer12);
    delete timersInactividad[senderId];
  }
}

function reiniciarTimerInactividad(senderId) {
  limpiarTimers(senderId);
  timersInactividad[senderId] = {};
  timersInactividad[senderId].timer10 = setTimeout(() => enviarAvisoInactividad(senderId), 10 * 60 * 1000);
  timersInactividad[senderId].timer12 = setTimeout(() => finalizarSesion(senderId), 12 * 60 * 1000);
}

async function enviarAvisoInactividad(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        text: { body: "¿Podemos ayudarte en algo más? 😊 Escribe 'menu' para volver al inicio." }
      },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );
  } catch (error) {
    console.error('❌ Error enviando aviso de inactividad:', error.response?.data || error.message);
  }
}

async function finalizarSesion(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        text: { body: "⏳ Tu sesión ha terminado. ¡Gracias por visitar Tiendas Megan!" }
      },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );
  } catch (error) {
    console.error('❌ Error finalizando sesión:', error.response?.data || error.message);
  }
  delete estadoUsuario[to];
  delete memoriaConversacion[to];
  delete contadorMensajesAsesor[to];
  delete primerMensaje[to];
  delete avisoEnviado[to];
  delete provinciaPagosEnviados[to];
  limpiarTimers(to);
}

// Verificación del webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const tokenFromMeta = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && tokenFromMeta === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Recepción de mensajes
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (
    body.object && body.entry && body.entry[0].changes &&
    body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]
  ) {
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from;
    const type = message.type;

    // Manejo de botones interactivos
    if (type === 'interactive' && message.interactive?.button_reply?.id) {
      const buttonId = message.interactive.button_reply.id;
      switch (buttonId) {
        case 'CABALLEROS':
        case 'DAMAS':
          await enviarSubmenuTipoReloj(from, buttonId);
          break;
        case 'CABALLEROS_AUTO':
        case 'CABALLEROS_CUARZO':
        case 'DAMAS_AUTO':
        case 'DAMAS_CUARZO':
          await enviarCatalogo(from, buttonId.toLowerCase());
          break;
        case 'ASESOR':
          estadoUsuario[from] = 'ASESOR';
          memoriaConversacion[from] = [];
          contadorMensajesAsesor[from] = 0;
          await enviarMensajeConBotonSalir(from, '😊 ¡Claro que sí! Escribe tu consulta y nuestro asesor te atenderá.');
          break;
        case 'SALIR_ASESOR':
          delete estadoUsuario[from];
          delete memoriaConversacion[from];
          delete contadorMensajesAsesor[from];
          await enviarMenuPrincipal(from);
          break;
        default:
          if (buttonId.startsWith('COMPRAR_')) {
            await enviarPreguntaUbicacion(from);
          } else if (buttonId === 'UBICACION_LIMA') {
            estadoUsuario[from] = 'ESPERANDO_DATOS_LIMA';
            avisoEnviado[from] = false;
            await enviarMensajeTexto(from,
              "😊 Claro que sí. Por favor, para enviar tu pedido indícanos los siguientes datos:\n\n" +
              "✅ Nombre completo ✍️\n" +
              "✅ Número de WhatsApp 📱\n" +
              "✅ Dirección exacta 📍\n" +
              "✅ Una referencia de cómo llegar a tu domicilio 🏠"
            );
          } else if (buttonId === 'UBICACION_PROVINCIA') {
            estadoUsuario[from] = 'ESPERANDO_DATOS_PROVINCIA';
            avisoEnviado[from] = false;
            provinciaPagosEnviados[from] = false;
            await enviarMensajeTexto(from,
              "😊 Claro que sí. Por favor, permítenos los siguientes datos para programar tu pedido:\n\n" +
              "✅ Nombre completo ✍️\n" +
              "✅ DNI 🪪\n" +
              "✅ Número de WhatsApp 📱\n" +
              "✅ Agencia Shalom que te quede más cerca 🚚"
            );
          } else {
            await enviarMensajeTexto(from, '❓ No entendí tu selección, por favor intenta de nuevo.');
          }
      }
      return res.sendStatus(200);
    }

    // Manejo de mensajes de texto
    if (type === 'text' && message.text?.body) {
      const text = message.text.body.trim();
      const mensaje = text.toLowerCase();

      reiniciarTimerInactividad(from);

      // Salir del modo asesor
      if (estadoUsuario[from] === 'ASESOR' && mensaje === 'salir') {
        delete estadoUsuario[from];
        delete memoriaConversacion[from];
        delete contadorMensajesAsesor[from];
        await enviarMensajeTexto(from, '🚪 Has salido del chat con asesor.');
        await enviarMenuPrincipal(from);
        return res.sendStatus(200);
      }

      // Respuesta a "gracias"
if (/^(gracias|muchas gracias|mil gracias|gracias!|gracias \:\))$/i.test(mensaje)) {
  await enviarMensajeTexto(from, '😄 ¡Gracias a ti! Estamos para servirte.');
  return res.sendStatus(200);
}


      // Flujos de compra (texto libre)
      if (estadoUsuario[from] === 'ESPERANDO_DATOS_LIMA' || estadoUsuario[from] === 'ESPERANDO_DATOS_PROVINCIA') {
        await manejarFlujoCompra(from, text);
        return res.sendStatus(200);
      }

      // Disparadores de promociones y menú
      if (mensaje.includes('me interesa este reloj exclusivo')) {
        const producto = data.caballeros_automaticos[0];
        await enviarInfoPromo(from, producto);
        return res.sendStatus(200);
      }
      if (mensaje.includes('me interesa este reloj de lujo')) {
        const producto = data.damas_cuarzo[0];
        await enviarInfoPromo(from, producto);
        return res.sendStatus(200);
      }
      if (mensaje.includes('ver otros modelos') || mensaje === 'menu' || mensaje === 'hola') {
        await enviarMenuPrincipal(from);
        return res.sendStatus(200);
      }

      // ChatGPT con primer mensaje ignorado
      if (!primerMensaje[from]) {
        primerMensaje[from] = true;
        return res.sendStatus(200);
      }
      await enviarConsultaChatGPT(from, text);
      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

// Función: menú principal
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

// Submenú de tipo de reloj
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

n            buttons: [
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

// Enviar catálogo de productos
async function enviarCatalogo(to, tipo) {
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

// ChatGPT con memoria y triggers
async function enviarConsultaChatGPT(from, mensajeCliente) {
  try {
    memoriaConversacion[from].push({ role: 'user', content: mensajeCliente });
    contadorMensajesAsesor[from]++;
    const contexto = [
      { role: 'system', content: `${systemPrompt}\nAquí tienes los datos del catálogo: ${JSON.stringify(data, null, 2)}` },
      ...memoriaConversacion[from]
    ];
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model: 'gpt-4o', messages: contexto },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    const respuesta = response.data.choices[0].message.content.trim();
    memoriaConversacion[from].push({ role: 'assistant', content: respuesta });
    if (respuesta.startsWith('MOSTRAR_MODELO:')) {
      const codigo = respuesta.split(':')[1].trim();
      const producto = Object.values(data).flat().find(p => p.codigo === codigo);
      if (producto) await enviarInfoPromo(from, producto);
      else await enviarMensajeTexto(from, '😔 Lo siento, no encontramos ese modelo.');
      return;
    }
    if (respuesta.startsWith('MOSTRAR_CATALOGO:')) {
      const categoria = respuesta.split(':')[1].trim().toLowerCase();
      await enviarCatalogo(from, categoria);
      return;
    }
    if (respuesta === 'PEDIR_CATALOGO') {
      await enviarMensajeTexto(from, '😊 Claro que sí. ¿El catálogo que deseas ver es para caballeros o para damas?');
      estadoUsuario[from] = 'ESPERANDO_GENERO';
      return;
    }
    if (respuesta.startsWith('PREGUNTAR_TIPO:')) {
      const genero = respuesta.split(':')[1].trim().toUpperCase();
      estadoUsuario[from] = `ESPERANDO_TIPO_${genero}`;
      await enviarSubmenuTipoReloj(from, genero);
      return;
    }
    await enviarMensajeConBotonSalir(from, respuesta);
  } catch (error) {
    console.error('❌ Error en consulta a ChatGPT:', error.response?.data || error.message);
    await enviarMensajeTexto(from, '⚠️ Lo siento, hubo un problema al conectarme al asesor.');
  }
}

// Enviar info/promoción de producto
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

// Enviar texto simple
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

// Enviar botón de volver al inicio (adaptado movilizar Messenger)
async function enviarMensajeConBotonSalir(to, text) {
  try {
    // Antes de 6 intercambios, solo texto
    if (!contadorMensajesAsesor[to] || contadorMensajesAsesor[to] < 6) {
      await enviarMensajeTexto(to, text);
      return;
    }
    // Después de 6 intercambios, mostramos botón
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text },
          action: { buttons: [{ type: 'reply', reply: { id: 'SALIR_ASESOR', title: '↩️ Volver al inicio' } }] }
        }
      },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );
  } catch (error) {
    console.error('❌ Error enviando botón salir:', error.response?.data || error.message);
  }
}

// Manejar flujo de compra
async function manejarFlujoCompra(from, mensaje) {
  const tieneCelular = /\b9\d{8}\b/.test(mensaje);
  const tieneNombre = /^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)(\s+[A-ZÁÉÍÓÚÑ]?[a-záéíóúñ]+){1,3}$/.test(mensaje);
  const tieneDireccion = /(jirón|jr\.|avenida|av\.|calle|pasaje|mz|mza|lote|urb\.|urbanización)/i.test(mensaje);
  const tieneDNI = /\b\d{8}\b/.test(mensaje);

  if (estadoUsuario[from] === 'ESPERANDO_DATOS_PROVINCIA') {
    if (!tieneNombre) return enviarMensajeTexto(from, '📌 Por favor envía tu nombre completo.');
    if (!tieneDNI) return enviarMensajeTexto(from, '📌 Tu DNI debe tener 8 dígitos.');
    if (!tieneCelular) return enviarMensajeTexto(from, '📌 Tu número de WhatsApp debe tener 9 dígitos y comenzar con 9.');
    await enviarMensajeTexto(from,
      "✅ Tu orden ha sido confirmada ✔\nEnvío de: 1 Reloj Premium\n" +
      "👉 Forma: Envío a recoger en Agencia Shalom\n" +
      "👉 Datos recibidos correctamente.\n"
    );
    await enviarMensajeTexto(from,
      "😊 Estimado cliente, para enviar tu pedido necesitamos un adelanto de 20 soles:\n\n" +
      "📱 YAPE: 979 434 826 (Paulina Gonzales Ortega)\n" +
      "🏦 BCP: 19303208489096\n" +
      "🏦 CCI: 00219310320848909613\n\n" +
      "📤 Envía la captura de tu pago aquí para registrar tu adelanto."
    );
    provinciaPagosEnviados[from] = true;
    delete estadoUsuario[from];
    return;
  }

  if (estadoUsuario[from] === 'ESPERANDO_DATOS_LIMA') {
    if (!tieneNombre) return enviarMensajeTexto(from, '📌 Por favor envía tu nombre completo.');
    if (!tieneCelular) return enviarMensajeTexto(from, '📌 Tu número de WhatsApp debe tener 9 dígitos y comenzar con 9.');
    if (!tieneDireccion) return enviarMensajeTexto(from, '📌 Tu dirección debe incluir calle, avenida, jirón o pasaje.');
    await enviarMensajeTexto(from,
      "✅ Tu orden ha sido confirmada ✔\nEnvío de: 1 Reloj Premium\n" +
      "👉 Forma: Envío express a domicilio\n" +
      "👉 Datos recibidos correctamente.\n" +
      "💰 El costo incluye S/10 adicionales por envío a domicilio."
    );
    delete estadoUsuario[from];
    return;
  }

  if (!avisoEnviado[from]) {
    await enviarMensajeTexto(from,
      "📌 Por favor, asegúrate de enviar datos correctos (nombre, WhatsApp, DNI/dirección y agencia Shalom)."
    );
    avisoEnviado[from] = true;
  }
}

// Iniciar servidor
app.listen(PORT, () => console.log(`🚀 Servidor escuchando en http://0.0.0.0:${PORT}`));
