const express = require('express');
const bodyParser = require('body-parser');
// Axios ya no es necesario para enviar mensajes a Meta
// const axios = require('axios'); 
const fs = require('fs');
require('dotenv').config();
const OpenAI = require('openai');

// Carga de datos de catálogos y promociones y prompt del sistema
const data = require('./data.json');
const promoData = require('./promoData.json');
const systemPrompt = fs.readFileSync('./SystemPrompt.txt', 'utf-8');

// Memoria de conversaciones y estados de flujo (sin cambios)
const memoriaConversacion = {};
const estadoUsuario = {};
let primerMensaje = {};
let timersInactividad = {};
let pedidoActivo = {};
let timersHibernacion = {};
let datosPedidoTemporal = {}; 
let timersPedido = {}; 

const app = express();
app.use(bodyParser.json());

// Las variables de entorno de Meta ya no son necesarias para el envío
// const token = process.env.WHATSAPP_TOKEN;
// const phoneNumberId = process.env.PHONE_NUMBER_ID;
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// El endpoint de verificación de webhook para Meta puede ser eliminado o desactivado
// si solo se usará con ManyChat. Lo mantengo comentado por si lo necesitas.
/*
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
*/

// ===== INICIO DE FUNCIONES DE MANEJO DE ESTADO (SIN CAMBIOS) =====
// Estas funciones no necesitan cambios ya que manejan la lógica interna del bot.

function reiniciarTimerInactividad(senderId) {
    if (timersInactividad[senderId]) {
        clearTimeout(timersInactividad[senderId].timer10);
        clearTimeout(timersInactividad[senderId].timer12);
    }
    timersInactividad[senderId] = {};
    timersInactividad[senderId].timer10 = setTimeout(() => {
        // La lógica de aviso de inactividad necesitaría un flujo en ManyChat para ser enviada.
        // Por ahora, esta función se mantiene pero no enviará mensajes proactivos.
        console.log(`Aviso de inactividad para ${senderId}`);
    }, 10 * 60 * 1000);
    timersInactividad[senderId].timer12 = setTimeout(() => {
        finalizarSesion(senderId, true);
    }, 12 * 60 * 1000);
}

async function finalizarSesion(senderId, conservarMemoria = false) {
    delete estadoUsuario[senderId];
    delete pedidoActivo[senderId];
    if (timersHibernacion[senderId]) {
        clearTimeout(timersHibernacion[senderId]);
        delete timersHibernacion[senderId];
    }
    if (!conservarMemoria) {
        delete memoriaConversacion[senderId];
        delete primerMensaje[senderId];
        // No se puede enviar un mensaje al finalizar sesión sin una interacción del usuario.
        console.log(`Sesión de ${senderId} ha terminado.`);
    } else {
        console.log(`Sesión de pedido para ${senderId} finalizada. Se conserva la memoria de chat.`);
    }
}
// ===== FIN DE FUNCIONES DE MANEJO DE ESTADO =====


