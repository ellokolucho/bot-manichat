const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();
const OpenAI = require('openai');

// --- CONFIGURACIÓN ---
const MENSAJE_DE_ESPERA = "Un momento por favor... 💭";

// Carga de datos
const data = require('./data.json');
const promoData = require('./promoData.json');
const systemPrompt = fs.readFileSync('./SystemPrompt.txt', 'utf-8');

// Memoria y estados (conservados del original)
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

    // --- PRIORIDAD 1: Flujos de estado activos ---
    if (estadoUsuario[from]) {
        console.log(`🌀 Usuario ${from} está en estado: ${estadoUsuario[from]}`);
        if (estadoUsuario[from] === 'ESPERANDO_DATOS_LIMA' || estadoUsuario[from] === 'ESPERANDO_DATOS_PROVINCIA') {
            datosPedidoTemporal[from].texto = (datosPedidoTemporal[from].texto || '') + textFromUser + '\n';
            if (verificarDatosCompletos(from)) {
                if (timersPedido[from]) clearTimeout(timersPedido[from]);
                await manejarFlujoCompra(res, from, datosPedidoTemporal[from].texto);
                delete datosPedidoTemporal[from];
                delete timersPedido[from];
            } else {
                if (timersPedido[from]) clearTimeout(timersPedido[from]);
                timersPedido[from] = setTimeout(async () => {
                    if (verificarDatosCompletos(from)) {
                        await manejarFlujoCompra(null, from, datosPedidoTemporal[from].texto);
                    } else {
                        const msg = "Parece que faltan datos para su pedido. Por favor, asegúrese de enviarlos. 😊";
                        await enviarMensajeProactivoManyChat(from, [{ type: 'text', text: msg }]);
                        delete estadoUsuario[from];
                    }
                    delete datosPedidoTemporal[from];
                    delete timersPedido[from];
                }, 15000);
            }
            return res.json({}); // No responde para que el usuario siga escribiendo
        }
         if (estadoUsuario[from] === 'ASESOR') {
            if (textFromUser.toLowerCase() === 'salir' || payload?.action === 'SALIR') {
                 delete estadoUsuario[from];
                 delete memoriaConversacion[from];
                 await enviarMensajeTexto(res, "🚪 Ha salido del chat con asesor. Volviendo al menú principal...");
                 await new Promise(resolve => setTimeout(resolve, 500));
                 await enviarMenuPrincipal(res);
            } else {
                 // Las consultas al asesor pueden ser lentas, usamos el flujo asíncrono
                 res.json({ version: "v2", content: { messages: [{ type: "text", text: MENSAJE_DE_ESPERA }] }});
                 procesarConsultaConChatGPT(from, textFromUser, 'asesor');
            }
            return;
        }
    }

    // --- PRIORIDAD 2: Acciones directas por clic en botones ---
    if (payload && payload.action) {
        const action = payload.action.toUpperCase();
        console.log(`🤖 Procesando PAYLOAD de botón: ${action}`);
        primerMensaje[from] = true; 

        if (action.startsWith('COMPRAR_PRODUCTO_')) {
            const codigoProducto = payload.action.replace('COMPRAR_PRODUCTO_', '');
            pedidoActivo[from] = { codigo: codigoProducto };
            return await enviarPreguntaUbicacion(res);
        }
        
        // Estas acciones son rápidas y no necesitan el flujo asíncrono
        switch (action) {
            case 'VER_MODELOS': return await enviarMenuPrincipal(res);
            case 'CABALLEROS': case 'DAMAS': return await enviarSubmenuTipoReloj(res, action);
            case 'CABALLEROS_AUTO': return await enviarCatalogo(res, from, 'caballeros_automaticos');
            case 'CABALLEROS_CUARZO': return await enviarCatalogo(res, from, 'caballeros_cuarzo');
            case 'DAMAS_AUTO': return await enviarCatalogo(res, from, 'damas_automaticos');
            case 'DAMAS_CUARZO': return await enviarCatalogo(res, from, 'damas_cuarzo');
        }
    }
    
    // --- PRIORIDAD 3: Mensajes de texto (usan flujo asíncrono por defecto) ---
    if (textFromUser) {
        console.log(`⏳ Iniciando flujo asíncrono para texto: "${textFromUser}"`);
        res.json({ version: "v2", content: { messages: [{ type: "text", text: MENSAJE_DE_ESPERA }] }});
        procesarConsultaConChatGPT(from, textFromUser);
        return;
    }
    
    // Si no hay texto ni payload (ej. primer contacto), enviar menú principal
    if (!primerMensaje[from]) {
        primerMensaje[from] = true;
        await enviarMenuPrincipal(res);
    } else {
        res.json({}); 
    }
});


