const express = require('express');
const bodyParser = require('body-parser');
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

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===== MANEJADOR PRINCIPAL DE MENSAJES (MEJORADO) =====
app.post('/webhook', async (req, res) => {
    console.log('📩 Webhook de ManyChat recibido:', JSON.stringify(req.body, null, 2));

    const from = req.body.id;
    const textFromUser = req.body.last_input_text || '';
    const payload = req.body.payload || null; // Usaremos 'payload' como fuente principal para botones

    if (!from) {
        return res.status(400).send('Falta el ID de usuario.');
    }

    reiniciarTimerInactividad(from);

    // --- NUEVA LÓGICA DE PRIORIDAD: PAYLOAD DE BOTONES ---
    // Si el usuario hizo clic en un botón, 'payload' tendrá datos.
    if (payload && payload.action) {
        const action = payload.action.toUpperCase();

        // Manejo de botones de compra de productos
        if (action.startsWith('COMPRAR_PRODUCTO_')) {
            const codigoProducto = payload.action.replace('COMPRAR_PRODUCTO_', '');
            pedidoActivo[from] = { codigo: codigoProducto, ultimoProductoVisto: codigoProducto };
            await enviarPreguntaUbicacion(res);
            return;
        }

        // Manejo de botones del menú principal y submenús
        switch (action) {
            case 'VER_MODELOS':
                await enviarMenuPrincipal(res);
                break;
            case 'CABALLEROS':
            case 'DAMAS':
                await enviarSubmenuTipoReloj(res, action);
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
                await new Promise(resolve => setTimeout(resolve, 500));
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
                // Si la acción no es reconocida, lo tratamos como texto
                await procesarMensajeDeTexto(req, res);
        }
    } else {
        // Si no hay payload, procesamos el mensaje como texto normal
        await procesarMensajeDeTexto(req, res);
    }
});

// ===== FUNCIÓN PARA PROCESAR MENSAJES DE TEXTO (REFACTORIZADO) =====
async function procesarMensajeDeTexto(req, res) {
    const from = req.body.id;
    const text = req.body.last_input_text || '';
    const mensaje = text.trim().toLowerCase();

    // MODO POST-VENTA (MÁXIMA PRIORIDAD)
    if (estadoUsuario[from] === 'ESPERANDO_COMPROBANTE') {
        if (text) {
            await enviarConsultaChatGPT(res, from, text, 'post-venta');
        } else {
            await enviarMensajeTexto(res, "OK, estimado, vamos a confirmarlo. En breve le enviamos una respuesta.");
            finalizarSesion(from, true);
        }
        return;
    }

    // LÓGICA PARA RECOPILAR DATOS DE PEDIDO
    if (estadoUsuario[from] === 'ESPERANDO_DATOS_LIMA' || estadoUsuario[from] === 'ESPERANDO_DATOS_PROVINCIA') {
        datosPedidoTemporal[from].texto = (datosPedidoTemporal[from].texto || '') + text + '\n';
        if (verificarDatosCompletos(from)) {
            if (timersPedido[from]) clearTimeout(timersPedido[from]);
            await manejarFlujoCompra(res, from, datosPedidoTemporal[from].texto);
            delete datosPedidoTemporal[from];
            delete timersPedido[from];
        } else {
            if (timersPedido[from]) clearTimeout(timersPedido[from]);
            timersPedido[from] = setTimeout(() => {
                console.log(`Temporizador de pedido para ${from} finalizado. Datos insuficientes.`);
            }, 15000);
            return res.json({}); // Respondemos vacío para que el usuario siga escribiendo
        }
        return;
    }

    // MODO ASESOR
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

    // MENSAJES ESPECÍFICOS DE PROMO
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

    // MENSAJES COMUNES
    if (/^(gracias|muchas gracias|mil gracias)$/i.test(mensaje)) {
        await enviarMensajeTexto(res, "😊 ¡De nada! Estamos para servirle.");
        return;
    }

    // COMPORTAMIENTO POR DEFECTO
    if (primerMensaje[from]) {
        await enviarConsultaChatGPT(res, from, text);
    } else {
        primerMensaje[from] = true;
        await enviarMenuPrincipal(res);
    }
}