// ===== MANEJADOR PRINCIPAL DE MENSAJES (ADAPTADO PARA MANYCHAT) =====
app.post('/webhook', async (req, res) => {
    console.log('📩 Webhook de ManyChat recibido:', JSON.stringify(req.body, null, 2));
    
    // Extraemos el ID de usuario y el texto del cuerpo de la solicitud de ManyChat.
    // IMPORTANTE: Asegúrate de que ManyChat envíe 'id' y 'last_input_text'.
    const from = req.body.id; 
    const textFromUser = req.body.last_input_text || '';
    const payload = req.body.payload || {}; // Para botones con callback

    if (!from) {
        return res.status(400).send('Falta el ID de usuario.');
    }

    reiniciarTimerInactividad(from);
    
    let messageContent = textFromUser;
    
    // Si la interacción viene de un botón de callback dinámico
    if (payload.action) {
        if (payload.action === 'COMPRAR_PRODUCTO') {
            const codigoProducto = payload.codigo;
            pedidoActivo[from] = { codigo: codigoProducto, ultimoProductoVisto: codigoProducto };
            await enviarPreguntaUbicacion(res);
            return;
        }
        // Asignamos el ID del botón como el contenido del mensaje para que el resto de la lógica funcione
        messageContent = payload.action;
    }
    
    // MODO POST-VENTA (MÁXIMA PRIORIDAD)
    if (estadoUsuario[from] === 'ESPERANDO_COMPROBANTE') {
        // La recepción de imágenes se gestiona en el flujo de ManyChat.
        // Si el usuario escribe texto, se procesa aquí.
        if (messageContent) {
            await enviarConsultaChatGPT(res, from, messageContent, 'post-venta');
        } else {
            // Si no hay texto (ej. envió imagen), ManyChat debería manejarlo.
            // Aquí simplemente respondemos para confirmar recepción.
            await enviarMensajeTexto(res, "OK, estimado, vamos a confirmarlo. En breve le enviamos una respuesta.");
            finalizarSesion(from, true);
        }
        return;
    }
    
    // --- MANEJO DE RESPUESTAS TIPO BOTÓN (AHORA COMO TEXTO) ---
    // La lógica original se basaba en IDs de botón. Ahora se basa en el texto que ManyChat nos reenvía.
    const buttonId = messageContent.toUpperCase();

    if (buttonId.startsWith('COMPRAR_PRODUCTO_')) {
        const codigoProducto = buttonId.replace('COMPRAR_PRODUCTO_', '');
        pedidoActivo[from] = { codigo: codigoProducto, ultimoProductoVisto: codigoProducto };
        await enviarPreguntaUbicacion(res);
        return;
    }

    switch (buttonId) {
        case 'VER_MODELOS':
            await enviarMenuPrincipal(res);
            break;
        case 'CABALLEROS':
        case 'DAMAS':
            await enviarSubmenuTipoReloj(res, buttonId);
            break;
        case 'CABALLEROS_AUTO':
            await enviarCatalogo(res, from, 'caballeros_automaticos');
            break;
        case 'CABALLEROS_CUARZO':
            await enviarCatalogo(res, from, 'caballeros_cuarzo');
            break;
        case 'DAMAS_AUTO':
            await enviarCatalogo(res, from, 'damas_automaticos');
            break;
        case 'DAMAS_CUARZO':
            await enviarCatalogo(res, from, 'damas_cuarzo');
            break;
        case 'ASESOR':
            estadoUsuario[from] = 'ASESOR';
            memoriaConversacion[from] = [];
            await enviarMensajeConBotonSalir(res, "😊 ¡Claro que sí! Estamos listos para responder todas sus dudas y consultas. Por favor, escríbanos qué le gustaría saber ✍️");
            break;
        case 'SALIR':
            delete estadoUsuario[from];
            delete memoriaConversacion[from];
            await enviarMensajeTexto(res, "🚪 Ha salido del chat con asesor. Volviendo al menú principal...");
            await new Promise(resolve => setTimeout(resolve, 500)); // Pequeña pausa
            await enviarMenuPrincipal(res);
            break;
        case 'COMPRAR_LIMA':
            estadoUsuario[from] = 'ESPERANDO_DATOS_LIMA';
            datosPedidoTemporal[from] = { texto: '' };
            await enviarMensajeTexto(res, "😊 Claro que sí. Por favor, para enviar su pedido indíquenos los siguientes datos:\n\n✅ Nombre completo ✍️\n✅ Dirección exacta 📍\n✅ Una referencia de cómo llegar a su domicilio 🏠");
            break;
        case 'COMPRAR_PROVINCIA':
            estadoUsuario[from] = 'ESPERANDO_DATOS_PROVINCIA';
            datosPedidoTemporal[from] = { texto: '' };
            await enviarMensajeTexto(res, "😊 Claro que sí. Por favor, permítanos los siguientes datos para programar su pedido:\n\n✅ Nombre completo ✍️\n✅ DNI 🪪\n✅ Agencia Shalom que le queda más cerca 🚚");
            break;
        default:
            // --- LÓGICA PARA MENSAJES DE TEXTO CON SISTEMA DE PRIORIDADES ---
            const text = messageContent;
            const mensaje = text.trim().toLowerCase();

            if (estadoUsuario[from] === 'ESPERANDO_DATOS_LIMA' || estadoUsuario[from] === 'ESPERANDO_DATOS_PROVINCIA') {
                datosPedidoTemporal[from].texto = (datosPedidoTemporal[from].texto || '') + text + '\n';
                if (verificarDatosCompletos(from)) {
                    if (timersPedido[from]) clearTimeout(timersPedido[from]);
                    await manejarFlujoCompra(res, from, datosPedidoTemporal[from].texto);
                    delete datosPedidoTemporal[from];
                    delete timersPedido[from];
                } else {
                    if (timersPedido[from]) clearTimeout(timersPedido[from]);
                    timersPedido[from] = setTimeout(async () => {
                        if (datosPedidoTemporal[from] && verificarDatosCompletos(from)) {
                            // Este manejo asíncrono no puede responder a 'res'. Se necesita un enfoque diferente
                            // o confiar en que el usuario envíe otro mensaje.
                            console.log(`Temporizador de pedido para ${from} finalizado. Datos insuficientes.`);
                        }
                    }, 15000);
                    // No se envía respuesta inmediata para permitir que el usuario siga escribiendo.
                    // ManyChat podría tener un "tiempo de espera de respuesta" que debemos considerar.
                    // Por ahora, respondemos con un OK vacío para no cerrar la conexión.
                    return res.json({});
                }
                return;
            }

            if (estadoUsuario[from] === 'ASESOR') {
                if (mensaje === 'salir') {
                    delete estadoUsuario[from];
                    await enviarMensajeTexto(res, "🚪 Ha salido del chat con asesor.");
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await enviarMenuPrincipal(res);
                } else {
                    await enviarConsultaChatGPT(res, from, text);
                }
                return;
            }

            if (mensaje.includes('me interesa este reloj exclusivo')) {
                primerMensaje[from] = true;
                await enviarInfoPromo(res, from, promoData.reloj1);
                return;
            }
            if (mensaje.includes('me interesa este reloj de lujo')) {
                primerMensaje[from] = true;
                await enviarInfoPromo(res, from, promoData.reloj2);
                return;
            }
            if (/^(gracias|muchas gracias|mil gracias)$/i.test(mensaje)) {
                await enviarMensajeTexto(res, "😊 ¡De nada! Estamos para servirle.");
                return;
            }

            if (primerMensaje[from]) {
                await enviarConsultaChatGPT(res, from, text);
            } else {
                primerMensaje[from] = true;
                await enviarMenuPrincipal(res);
            }
    }
});


