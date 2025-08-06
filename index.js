const express = require('express');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// Ruta principal para comprobar si el bot está activo
app.get('/', (req, res) => {
  res.send('Bot WhatsApp funcionando ✅');
});

// Webhook para recibir mensajes de WhatsApp
app.post('/webhook', (req, res) => {
  const body = req.body;

  const mensaje = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (mensaje && mensaje.text && mensaje.text.body.toLowerCase() === 'hola') {
    console.log('✅ Recibido: hola');
    // Aquí luego programaremos la respuesta automática
  }

  res.sendStatus(200);
});

// 🔥 Escuchar en el puerto que asigna Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
