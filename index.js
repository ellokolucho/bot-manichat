const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const axios = require('axios'); // Necesario para la API de ManyChat
require('dotenv').config();
const OpenAI = require('openai');

// --- CONFIGURACIÓN ---
const MENSAJE_DE_ESPERA = "Un momento por favor... 💭"; // Puedes cambiar este mensaje

// Carga de datos
const data = require('./data.json');
const promoData = require('./promoData.json');
const systemPrompt = fs.readFileSync('./SystemPrompt.txt', 'utf-8');

// Memoria y estados
const memoriaConversacion = {};
const estadoUsuario = {};
let primerMensaje = {};
let pedidoActivo = {};

const app = express();
app.use(bodyParser.json());

// Variables de Entorno
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MANYCHAT_API_KEY = process.env.MANYCHAT_API_KEY; // Nueva variable
const client = new OpenAI({ apiKey: OPENAI_API_KEY });


// ===== MANEJADOR PRINCIPAL DE MENSAJES (ASÍNCRONO) =====
app.post('/webhook', async (req, res) => {
    console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2));

    const from = req.body.id;
    const textFromUser = req.body.last_input_text || '';
    const payload = req.body.payload || null;

    if (!from) return res.status(400).send('Falta ID de usuario.');

    // Las interacciones que NO requieren IA se manejan de forma síncrona y rápida
    if (payload && payload.action) {
        const action = payload.action.toUpperCase();
        console.log(`🤖 Procesando PAYLOAD síncrono: ${action}`);
        primerMensaje[from] = true;

        if (action.startsWith('COMPRAR_PRODUCTO_')) {
            const codigoProducto = payload.action.replace('COMPRAR_PRODUCTO_', '');
            pedidoActivo[from] = { codigo: codigoProducto };
            return await enviarPreguntaUbicacion(res);
        }
        
        switch (action) {
            case 'VER_MODELOS': return await enviarMenuPrincipal(res);
            case 'CABALLEROS': case 'DAMAS': return await enviarSubmenuTipoReloj(res, action);
            case 'CABALLEROS_AUTO': return await enviarCatalogo(res, from, 'caballeros_automaticos');
            case 'CABALLEROS_CUARZO': return await enviarCatalogo(res, from, 'caballeros_cuarzo');
            case 'DAMAS_AUTO': return await enviarCatalogo(res, from, 'damas_automaticos');
            case 'DAMAS_CUARZO': return await enviarCatalogo(res, from, 'damas_cuarzo');
        }
    }
    
    // Si la interacción es de texto o un botón que requiere IA, usamos el flujo asíncrono
    console.log(`⏳ Iniciando flujo asíncrono para texto: "${textFromUser}"`);

    // 1. Enviamos una respuesta inmediata para cumplir el timeout de 10s
    res.json({
        version: "v2",
        content: {
            messages: [{ type: "text", text: MENSAJE_DE_ESPERA }]
        }
    });

    // 2. Procesamos la consulta larga (ChatGPT) en segundo plano
    procesarConsultaConChatGPT(from, textFromUser);
});


// ===== NUEVA FUNCIÓN DE PROCESAMIENTO ASÍNCRONO =====
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

        // Interceptamos los triggers de la IA
        if (respuesta.startsWith('MOSTRAR_MODELO:')) {
            const codigo = respuesta.split(':')[1].trim();
            const producto = Object.values(data).flat().find(p => p.codigo === codigo) || Object.values(promoData).find(p => p.codigo === codigo);
            if (producto) await enviarMensajeProactivoManyChat(senderId, construirMensajeInfoPromo(producto));
            else await enviarMensajeProactivoManyChat(senderId, [{ type: 'text', text: `😔 Lo siento, no pude encontrar el modelo con código ${codigo}.` }]);
            return; 
        }
        if (respuesta === 'PEDIR_CATALOGO') {
            await enviarMensajeProactivoManyChat(senderId, construirMenuPrincipal());
            return;
        }
        if (respuesta.startsWith('MOSTRAR_CATALOGO:')) {
            const tipo = respuesta.split(':')[1].trim();
            await enviarMensajeProactivoManyChat(senderId, construirCatalogo(senderId, tipo));
            return;
        }
        
        // Si no es un trigger, enviamos la respuesta de texto
        await enviarMensajeProactivoManyChat(senderId, [{ type: 'text', text: respuesta }]);

    } catch (error) {
        console.error('❌ Error en consulta a ChatGPT:', error);
        await enviarMensajeProactivoManyChat(senderId, [{ type: 'text', text: '⚠️ Lo siento, hubo un problema con el asesor. Intente nuevamente.' }]);
    }
}