// ===== FUNCIONES AUXILIARES (LÓGICA INTERNA SIN CAMBIOS) =====

function verificarDatosCompletos(senderId) {
    const datosAcumulados = datosPedidoTemporal[senderId]?.texto || '';
    const tipo = estadoUsuario[senderId];
    const lineas = datosAcumulados.split('\n').filter(l => l.trim() !== '');

    if (tipo === 'ESPERANDO_DATOS_LIMA') {
        const tieneNombre = /[a-zA-Z]{3,}/.test(datosAcumulados);
        return tieneNombre && lineas.length >= 2;
    } else if (tipo === 'ESPERANDO_DATOS_PROVINCIA') {
        const tieneNombre = /[a-zA-Z]{3,}/.test(datosAcumulados);
        const tieneDNI = /\b\d{8}\b/.test(datosAcumulados);
        return tieneNombre && tieneDNI && lineas.length >= 3;
    }
    return false;
}

// ===== FUNCIONES DE ENVÍO DE MENSAJES (ADAPTADAS PARA MANYCHAT) =====

/**
 * Función central para responder a ManyChat.
 * @param {object} res - El objeto de respuesta de Express.
 * @param {Array} messages - Un array de objetos de mensaje para ManyChat.
 * @param {Array} quick_replies - Un array opcional de respuestas rápidas.
 * @param {Array} actions - Un array opcional de acciones.
 */
