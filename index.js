const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config();
const OpenAI = require('openai');

// Carga de datos
const data = require('./data.json');
const promoData = require('./promoData.json');
const systemPrompt = fs.readFileSync('./SystemPrompt.txt', 'utf-8');

// Memoria y estados (conservados de tu bot de Messenger)
const memoriaConversacion = {};
const estadoUsuario = {};
let primerMensaje = {};
let timersInactividad = {};
let pedidoActivo = {};

const app = express();
app.use(bodyParser.json());

// Variables de Entorno
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MANYCHAT_API_KEY = process.env.MANYCHAT_API_KEY;
const client = new OpenAI({ apiKey: OPENAI_API_KEY });


// ===== MANEJADOR PRINCIPAL DE MENSAJES =====
app.post('/webhook', async (req, res) => {
    console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2));

    const from = req.body.id;
    const textFromUser = req.body.last_input_text || '';
    const payload = req.body.payload || null;

    if (!from) return res.status(400).send('Falta ID de usuario.');
    
    reiniciarTimerInactividad(from);

    // --- PRIORIDAD 1: Clics en Botones (Payload) ---
    // Esto reemplaza la lógica de 'postback' y 'quick_reply' de tu bot de Messenger
    if (payload && payload.action) {
        const action = payload.action.toUpperCase();
        console.log(`🤖 Procesando PAYLOAD de botón: ${action}`);
        primerMensaje[from] = true;

        if (action.startsWith('COMPRAR_')) {
            const codigo = action.split('_')[1];
            pedidoActivo[from] = { codigo };
            return await enviarPreguntaUbicacion(res);
        }
        
        switch (action) {
            case 'CABALLEROS': return await enviarSubmenuTipoReloj(res, 'CABALLEROS');
            case 'DAMAS': return await enviarSubmenuTipoReloj(res, 'DAMAS');
            case 'ASESOR':
                estadoUsuario[from] = 'ASESOR';
                memoriaConversacion[from] = [];
                return await enviarMensajeConBotonSalir(res, "😊 ¡Claro que sí! Estamos listos para responder todas sus dudas y consultas. Por favor, escríbenos qué te gustaría saber ✍️");
            case 'CABALLEROS_AUTO': return await enviarCatalogo(res, 'caballeros_automaticos');
            case 'CABALLEROS_CUARZO': return await enviarCatalogo(res, 'caballeros_cuarzo');
            case 'DAMAS_AUTO': return await enviarCatalogo(res, 'damas_automaticos');
            case 'DAMAS_CUARZO': return await enviarCatalogo(res, 'damas_cuarzo');
            case 'VER_MODELOS': return await enviarMenuPrincipal(res);
            case 'SALIR_ASESOR':
                delete estadoUsuario[from];
                delete memoriaConversacion[from];
                await enviarMensajeTexto(res, "🚪 Has salido del chat con asesor.");
                return await enviarMenuPrincipal(res); // Envía una nueva respuesta para continuar
            case 'UBICACION_LIMA':
                estadoUsuario[from] = 'ESPERANDO_DATOS_LIMA';
                return await enviarMensajeTexto(res, "😊 Claro que sí. Por favor, para enviar su pedido indíquenos los siguientes datos:\n\n✅ Nombre completo ✍️\n✅ Dirección exacta 📍\n✅ Una referencia de cómo llegar a su domicilio 🏠");
            case 'UBICACION_PROVINCIA':
                estadoUsuario[from] = 'ESPERANDO_DATOS_PROVINCIA';
                return await enviarMensajeTexto(res, "😊 Claro que sí. Por favor, permítanos los siguientes datos para programar su pedido:\n\n✅ Nombre completo ✍️\n✅ DNI 🪪\n✅ Agencia Shalom que le queda más cerca 🚚");
            default:
                // Si el payload no es reconocido, pasamos a la IA
                return await procesarConChatGPT(res, from, textFromUser, payload);
        }
    }
    
    // --- PRIORIDAD 2: Mensajes de texto ---
    if (textFromUser) {
        return await procesarConChatGPT(res, from, textFromUser, null);
    }
    
    // Si no hay texto ni payload (ej. primer contacto), enviar menú principal
    if (!primerMensaje[from]) {
        primerMensaje[from] = true;
        await enviarMenuPrincipal(res);
    } else {
        res.json({}); 
    }
});


