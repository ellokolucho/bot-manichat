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
const estadoUsuario = {};
let primerMensaje = {};
let timersInactividad = {};
let pedidoActivo = {};
let timersHibernacion = {};
let datosPedidoTemporal = {}; // Para acumular datos del pedido
let timersPedido = {}; // Para manejar el tiempo de espera de datos

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
    finalizarSesion(senderId, true);
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

async function finalizarSesion(senderId, conservarMemoria = false) {
  try {
    delete estadoUsuario[senderId];
    delete pedidoActivo[senderId];
    if (timersHibernacion[senderId]) {
        clearTimeout(timersHibernacion[senderId]);
        delete timersHibernacion[senderId];
    }

    if (!conservarMemoria) {
        delete memoriaConversacion[senderId];
        delete primerMensaje[senderId];
        await enviarMensajeTexto(senderId, "⏳ Su sesión ha terminado. ¡Gracias por visitar Tiendas Megan!");
    } else {
         console.log(`Sesión de pedido para ${senderId} finalizada. Se conserva la memoria de chat.`);
    }
  } catch (error) {
    console.error('❌ Error finalizando sesión:', error.response?.data || error.message);
  }
}


// ===== MANEJADOR PRINCIPAL DE MENSAJES =====
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

    // MODO POST-VENTA (MÁXIMA PRIORIDAD)
    if (estadoUsuario[from] === 'ESPERANDO_COMPROBANTE') {
        if (type === 'image') {
            await enviarMensajeTexto(from, "OK, estimado, vamos a confirmarlo. En breve le enviamos una respuesta.");
            finalizarSesion(from, true);
        } else if (type === 'text') {
            await enviarConsultaChatGPT(from, message.text.body, 'post-venta');
        }
        return res.sendStatus(200);
    }

    // --- MANEJO DE BOTONES ---
    if (type === 'interactive' && message.interactive?.button_reply?.id) {
      primerMensaje[from] = true;
      const buttonId = message.interactive.button_reply.id;

      if (buttonId.startsWith('COMPRAR_PRODUCTO_')) {
          const codigoProducto = buttonId.replace('COMPRAR_PRODUCTO_', '');
          pedidoActivo[from] = { codigo: codigoProducto, ultimoProductoVisto: codigoProducto };
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
          await enviarMensajeConBotonSalir(from, "😊 ¡Claro que sí! Estamos listos para responder todas sus dudas y consultas. Por favor, escríbanos qué le gustaría saber ✍️");
          break;
        case 'SALIR':
          delete estadoUsuario[from];
          delete memoriaConversacion[from];
          await enviarMensajeTexto(from, "🚪 Ha salido del chat con asesor. Volviendo al menú principal...");
          await enviarMenuPrincipal(from);
          break;
        case 'COMPRAR_LIMA':
          estadoUsuario[from] = 'ESPERANDO_DATOS_LIMA';
          datosPedidoTemporal[from] = { texto: '' }; // Inicializa el acumulador de datos
          await enviarMensajeTexto(from, "😊 Claro que sí. Por favor, para enviar su pedido indíquenos los siguientes datos:\n\n✅ Nombre completo ✍️\n✅ Dirección exacta 📍\n✅ Una referencia de cómo llegar a su domicilio 🏠");
          break;
        case 'COMPRAR_PROVINCIA':
          estadoUsuario[from] = 'ESPERANDO_DATOS_PROVINCIA';
          datosPedidoTemporal[from] = { texto: '' }; // Inicializa el acumulador de datos
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

      // ===== NUEVO TEMPORIZADOR INTELIGENTE PARA DATOS DE PEDIDO =====
      if (estadoUsuario[from] === 'ESPERANDO_DATOS_LIMA' || estadoUsuario[from] === 'ESPERANDO_DATOS_PROVINCIA') {
        
        datosPedidoTemporal[from].texto += text + '\n';
        
        if (verificarDatosCompletos(from)) {
            // Si los datos están completos, procesa de inmediato
            if (timersPedido[from]) clearTimeout(timersPedido[from]);
            await manejarFlujoCompra(from, datosPedidoTemporal[from].texto);
            delete datosPedidoTemporal[from];
            delete timersPedido[from];
        } else {
            // Si no, reinicia el temporizador
            if (timersPedido[from]) clearTimeout(timersPedido[from]);
            
            timersPedido[from] = setTimeout(async () => {
                console.log(`Temporizador de pedido para ${from} finalizado.`);
                if (verificarDatosCompletos(from)) {
                    await manejarFlujoCompra(from, datosPedidoTemporal[from].texto);
                } else {
                    const tipo = estadoUsuario[from];
                    const msg = tipo === 'ESPERANDO_DATOS_LIMA' 
                        ? "Parece que faltan datos. Por favor, asegúrese de enviarnos su Nombre, Dirección y Referencia. 😊"
                        : "Parece que faltan datos. Por favor, asegúrese de enviarnos su Nombre, DNI y Agencia Shalom. 😊";
                    await enviarMensajeTexto(from, msg);
                    delete estadoUsuario[from]; // Reinicia el estado para que pueda intentarlo de nuevo
                }
                delete datosPedidoTemporal[from];
                delete timersPedido[from];
            }, 15000); // 15 segundos de espera
        }
        return res.sendStatus(200);
      }
      
      if (estadoUsuario[from] === 'ASESOR') {
        if (mensaje === 'salir') {
            delete estadoUsuario[from];
            await enviarMensajeTexto(from, "🚪 Ha salido del chat con asesor.");
            await enviarMenuPrincipal(from);
        } else {
            await enviarConsultaChatGPT(from, text);
        }
        return res.sendStatus(200);
      }
      
      // PRIORIDAD 2: Comandos Específicos y Promociones
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

      // PRIORIDAD 3: Lógica por Defecto (ChatGPT o Menú Principal)
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

// ===== FUNCIONES AUXILIARES =====

// NUEVA FUNCIÓN para verificar si los datos del pedido están completos
function verificarDatosCompletos(senderId) {
    const datosAcumulados = datosPedidoTemporal[senderId]?.texto || '';
    const tipo = estadoUsuario[senderId];

    if (tipo === 'ESPERANDO_DATOS_LIMA') {
        const tieneNombre = /[a-zA-Z]{3,}/.test(datosAcumulados); // Chequeo simple de que haya texto
        const tieneDireccion = /(jirón|jr\.|avenida|av\.|calle|pasaje)/i.test(datosAcumulados);
        return tieneNombre && tieneDireccion;
    } else if (tipo === 'ESPERANDO_DATOS_PROVINCIA') {
        const tieneNombre = /[a-zA-Z]{3,}/.test(datosAcumulados);
        const tieneDNI = /\b\d{8}\b/.test(datosAcumulados);
        const lineas = datosAcumulados.split('\n').filter(l => l.trim() !== '');
        // Asumimos que si hay 3 líneas de información (nombre, DNI, agencia), está completo
        return tieneNombre && tieneDNI && lineas.length >= 3;
    }
    return false;
}

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

// Submenú tipo de reloj
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
      pedidoActivo[to] = { ...pedidoActivo[to], ultimoProductoVisto: producto.codigo };
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
async function enviarConsultaChatGPT(senderId, mensajeCliente, modo = 'normal') {
  try {
    if (!memoriaConversacion[senderId]) memoriaConversacion[senderId] = [];
    memoriaConversacion[senderId].push({ role: 'user', content: mensajeCliente });

    let systemMessageContent = `${systemPrompt}\n\nCatálogo disponible:\n${JSON.stringify(data)}`;
    
    if (modo === 'post-venta') {
        systemMessageContent += `\n\nINSTRUCCIÓN ESPECIAL: El usuario acaba de recibir los medios de pago para un pedido. Aún no ha enviado el comprobante. Tu tarea principal ahora es resolver sus dudas sobre la seguridad del pago, la confianza en la tienda o el proceso. Sé muy tranquilizador, profesional y anímale a completar el pago. NO intentes venderle otro producto ni mostrarle el catálogo de nuevo. Responde a sus preguntas de forma concisa y amable.`;
    }

    const contexto = [
      { role: 'system', content: systemMessageContent },
      ...memoriaConversacion[senderId]
    ];

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: contexto
    });

    const respuesta = response.choices[0].message.content.trim();
    memoriaConversacion[senderId].push({ role: 'assistant', content: respuesta });

    if (respuesta === 'GENERAR_ORDEN') {
        const ultimoMensajeUsuario = memoriaConversacion[senderId].filter(m => m.role === 'user').slice(-1)[0].content;
        await manejarFlujoCompra(senderId, ultimoMensajeUsuario);
        return;
    }
    if (respuesta.startsWith('MOSTRAR_MODELO:')) {
      const codigo = respuesta.split(':')[1].trim();
      const producto = Object.values(data).flat().find(p => p.codigo === codigo) || Object.values(promoData).find(p => p.codigo === codigo);
      if (producto) {
        pedidoActivo[senderId] = { ...pedidoActivo[senderId], ultimoProductoVisto: producto.codigo };
        await enviarInfoPromo(senderId, producto);
      } else {
        await enviarMensajeTexto(senderId, `😔 Lo siento, no pude encontrar el modelo con el código ${codigo}.`);
      }
      return;
    }
    if (respuesta === 'PEDIR_CATALOGO') {
      await enviarMenuPrincipal(senderId);
      return;
    }
    if (respuesta.startsWith('PREGUNTAR_TIPO:')) {
        const genero = respuesta.split(':')[1].trim().toUpperCase();
        await enviarSubmenuTipoReloj(senderId, genero);
        return;
    }
    
    await enviarMensajeTexto(senderId, respuesta);

  } catch (error) {
    console.error('❌ Error en consulta a ChatGPT:', error);
    await enviarMensajeTexto(senderId, '⚠️ Lo siento, hubo un problema al conectarme con el asesor. Intente nuevamente en unos minutos.');
  }
}