function responderAManyChat(res, messages = [], quick_replies = [], actions = []) {
    const response = {
        version: "v2",
        content: {
            messages,
            actions,
            quick_replies
        }
    };
    // Filtramos arrays vacíos para una respuesta más limpia
    if (quick_replies.length === 0) delete response.content.quick_replies;
    if (actions.length === 0) delete response.content.actions;

    console.log("📢 Respondiendo a ManyChat:", JSON.stringify(response, null, 2));
    res.json(response);
}

async function enviarMenuPrincipal(res) {
    const messages = [{
        type: 'text',
        text: '👋 ¡Hola! Bienvenido a Tiendas Megan\n💎 Descubra su reloj ideal o el regalo perfecto 🎁'
    }];
    const quick_replies = [
        { type: 'node', caption: '🤵‍♂️ Para Caballeros', target: ' gatillo_caballeros' }, // target debe ser el nombre de un nodo o flujo en ManyChat
        { type: 'node', caption: '💃 Para Damas', target: 'gatillo_damas' },
        { type: 'node', caption: '💬 Hablar con Asesor', target: 'gatillo_asesor' }
    ];
    responderAManyChat(res, messages, quick_replies);
}

async function enviarSubmenuTipoReloj(res, genero) {
    const label = genero === 'CABALLEROS' ? 'caballeros' : 'damas';
    const messages = [{
        type: 'text',
        text: `✅ ¡Excelente elección! ¿Qué tipo de reloj para ${label} le gustaría ver?`
    }];
    const quick_replies = [
        { type: 'node', caption: '⌚ Automáticos', target: `gatillo_${genero}_auto` },
        { type: 'node', caption: '⏱️ De cuarzo', target: `gatillo_${genero}_cuarzo` }
    ];
    responderAManyChat(res, messages, quick_replies);
}

async function enviarCatalogo(res, to, tipo) {
    const productos = data[tipo];
    if (!productos || !productos.length) {
        await enviarMensajeTexto(res, '😔 Lo siento, no hay productos disponibles en esa categoría.');
        return;
    }

    const elements = productos.map(producto => {
        pedidoActivo[to] = { ...pedidoActivo[to], ultimoProductoVisto: producto.codigo };
        return {
            title: producto.nombre,
            subtitle: `${producto.descripcion}\n💲 ${producto.precio} soles`,
            image_url: producto.imagen,
            buttons: [{
                type: 'dynamic_block_callback',
                caption: '🛍️ Pedir este modelo',
                url: process.env.RAILWAY_APP_URL + '/webhook', // URL de tu propio webhook
                method: 'post',
                payload: {
                    action: `COMPRAR_PRODUCTO_${producto.codigo}`
                }
            }]
        };
    });

    const messages = [{
        type: 'cards',
        elements: elements,
        image_aspect_ratio: 'square'
    }];
    
    const finalMessage = {
        type: 'text',
        text: '✨ Tenemos estos modelos disponibles, ¿qué modelito le gustaría adquirir? 😉'
    };

    const quick_replies = [{
        type: 'node',
        caption: '📖 Ver otros modelos',
        target: 'gatillo_ver_modelos'
    }];

    // Enviamos primero la galería y luego el mensaje final con el quick reply
    responderAManyChat(res, [...messages, finalMessage], quick_replies);
}