// ===== FUNCIONES ASÍNCRONAS (PROCESOS LARGOS) =====

async function procesarConsultaConChatGPT(senderId, mensajeCliente, modo = 'normal') {
    try {
        console.log(`🧠 Enviando a ChatGPT: "${mensajeCliente}"`);
        if (!memoriaConversacion[senderId]) memoriaConversacion[senderId] = [];
        memoriaConversacion[senderId].push({ role: 'user', content: mensajeCliente });

        const contexto = [{ role: 'system', content: systemPrompt }, ...memoriaConversacion[senderId]];
        const response = await client.chat.completions.create({ model: 'gpt-4o', messages: contexto });
        const respuesta = response.choices[0].message.content.trim();
        memoriaConversacion[senderId].push({ role: 'assistant', content: respuesta });
        
        console.log(`🤖 Respuesta de ChatGPT: ${respuesta}`);

        // Interceptamos TODOS los triggers de la IA
        if (respuesta.startsWith('MOSTRAR_MODELO:')) {
            const codigo = respuesta.split(':')[1].trim();
            const producto = Object.values(data).flat().find(p => p.codigo === codigo) || Object.values(promoData).find(p => p.codigo === codigo);
            if (producto) await enviarMensajeProactivoManyChat(senderId, construirMensajeInfoPromo(producto));
            else await enviarMensajeProactivoManyChat(senderId, [{ type: 'text', text: `😔 Lo siento, no pude encontrar el modelo con código ${codigo}.` }]);
        } else if (respuesta === 'PEDIR_CATALOGO') {
            await enviarMensajeProactivoManyChat(senderId, construirMenuPrincipal());
        } else if (respuesta.startsWith('PREGUNTAR_TIPO:')) {
            const genero = respuesta.split(':')[1].trim().toUpperCase();
            await enviarMensajeProactivoManyChat(senderId, construirSubmenuTipoReloj(genero));
        } else if (respuesta.startsWith('MOSTRAR_CATALOGO:')) {
            const tipo = respuesta.split(':')[1].trim();
            await enviarMensajeProactivoManyChat(senderId, construirCatalogo(senderId, tipo));
        } else {
            // Si no es un trigger, enviamos la respuesta de texto
            await enviarMensajeProactivoManyChat(senderId, [{ type: 'text', text: respuesta }]);
        }
    } catch (error) {
        console.error('❌ Error en consulta a ChatGPT:', error);
        await enviarMensajeProactivoManyChat(senderId, [{ type: 'text', text: '⚠️ Lo siento, hubo un problema con el asesor. Intente nuevamente.' }]);
    }
}

async function enviarMensajeProactivoManyChat(subscriberId, messages) {
    const url = 'https://api.manychat.com/fb/sending/sendContent';
    const headers = {
        'Authorization': `Bearer ${MANYCHAT_API_KEY}`,
        'Content-Type': 'application/json'
    };
    const body = {
        subscriber_id: subscriberId,
        data: {
            version: 'v2',
            content: {
                messages,
                "external_message_callback": { // Mantenemos el bucle de conversación
                    "url": process.env.RAILWAY_APP_URL + '/webhook',
                    "payload": { "id": "{{user_id}}", "last_input_text": "{{last_input_text}}" }
                }
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
function responderAManyChat(res, messages = []) {
    const response = {
        version: "v2",
        content: {
            messages,
            "external_message_callback": { // Mantenemos el bucle de conversación
                "url": process.env.RAILWAY_APP_URL + '/webhook',
                "payload": { "id": "{{user_id}}", "last_input_text": "{{last_input_text}}" }
            }
        }
    };
    console.log("📢 Respondiendo síncronamente a ManyChat:", JSON.stringify(response, null, 2));
    res.json(response);
}

// ... Las funciones de envío síncronas ahora solo llaman a las constructoras ...
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
     responderAManyChat(res, construirPreguntaUbicacion());
}
async function enviarMensajeTexto(res, texto) {
    responderAManyChat(res, [{type: 'text', text: texto}]);
}
async function enviarMensajeConBotonSalir(res, texto) {
    responderAManyChat(res, construirMensajeConBotonSalir(texto));
}


// ===== FUNCIONES "CONSTRUCTORAS" DE MENSAJES =====
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
        type: 'cards',
        elements: [{
            title: producto.nombre, subtitle: `${producto.descripcion}\n💰 Precio: ${producto.precio}`, image_url: producto.imagen,
            buttons: [
                { type: 'dynamic_block_callback', caption: '🛍️ Pedir este modelo', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: `COMPRAR_PRODUCTO_${producto.codigo}` }},
                { type: 'dynamic_block_callback', caption: '📖 Ver otros modelos', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'VER_MODELOS' }}
            ]
        }],
        image_aspect_ratio: 'square'
    }];
}

