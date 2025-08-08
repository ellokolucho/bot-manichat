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
let pedidoActivo = {}; // NUEVO: Para recordar el producto que se está comprando

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

// Funciones para gestionar la inactividad del usuario
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
    const text = "¿Podemos ayudarle en algo más? 😊 También puede continuar su pedido por WhatsApp:";
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
    delete primerMensaje[senderId];
    delete pedidoActivo[senderId]; // Limpiamos el pedido activo

    await enviarMensajeTexto(senderId, "⏳ Su sesión ha terminado. ¡Gracias por visitar Tiendas Megan!");
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

    // --- MANEJO DE BOTONES ---
    if (type === 'interactive' && message.interactive?.button_reply?.id) {
      primerMensaje[from] = true;
      const buttonId = message.interactive.button_reply.id;

      if (buttonId.startsWith('COMPRAR_PRODUCTO_')) {
          const codigoProducto = buttonId.replace('COMPRAR_PRODUCTO_', '');
          pedidoActivo[from] = { codigo: codigoProducto }; // Guardamos el código del producto
          await enviarPreguntaUbicacion(from);
          return res.sendStatus(200);
      }

      switch (buttonId) {
        case 'VER_MODELOS':
          await enviarMenuPrincipal(from);
          break;
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
          await enviarMensajeConBotonSalir(from, "😊 ¡Claro que sí! Estamos listos para responder todas sus dudas y consultas. Por favor, escríbanos qué le gustaría saber ✍️");
          break;
        case 'SALIR':
          delete estadoUsuario[from];
          delete memoriaConversacion[from];
          delete contadorMensajesAsesor[from];
          await enviarMensajeTexto(from, "🚪 Ha salido del chat con asesor. Volviendo al menú principal...");
          await enviarMenuPrincipal(from);
          break;
        case 'COMPRAR_LIMA':
          estadoUsuario[from] = 'ESPERANDO_DATOS_LIMA';
          await enviarMensajeTexto(from, "😊 Claro que sí. Por favor, para enviar su pedido indíquenos los siguientes datos:\n\n✅ Nombre completo ✍️\n✅ Dirección exacta 📍\n✅ Una referencia de cómo llegar a su domicilio 🏠");
          break;
        case 'COMPRAR_PROVINCIA':
          estadoUsuario[from] = 'ESPERANDO_DATOS_PROVINCIA';
          await enviarMensajeTexto(from, "😊 Claro que sí. Por favor, permítanos los siguientes datos para programar su pedido:\n\n✅ Nombre completo ✍️\n✅ DNI 🪪\n✅ Agencia Shalom que le queda más cerca 🚚");
          break;
        default:
          await enviarMensajeTexto(from, '❓ No entendí su selección, por favor intenta de nuevo.');
      }
      return res.sendStatus(200);
    }

    // --- LÓGICA PARA MENSAJES DE TEXTO CON SISTEMA DE PRIORIDADES ---
    if (type === 'text') {
      const text = message.text.body;
      const mensaje = text.trim().toLowerCase();

      // PRIORIDAD 1: Flujos de Compra Activos
      if (estadoUsuario[from] === 'ESPERANDO_DATOS_LIMA' || estadoUsuario[from] === 'ESPERANDO_DATOS_PROVINCIA') {
        await manejarFlujoCompra(from, text);
        return res.sendStatus(200);
      }
      
      // PRIORIDAD 2: Flujo de Asesor Activo
      if (estadoUsuario[from] === 'ASESOR') {
        if (mensaje === 'salir') {
            delete estadoUsuario[from]; // Salir del modo asesor
            await enviarMensajeTexto(from, "🚪 Ha salido del chat con asesor.");
            await enviarMenuPrincipal(from);
        } else {
            await enviarConsultaChatGPT(from, text);
        }
        return res.sendStatus(200);
      }
      
      // PRIORIDAD 3: Detección de Intento de Compra (El "Interruptor")
      const contieneDNI = /\b\d{8}\b/.test(mensaje);
      const contieneDireccion = /(jirón|jr\.|avenida|av\.|calle|pasaje|mz|mza|lote|urb\.|urbanización)/i.test(mensaje);
      if (pedidoActivo[from] && (contieneDNI || contieneDireccion)) {
          await manejarFlujoCompra(from, text);
          return res.sendStatus(200);
      }

      // PRIORIDAD 4: Comandos Específicos y Promociones
      if (mensaje.includes('me interesa este reloj exclusivo')) {
          primerMensaje[from] = true;
          await enviarInfoPromo(from, promoData.reloj1);
          return res.sendStatus(200);
      }
      if (mensaje.includes('me interesa este reloj de lujo')) {
          primerMensaje[from] = true;
          await enviarInfoPromo(from, promoData.reloj2);
          return res.sendStatus(200);
      }
      if (/^(gracias|muchas gracias|mil gracias)$/i.test(mensaje)) {
        await enviarMensajeTexto(from, "😊 ¡De nada! Estamos para servirle.");
        return res.sendStatus(200);
      }

      // PRIORIDAD 5: Lógica por Defecto (ChatGPT o Menú Principal)
      if (primerMensaje[from]) {
        await enviarConsultaChatGPT(from, text);
      } else {
        primerMensaje[from] = true;
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
          body: { text: '👋 ¡Hola! Bienvenido a Tiendas Megan\n💎 Descubra su reloj ideal o el regalo perfecto 🎁' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'CABALLEROS', title: '🤵‍♂️ Para Caballeros' } },
              { type: 'reply', reply: { id: 'DAMAS', title: '💃 Para Damas' } },
              { type: 'reply', reply: { id: 'ASESOR', title: '💬 Hablar con Asesor' } }
            ]
          }
        }
      },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );
  } catch (error) {
    console.error('❌ Error enviando menú principal:', JSON.stringify(error.response?.data || error.message));
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
          body: { text: `✅ ¡Excelente elección! ¿Qué tipo de reloj para ${label} le gustaría ver?` },
          action: {
            buttons: [
              { type: 'reply', reply: { id: `${genero}_AUTO`, title: '⌚ Automáticos' } },
              { type: 'reply', reply: { id: `${genero}_CUARZO`, title: '⏱️ De cuarzo' } }
            ]
          }
        }
      },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );
  } catch (error) {
    console.error('❌ Error enviando submenu:', JSON.stringify(error.response?.data || error.message));
  }
}