// ===== FUNCIÓN UNIFICADA DE PROCESAMIENTO DE TEXTO Y AI =====
async function procesarConChatGPT(res, senderId, mensajeCliente, payload) {
    // Si el usuario está en un estado específico (ej. pidiendo datos), no usamos la IA
    if (estadoUsuario[senderId]) {
         // Lógica para manejar estados como 'ESPERANDO_DATOS_LIMA', etc.
         // Se puede expandir aquí si es necesario, por ahora lo maneja la IA.
    }

    // Usamos el flujo asíncrono para todas las consultas a la IA para evitar timeouts
    const MENSAJE_DE_ESPERA = "Un momento por favor... 💭";
    res.json({
        version: "v2",
        content: { messages: [{ type: "text", text: MENSAJE_DE_ESPERA }] }
    });

    try {
        const input = payload?.action || mensajeCliente;
        console.log(`🧠 Enviando a ChatGPT: "${input}"`);

        if (!memoriaConversacion[senderId]) memoriaConversacion[senderId] = [];
        memoriaConversacion[senderId].push({ role: 'user', content: input });
        const contexto = [{ role: 'system', content: systemPrompt }, ...memoriaConversacion[senderId]];

        const response = await client.chat.completions.create({ model: 'gpt-4o', messages: contexto });
        const respuesta = response.choices[0].message.content.trim();
        memoriaConversacion[senderId].push({ role: 'assistant', content: respuesta });
        
        console.log(`🤖 Respuesta de ChatGPT: ${respuesta}`);
        let messagesToSend;

        if (respuesta.startsWith('MOSTRAR_MODELO:')) {
            const codigo = respuesta.split(':')[1].trim();
            const producto = Object.values(data).flat().find(p => p.codigo.toUpperCase().includes(codigo.toUpperCase())) || 
                           Object.values(promoData).find(p => p.nombre.toUpperCase().includes(codigo.toUpperCase()));
            messagesToSend = producto ? construirMensajeInfoPromo(producto) : [{ type: 'text', text: `😔 Lo siento, no pude encontrar el modelo con código ${codigo}.` }];
        } else if (respuesta === 'PEDIR_CATALOGO') {
            messagesToSend = construirMenuPrincipal();
        } else if (respuesta.startsWith('PREGUNTAR_TIPO:')) {
            const genero = respuesta.split(':')[1].trim().toUpperCase();
            messagesToSend = construirSubmenuTipoReloj(genero);
        } else if (respuesta.startsWith('MOSTRAR_CATALOGO:')) {
            const tipo = respuesta.split(':')[1].trim();
            messagesToSend = construirCatalogo(tipo);
        } else {
            messagesToSend = [{ type: 'text', text: respuesta }];
        }
        await enviarMensajeProactivoManyChat(senderId, messagesToSend);

    } catch (error) {
        console.error('❌ Error en consulta a ChatGPT:', error);
        await enviarMensajeProactivoManyChat(senderId, [{ type: 'text', text: '⚠️ Lo siento, hubo un problema con el asesor. Intente nuevamente.' }]);
    }
}


// ===== FUNCIÓN PARA ENVIAR MENSAJES PROACTIVOS (NECESARIA PARA IA Y TIMERS) =====
async function enviarMensajeProactivoManyChat(subscriberId, messages) {
    if (!MANYCHAT_API_KEY) return console.error("### ERROR CRÍTICO: MANYCHAT_API_KEY no definida. ###");
    
    const url = 'https://api.manychat.com/fb/sending/sendContent';
    const headers = { 'Authorization': `Bearer ${MANYCHAT_API_KEY}`, 'Content-Type': 'application/json' };
    const body = {
        subscriber_id: subscriberId,
        data: { version: 'v2', content: { messages } },
        message_tag: "POST_PURCHASE_UPDATE"
    };

    try {
        console.log(`📤 Enviando mensaje proactivo a ${subscriberId}`);
        await axios.post(url, body, { headers });
        console.log(`✅ Mensaje proactivo enviado con éxito.`);
    } catch (error) {
        console.error("### ERROR AL ENVIAR MENSAJE PROACTIVO ###");
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Data:", JSON.stringify(error.response.data, null, 2));
        } else {
            console.error("Error:", error.message);
        }
    }
}


// ===== FUNCIONES SÍNCRONAS (RESPUESTAS RÁPIDAS) =====
function responderAManyChat(res, messages = []) {
    res.json({ version: "v2", content: { messages } });
}

async function enviarMenuPrincipal(res) {
    responderAManyChat(res, construirMenuPrincipal());
}
async function enviarSubmenuTipoReloj(res, genero) {
    responderAManyChat(res, construirSubmenuTipoReloj(genero));
}
async function enviarCatalogo(res, tipo) {
    responderAManyChat(res, construirCatalogo(tipo));
}
async function enviarPreguntaUbicacion(res) {
     responderAManyChat(res, construirPreguntaUbicacion());
}
async function enviarMensajeTexto(res, texto) {
    responderAManyChat(res, [{type: 'text', text: texto}]);
}
async function enviarMensajeConBotonSalir(res, texto) {
    responderAManyChat(res, construirMensajeConBotonSalir(texto));
}


// ===== FUNCIONES "CONSTRUCTORAS" DE MENSAJES (TRADUCIDAS DE TU BOT) =====
function construirMenuPrincipal() {
    return [{
        type: 'text', text: '👋 ¡Hola! Bienvenido a Tiendas Megan\n💎 Descubra su reloj ideal o el regalo perfecto 🎁\nElige una opción para ayudarte 👇',
        buttons: [
            { type: 'dynamic_block_callback', caption: '⌚ Para Caballeros', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'CABALLEROS' }},
            { type: 'dynamic_block_callback', caption: '🕒 Para Damas', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'DAMAS' }},
            { type: 'dynamic_block_callback', caption: '💬 Hablar con Asesor', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'ASESOR' }}
        ]
    }];
}

