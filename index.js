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

// Memoria y estados (basados en tu bot de Messenger)
const memoriaConversacion = {};
const estadoUsuario = {};
let primerMensaje = {};
let timersInactividad = {};

const app = express();
app.use(bodyParser.json());

// Variables de Entorno
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MANYCHAT_API_KEY = process.env.MANYCHAT_API_KEY;
const client = new OpenAI({ apiKey: OPENAI_API_KEY });


// ===== MANEJADOR PRINCIPAL DE MENSAJES =====
app.post('/webhook', async (req, res) => {
    console.log('--- NUEVA SOLICITUD ---');
    console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2));

    const from = req.body.id;
    const textFromUser = req.body.last_input_text || '';
    const payload = req.body.payload || null;

    if (!from) return res.status(400).send('Falta ID de usuario.');
    
    reiniciarTimerInactividad(from);

    let messagesToSend = [];

    // --- PRIORIDAD 1: Clics en Botones (Payload) ---
    if (payload && payload.action) {
        const action = payload.action.toUpperCase();
        console.log(`🤖 Procesando PAYLOAD de botón: ${action}`);
        primerMensaje[from] = true;
        
        switch (action) {
            case 'CABALLEROS': messagesToSend = construirSubmenuTipoReloj('CABALLEROS'); break;
            case 'DAMAS': messagesToSend = construirSubmenuTipoReloj('DAMAS'); break;
            case 'CABALLEROS_AUTO': messagesToSend = construirCatalogo('caballeros_automaticos'); break;
            case 'CABALLEROS_CUARZO': messagesToSend = construirCatalogo('caballeros_cuarzo'); break;
            case 'DAMAS_AUTO': messagesToSend = construirCatalogo('damas_automaticos'); break;
            case 'DAMAS_CUARZO': messagesToSend = construirCatalogo('damas_cuarzo'); break;
            case 'VER_MODELOS': messagesToSend = construirMenuPrincipal(); break;
            default:
                // Si la acción del botón requiere IA, pasa al procesamiento de texto
                messagesToSend = await procesarConsultaConChatGPT(from, action);
                break;
        }
    
    // --- PRIORIDAD 2: Mensajes de texto ---
    } else if (textFromUser) {
        console.log(`💬 Procesando TEXTO: ${textFromUser}`);
        if (!primerMensaje[from]) {
            primerMensaje[from] = true;
            messagesToSend = construirMenuPrincipal();
        } else {
            messagesToSend = await procesarConsultaConChatGPT(from, textFromUser);
        }

    // --- PRIORIDAD 3: Primer contacto sin texto ---
    } else if (!primerMensaje[from]) {
        primerMensaje[from] = true;
        messagesToSend = construirMenuPrincipal();
    }

    if (messagesToSend && messagesToSend.length > 0) {
        responderAManyChat(res, messagesToSend);
    } else {
        res.sendStatus(200);
    }
});


// ===== FUNCIÓN DE CONSULTA A OPENAI (DEVUELVE EL MENSAJE A ENVIAR) =====
async function procesarConsultaConChatGPT(senderId, mensajeCliente) {
    try {
        console.log(`🧠 Enviando a ChatGPT: "${mensajeCliente}"`);
        if (!memoriaConversacion[senderId]) memoriaConversacion[senderId] = [];
        memoriaConversacion[senderId].push({ role: 'user', content: mensajeCliente });

        const contexto = [{ role: 'system', content: systemPrompt }, ...memoriaConversacion[senderId]];
        const response = await client.chat.completions.create({ model: 'gpt-4o', messages: contexto });
        const respuesta = response.choices[0].message.content.trim();
        memoriaConversacion[senderId].push({ role: 'assistant', content: respuesta });
        
        console.log(`🤖 Respuesta de ChatGPT: ${respuesta}`);

        if (respuesta.startsWith('MOSTRAR_MODELO:')) {
            const codigo = respuesta.split(':')[1].trim();
            const producto = Object.values(data).flat().find(p => p.codigo.toUpperCase().includes(codigo.toUpperCase())) || 
                           Object.values(promoData).find(p => p.nombre.toUpperCase().includes(codigo.toUpperCase()));
            return producto ? construirMensajeInfoPromo(producto) : [{ type: 'text', text: `😔 Lo siento, no pude encontrar el modelo con código ${codigo}.` }];
        }
        if (respuesta === 'PEDIR_CATALOGO') return construirMenuPrincipal();
        if (respuesta.startsWith('PREGUNTAR_TIPO:')) {
            const genero = respuesta.split(':')[1].trim().toUpperCase();
            return construirSubmenuTipoReloj(genero);
        }
        if (respuesta.startsWith('MOSTRAR_CATALOGO:')) {
            const tipo = respuesta.split(':')[1].trim();
            return construirCatalogo(tipo);
        }
        
        return [{ type: 'text', text: respuesta }];

    } catch (error) {
        console.error('❌ Error en consulta a ChatGPT:', error);
        return [{ type: 'text', text: '⚠️ Lo siento, hubo un problema con el asesor. Intente nuevamente.' }];
    }
}