// Envía catálogo de productos
async function enviarCatalogo(to, tipo) {
  try {
    const productos = data[tipo];
    if (!productos || !productos.length) {
      await enviarMensajeTexto(to, '😔 Lo siento, no hay productos disponibles en esa categoría.');
      return;
    }

    for (const producto of productos) {
      const detallesProducto =
        `*${producto.nombre}*\n` +
        `${producto.descripcion}\n` +
        `💲 ${producto.precio} soles`;

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          header: {
            type: 'image',
            image: { link: producto.imagen }
          },
          body: {
            text: detallesProducto
          },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: {
                  id: `COMPRAR_PRODUCTO_${producto.codigo}`,
                  title: '🛍️ Pedir este modelo'
                }
              }
            ]
          }
        }
      };
      
      await axios.post(
        `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
        payload,
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
      );
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    await enviarMensajeFinalCatalogo(to);
    
  } catch (error) {
    console.error(`❌ Error fatal en la función enviarCatalogo para el tipo "${tipo}":`, error.message);
    if (error.response) {
      console.error('❌ Datos del error de la API de Meta:', JSON.stringify(error.response.data, null, 2));
    }
    await enviarMensajeTexto(to, '⚠️ Tuvimos un problema al mostrar el catálogo. Por favor, intente de nuevo más tarde.');
  }
}

// Lógica de ChatGPT
async function enviarConsultaChatGPT(senderId, mensajeCliente) {
  try {
    if (!memoriaConversacion[senderId]) memoriaConversacion[senderId] = [];
    memoriaConversacion[senderId].push({ role: 'user', content: mensajeCliente });
    
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
    
    // Aquí podrías añadir lógica para que ChatGPT te devuelva triggers especiales
    // Por ahora, solo responde el texto.
    await enviarMensajeTexto(senderId, respuesta);

  } catch (error) {
    console.error('❌ Error en consulta a ChatGPT:', error);
    await enviarMensajeTexto(senderId, '⚠️ Lo siento, hubo un problema al conectarme con el asesor. Intente nuevamente en unos minutos.');
  }
}

// ===== FUNCIÓN DE VALIDACIÓN Y CIERRE DE COMPRA (MODIFICADA) =====
async function manejarFlujoCompra(senderId, mensaje) {
    // Primero, validamos que haya un producto seleccionado
    if (!pedidoActivo[senderId] || !pedidoActivo[senderId].codigo) {
        await enviarMensajeTexto(senderId, "😊 Veo que quiere hacer un pedido. Por favor, primero seleccione un modelo del catálogo para poder continuar.");
        return;
    }

    const dniRegex = /\b(\d{8})\b/;
    const dniMatch = mensaje.match(dniRegex);
    const tieneDireccion = /(jirón|jr\.|avenida|av\.|calle|pasaje|mz|mza|lote|urb\.|urbanización)/i.test(mensaje);

    let datosExtraidos = {
        nombre: mensaje.split('\n')[0].trim(), // Asume que el nombre es la primera línea
        dni: dniMatch ? dniMatch[1] : null,
        direccion: mensaje, // Guardamos todo el mensaje como dirección/agencia
        tipo: null
    };

    if (dniMatch) {
        datosExtraidos.tipo = 'Provincia';
    } else if (tieneDireccion) {
        datosExtraidos.tipo = 'Lima';
    } else {
        // Si no se puede determinar, pedimos que aclaren
        await enviarMensajeTexto(senderId, "📌 No pudimos identificar claramente sus datos. Por favor, asegúrese de incluir su DNI (para provincia) o su dirección (para Lima).");
        return;
    }

    // Mensaje de confirmación inicial
    await enviarMensajeTexto(senderId, `✅ ¡Su orden para ${datosExtraidos.tipo} ha sido confirmada! Un asesor se comunicará con usted en breve. ¡Gracias! 😊`);

    // Pausa de 5 segundos
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Generar y enviar el resumen
    await generarYEnviarResumen(senderId, datosExtraidos);
    
    // Limpiar estados
    delete estadoUsuario[senderId];
    delete pedidoActivo[senderId];
}


// ===== NUEVA FUNCIÓN PARA GENERAR EL RESUMEN DE LA ORDEN =====
async function generarYEnviarResumen(senderId, datos) {
    try {
        const codigoProducto = pedidoActivo[senderId]?.codigo;
        if (!codigoProducto) return;

        // Buscar el producto en ambos catálogos (normal y promo)
        let producto = Object.values(data).flat().find(p => p.codigo === codigoProducto);
        if (!producto) {
            producto = Object.values(promoData).find(p => p.codigo === codigoProducto);
        }

        if (!producto) {
            console.error(`❌ No se encontró el producto con el código ${codigoProducto} para generar el resumen.`);
            return;
        }

        let resumenTexto = `*Resumen de su Pedido* 📝\n\n`;
        resumenTexto += `*Nombre:* ${datos.nombre}\n`;
        
        if (datos.tipo === 'Provincia') {
            resumenTexto += `*DNI:* ${datos.dni}\n`;
            resumenTexto += `*Forma de Envío:* Envío a recoger en la agencia Shalom\n`;
            resumenTexto += `*Lugar:* ${datos.direccion}\n`; // El usuario pone la agencia aquí
        } else { // Lima
            resumenTexto += `*Forma de Envío:* Envío express a domicilio\n`;
            resumenTexto += `*Dirección:* ${datos.direccion}\n`;
        }

        resumenTexto += `*Monto a Pagar:* ${producto.precio} soles`;

        // Enviar el resumen con la imagen del producto
        await axios.post(
          `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
          {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: senderId,
            type: 'image',
            image: {
              link: producto.imagen,
              caption: resumenTexto
            }
          },
          { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
        );

    } catch (error) {
        console.error('❌ Error generando o enviando el resumen del pedido:', error.response ? JSON.stringify(error.response.data) : error.message);
        await enviarMensajeTexto(senderId, "⚠️ Tuvimos un problema al generar el resumen de su orden. Un asesor se comunicará de todas formas.");
    }
}