// ===== NUEVA FUNCIÓN PARA ENVIAR MENSAJES PROACTIVOS =====
async function enviarMensajeProactivoManyChat(subscriberId, messages) {
    const url = 'https://api.manychat.com/fb/sender';
    const headers = {
        'Authorization': `Bearer ${MANYCHAT_API_KEY}`,
        'Content-Type': 'application/json'
    };
    const body = {
        subscriber_id: subscriberId,
        data: {
            version: 'v2',
            content: {
                messages
            }
        }
    };

    try {
        console.log(`📤 Enviando mensaje proactivo a ${subscriberId}`);
        await axios.post(url, body, { headers });
        console.log(`✅ Mensaje proactivo enviado con éxito.`);
    } catch (error) {
        console.error('❌ Error al enviar mensaje proactivo a ManyChat:', error.response ? error.response.data : error.message);
    }
}


// ===== FUNCIONES SÍNCRONAS (RESPUESTAS RÁPIDAS) =====
// Estas funciones responden directamente al webhook y no usan la API proactiva.

function responderAManyChat(res, messages = []) {
    const response = { version: "v2", content: { messages } };
    console.log("📢 Respondiendo síncronamente a ManyChat:", JSON.stringify(response, null, 2));
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

async function enviarPreguntaUbicacion(res) {
    const messages = [{
        type: 'text',
        text: "😊 Para coordinar el envío, por favor indíquenos, ¿para dónde es su pedido?",
        buttons: [
            { type: 'dynamic_block_callback', caption: '🏙️ Lima', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'COMPRAR_LIMA' }},
            { type: 'dynamic_block_callback', caption: '🏞️ Provincia', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'COMPRAR_PROVINCIA' }}
        ]
    }];
    responderAManyChat(res, messages);
}


// ===== FUNCIONES "CONSTRUCTORAS" DE MENSAJES =====
// Se han separado para poder ser usadas tanto por las respuestas síncronas como las proactivas.

function construirMenuPrincipal() {
    return [{
        type: 'text',
        text: '👋 ¡Hola! Bienvenido a Tiendas Megan\n💎 Descubra su reloj ideal o el regalo perfecto 🎁',
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
        type: 'text',
        text: `✅ ¡Excelente elección! ¿Qué tipo de reloj para ${label} le gustaría ver?`,
        buttons: [
            { type: 'dynamic_block_callback', caption: '⌚ Automáticos', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: `${genero}_AUTO` }},
            { type: 'dynamic_block_callback', caption: '⏱️ De cuarzo', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: `${genero}_CUARZO` }}
        ]
    }];
}

function construirCatalogo(to, tipo) {
    const productos = data[tipo];
    if (!productos || !productos.length) {
        return [{ type: 'text', text: '😔 Lo siento, no hay productos disponibles en esa categoría.' }];
    }
    const elements = productos.map(producto => ({
        title: producto.nombre,
        subtitle: `${producto.descripcion}\n💲 ${producto.precio} soles`,
        image_url: producto.imagen,
        buttons: [{ type: 'dynamic_block_callback', caption: '🛍️ Pedir este modelo', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: `COMPRAR_PRODUCTO_${producto.codigo}` }}]
    }));
    return [{
        type: 'cards',
        elements: elements,
        image_aspect_ratio: 'square'
    }, {
        type: 'text',
        text: '✨ ¿Le gustaría adquirir alguno o ver otras opciones?',
        buttons: [{ type: 'dynamic_block_callback', caption: '📖 Volver al menú', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'VER_MODELOS' }}]
    }];
}

function construirMensajeInfoPromo(producto) {
    if (!producto) return [{ type: 'text', text: '⚠️ Lo siento, no pude encontrar los detalles de esa promoción.' }];
    const elements = [{
        title: producto.nombre,
        subtitle: `${producto.descripcion}\n💰 Precio: ${producto.precio}`,
        image_url: producto.imagen,
        buttons: [
            { type: 'dynamic_block_callback', caption: '🛍️ Pedir este modelo', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: `COMPRAR_PRODUCTO_${producto.codigo}` }},
            { type: 'dynamic_block_callback', caption: '📖 Ver otros modelos', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'VER_MODELOS' }}
        ]
    }];
    return [{ type: 'cards', elements: elements, image_aspect_ratio: 'square' }];
}

// ... Resto de funciones auxiliares (timers, etc.) que no envían mensajes directamente ...
function reiniciarTimerInactividad(senderId) {}
function finalizarSesion(senderId, conservarMemoria = false) {}
function verificarDatosCompletos(senderId) { return false; }
async function manejarFlujoCompra(res, senderId, mensaje) {}


app.listen(PORT, () => {
  console.log(`🚀 Servidor para ManyChat escuchando en http://0.0.0.0:${PORT}`);
});