function construirPreguntaUbicacion() {
    return [{
        type: 'text', text: "😊 Para coordinar el envío, por favor indíquenos, ¿para dónde es su pedido?",
        buttons: [
            { type: 'dynamic_block_callback', caption: '🏙️ Lima', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'COMPRAR_LIMA' }},
            { type: 'dynamic_block_callback', caption: '🏞️ Provincia', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'COMPRAR_PROVINCIA' }}
        ]
    }];
}

function construirMensajeConBotonSalir(texto) {
     return [{
        type: 'text', text: texto,
        buttons: [{ type: 'dynamic_block_callback', caption: '🔙 Salir', url: process.env.RAILWAY_APP_URL + '/webhook', payload: { action: 'SALIR' }}]
    }];
}


// ===== LÓGICA DE ESTADO Y TIMERS (RESTAURADA) =====

function reiniciarTimerInactividad(senderId) {
    if (timersInactividad[senderId]) clearTimeout(timersInactividad[senderId]);
    
    timersInactividad[senderId] = setTimeout(() => {
        enviarAvisoInactividad(senderId);
    }, 10 * 60 * 1000); // 10 minutos
}

async function enviarAvisoInactividad(senderId) {
    const text = "¿Podemos ayudarle en algo más? 😊";
    await enviarMensajeProactivoManyChat(senderId, construirMensajeConBotonSalir(text));
    
    // Programamos la finalización total de la sesión 2 minutos después
    if (timersInactividad[senderId]) clearTimeout(timersInactividad[senderId]);
    timersInactividad[senderId] = setTimeout(() => {
        finalizarSesion(senderId, false);
    }, 2 * 60 * 1000); // 2 minutos
}

async function finalizarSesion(senderId, conservarMemoria = false) {
    delete estadoUsuario[senderId];
    delete pedidoActivo[senderId];
    if (timersHibernacion[senderId]) clearTimeout(timersHibernacion[senderId]);
    if (!conservarMemoria) {
        delete memoriaConversacion[senderId];
        delete primerMensaje[senderId];
        await enviarMensajeProactivoManyChat(senderId, [{type: 'text', text: "⏳ Su sesión ha terminado. ¡Gracias por visitar Tiendas Megan!"}]);
    }
    console.log(`Sesión para ${senderId} finalizada. Conservar memoria: ${conservarMemoria}`);
}

function verificarDatosCompletos(senderId) {
    const datos = datosPedidoTemporal[senderId]?.texto || '';
    const tipo = estadoUsuario[senderId];
    const lineas = datos.split('\n').filter(l => l.trim() !== '');
    if (tipo === 'ESPERANDO_DATOS_LIMA') return /[a-zA-Z]{3,}/.test(datos) && lineas.length >= 2;
    if (tipo === 'ESPERANDO_DATOS_PROVINCIA') return /[a-zA-Z]{3,}/.test(datos) && /\b\d{8}\b/.test(datos) && lineas.length >= 3;
    return false;
}

// Lógica de compra (simplificada, expandir si es necesario)
async function manejarFlujoCompra(res, senderId, mensaje) {
     // Aquí iría la lógica completa de generarYEnviarResumen, enviarConfirmacionLima, etc.
     // Por simplicidad, se puede adaptar para que también use las funciones "constructoras" y envíe
     // un mensaje proactivo o síncrono según corresponda.
     const exitoMsg = {type: 'text', text: '¡Pedido procesado con éxito!'};
     if (res) {
         responderAManyChat(res, [exitoMsg]);
     } else {
         await enviarMensajeProactivoManyChat(senderId, [exitoMsg]);
     }
}


app.listen(PORT, () => {
  console.log(`🚀 Servidor para ManyChat escuchando en http://0.0.0.0:${PORT}`);
});