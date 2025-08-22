const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
require('dotenv').config();
const OpenAI = require('openai');

// Carga de datos de catálogos y promociones y prompt del sistema
const data = require('./data.json');
const promoData = require('./promoData.json');
const systemPrompt = fs.readFileSync('./SystemPrompt.txt', 'utf-8');

// Memoria de conversaciones y estados de flujo (conservados del original)
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
        if (estadoUsuario[from] === 'ESPERANDO_COMPROBANTE') {
            if (textFromUser) await enviarConsultaChatGPT(res, from, textFromUser, 'post-venta');
            else await enviarMensajeTexto(res, "OK, estimado, vamos a confirmarlo. En breve le enviamos una respuesta."); // Asume imagen
            return;
        }
        if (estadoUsuario[from] === 'ESPERANDO_DATOS_LIMA' || estadoUsuario[from] === 'ESPERANDO_DATOS_PROVINCIA') {
            datosPedidoTemporal[from].texto = (datosPedidoTemporal[from].texto || '') + textFromUser + '\n';
            if (verificarDatosCompletos(from)) {
                if (timersPedido[from]) clearTimeout(timersPedido[from]);
                await manejarFlujoCompra(res, from, datosPedidoTemporal[from].texto);
                delete datosPedidoTemporal[from];
            } else {
                return res.json({}); // No responde para permitir que el usuario siga escribiendo
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

    // --- PRIORIDAD 2: Acciones de botones ---
    if (payload && payload.action) {
        let action = payload.action.toUpperCase();
        console.log(`🤖 Procesando PAYLOAD de botón: ${action}`);

        if (action.startsWith('COMPRAR_PRODUCTO_')) {
            const codigoProducto = payload.action.replace('COMPRAR_PRODUCTO_', '');
            pedidoActivo[from] = { codigo: codigoProducto, ultimoProductoVisto: codigoProducto };
            await enviarPreguntaUbicacion(res);
            return;
        }

        switch (action) {
            case 'VER_MODELOS': await enviarMenuPrincipal(res); break;
            case 'CABALLEROS': case 'DAMAS': await enviarSubmenuTipoReloj(res, action); break;
            case 'CABALLEROS_AUTO': await enviarCatalogo(res, from, 'caballeros_automaticos'); break;
            case 'CABALLEROS_CUARZO': await enviarCatalogo(res, from, 'caballeros_cuarzo'); break;
            case 'DAMAS_AUTO': await enviarCatalogo(res, from, 'damas_automaticos'); break;
            case 'DAMAS_CUARZO': await enviarCatalogo(res, from, 'damas_cuarzo'); break;
            case 'ASESOR':
                estadoUsuario[from] = 'ASESOR';
                memoriaConversacion[from] = [];
                await enviarMensajeConBotonSalir(res, "😊 ¡Claro que sí! Estamos listos para responder todas sus dudas y consultas. Por favor, escríbanos qué le gustaría saber ✍️");
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
                await enviarConsultaChatGPT(res, from, textFromUser);
        }
        return;
    }
    
    // --- PRIORIDAD 3: Mensajes de texto ---
    if (textFromUser) {
        const mensaje = textFromUser.trim().toLowerCase();
        console.log(`💬 Procesando TEXTO: ${mensaje}`);

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
            await enviarConsultaChatGPT(res, from, textFromUser);
        } else {
            primerMensaje[from] = true;
            await enviarMenuPrincipal(res);
        }
        return;
    }
    
    // Si no hay texto ni payload (ej. primer contacto), enviar menú
    if (!primerMensaje[from]) {
        primerMensaje[from] = true;
        await enviarMenuPrincipal(res);
    } else {
        // Si ya hubo un primer mensaje pero se recibe una interacción vacía, no hacer nada.
        res.json({});
    }
});


// ===== FUNCIONES DE LÓGICA (ADAPTADAS Y RESTAURADAS) =====

