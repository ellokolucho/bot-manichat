const express = require('express');
const bodyParser = require('body-parser');
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
let datosPedidoTemporal = {};
let timersPedido = {};

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===== MANEJADOR PRINCIPAL DE MENSAJES (ESTRUCTURA FINAL) =====
app.post('/webhook', async (req, res) => {
    console.log('📩 Webhook de ManyChat recibido:', JSON.stringify(req.body, null, 2));

    const from = req.body.id;
    const textFromUser = req.body.last_input_text || '';
    const payload = req.body.payload || null;

    if (!from) return res.status(400).send('Falta el ID de usuario.');
    
    reiniciarTimerInactividad(from);

    // --- PRIORIDAD 1: Flujos de estado activos ---
    if (estadoUsuario[from]) {
        console.log(`🌀 Usuario ${from} está en estado: ${estadoUsuario[from]}`);
        if (estadoUsuario[from] === 'ESPERANDO_DATOS_LIMA' || estadoUsuario[from] === 'ESPERANDO_DATOS_PROVINCIA') {
            datosPedidoTemporal[from].texto = (datosPedidoTemporal[from].texto || '') + textFromUser + '\n';
            if (verificarDatosCompletos(from)) {
                if (timersPedido[from]) clearTimeout(timersPedido[from]);
                await manejarFlujoCompra(res, from, datosPedidoTemporal[from].texto);
                delete datosPedidoTemporal[from];
            } else {
                return res.json({});
            }
            return;
        }
         if (estadoUsuario[from] === 'ASESOR') {
            if (textFromUser.toLowerCase() === 'salir' || payload?.action === 'SALIR') {
                 delete estadoUsuario[from];
                 delete memoriaConversacion[from];
                 await enviarMensajeTexto(res, "🚪 Ha salido del chat con asesor. Volviendo al menú principal...");
                 await new Promise(resolve => setTimeout(resolve, 500));
                 await enviarMenuPrincipal(res);
            } else {
                 await enviarConsultaChatGPT(res, from, textFromUser);
            }
            return;
        }
    }

    // --- PRIORIDAD 2: Acciones directas por clic en botones (Payload) ---
    if (payload && payload.action) {
        const action = payload.action.toUpperCase();
        console.log(`🤖 Procesando PAYLOAD de botón: ${action}`);
        primerMensaje[from] = true; // Un clic cuenta como interacción

        if (action.startsWith('COMPRAR_PRODUCTO_')) {
            const codigoProducto = payload.action.replace('COMPRAR_PRODUCTO_', '');
            pedidoActivo[from] = { codigo: codigoProducto, ultimoProductoVisto: codigoProducto };
            await enviarPreguntaUbicacion(res);
            return;
        }

        switch (action) {
            case 'VER_MODELOS': await enviarMenuPrincipal(res); return;
            case 'CABALLEROS': case 'DAMAS': await enviarSubmenuTipoReloj(res, action); return;
            case 'CABALLEROS_AUTO': await enviarCatalogo(res, from, 'caballeros_automaticos'); return;
            case 'CABALLEROS_CUARZO': await enviarCatalogo(res, from, 'caballeros_cuarzo'); return;
            case 'DAMAS_AUTO': await enviarCatalogo(res, from, 'damas_automaticos'); return;
            case 'DAMAS_CUARZO': await enviarCatalogo(res, from, 'damas_cuarzo'); return;
            case 'ASESOR':
                estadoUsuario[from] = 'ASESOR';
                memoriaConversacion[from] = [];
                await enviarMensajeConBotonSalir(res, "😊 ¡Claro que sí! Estamos listos para responder todas sus dudas y consultas. Por favor, escríbanos qué le gustaría saber ✍️");
                return;
            case 'COMPRAR_LIMA':
                estadoUsuario[from] = 'ESPERANDO_DATOS_LIMA';
                datosPedidoTemporal[from] = { texto: '' };
                await enviarMensajeTexto(res, "😊 Claro que sí. Por favor, para enviar su pedido indíquenos los siguientes datos:\n\n✅ Nombre completo ✍️\n✅ Dirección exacta 📍\n✅ Una referencia de cómo llegar a su domicilio 🏠");
                return;
            case 'COMPRAR_PROVINCIA':
                estadoUsuario[from] = 'ESPERANDO_DATOS_PROVINCIA';
                datosPedidoTemporal[from] = { texto: '' };
                await enviarMensajeTexto(res, "😊 Claro que sí. Por favor, permítanos los siguientes datos para programar su pedido:\n\n✅ Nombre completo ✍️\n✅ DNI 🪪\n✅ Agencia Shalom que le queda más cerca 🚚");
                return;
        }
    }
    
    // --- PRIORIDAD 3: Mensajes de texto ---
    if (textFromUser) {
        console.log(`💬 Procesando TEXTO: ${textFromUser}`);
        // Si es el primer mensaje del usuario, siempre mostrar el menú principal
        if (!primerMensaje[from]) {
            primerMensaje[from] = true;
            await enviarMenuPrincipal(res);
        } else {
            await enviarConsultaChatGPT(res, from, textFromUser);
        }
        return;
    }
    
    // Si no hay texto ni payload (ej. primer contacto), enviar menú
    if (!primerMensaje[from]) {
        primerMensaje[from] = true;
        await enviarMenuPrincipal(res);
    } else {
        res.json({}); 
    }
});