// Función de validación y cierre de compra
async function manejarFlujoCompra(senderId, mensaje) {
    const codigoUltimoVisto = pedidoActivo[senderId]?.ultimoProductoVisto;
    if (!pedidoActivo[senderId]?.codigo && codigoUltimoVisto) {
        pedidoActivo[senderId] = { ...pedidoActivo[senderId], codigo: codigoUltimoVisto };
    }

    if (!pedidoActivo[senderId] || !pedidoActivo[senderId].codigo) {
        await enviarConsultaChatGPT(senderId, "El cliente quiere comprar pero no sé qué modelo. Por favor, pregúntale amablemente qué modelo o código le gustaría pedir.");
        return;
    }

    const lineas = mensaje.split('\n').map(line => line.trim()).filter(line => line);
    const dniMatch = mensaje.match(/\b(\d{8})\b/);
    const dni = dniMatch ? dniMatch[1] : null;
    const tieneDireccion = /(jirón|jr\.|avenida|av\.|calle|pasaje)/i.test(mensaje);

    let tipoPedido;
    if (dni) {
        tipoPedido = 'Provincia';
    } else if (tieneDireccion) {
        tipoPedido = 'Lima';
    } else {
        await enviarMensajeTexto(senderId, "📌 No pudimos identificar claramente sus datos. Por favor, asegúrese de incluir su DNI (para provincia) o su dirección (para Lima).");
        return;
    }

    const nombre = lineas[0] || '';
    const lugar = lineas.slice(1).filter(l => l.trim() !== dni).join(', ') || lineas.slice(1).join(', ');

    const datosExtraidos = { nombre, dni, lugar, tipo: tipoPedido };
    
    await generarYEnviarResumen(senderId, datosExtraidos);

    if (tipoPedido === 'Provincia') {
        await enviarInstruccionesDePagoProvincia(senderId);
    } else {
        await enviarConfirmacionLima(senderId);
    }
    
    delete estadoUsuario[senderId];
}