async function manejarFlujoCompra(res, senderId, mensaje) {
    const tipoPedido = estadoUsuario[senderId] === 'ESPERANDO_DATOS_LIMA' ? 'Lima' : 'Provincia';
    await enviarMensajeTexto(res, `✅ ¡Su orden para ${tipoPedido} ha sido confirmada!`);
    
    // Pequeña pausa para que los mensajes lleguen en orden
    await new Promise(resolve => setTimeout(resolve, 1500));

    const lineas = mensaje.split('\n').map(line => line.trim()).filter(line => line);
    const dniMatch = mensaje.match(/\b(\d{8})\b/);
    const dni = dniMatch ? dniMatch[1] : null;
    const nombre = lineas[0] || '';
    const lugar = lineas.slice(1).filter(l => l.trim() !== dni).join(', ') || lineas.slice(1).join(', ');
    const datosExtraidos = { nombre, dni, lugar, tipo: tipoPedido };
    
    const mensajesResumen = await generarResumen(senderId, datosExtraidos);
    let mensajesSiguientes = [];

    if (tipoPedido === 'Provincia') {
        mensajesSiguientes = await obtenerInstruccionesDePagoProvincia(senderId);
    } else {
        mensajesSiguientes = await obtenerConfirmacionLima(senderId);
    }
    
    // Unimos todos los mensajes en una sola respuesta a ManyChat
    responderAManyChat(res, [...mensajesResumen, ...mensajesSiguientes]);
    
    delete estadoUsuario[senderId]; // Limpiamos el estado al finalizar
}

async function generarResumen(senderId, datos) {
    const codigoProducto = pedidoActivo[senderId]?.codigo;
    if (!codigoProducto) return [{ type: 'text', text: "⚠️ Tuvimos un problema al generar el resumen." }];

    const producto = Object.values(data).flat().find(p => p.codigo === codigoProducto) || Object.values(promoData).find(p => p.codigo === codigoProducto);
    if (!producto) return [{ type: 'text', text: "⚠️ No encontramos el producto del resumen." }];
    
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
    
    // Retornamos un array de mensajes para ser enviados
    return [
        { type: 'image', url: producto.imagen },
        { type: 'text', text: resumenTexto }
    ];
}

async function obtenerConfirmacionLima(to) {
    finalizarSesion(to, true);
    return [{ 
        type: 'text', 
        text: "😊 ¡Perfecto! Ya estamos alistando su pedido. Cuando esté listo para la entrega, nos comunicaremos con usted para que esté atento a la hora. ¡Gracias por su compra!"
    }];
}

async function obtenerInstruccionesDePagoProvincia(to) {
    estadoUsuario[to] = 'ESPERANDO_COMPROBANTE';
    timersHibernacion[to] = setTimeout(() => {
        if (estadoUsuario[to] === 'ESPERANDO_COMPROBANTE') {
            finalizarSesion(to, true);
        }
    }, 1 * 60 * 60 * 1000); // 1 hora
    
    const mensajeAdelanto = "😊 Estimad@, para enviar su pedido necesitamos un adelanto Simbólico de 30 soles por motivo de seguridad. Esto nos permite asegurar que el cliente se compromete a recoger su pedido. El resto se paga cuando su pedido llegue a la agencia, antes de recoger.";
    const mensajeMediosPago = "*MEDIOS DE PAGO*\n👉 *YAPE* : 979 434 826\n(Paulina Gonzales Ortega)\n\n👉 *Cuenta BCP Soles*\n19303208489096\n\n👉 *CCI para transferir de otros bancos*\n00219310320848909613";

    return [
        { type: 'text', text: mensajeAdelanto },
        { type: 'text', text: mensajeMediosPago }
    ];
}