// ===== FUNCIÓN DE CONSULTA A OPENAI (CON CORRECCIONES) =====
async function enviarConsultaChatGPT(res, senderId, mensajeCliente, modo = 'normal') {
    try {
        console.log(`🧠 Enviando a ChatGPT: "${mensajeCliente}"`);
        if (!memoriaConversacion[senderId]) memoriaConversacion[senderId] = [];
        memoriaConversacion[senderId].push({ role: 'user', content: mensajeCliente });

        let systemMessageContent = `${systemPrompt}\n\nCatálogo disponible:\n${JSON.stringify(data)}`;
        if (modo === 'post-venta') systemMessageContent += `\n\nINSTRUCCIÓN ESPECIAL: ...`;

        const contexto = [{ role: 'system', content: systemMessageContent }, ...memoriaConversacion[senderId]];
        const response = await client.chat.completions.create({ model: 'gpt-4o', messages: contexto });
        const respuesta = response.choices[0].message.content.trim();
        memoriaConversacion[senderId].push({ role: 'assistant', content: respuesta });
        
        console.log(`🤖 Respuesta de ChatGPT: ${respuesta}`);

        if (respuesta.startsWith('MOSTRAR_MODELO:')) {
            const codigo = respuesta.split(':')[1].trim();
            console.log(`⚡ Trigger detectado: MOSTRAR_MODELO ${codigo}`);
            const producto = Object.values(data).flat().find(p => p.codigo === codigo) || Object.values(promoData).find(p => p.codigo === codigo);
            if (producto) await enviarInfoPromo(res, senderId, producto);
            else await enviarMensajeTexto(res, `😔 Lo siento, no pude encontrar el modelo con el código ${codigo}.`);
            return; 
        }
        if (respuesta === 'PEDIR_CATALOGO') {
            console.log(`⚡ Trigger detectado: PEDIR_CATALOGO`);
            await enviarMenuPrincipal(res);
            return;
        }
        if (respuesta.startsWith('PREGUNTAR_TIPO:')) {
            const genero = respuesta.split(':')[1].trim().toUpperCase();
            console.log(`⚡ Trigger detectado: PREGUNTAR_TIPO ${genero}`);
            await enviarSubmenuTipoReloj(res, genero);
            return;
        }
        if (respuesta.startsWith('MOSTRAR_CATALOGO:')) {
            const tipo = respuesta.split(':')[1].trim();
            console.log(`⚡ Trigger detectado: MOSTRAR_CATALOGO ${tipo}`);
            await enviarCatalogo(res, senderId, tipo);
            return;
        }
        
        await enviarMensajeTexto(res, respuesta);

    } catch (error) {
        console.error('❌ Error en consulta a ChatGPT:', error);
        await enviarMensajeTexto(res, '⚠️ Lo siento, hubo un problema al conectarme con el asesor. Intente nuevamente en unos minutos.');
    }
}


// ===== FUNCIONES DE ENVÍO Y LÓGICA INTERNA (CON CORRECCIÓN DE URL) =====

function responderAManyChat(res, messages = []) {
    const response = { version: "v2", content: { messages } };
    console.log("📢 Respondiendo a ManyChat:", JSON.stringify(response, null, 2));
    res.json(response);
}