// ===== FUNCIÓN DE RESPUESTA ÚNICA Y DIRECTA A MANYCHAT =====
function responderAManyChat(res, messages = []) {
    const response = { version: "v2", content: { messages } };
    console.log("📢 Respondiendo a ManyChat:", JSON.stringify(messages, null, 2));
    res.json(response);
}


// ===== FUNCIONES "CONSTRUCTORAS" DE MENSAJES (TRADUCIDAS DE TU BOT DE MESSENGER) =====
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

// ===== LÓGICA DE INACTIVIDAD (ADAPTADA PARA MANYCHAT) =====
async function enviarMensajeProactivoManyChat(subscriberId, messages) {
    if (!MANYCHAT_API_KEY) return console.error("### ERROR CRÍTICO: MANYCHAT_API_KEY no definida. ###");
    
    const url = 'https://api.manychat.com/fb/sending/sendContent';
    const headers = { 'Authorization': `Bearer ${MANYCHAT_API_KEY}`, 'Content-Type': 'application/json' };
    const body = {
        subscriber_id: subscriberId,
        data: { version: 'v2', content: { messages } },
        message_tag: "POST_PURCHASE_UPDATE" // Etiqueta necesaria para enviar mensajes fuera de la ventana de 24h
    };

    try {
        console.log(`📤 Enviando mensaje proactivo de inactividad a ${subscriberId}`);
        await axios.post(url, body, { headers });
        console.log(`✅ Mensaje proactivo de inactividad enviado con éxito.`);
    } catch (error) {
        console.error("### ERROR AL ENVIAR MENSAJE PROACTIVO ###", error.response ? error.response.data : error.message);
    }
}

function reiniciarTimerInactividad(senderId) {
    limpiarTimers(senderId);
    const timer10 = setTimeout(() => enviarAvisoInactividad(senderId), 10 * 60 * 1000);
    const timer12 = setTimeout(() => finalizarSesion(senderId), 12 * 60 * 1000);
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
    console.log(`⏳ Enviando aviso de inactividad a ${senderId}`);
    const messages = [{
        type: 'text', text: '¿Le gustaría que le ayudemos en algo más o desea continuar la conversación con un asesor por WhatsApp?',
        buttons: [{ type: 'web_url', caption: '📞 Continuar en WhatsApp', url: "https://wa.me/51904805167" }]
    }];
    await enviarMensajeProactivoManyChat(senderId, messages);
}

async function finalizarSesion(senderId) {
    console.log(`⌛ Finalizando sesión por inactividad para ${senderId}`);
    delete memoriaConversacion[senderId];
    delete primerMensaje[senderId];
    limpiarTimers(senderId);
    await enviarMensajeProactivoManyChat(senderId, [{type: 'text', text: "⏳ Su sesión ha terminado."}]);
}


app.listen(PORT, () => {
  console.log(`🚀 Servidor para ManyChat escuchando en http://0.0.0.0:${PORT}`);
});