// Envía promociones e info de producto
async function enviarInfoPromo(to, producto) {
  if (!producto || !producto.nombre) {
    console.error('❌ Se intentó enviar una promo con datos inválidos o faltantes. Revisa tu promoData.json.');
    await enviarMensajeTexto(to, '⚠️ Lo siento, no pude encontrar los detalles de esa promoción en este momento.');
    return;
  }

  try {
    const detallesProducto =
      `*${producto.nombre}*\n` +
      `${producto.descripcion}\n` +
      `💰 Precio: ${producto.precio}`;

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: {
          type: 'image',
          image: { link: producto.imagen }
        },
        body: {
          text: detallesProducto
        },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: {
                id: `COMPRAR_PRODUCTO_${producto.codigo}`,
                title: '🛍️ Pedir este modelo'
              }
            },
            {
              type: 'reply',
              reply: {
                id: 'VER_MODELOS',
                title: '📖 Ver otros modelos'
              }
            }
          ]
        }
      }
    };

    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      payload,
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );

  } catch (error) {
    console.error(`❌ Error enviando promo para "${producto.nombre}":`, error.response ? JSON.stringify(error.response.data) : error.message);
    await enviarMensajeTexto(to, '⚠️ Lo siento, hubo un problema al mostrar esa promoción.');
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
    console.error('❌ Error enviando mensaje de texto:', JSON.stringify(error.response?.data || error.message));
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
    console.error('❌ Error enviando botón salir:', JSON.stringify(error.response?.data || error.message));
  }
}

// Envía el mensaje final del catálogo con un botón
async function enviarMensajeFinalCatalogo(to) {
  try {
    const textoAmigable = "✨ Tenemos estos modelos disponibles, ¿qué modelito le gustaría adquirir? 😉";

    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: textoAmigable },
          action: {
            buttons: [{
              type: 'reply',
              reply: {
                id: 'VER_MODELOS',
                title: '📖 Ver otros modelos'
              }
            }]
          }
        }
      },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );
  } catch (error) {
    console.error('❌ Error enviando mensaje final del catálogo:', JSON.stringify(error.response?.data || error.message));
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
          body: { text: "😊 Para coordinar el envío, por favor indíquenos, ¿para dónde es su pedido?" },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'COMPRAR_LIMA', title: '🏙️ Lima' } },
              { type: 'reply', reply: { id: 'COMPRAR_PROVINCIA', title: '🏞️ Provincia' } }
            ]
          }
        }
      },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );
  } catch (error) {
    console.error('❌ Error enviando pregunta de ubicación:', JSON.stringify(error.response?.data || error.message));
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://0.0.0.0:${PORT}`);
});