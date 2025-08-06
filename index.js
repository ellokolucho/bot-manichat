require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();
app.use(bodyParser.json());

// 🌐 Tokens
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// 🔹 Inicializar cliente OpenAI
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// 📥 Leer data.json y SystemPrompt.txt
const data = JSON.parse(fs.readFileSync('./data.json', 'utf8'));
const promoData = JSON.parse(fs.readFileSync('./promoData.json', 'utf8'));
const systemPrompt = fs.readFileSync('./SystemPrompt.txt', 'utf8');

// 🗂 Variables de control
let estadoUsuario = {};
let avisoEnviado = {};
let okEnviado = {};
let provinciaPagosEnviados = {};
let memoriaConversacion = {}; // 🆕 Memoria por usuario
let primerMensaje = {}; // 🆕 Bandera para saber si es el primer mensaje del usuario
let timersInactividad = {}; // ✅ NUEVO: control de inactividad por usuario
let contadorMensajesAsesor = {}; // ✅ NUEVO: Contador de mensajes por asesoría

// 🌐 WEBHOOK
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook verificado correctamente');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// 📩 MENSAJES ENTRANTES

// 🆕 Funciones para gestionar la inactividad del usuario
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

// Función para enviar aviso de inactividad al usuario por WhatsApp
async function enviarAvisoInactividad(senderId) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to: senderId,
      text: {
        body: "🤖 ¿Podemos ayudarte en algo más? También puedes continuar tu pedido por WhatsApp: https://wa.me/519048805167"
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WHATSAPP_TOKEN}`
      }
    });

  } catch (error) {
    console.error('❌ Error enviando aviso de inactividad:', error.response?.data || error.message);
  }
}

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages) return res.sendStatus(200);

    const message = messages[0];
    const senderId = message.from;
    const mensajeTexto = message.text?.body?.trim().toLowerCase();

    reiniciarTimerInactividad(senderId); // Reinicia inactividad

    // ✅ FLUJOS DE COMPRA
    if (estadoUsuario[senderId] === 'ESPERANDO_DATOS_LIMA' || estadoUsuario[senderId] === 'ESPERANDO_DATOS_PROVINCIA') {
      await manejarFlujoCompra(senderId, mensajeTexto);
      return res.sendStatus(200);
    }

    // ✅ RESPUESTA A “GRACIAS”
    if (/^(gracias|muchas gracias|mil gracias|gracias!|gracias :\))$/i.test(mensajeTexto)) {
      await enviarMensajeTexto(senderId, "😄 ¡Gracias a usted! Estamos para servirle.");
      return res.sendStatus(200);
    }

    // ✅ MODO ASESOR CON GPT
    if (estadoUsuario[senderId] === 'ASESOR') {
      if (mensajeTexto === 'salir') {
        delete estadoUsuario[senderId];
        delete memoriaConversacion[senderId];
        delete contadorMensajesAsesor[senderId];
        await enviarMensajeTexto(senderId, "🚪 Has salido del chat con asesor. Volviendo al menú principal...");
        await enviarMenuPrincipal(senderId);
        return res.sendStatus(200);
      }

      await enviarConsultaChatGPT(senderId, mensajeTexto);
      return res.sendStatus(200);
    }

    // ✅ DISPARADORES PERSONALIZADOS
    if (mensajeTexto.includes("me interesa este reloj exclusivo")) {
      await enviarInfoPromo(senderId, promoData.reloj1);
      return res.sendStatus(200);
    }

    if (mensajeTexto.includes("me interesa este reloj de lujo")) {
      await enviarInfoPromo(senderId, promoData.reloj2);
      return res.sendStatus(200);
    }

    if (mensajeTexto.includes("ver otros modelos")) {
      await enviarMenuPrincipal(senderId);
      return res.sendStatus(200);
    }

    if (mensajeTexto.includes("hola")) {
      await enviarMenuPrincipal(senderId);
      return res.sendStatus(200);
    }

    // ✅ RESPUESTA GPT SI NO HAY TRIGGER Y YA HUBO UN PRIMER MENSAJE
    if (primerMensaje[senderId]) {
      await enviarConsultaChatGPT(senderId, mensajeTexto);
    } else {
      primerMensaje[senderId] = true;
    }

    return res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// 🔹 MANEJAR POSTBACKS
function manejarPostback(senderId, payload) {
  switch (payload) {
    case "CABALLEROS":
      enviarSubmenuTipoReloj(senderId, "CABALLEROS");
      break;
    case "DAMAS":
      enviarSubmenuTipoReloj(senderId, "DAMAS");
      break;

    // ✅ ACTIVAR MODO ASESOR
    case "ASESOR":
      estadoUsuario[senderId] = 'ASESOR';
      memoriaConversacion[senderId] = [];
      contadorMensajesAsesor[senderId] = 0; // ✅ Reiniciamos contador al entrar
      enviarMensajeConBotonSalir(senderId,
        "😊 ¡Claro que sí! Estamos listos para responder todas sus dudas y consultas. Por favor, escríbenos qué te gustaría saber ✍️");
      break;

    // 📥 CATÁLOGOS
    case "CABALLEROS_AUTO":
      enviarCatalogo(senderId, "caballeros_automaticos");
      break;
    case "CABALLEROS_CUARZO":
      enviarCatalogo(senderId, "caballeros_cuarzo");
      break;
    case "DAMAS_AUTO":
      enviarCatalogo(senderId, "damas_automaticos");
      break;
    case "DAMAS_CUARZO":
      enviarCatalogo(senderId, "damas_cuarzo");
      break;

    case "VER_MODELOS":
      enviarMenuPrincipal(senderId);
      break;

    // ✅ SALIR DEL MODO ASESOR
    case "SALIR_ASESOR":
      delete estadoUsuario[senderId];
      delete memoriaConversacion[senderId];
      delete contadorMensajesAsesor[senderId]; // ✅ Borramos contador
      enviarMensajeTexto(senderId, "🚪 Has salido del chat con asesor.");
      enviarMenuPrincipal(senderId);
      break;

    default:
      if (payload.startsWith("COMPRAR_")) {
        enviarPreguntaUbicacion(senderId);
      } else {
        enviarMensajeTexto(senderId, "❓ No entendí su selección, por favor intente de nuevo.");
      }
  }
}


// 🔹 CONSULTAR CHATGPT CON MEMORIA (NUEVA LÓGICA DE TRIGGERS)
async function enviarConsultaChatGPT(from, mensajeCliente) {
  try {
    if (!memoriaConversacion[from]) memoriaConversacion[from] = [];

    memoriaConversacion[from].push({ role: "user", content: mensajeCliente });

    // ✅ Sumamos interacción
    if (!contadorMensajesAsesor[from]) contadorMensajesAsesor[from] = 0;
    contadorMensajesAsesor[from]++;

    const contexto = [
      { role: "system", content: `${systemPrompt}

