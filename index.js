const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config();
const OpenAI = require('openai');

const MENSAJE_DE_ESPERA = "Un momento por favor... 💭";

const data = require('./data.json');
const promoData = require('./promoData.json');
const systemPrompt = fs.readFileSync('./SystemPrompt.txt', 'utf-8');

const memoriaConversacion = {};
const estadoUsuario = {};
let primerMensaje = {};
let timersInactividad = {};
let pedidoActivo = {};

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MANYCHAT_API_KEY = process.env.MANYCHAT_API_KEY;
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

app.post('/webhook', async (req, res) => {
    console.log('--- NUEVA SOLICITUD ---');
    console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2));

    const from = req.body.id;
    const textFromUser = req.body.last_input_text || '';
    const payload = req.body.payload || null;

    if (!from) return res.status(400).send('Falta ID de usuario.');

    reiniciarTimerInactividad(from);

    if (payload && payload.action) {
        const action = payload.action.toUpperCase();
        console.log(`🤖 Decodificando PAYLOAD de botón: ${action}`);
        
        const accionesRapidas = ['VER_MODELOS', 'CABALLEROS', 'DAMAS', 'CABALLEROS_AUTO', 'CABALLEROS_CUARZO', 'DAMAS_AUTO', 'DAMAS_CUARZO'];
        
        if (accionesRapidas.includes(action)) {
            console.log(`⚡️ Es una acción rápida. Respondiendo de forma síncrona.`);
            switch (action) {
                case 'VER_MODELOS': return await enviarMenuPrincipal(res);
                case 'CABALLEROS': case 'DAMAS': return await enviarSubmenuTipoReloj(res, action);
                case 'CABALLEROS_AUTO': return await enviarCatalogo(res, 'caballeros_automaticos');
                case 'CABALLEROS_CUARZO': return await enviarCatalogo(res, 'caballeros_cuarzo');
                case 'DAMAS_AUTO': return await enviarCatalogo(res, 'damas_automaticos');
                case 'DAMAS_CUARZO': return await enviarCatalogo(res, 'damas_cuarzo');
            }
        }
    }
    
    console.log(`⏳ Iniciando flujo asíncrono para: "${textFromUser || payload?.action}"`);
    res.json({
        version: "v2",
        content: { messages: [{ type: "text", text: MENSAJE_DE_ESPERA }] }
    });
    procesarConsultaLarga(from, textFromUser, payload);
});

async function procesarConsultaLarga(senderId, mensajeCliente, payload) {
    const input = payload?.action || mensajeCliente;
    try {
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
        console.log(`📤 Enviando mensaje proactivo a ${subscriberId} con contenido:`, JSON.stringify(messages, null, 2));
        await axios.post(url, body, { headers });
        console.log(`✅ Mensaje proactivo enviado con éxito.`);
    } catch (error) {
        console.error("### ERROR CRÍTICO AL ENVIAR MENSAJE PROACTIVO ###");
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Data:", JSON.stringify(error.response.data, null, 2));
        } else {
            console.error("Error:", error.message);
        }
    }
}

function responderAManyChat(res, messages = []) {
    const response = { version: "v2", content: { messages } };
    console.log("📢 Respondiendo síncronamente a ManyChat con contenido:", JSON.stringify(messages, null, 2));
    res.json(response);
}

// Las funciones síncronas solo construyen y responden.
async function enviarMenuPrincipal(res) {
    responderAManyChat(res, construirMenuPrincipal());
}
async function enviarSubmenuTipoReloj(res, genero) {
    responderAManyChat(res, construirSubmenuTipoReloj(genero));
}
async function enviarCatalogo(res, tipo) {
    responderAManyChat(res, construirCatalogo(tipo));
}

// ===== FUNCIONES "CONSTRUCTORAS" DE MENSAJES (SIMPLIFICADAS) =====
function construirMenuPrincipal() {
    return [{
        type: 'text',
        text: '👋 ¡Hola! Bienvenido a Tiendas Megan\n💎 Descubra su reloj ideal o el regalo perfecto 🎁',
        buttons: [
            { type: 'dynamic_block_callback', caption: '⌚ Para Caballeros', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'CABALLEROS' }},
            { type: 'dynamic_block_callback', caption: '🕒 Para Damas', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'DAMAS' }},
            { type: 'dynamic_block_callback', caption: '💬 Hablar con Asesor', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'ASESOR' }}
        ]
    }];
}

function construirSubmenuTipoReloj(genero) {
    const label = genero === "CABALLEROS" ? "caballeros" : "damas";
    const payloadAuto = genero === "CABALLEROS" ? "CABALLEROS_AUTO" : "DAMAS_AUTO";
    const payloadCuarzo = genero === "CABALLEROS" ? "CABALLEROS_CUARZO" : "DAMAS_CUARZO";
    
    // Devolvemos un solo mensaje con los dos botones. Esta es la estructura más simple posible.
    return [{
        type: 'text',
        text: `🔥 ¡Excelente elección! ¿Qué tipo de reloj para ${label} le interesa?`,
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
        buttons: [{ type: 'dynamic_block_callback', caption: '🛍️ Comprar ahora', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: `COMPRAR_${p.codigo}` }}]
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
                { type: 'dynamic_block_callback', caption: '📖 Ver otros modelos', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'VER_MODELOS' }}
            ]
        }], image_aspect_ratio: 'square'
    }];
}

// ===== LÓGICA DE ESTADO Y TIMERS (RESTAURADA Y ADAPTADA) =====
let timersInactividad = {};

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
    // Simplificado para máxima compatibilidad: enviamos dos mensajes separados.
    const messages = [
        { type: 'text', text: '¿Podemos ayudarte en algo más? 😊 También puedes continuar tu pedido por WhatsApp:' },
        { 
            type: 'text', 
            text: 'Click aquí para ir a WhatsApp',
            buttons: [{ type: 'web_url', caption: '📞 Continuar por WhatsApp', url: "https://wa.me/51904805167" }]
        }
    ];
    await enviarMensajeProactivoManyChat(senderId, messages);
}

async function finalizarSesion(senderId) {
    console.log(`⌛ Finalizando sesión por inactividad para ${senderId}`);
    delete memoriaConversacion[senderId];
    delete primerMensaje[senderId];
    limpiarTimers(senderId);
    await enviarMensajeProactivoManyChat(senderId, [{type: 'text', text: "⏳ Tu sesión ha terminado. ¡Gracias por visitar Tiendas Megan!"}]);
}


app.listen(PORT, () => {
  console.log(`🚀 Servidor para ManyChat escuchando en http://0.0.0.0:${PORT}`);
});