async function enviarConsultaChatGPT(res, senderId, mensajeCliente, modo = 'normal') {
    try {
        if (!memoriaConversacion[senderId]) memoriaConversacion[senderId] = [];
        memoriaConversacion[senderId].push({ role: 'user', content: mensajeCliente });

        let systemMessageContent = `${systemPrompt}\n\nCatálogo disponible:\n${JSON.stringify(data)}`;
        if (modo === 'post-venta') {
            systemMessageContent += `\n\nINSTRUCCIÓN ESPECIAL: ...`; // Tu instrucción de post-venta
        }

        const contexto = [{ role: 'system', content: systemMessageContent }, ...memoriaConversacion[senderId]];
        const response = await client.chat.completions.create({ model: 'gpt-4o', messages: contexto });
        const respuesta = response.choices[0].message.content.trim();
        memoriaConversacion[senderId].push({ role: 'assistant', content: respuesta });

        if (respuesta.startsWith('MOSTRAR_MODELO:')) {
            const codigo = respuesta.split(':')[1].trim();
            const producto = Object.values(data).flat().find(p => p.codigo === codigo) || Object.values(promoData).find(p => p.codigo === codigo);
            if (producto) {
                await enviarInfoPromo(res, senderId, producto);
            } else {
                await enviarMensajeTexto(res, `😔 Lo siento, no pude encontrar el modelo con el código ${codigo}.`);
            }
            return;
        }
        if (respuesta === 'PEDIR_CATALOGO') {
            await enviarMenuPrincipal(res);
            return;
        }
        if (respuesta.startsWith('PREGUNTAR_TIPO:')) {
            const genero = respuesta.split(':')[1].trim().toUpperCase();
            await enviarSubmenuTipoReloj(res, genero);
            return;
        }
        
        await enviarMensajeTexto(res, respuesta);

    } catch (error) {
        console.error('❌ Error en consulta a ChatGPT:', error);
        await enviarMensajeTexto(res, '⚠️ Lo siento, hubo un problema al conectarme con el asesor. Intente nuevamente en unos minutos.');
    }
}


async function manejarFlujoCompra(res, senderId, mensaje) {
    const codigoUltimoVisto = pedidoActivo[senderId]?.ultimoProductoVisto;
    if (!pedidoActivo[senderId]?.codigo && codigoUltimoVisto) {
        pedidoActivo[senderId] = { ...pedidoActivo[senderId], codigo: codigoUltimoVisto };
    }

    if (!pedidoActivo[senderId] || !pedidoActivo[senderId].codigo) {
        await enviarConsultaChatGPT(res, senderId, "El cliente quiere comprar pero no sé qué modelo. Por favor, pregúntale amablemente qué modelo o código le gustaría pedir.");
        return;
    }

    const tipoPedido = estadoUsuario[senderId] === 'ESPERANDO_DATOS_LIMA' ? 'Lima' : 'Provincia';
    const lineas = mensaje.split('\n').map(line => line.trim()).filter(line => line);
    const dniMatch = mensaje.match(/\b(\d{8})\b/);
    const dni = dniMatch ? dniMatch[1] : null;
    const nombre = lineas[0] || '';
    const lugar = lineas.slice(1).filter(l => l.trim() !== dni).join(', ') || lineas.slice(1).join(', ');

    const datosExtraidos = { nombre, dni, lugar, tipo: tipoPedido };
    
    // Genera el resumen y las instrucciones de pago en una sola respuesta.
    const mensajesDeRespuesta = await generarResumenYContinuar(senderId, datosExtraidos);
    
    responderAManyChat(res, mensajesDeRespuesta);
    
    delete estadoUsuario[senderId];
}