// ===== FUNCIONES DE ENVÍO DE MENSAJES (ACTUALIZADAS) =====

/**
 * Función central para responder a ManyChat.
 * No necesita cambios.
 */
function responderAManyChat(res, messages = [], actions = [], quick_replies = []) {
    const response = {
        version: "v2",
        content: { messages, actions, quick_replies }
    };
    if (quick_replies.length === 0) delete response.content.quick_replies;
    if (actions.length === 0) delete response.content.actions;
    console.log("📢 Respondiendo a ManyChat:", JSON.stringify(response, null, 2));
    res.json(response);
}

/**
 * MEJORADO: Ahora usa botones 'dynamic_block_callback' en lugar de 'quick_replies'.
 * Esto simplifica la configuración en ManyChat.
 */
async function enviarMenuPrincipal(res) {
    const messages = [{
        type: 'text',
        text: '👋 ¡Hola! Bienvenido a Tiendas Megan\n💎 Descubra su reloj ideal o el regalo perfecto 🎁',
        buttons: [
            {
                type: 'dynamic_block_callback',
                caption: '🤵‍♂️ Para Caballeros',
                url: process.env.RAILWAY_APP_URL + '/webhook',
                payload: { action: 'CABALLEROS' }
            },
            {
                type: 'dynamic_block_callback',
                caption: '💃 Para Damas',
                url: process.env.RAILWAY_APP_URL + '/webhook',
                payload: { action: 'DAMAS' }
            },
            {
                type: 'dynamic_block_callback',
                caption: '💬 Hablar con Asesor',
                url: process.env.RAILWAY_APP_URL + '/webhook',
                payload: { action: 'ASESOR' }
            }
        ]
    }];
    responderAManyChat(res, messages);
}

/**
 * MEJORADO: También usa botones 'dynamic_block_callback'.
 */
async function enviarSubmenuTipoReloj(res, genero) {
    const label = genero === 'CABALLEROS' ? 'caballeros' : 'damas';
    const messages = [{
        type: 'text',
        text: `✅ ¡Excelente elección! ¿Qué tipo de reloj para ${label} le gustaría ver?`,
        buttons: [
            {
                type: 'dynamic_block_callback',
                caption: '⌚ Automáticos',
                url: process.env.RAILWAY_APP_URL + '/webhook',
                payload: { action: `${genero}_AUTO` }
            },
            {
                type: 'dynamic_block_callback',
                caption: '⏱️ De cuarzo',
                url: process.env.RAILWAY_APP_URL + '/webhook',
                payload: { action: `${genero}_CUARZO` }
            }
        ]
    }];
    responderAManyChat(res, messages);
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
                url: process.env.RAILWAY_APP_URL + '/webhook',
                method: 'post',
                payload: { action: `COMPRAR_PRODUCTO_${producto.codigo}` }
            }]
        };
    });

    const messages = [
        {
            type: 'cards',
            elements: elements,
            image_aspect_ratio: 'square'
        },
        {
            type: 'text',
            text: '✨ Tenemos estos modelos disponibles. ¿Le gustaría adquirir alguno o ver otras opciones? 😉',
            buttons: [{
                type: 'dynamic_block_callback',
                caption: '📖 Volver al menú',
                url: process.env.RAILWAY_APP_URL + '/webhook',
                payload: { action: 'VER_MODELOS' }
            }]
        }
    ];
    
    responderAManyChat(res, messages);
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
            payload: { action: `COMPRAR_PRODUCTO_${producto.codigo}` }
        }, {
            type: 'dynamic_block_callback',
            caption: '📖 Ver otros modelos',
            url: process.env.RAILWAY_APP_URL + '/webhook',
            payload: { action: 'VER_MODELOS' }
        }]
    }];
    
    responderAManyChat(res, [{ type: 'cards', elements: elements, image_aspect_ratio: 'square' }]);
}

