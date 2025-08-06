const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// Ruta principal
app.get('/', (req, res) => {
  res.send('Bot WhatsApp funcionando ✅');
});

// Verificación del webhook
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

// Webhook POST
app.post('/webhook', async (req, res) => {
  // 🟡 Log de todo lo recibido
  console.log('📩 Recibido en POST /webhook:', JSON.stringify(req.body, null, 2));

  try {
    const body = req.body;
    const mensaje = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const phoneNumberId = body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

    if (mensaje && mensaje.text && phoneNumberId) {
      const texto = mensaje.text.body.toLowerCase();
      const from = mensaje.from;

      if (texto === 'hola') {
        console.log('✅ Detectado "hola"');

        await axios.post(
          `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
          {
            messaging_product: 'whatsapp',
            to: from,
            text: { body: 'Hola, ¿cómo estás? Estoy para ayudarte. 🙌' }
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );

        console.log('📤 Respuesta enviada');
      }
    }
  } catch (error) {
    console.error('❌ Error general en /webhook:', error.response?.data || error.message);
  }

  res.sendStatus(200);
});

// Puerto
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
