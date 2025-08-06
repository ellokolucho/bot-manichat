const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// Ruta principal para comprobar si el bot está activo
app.get('/', (req, res) => {
  res.send('Bot WhatsApp funcionando ✅');
});

// Verificación del webhook de Meta
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ WEBHOOK_VERIFICADO');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
});

// Webhook para recibir mensajes de WhatsApp
app.post('/webhook', async (req, res) => {
  // 🔍 Log completo del cuerpo recibido
  console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2));

  const body = req.body;
  const mensaje = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const phoneNumberId = body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

  if (mensaje && mensaje.text && phoneNumberId) {
    const texto = mensaje.text.body.toLowerCase();
    const from = mensaje.from;

    if (texto === 'hola') {
      console.log('✅ Recibido: hola');

      try {
        await axios({
          method: 'POST',
          url: `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
          headers: {
            'Authorization': `Bearer ${process.env.TOKEN}`,
            'Content-Type': 'application/json'
          },
          data: {
            messaging_product: 'whatsapp',
            to: from,
            text: {
              body: 'Hola, ¿cómo estás? Estoy para ayudarte. 🙌'
            }
          }
        });

        console.log('📤 Mensaje enviado exitosamente.');
      } catch (err) {
        console.error('❌ Error al enviar mensaje:', err.response?.data || err.message);
      }
    }
  }

  res.sendStatus(200);
});

// 🔥 Escuchar en el puerto que asigna Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
