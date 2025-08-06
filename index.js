const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

app.get('/', (req, res) => {
  res.send('Bot de WhatsApp funcionando');
});

// Webhook de verificación (GET)
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('🟢 Verificación exitosa del webhook');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// Webhook receptor (POST)
app.post('/webhook', async (req, res) => {
  console.log('📩 Recibido en POST /webhook:', JSON.stringify(req.body, null, 2));

  const body = req.body;

  if (body.object) {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];
    const phone_number_id = value?.metadata?.phone_number_id;
    const from = message?.from;
    const msg_body = message?.text?.body;

    if (msg_body && from && phone_number_id) {
      console.log(`✉️ Mensaje recibido: ${msg_body} de ${from}`);

      // Aquí respondemos al mensaje recibido
      try {
        await axios({
          method: 'POST',
          url: `https://graph.facebook.com/v18.0/${phone_number_id}/messages`,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          },
          data: {
            messaging_product: 'whatsapp',
            to: from,
            text: {
              body: 'Hola, ¿cómo estás? Estoy para ayudarte.',
            },
          },
        });

        console.log('✅ Respuesta enviada correctamente');
      } catch (error) {
        console.error('❌ Error al enviar respuesta:', error.response?.data || error.message);
      }
    }

    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});