/**
 * MEJORADO: Ahora usa botones para las opciones de ubicación.
 */
async function enviarPreguntaUbicacion(res) {
    const messages = [{
        type: 'text',
        text: "😊 Para coordinar el envío, por favor indíquenos, ¿para dónde es su pedido?",
        buttons: [
            {
                type: 'dynamic_block_callback',
                caption: '🏙️ Lima',
                url: process.env.RAILWAY_APP_URL + '/webhook',
                payload: { action: 'COMPRAR_LIMA' }
            },
            {
                type: 'dynamic_block_callback',
                caption: '🏞️ Provincia',
                url: process.env.RAILWAY_APP_URL + '/webhook',
                payload: { action: 'COMPRAR_PROVINCIA' }
            }
        ]
    }];
    responderAManyChat(res, messages);
}

async function enviarMensajeTexto(res, text) {
    responderAManyChat(res, [{ type: 'text', text: text }]);
}

async function enviarMensajeConBotonSalir(res, text) {
    const messages = [{
        type: 'text',
        text: text,
        buttons: [{
            type: 'dynamic_block_callback',
            caption: '🔙 Salir',
            url: process.env.RAILWAY_APP_URL + '/webhook',
            payload: { action: 'SALIR' }
        }]
    }];
    responderAManyChat(res, messages);
}

// ===== FUNCIONES DE LÓGICA INTERNA (SIN CAMBIOS SIGNIFICATIVOS) =====

function verificarDatosCompletos(senderId) {
    const datosAcumulados = datosPedidoTemporal[senderId]?.texto || '';
    const tipo = estadoUsuario[senderId];
    const lineas = datosAcumulados.split('\n').filter(l => l.trim() !== '');

    if (tipo === 'ESPERANDO_DATOS_LIMA') {
        return /[a-zA-Z]{3,}/.test(datosAcumulados) && lineas.length >= 2;
    } else if (tipo === 'ESPERANDO_DATOS_PROVINCIA') {
        return /[a-zA-Z]{3,}/.test(datosAcumulados) && /\b\d{8}\b/.test(datosAcumulados) && lineas.length >= 3;
    }
    return false;
}

async function enviarConsultaChatGPT(res, senderId, mensajeCliente, modo = 'normal') {
    try {
        if (!memoriaConversacion[senderId]) memoriaConversacion[senderId] = [];
        memoriaConversacion[senderId].push({ role: 'user', content: mensajeCliente });

        let systemMessageContent = `${systemPrompt}\n\nCatálogo disponible:\n${JSON.stringify(data)}`;
        if (modo === 'post-venta') {
            systemMessageContent += `\n\nINSTRUCCIÓN ESPECIAL: El usuario está en modo post-venta. Ayúdalo a confirmar su pago o resolver dudas sobre su envío.`;
        }

        const contexto = [{ role: 'system', content: systemMessageContent }, ...memoriaConversacion[senderId]];
        const response = await client.chat.completions.create({ model: 'gpt-4o', messages: contexto });
        const respuesta = response.choices[0].message.content.trim();
        memoriaConversacion[senderId].push({ role: 'assistant', content: respuesta });

        // ... el resto de la lógica de triggers de ChatGPT sigue igual
        
        await enviarMensajeTexto(res, respuesta);

    } catch (error) {
        console.error('❌ Error en consulta a ChatGPT:', error);
        await enviarMensajeTexto(res, '⚠️ Lo siento, hubo un problema al conectarme con el asesor. Intente nuevamente en unos minutos.');
    }
}


async function manejarFlujoCompra(res, senderId, mensaje) {
    // ... esta función no requiere cambios
}

async function generarResumenYContinuar(senderId, datos) {
    // ... esta función no requiere cambios
}

function reiniciarTimerInactividad(senderId) {
    // ... esta función no requiere cambios
}

async function finalizarSesion(senderId, conservarMemoria = false) {
    // ... esta función no requiere cambios
}


app.listen(PORT, () => {
    console.log(`🚀 Servidor para ManyChat escuchando en http://0.0.0.0:${PORT}`);
});