// === CADA 'url' HA SIDO CORREGIDA PARA NO TENER EL PUNTO Y COMA (;) ===

async function enviarMenuPrincipal(res) {
    const messages = [{
        type: 'text',
        text: '👋 ¡Hola! Bienvenido a Tiendas Megan\n💎 Descubra su reloj ideal o el regalo perfecto 🎁',
        buttons: [
            { type: 'dynamic_block_callback', caption: '🤵‍♂️ Para Caballeros', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'CABALLEROS' }},
            { type: 'dynamic_block_callback', caption: '💃 Para Damas', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'DAMAS' }},
            { type: 'dynamic_block_callback', caption: '💬 Hablar con Asesor', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'ASESOR' }}
        ]
    }];
    responderAManyChat(res, messages);
}

async function enviarSubmenuTipoReloj(res, genero) {
    const label = genero === 'CABALLEROS' ? 'caballeros' : 'damas';
    const messages = [{
        type: 'text',
        text: `✅ ¡Excelente elección! ¿Qué tipo de reloj para ${label} le gustaría ver?`,
        buttons: [
            { type: 'dynamic_block_callback', caption: '⌚ Automáticos', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: `${genero}_AUTO` }},
            { type: 'dynamic_block_callback', caption: '⏱️ De cuarzo', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: `${genero}_CUARZO` }}
        ]
    }];
    responderAManyChat(res, messages);
}

async function enviarCatalogo(res, to, tipo) {
    const productos = data[tipo];
    if (!productos || !productos.length) {
        return await enviarMensajeTexto(res, '😔 Lo siento, no hay productos disponibles en esa categoría.');
    }
    const elements = productos.map(producto => {
        pedidoActivo[to] = { ...pedidoActivo[to], ultimoProductoVisto: producto.codigo };
        return {
            title: producto.nombre,
            subtitle: `${producto.descripcion}\n💲 ${producto.precio} soles`,
            image_url: producto.imagen,
            buttons: [{ type: 'dynamic_block_callback', caption: '🛍️ Pedir este modelo', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: `COMPRAR_PRODUCTO_${producto.codigo}` }}]
        };
    });
    const messages = [{
        type: 'cards',
        elements: elements,
        image_aspect_ratio: 'square'
    }, {
        type: 'text',
        text: '✨ ¿Le gustaría adquirir alguno o ver otras opciones?',
        buttons: [{ type: 'dynamic_block_callback', caption: '📖 Volver al menú', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'VER_MODELOS' }}]
    }];
    responderAManyChat(res, messages);
}

async function enviarInfoPromo(res, to, producto) {
    if (!producto) return await enviarMensajeTexto(res, '⚠️ Lo siento, no pude encontrar los detalles de esa promoción.');
    pedidoActivo[to] = { ...pedidoActivo[to], ultimoProductoVisto: producto.codigo };
    const elements = [{
        title: producto.nombre,
        subtitle: `${producto.descripcion}\n💰 Precio: ${producto.precio}`,
        image_url: producto.imagen,
        buttons: [
            { type: 'dynamic_block_callback', caption: '🛍️ Pedir este modelo', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: `COMPRAR_PRODUCTO_${producto.codigo}` }},
            { type: 'dynamic_block_callback', caption: '📖 Ver otros modelos', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'VER_MODELOS' }}
        ]
    }];
    responderAManyChat(res, [{ type: 'cards', elements: elements, image_aspect_ratio: 'square' }]);
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

async function enviarMensajeTexto(res, text) {
    responderAManyChat(res, [{ type: 'text', text: text }]);
}

async function enviarMensajeConBotonSalir(res, text) {
    const messages = [{
        type: 'text',
        text: text,
        buttons: [{ type: 'dynamic_block_callback', caption: '🔙 Salir', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'SALIR' }}]
    }];
    responderAManyChat(res, messages);
}

// ... Resto de funciones auxiliares (timers, verificación, etc.) sin cambios ...
function reiniciarTimerInactividad(senderId) {}
function finalizarSesion(senderId, conservarMemoria = false) {}
function verificarDatosCompletos(senderId) {}
async function manejarFlujoCompra(res, senderId, mensaje) {}


app.listen(PORT, () => {
  console.log(`🚀 Servidor para ManyChat escuchando en http://0.0.0.0:${PORT}`);
});