function construirSubmenuTipoReloj(genero) {
    const texto = genero === "CABALLEROS" 
        ? "🔥 ¡Excelente elección! ¿Qué tipo de reloj para caballeros le interesa?"
        : "🔥 ¡Excelente elección! ¿Qué tipo de reloj para damas le interesa?";
    const payloadAuto = genero === "CABALLEROS" ? "CABALLEROS_AUTO" : "DAMAS_AUTO";
    const payloadCuarzo = genero === "CABALLEROS" ? "CABALLEROS_CUARZO" : "DAMAS_CUARZO";
    
    return [{
        type: 'text', text: texto,
        buttons: [
            { type: 'dynamic_block_callback', caption: '⌚ Automáticos ⚙️', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: payloadAuto }},
            { type: 'dynamic_block_callback', caption: '🕑 De cuarzo ✨', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: payloadCuarzo }}
        ]
    }];
}

function construirCatalogo(tipo) {
    const productos = data[tipo];
    if (!productos || !productos.length) return [{ type: 'text', text: '😔 No hay productos disponibles.' }];
    
    const elements = productos.map(p => ({
        title: p.nombre, subtitle: `${p.descripcion}\n💰 Precio: S/${p.precio}`, image_url: p.imagen,
        buttons: [
            { type: 'dynamic_block_callback', caption: '🛍️ Comprar ahora', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: `COMPRAR_${p.codigo}` }},
            { type: 'web_url', caption: '📞 Comprar por WhatsApp', url: "https://wa.me/51904805167?text=Hola%20quiero%20comprar%20este%20modelo" },
            { type: 'dynamic_block_callback', caption: '📖 Ver otros modelos', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'VER_MODELOS' }}
        ]
    }));
    return [{ type: 'cards', elements: elements, image_aspect_ratio: 'square' }];
}

function construirMensajeInfoPromo(producto) {
    if (!producto) return [{ type: 'text', text: '⚠️ No se pudo encontrar la promo.' }];
    
    return [{
        type: 'cards', elements: [{
            title: producto.nombre, subtitle: `${producto.descripcion}\n💰 Precio: S/${producto.precio}`, image_url: producto.imagen,
            buttons: [
                { type: 'dynamic_block_callback', caption: '🛍️ Comprar ahora', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: `COMPRAR_${producto.codigo}` }},
                { type: 'web_url', caption: '📞 Comprar por WhatsApp', url: "https://wa.me/51904805167?text=Hola%20quiero%20comprar%20este%20modelo" },
                { type: 'dynamic_block_callback', caption: '📖 Ver otros modelos', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'VER_MODELOS' }}
            ]
        }], image_aspect_ratio: 'square'
    }];
}

function construirPreguntaUbicacion() {
    return [{
        type: 'text', text: "😊 Por favor indíquenos, ¿su pedido es para Lima o para Provincia?",
        buttons: [
            { type: 'dynamic_block_callback', caption: '🏙 Lima', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'UBICACION_LIMA' }},
            { type: 'dynamic_block_callback', caption: '🏞 Provincia', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'UBICACION_PROVINCIA' }}
        ]
    }];
}

function construirMensajeConBotonSalir(texto) {
     return [{
        type: 'text', text: texto,
        buttons: [{ type: 'dynamic_block_callback', caption: '↩️ Volver al inicio', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'SALIR_ASESOR' }}]
    }];
}


// ===== LÓGICA DE ESTADO Y TIMERS (RESTAURADA Y ADAPTADA) =====

function reiniciarTimerInactividad(senderId) {
    limpiarTimers(senderId);
    const timer10 = setTimeout(() => enviarAvisoInactividad(senderId), 10 * 60 * 1000); // 10 min
    const timer12 = setTimeout(() => finalizarSesion(senderId), 12 * 60 * 1000); // 12 min
    timersInactividad[senderId] = { timer10, timer12 };
}

function limpiarTimers(senderId) {
    if (timersInactividad[senderId]) {
        clearTimeout(timersInactividad[senderId].timer10);
        clearTimeout(timersInactividad[senderId].timer12);
        delete timersInactividad[senderId];
    }
}

async function enviarAvisoInactividad(senderId) {
    const messages = [{
        type: 'text', text: '¿Podemos ayudarte en algo más? 😊 También puedes continuar tu pedido por WhatsApp:',
        buttons: [{ type: 'web_url', caption: '📞 Continuar por WhatsApp', url: "https://wa.me/51904805167" }]
    }];
    await enviarMensajeProactivoManyChat(senderId, messages);
}

async function finalizarSesion(senderId) {
    delete estadoUsuario[senderId];
    delete memoriaConversacion[senderId];
    limpiarTimers(senderId);
    await enviarMensajeProactivoManyChat(senderId, [{type: 'text', text: "⏳ Tu sesión ha terminado. ¡Gracias por visitar Tiendas Megan!"}]);
}


app.listen(PORT, () => {
  console.log(`🚀 Servidor para ManyChat escuchando en http://0.0.0.0:${PORT}`);
});