Aquí tienes los datos del catálogo: ${JSON.stringify(data, null, 2)}` },
      ...memoriaConversacion[from]
    ];

    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      messages: contexto
    });

    const respuesta = completion.choices[0].message.content.trim();
    memoriaConversacion[from].push({ role: "assistant", content: respuesta });

    // ✅ Detectar triggers de ChatGPT
    if (respuesta.startsWith("MOSTRAR_MODELO:")) {
      const codigo = respuesta.split(":")[1].trim();
      const producto = Object.values(data).flat().find(p => p.codigo === codigo);
      
      if (producto) {
        await enviarInfoPromo(from, producto); // 📸 Envía imagen + info
      } else {
        await enviarMensajeTexto(from, "😔 Lo siento, no encontramos ese modelo en nuestra base de datos.");
      }
      return;
    }

    if (respuesta.startsWith("MOSTRAR_CATALOGO:")) {
      const categoria = respuesta.split(":")[1].trim();
      await enviarCatalogo(from, categoria);
      return;
    }

    if (respuesta === "PEDIR_CATALOGO") {
      await enviarMensajeTexto(from, "😊 Claro que sí. ¿El catálogo que desea ver es para caballeros o para damas?");
      estadoUsuario[from] = "ESPERANDO_GENERO";
      return;
    }

    if (respuesta.startsWith("PREGUNTAR_TIPO:")) {
      const genero = respuesta.split(":")[1].trim();
      estadoUsuario[from] = `ESPERANDO_TIPO_${genero.toUpperCase()}`;
      await enviarSubmenuTipoReloj(from, genero.toUpperCase());
      return;
    }

    // ✅ Si no hay trigger, enviamos la respuesta normal como antes
    await enviarMensajeConBotonSalir(from, respuesta);

  } catch (error) {
    console.error('❌ Error en consulta a ChatGPT:', error);
    await enviarMensajeTexto(from, "⚠️ Lo siento, hubo un problema al conectarme con el asesor. Intenta nuevamente en unos minutos.");
  }
}


// 🔹 MANEJAR FLUJO DE COMPRA (adaptado a WhatsApp)
async function manejarFlujoCompra(from, mensaje) {
  const tieneCelular = /\b9\d{8}\b/.test(mensaje);
  const tieneNombre = /^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)(\s+[A-ZÁÉÍÓÚÑ]?[a-záéíóúñ]+){1,3}$/.test(mensaje);
  const tieneDireccion = /(jirón|jr\.|avenida|av\.|calle|pasaje|mz|mza|lote|urb\.|urbanización)/i.test(mensaje);
  const tieneDNI = /\b\d{8}\b/.test(mensaje);

  if (estadoUsuario[from] === 'ESPERANDO_DATOS_PROVINCIA') {
    if (!tieneNombre) return enviarMensajeTexto(from, "📌 Por favor envíe su nombre completo.");
    if (!tieneDNI) return enviarMensajeTexto(from, "📌 Su DNI debe tener 8 dígitos. Por favor, envíelo correctamente.");
    if (!tieneCelular) return enviarMensajeTexto(from, "📌 Su número de WhatsApp debe tener 9 dígitos y comenzar con 9.");

    await enviarMensajeTexto(from,
      "✅ Su orden ha sido confirmada ✔\nEnvío de: 1 Reloj Premium\n" +
      "👉 Forma: Envío a recoger en Agencia Shalom\n" +
      "👉 Datos recibidos correctamente.\n");

    await enviarMensajeTexto(from,
      "😊 Estimado cliente, para enviar su pedido necesitamos un adelanto simbólico de 20 soles por motivo de seguridad.\n\n" +
      "📱 YAPE: 979 434 826 (Paulina Gonzales Ortega)\n" +
      "🏦 BCP: 19303208489096\n" +
      "🏦 CCI: 00219310320848909613\n\n" +
      "📤 Envíe la captura de su pago aquí para registrar su adelanto.");

    provinciaPagosEnviados[from] = true;
    delete estadoUsuario[from];
    return;
  }
  if (estadoUsuario[from] === 'ESPERANDO_DATOS_LIMA') {
  if (!tieneNombre) return enviarMensajeTexto(from, "📌 Por favor envíe su nombre completo.");
  if (!tieneCelular) return enviarMensajeTexto(from, "📌 Su número de WhatsApp debe tener 9 dígitos y comenzar con 9.");
  if (!tieneDireccion) return enviarMensajeTexto(from, "📌 Su dirección debe incluir calle, avenida, jirón o pasaje.");

  await enviarMensajeTexto(from,
    "✅ Su orden ha sido confirmada ✔\nEnvío de: 1 Reloj Premium\n" +
    "👉 Forma: Envío express a domicilio\n" +
    "👉 Datos recibidos correctamente.\n" +
    "💰 El costo incluye S/10 adicionales por envío a domicilio.");

  delete estadoUsuario[from];
  return;
}

if (!avisoEnviado[from]) {
  await enviarMensajeTexto(from,
    "📌 Por favor, asegúrese de enviar sus datos correctos (nombre, WhatsApp, DNI/dirección y agencia Shalom).");
  avisoEnviado[from] = true;
}

}

// 🔹 ENVIAR MENSAJE TEXTO (adaptado para WhatsApp)
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
    console.error('❌ Error enviando mensaje:', error.response?.data || error.message);
  }
}


// 🔹 ENVIAR MENSAJE + BOTÓN (adaptado para WhatsApp)
async function enviarMensajeConBotonSalir(to, text) {
  try {
    // ✅ Antes de 6 interacciones, solo enviamos el texto normal
    if (!contadorMensajesAsesor[to] || contadorMensajesAsesor[to] < 6) {
      await enviarMensajeTexto(to, text);
      return;
    }

    // ✅ Después de 6 interacciones, enviamos un botón para volver al inicio
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: "SALIR_ASESOR",
                title: "↩️ Volver al inicio"
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
    console.error('❌ Error enviando mensaje con botón salir:', error.response?.data || error.message);
  }
}


// 🔹 ENVIAR INFO DE PROMO (adaptado a WhatsApp con imagen + botones)
async function enviarInfoPromo(to, producto) {
  try {
    // 1️⃣ Enviar la imagen del producto
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { link: producto.imagen }
    }, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    // 2️⃣ Enviar mensaje con botones
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: `${producto.nombre}\n${producto.descripcion}\n💰 Precio: S/${producto.precio}`
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: `COMPRAR_${producto.codigo}`,
                title: "🛍️ Comprar ahora"
              }
            },
            {
              type: "reply",
              reply: {
                id: "VER_MODELOS",
                title: "📖 Ver otros modelos"
              }
            },
            {
              type: "reply",
              reply: {
                id: "COMPRAR_WHATSAPP",
                title: "📞 Comprar por WhatsApp"
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
    console.error('❌ Error enviando info promo:', error.response?.data || error.message);
  }
}

// 🔹 ENVIAR MENÚ PRINCIPAL (adaptado a WhatsApp)
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


// 🔹 SUBMENÚ AUTOMÁTICOS / CUARZO (adaptado a WhatsApp)
async function enviarSubmenuTipoReloj(to, genero) {
  let texto = genero === "CABALLEROS" 
    ? "🔥 ¡Excelente elección! ¿Qué tipo de reloj para caballeros le interesa?"
    : "🔥 ¡Excelente elección! ¿Qué tipo de reloj para damas le interesa?";

  let payloadAuto = genero === "CABALLEROS" ? "CABALLEROS_AUTO" : "DAMAS_AUTO";
  let payloadCuarzo = genero === "CABALLEROS" ? "CABALLEROS_CUARZO" : "DAMAS_CUARZO";

  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: texto },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: payloadAuto,
                title: "⌚ Automáticos ⚙️"
              }
            },
            {
              type: "reply",
              reply: {
                id: payloadCuarzo,
                title: "🕑 De cuarzo ✨"
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
    console.error('❌ Error enviando submenú tipo de reloj:', error.response?.data || error.message);
  }
}


// 🔹 ENVIAR CATÁLOGO (adaptado para WhatsApp)
async function enviarCatalogo(to, categoria) {
  try {
    const listaProductos = data[categoria];

    if (!listaProductos || listaProductos.length === 0) {
      await enviarMensajeTexto(to, "❌ No tenemos productos en esta categoría por ahora.");
      return;
    }

    for (let producto of listaProductos) {
      // 1️⃣ Enviar imagen
      await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: {
          link: producto.imagen
        }
      }, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        }
      });

      // 2️⃣ Enviar texto + botones
      await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: `${producto.nombre}\n${producto.descripcion}\n💰 Precio: S/${producto.precio}`
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: `COMPRAR_${producto.codigo}`,
                  title: "🛍️ Comprar ahora"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "WHATSAPP_COMPRA",
                  title: "📞 Comprar por WhatsApp"
                }
              },
              {
                type: "reply",
                reply: {
                  id: "VER_MODELOS",
                  title: "📖 Ver otros modelos"
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
    }
  } catch (error) {
    console.error('❌ Error enviando catálogo:', error.response?.data || error.message);
  }
}

// 🔹 PREGUNTAR LIMA O PROVINCIA (adaptado para WhatsApp)
async function enviarPreguntaUbicacion(to) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: "😊 Por favor indíquenos, ¿su pedido es para Lima o para Provincia?"
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: "UBICACION_LIMA",
                title: "🏙 Lima"
              }
            },
            {
              type: "reply",
              reply: {
                id: "UBICACION_PROVINCIA",
                title: "🏞 Provincia"
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
    console.error('❌ Error enviando pregunta de ubicación:', error.response?.data || error.message);
  }
}

// 🚀 Servidor

// 🔥 FUNCIONES DE INACTIVIDAD 🔥
function reiniciarTimerInactividad(senderId) {
  limpiarTimers(senderId);

  const timer10 = setTimeout(async () => {
    await enviarBotonWhatsApp(senderId); // ✅ Esta función debe estar adaptada para WhatsApp
  }, 10 * 60 * 1000);

  const timer12 = setTimeout(async () => {
    await enviarMensajeTexto(senderId, "⏳ Su sesión ha terminado.");
    delete estadoUsuario[senderId];
    delete memoriaConversacion[senderId];
    delete contadorMensajesAsesor[senderId];
    limpiarTimers(senderId);
  }, 12 * 60 * 1000);

  timersInactividad[senderId] = { timer10, timer12 };
}

function limpiarTimers(senderId) {
  if (timersInactividad[senderId]) {
    clearTimeout(timersInactividad[senderId].timer10);
    clearTimeout(timersInactividad[senderId].timer12);
    delete timersInactividad[senderId];
  }
}
async function enviarBotonWhatsApp(to) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: "¿Deseas continuar con la atención o prefieres hablar por WhatsApp?"
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: "CONTINUAR",
                title: "✅ Continuar aquí"
              }
            },
            {
              type: "reply",
              reply: {
                id: "HABLAR_WHATSAPP",
                title: "📞 Hablar por WhatsApp"
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
    console.error("❌ Error enviando botón WhatsApp:", error.response?.data || error.message);
  }
}


async function enviarBotonWhatsApp(to) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: "¿Deseas continuar con la atención o prefieres hablar por WhatsApp?"
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: "CONTINUAR",
                title: "✅ Continuar aquí"
              }
            },
            {
              type: "reply",
              reply: {
                id: "HABLAR_WHATSAPP",
                title: "📞 Hablar por WhatsApp"
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
    console.error("❌ Error enviando botón WhatsApp:", error.response?.data || error.message);
  }
}

// 🔥 FIN FUNCIONES DE INACTIVIDAD 🔥

app.listen(3000, () => console.log('🚀 Servidor corriendo en http://localhost:3000'));