async function generarResumenYContinuar(senderId, datos) {
    const codigoProducto = pedidoActivo[senderId]?.codigo;
    if (!codigoProducto) return [{ type: 'text', text: "⚠️ Tuvimos un problema al generar el resumen de su orden." }];

    let producto = Object.values(data).flat().find(p => p.codigo === codigoProducto) || Object.values(promoData).find(p => p.codigo === codigoProducto);
    if (!producto) return [{ type: 'text', text: "⚠️ No encontramos el producto para generar el resumen." }];
    
    let montoFinal = parseInt(String(producto.precio).replace(/[^0-9]/g, ''));
    if (datos.tipo === 'Lima') montoFinal += 10;
    
    let resumenTexto = `*${producto.nombre}*\n\n*Resumen de su Pedido* 📝\n\n`;
    resumenTexto += `✅ *Nombre:* ${datos.nombre}\n`;
    
    if (datos.tipo === 'Provincia') {
        resumenTexto += `✅ *DNI:* ${datos.dni}\n`;
        resumenTexto += `✅ *Forma de Envío:* Envío a recoger en la agencia Shalom\n`;
        resumenTexto += `✅ *Lugar:* ${datos.lugar}\n`;
    } else {
        resumenTexto += `✅ *Forma de Envío:* Envío express a domicilio\n`;
        resumenTexto += `✅ *Dirección:* ${datos.lugar}\n`;
    }
    resumenTexto += `✅ *Monto a Pagar:* ${montoFinal} soles`;

    const allMessages = [];
    allMessages.push({ type: 'image', url: producto.imagen });
    allMessages.push({ type: 'text', text: resumenTexto });

    // Añade las instrucciones de pago si corresponde
    if (datos.tipo === 'Provincia') {
        const mensajeAdelanto = "😊 Estimad@, para enviar su pedido necesitamos un adelanto Simbólico de 30 soles por motivo de seguridad. Esto nos permite asegurar que el cliente se compromete a recoger su pedido. El resto se paga cuando su pedido llegue a la agencia, antes de recoger.";
        const mensajeMediosPago = "*MEDIOS DE PAGO*\n👉 *YAPE* : 979 434 826\n(Paulina Gonzales Ortega)\n\n👉 *Cuenta BCP Soles*\n19303208489096\n\n👉 *CCI para transferir de otros bancos*\n00219310320848909613";
        allMessages.push({ type: 'text', text: mensajeAdelanto });
        allMessages.push({ type: 'text', text: mensajeMediosPago });
        estadoUsuario[senderId] = 'ESPERANDO_COMPROBANTE';
        // Configurar timer de hibernación
    } else {
        const mensajeConfirmacion = "😊 ¡Perfecto! Ya estamos alistando su pedido. Cuando esté listo para la entrega, nos comunicaremos con usted para que esté atento a la hora. ¡Gracias por su compra!";
        allMessages.push({ type: 'text', text: mensajeConfirmacion });
        finalizarSesion(senderId, true);
    }
    return allMessages;
}


async function enviarInfoPromo(res, to, producto) {
    if (!producto || !producto.nombre) {
        await enviarMensajeTexto(res, '⚠️ Lo siento, no pude encontrar los detalles de esa promoción.');
        return;
    }
    pedidoActivo[to] = { ...pedidoActivo[to], ultimoProductoVisto: producto.codigo };

    const elements = [{
        title: producto.nombre,
        subtitle: `${producto.descripcion}\n💰 Precio: ${producto.precio}`,
        image_url: producto.imagen,
        buttons: [{
            type: 'dynamic_block_callback',
            caption: '🛍️ Pedir este modelo',
            url: process.env.RAILWAY_APP_URL + '/webhook',
            method: 'post',
            payload: { action: `COMPRAR_PRODUCTO_${producto.codigo}` }
        }, {
            type: 'node',
            caption: '📖 Ver otros modelos',
            target: 'gatillo_ver_modelos'
        }]
    }];
    
    responderAManyChat(res, [{ type: 'cards', elements: elements, image_aspect_ratio: 'square' }]);
}

async function enviarMensajeTexto(res, text) {
    responderAManyChat(res, [{ type: 'text', text: text }]);
}

async function enviarMensajeConBotonSalir(res, text) {
    const messages = [{ type: 'text', text: text }];
    const quick_replies = [{
        type: 'node',
        caption: '🔙 Salir',
        target: 'gatillo_salir' // Un nodo en ManyChat que envíe la palabra "salir" a tu bot.
    }];
    responderAManyChat(res, messages, quick_replies);
}

async function enviarPreguntaUbicacion(res) {
    const messages = [{
        type: 'text',
        text: "😊 Para coordinar el envío, por favor indíquenos, ¿para dónde es su pedido?"
    }];
    const quick_replies = [
        { type: 'node', caption: '🏙️ Lima', target: 'gatillo_comprar_lima' },
        { type: 'node', caption: '🏞️ Provincia', target: 'gatillo_comprar_provincia' }
    ];
    responderAManyChat(res, messages, quick_replies);
}


app.listen(PORT, () => {
    console.log(`🚀 Servidor para ManyChat escuchando en http://0.0.0.0:${PORT}`);
});