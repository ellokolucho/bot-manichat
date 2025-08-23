const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config();
const OpenAI = require('openai');

// --- CONFIGURACIÓN ---
const MENSAJE_DE_ESPERA = "Un momento por favor... 💭";

// Carga de datos
const data = require('./data.json');
const promoData = require('./promoData.json');
const systemPrompt = fs.readFileSync('./SystemPrompt.txt', 'utf-8');

// Memoria y estados
const memoriaConversacion = {};
let primerMensaje = {};
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

    // Las acciones de botones que no usan IA se manejan de forma síncrona y rápida
    if (payload && payload.action) {
        const action = payload.action.toUpperCase();
        const accionesRapidas = ['VER_MODELOS', 'CABALLEROS', 'DAMAS', 'CABALLEROS_AUTO', 'CABALLEROS_CUARZO', 'DAMAS_AUTO', 'DAMAS_CUARZO'];
        
        if (accionesRapidas.includes(action)) {
            console.log(`🤖 Procesando PAYLOAD síncrono: ${action}`);
            switch (action) {
                case 'VER_MODELOS': return await enviarMenuPrincipal(res);
                case 'CABALLEROS': case 'DAMAS': return await enviarSubmenuTipoReloj(res, action);
                case 'CABALLEROS_AUTO': return await enviarCatalogo(res, from, 'caballeros_automaticos');
                case 'CABALLEROS_CUARZO': return await enviarCatalogo(res, from, 'caballeros_cuarzo');
                case 'DAMAS_AUTO': return await enviarCatalogo(res, from, 'damas_automaticos');
                case 'DAMAS_CUARZO': return await enviarCatalogo(res, from, 'damas_cuarzo');
            }
        }
    }
    
    // Todas las demás interacciones (texto o botones que usan IA) usan el flujo asíncrono
    console.log(`⏳ Iniciando flujo asíncrono para: "${textFromUser || payload?.action}"`);
    
    // 1. Enviamos respuesta inmediata para evitar el timeout
    res.json({
        version: "v2",
        content: { messages: [{ type: "text", text: MENSAJE_DE_ESPERA }] }
    });

    // 2. Procesamos la consulta larga en segundo plano
    procesarConsultaLarga(from, textFromUser, payload);
});


// ===== FUNCIÓN DE PROCESAMIENTO ASÍNCRONO =====
async function procesarConsultaLarga(senderId, mensajeCliente, payload) {
    // Si la acción vino de un botón, usamos esa acción. Si no, el texto.
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
                           Object.values(promoData).find(p => p.codigo.toUpperCase().includes(codigo.toUpperCase()));
            messagesToSend = producto ? construirMensajeInfoPromo(producto) : [{ type: 'text', text: `😔 Lo siento, no pude encontrar el modelo con código ${codigo}.` }];
        } else if (respuesta === 'PEDIR_CATALOGO') {
            messagesToSend = construirMenuPrincipal();
        } else if (respuesta.startsWith('PREGUNTAR_TIPO:')) {
            const genero = respuesta.split(':')[1].trim().toUpperCase();
            messagesToSend = construirSubmenuTipoReloj(genero);
        } else if (respuesta.startsWith('MOSTRAR_CATALOGO:')) {
            const tipo = respuesta.split(':')[1].trim();
            messagesToSend = construirCatalogo(senderId, tipo);
        } else {
            messagesToSend = [{ type: 'text', text: respuesta }];
        }
        await enviarMensajeProactivoManyChat(senderId, messagesToSend);

    } catch (error) {
        console.error('❌ Error en consulta a ChatGPT:', error);
        await enviarMensajeProactivoManyChat(senderId, [{ type: 'text', text: '⚠️ Lo siento, hubo un problema con el asesor. Intente nuevamente.' }]);
    }
}


// ===== FUNCIÓN PARA ENVIAR MENSAJES PROACTIVOS =====
async function enviarMensajeProactivoManyChat(subscriberId, messages) {
    if (!MANYCHAT_API_KEY) {
        console.error("### ERROR CRÍTICO: MANYCHAT_API_KEY no está definida. ###");
        return;
    }
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
        console.error("### ERROR CRÍTICO AL ENVIAR MENSAJE PROACTIVO ###");
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
    const response = { version: "v2", content: { messages } };
    res.json(response);
}

async function enviarMenuPrincipal(res) {
    responderAManyChat(res, construirMenuPrincipal());
}
async function enviarSubmenuTipoReloj(res, genero) {
    responderAManyChat(res, construirSubmenuTipoReloj(genero));
}
async function enviarCatalogo(res, to, tipo) {
    responderAManyChat(res, construirCatalogo(to, tipo));
}


// ===== FUNCIONES "CONSTRUCTORAS" DE MENSAJES (BASADAS EN TU LÓGICA) =====
function construirMenuPrincipal() {
    return [{
        type: 'text', text: '👋 ¡Hola! Bienvenido a Tiendas Megan\n💎 Descubra su reloj ideal o el regalo perfecto 🎁',
        buttons: [
            { type: 'dynamic_block_callback', caption: '🤵‍♂️ Para Caballeros', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'CABALLEROS' }},
            { type: 'dynamic_block_callback', caption: '💃 Para Damas', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'DAMAS' }},
            { type: 'dynamic_block_callback', caption: '💬 Hablar con Asesor', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'ASESOR' }}
        ]
    }];
}
function construirSubmenuTipoReloj(genero) {
    const label = genero === 'CABALLEROS' ? 'caballeros' : 'damas';
    return [{
        type: 'text', text: `✅ ¡Excelente elección! ¿Qué tipo de reloj para ${label} le gustaría ver?`,
        buttons: [
            { type: 'dynamic_block_callback', caption: '⌚ Automáticos', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: `${genero}_AUTO` }},
            { type: 'dynamic_block_callback', caption: '⏱️ De cuarzo', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: `${genero}_CUARZO` }}
        ]
    }];
}
function construirCatalogo(to, tipo) {
    const productos = data[tipo];
    if (!productos || !productos.length) return [{ type: 'text', text: '😔 Lo siento, no hay productos disponibles.' }];
    const elements = productos.map(p => ({
        title: p.nombre, subtitle: `${p.descripcion}\n💲 ${p.precio} soles`, image_url: p.imagen,
        buttons: [{ type: 'dynamic_block_callback', caption: '🛍️ Pedir este modelo', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: `COMPRAR_PRODUCTO_${p.codigo}` }}]
    }));
    return [{ type: 'cards', elements: elements, image_aspect_ratio: 'square' }, {
        type: 'text', text: '✨ ¿Le gustaría adquirir alguno o ver otras opciones?',
        buttons: [{ type: 'dynamic_block_callback', caption: '📖 Volver al menú', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'VER_MODELOS' }}]
    }];
}
function construirMensajeInfoPromo(producto) {
    if (!producto) return [{ type: 'text', text: '⚠️ No se pudo encontrar la promo.' }];
    return [{
        type: 'cards', elements: [{
            title: producto.nombre, subtitle: `${producto.descripcion}\n💰 Precio: ${producto.precio}`, image_url: producto.imagen,
            buttons: [
                { type: 'dynamic_block_callback', caption: '🛍️ Pedir este modelo', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: `COMPRAR_PRODUCTO_${producto.codigo}` }},
                { type: 'dynamic_block_callback', caption: '📖 Ver otros modelos', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'VER_MODELOS' }}
            ]
        }], image_aspect_ratio: 'square'
    }];
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor para ManyChat escuchando en http://0.0.0.0:${PORT}`);
});