// ===== FUNCIONES DE CONSULTA A OPENAI (CON CORRECCIONES) =====
async function enviarConsultaChatGPT(res, senderId, mensajeCliente, modo = 'normal') {
    try {
        if (!memoriaConversacion[senderId]) memoriaConversacion[senderId] = [];
        memoriaConversacion[senderId].push({ role: 'user', content: mensajeCliente });

        let systemMessageContent = `${systemPrompt}\n\nCatálogo disponible:\n${JSON.stringify(data)}`;
        if (modo === 'post-venta') systemMessageContent += `\n\nINSTRUCCIÓN ESPECIAL: El usuario está en modo post-venta...`;

        const contexto = [{ role: 'system', content: systemMessageContent }, ...memoriaConversacion[senderId]];
        const response = await client.chat.completions.create({ model: 'gpt-4o', messages: contexto });
        const respuesta = response.choices[0].message.content.trim();
        memoriaConversacion[senderId].push({ role: 'assistant', content: respuesta });

        if (respuesta.startsWith('MOSTRAR_MODELO:')) {
            const codigo = respuesta.split(':')[1].trim();
            const producto = Object.values(data).flat().find(p => p.codigo === codigo) || Object.values(promoData).find(p => p.codigo === codigo);
            if (producto) await enviarInfoPromo(res, senderId, producto);
            else await enviarMensajeTexto(res, `😔 Lo siento, no pude encontrar el modelo con el código ${codigo}.`);
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


// ===== FUNCIONES DE ENVÍO DE MENSAJES (ADAPTADAS PARA MANYCHAT) =====
// El resto de funciones de envío (enviarMenuPrincipal, enviarCatalogo, etc.) 
// y las funciones de estado (reiniciarTimerInactividad, etc.) se mantienen como en la versión anterior
// que ya funcionaban correctamente con los botones dynamic_block_callback.

function responderAManyChat(res, messages = []) {
    const response = { version: "v2", content: { messages } };
    console.log("📢 Respondiendo a ManyChat:", JSON.stringify(response, null, 2));
    res.json(response);
}

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
        await enviarMensajeTexto(res, '😔 Lo siento, no hay productos disponibles en esa categoría.');
        return;
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

// ===== FUNCIONES DE ESTADO (CON ADAPTACIONES) =====
function reiniciarTimerInactividad(senderId) {
    if (timersInactividad[senderId]) clearTimeout(timersInactividad[senderId].timer);
    timersInactividad[senderId] = {};
    // La API de ManyChat no permite enviar mensajes proactivos por inactividad.
    // Solo reiniciamos el timer para la finalización de la sesión lógica.
    timersInactividad[senderId].timer = setTimeout(() => {
        finalizarSesion(senderId, true);
    }, 12 * 60 * 1000); // 12 minutos
}

function finalizarSesion(senderId, conservarMemoria = false) {
    delete estadoUsuario[senderId];
    delete pedidoActivo[senderId];
    if (timersHibernacion[senderId]) {
        clearTimeout(timersHibernacion[senderId]);
        delete timersHibernacion[senderId];
    }
    if (!conservarMemoria) {
        delete memoriaConversacion[senderId];
        delete primerMensaje[senderId];
    }
    console.log(`Sesión para ${senderId} finalizada. Conservar memoria: ${conservarMemoria}`);
    // No se puede enviar un mensaje de "Sesión terminada" proactivamente.
}

function verificarDatosCompletos(senderId) {
    const datosAcumulados = datosPedidoTemporal[senderId]?.texto || '';
    const tipo = estadoUsuario[senderId];
    const lineas = datosAcumulados.split('\n').filter(l => l.trim() !== '');
    if (tipo === 'ESPERANDO_DATOS_LIMA') return /[a-zA-Z]{3,}/.test(datosAcumulados) && lineas.length >= 2;
    if (tipo === 'ESPERANDO_DATOS_PROVINCIA') return /[a-zA-Z]{3,}/.test(datosAcumulados) && /\b\d{8}\b/.test(datosAcumulados) && lineas.length >= 3;
    return false;
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor para ManyChat escuchando en http://0.0.0.0:${PORT}`);
});