// Función para generar el resumen de la orden
async function generarYEnviarResumen(senderId, datos) {
    try {
        const codigoProducto = pedidoActivo[senderId]?.codigo;
        if (!codigoProducto) return;

        let producto = Object.values(data).flat().find(p => p.codigo === codigoProducto) || Object.values(promoData).find(p => p.codigo === codigoProducto);

        if (!producto) {
            console.error(`❌ No se encontró el producto con el código ${codigoProducto} para generar el resumen.`);
            await enviarMensajeTexto(senderId, "⚠️ Tuvimos un problema al generar el resumen de su orden. Un asesor se comunicará de todas formas.");
            return;
        }
        
        let montoFinal = parseInt(String(producto.precio).replace(/[^0-9]/g, ''));
        if (datos.tipo === 'Lima') {
            montoFinal += 10;
        }
        
        let resumenTexto = `*${producto.nombre}*\n\n`;
        resumenTexto += `*Resumen de su Pedido* 📝\n\n`;
        resumenTexto += `✅ *Nombre:* ${datos.nombre}\n`;
        
        if (datos.tipo === 'Provincia') {
            resumenTexto += `✅ *DNI:* ${datos.dni}\n`;
            resumenTexto += `✅ *Forma de Envío:* Envío a recoger en la agencia Shalom\n`;
            resumenTexto += `✅ *Lugar:* ${datos.lugar}\n`;
        } else { // Lima
            resumenTexto += `✅ *Forma de Envío:* Envío express a domicilio\n`;
            resumenTexto += `✅ *Dirección:* ${datos.lugar}\n`;
        }

        resumenTexto += `✅ *Monto a Pagar:* ${montoFinal} soles`;

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

// Función para enviar la confirmación de Lima
async function enviarConfirmacionLima(to) {
    try {
        const mensaje = "😊 ¡Perfecto! Ya estamos alistando su pedido. Cuando esté listo para la entrega, nos comunicaremos con usted para que esté atento a la hora. ¡Gracias por su compra!";
        await new Promise(resolve => setTimeout(resolve, 2000));
        await enviarMensajeTexto(to, mensaje);
        finalizarSesion(to, true);
    } catch (error) {
        console.error('❌ Error enviando confirmación de Lima:', error.message);
    }
}

// Función para enviar instrucciones de pago de Provincia
async function enviarInstruccionesDePagoProvincia(to) {
    try {
        const mensajeAdelanto = "😊 Estimad@, para enviar su pedido necesitamos un adelanto Simbólico de 30 soles por motivo de seguridad. Esto nos permite asegurar que el cliente se compromete a recoger su pedido. El resto se paga cuando su pedido llegue a la agencia, antes de recoger.";
        const mensajeMediosPago = "*MEDIOS DE PAGO*\n👉 *YAPE* : 979 434 826\n(Paulina Gonzales Ortega)\n\n👉 *Cuenta BCP Soles*\n19303208489096\n\n👉 *CCI para transferir de otros bancos*\n00219310320848909613";

        await new Promise(resolve => setTimeout(resolve, 2000));
        await enviarMensajeTexto(to, mensajeAdelanto);
        await new Promise(resolve => setTimeout(resolve, 1500));
        await enviarMensajeTexto(to, mensajeMediosPago);

        estadoUsuario[to] = 'ESPERANDO_COMPROBANTE';
        
        if (timersHibernacion[to]) clearTimeout(timersHibernacion[to]);
        timersHibernacion[to] = setTimeout(() => {
            if (estadoUsuario[to] === 'ESPERANDO_COMPROBANTE') {
                console.log(`Timer de hibernación para ${to} expirado. Limpiando estado de venta.`);
                finalizarSesion(to, true);
            }
        }, 1 * 60 * 60 * 1000); // 1 hora

    } catch (error) {
         console.error('❌ Error enviando instrucciones de pago:', error.message);
    }
}


// Envía promociones e info de producto
async function enviarInfoPromo(to, producto) {
  if (!producto || !producto.nombre) {
    console.error('❌ Se intentó enviar una promo con datos inválidos o faltantes. Revisa tu promoData.json.');
    await enviarMensajeTexto(to, '⚠️ Lo siento, no pude encontrar los detalles de esa promoción en este momento.');
    return;
  }
  
  pedidoActivo[to] = { ...pedidoActivo[to], ultimoProductoVisto: producto.codigo };

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