const express = require('express');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

app.get('/', (req, res) => {
  res.send('Bot WhatsApp funcionando ✅');
});

app.post('/webhook', (req, res) => {
  const body = req.body;

  const mensaje = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (mensaje && mensaje.text && mensaje.text.body.toLowerCase() === 'hola') {
    console.log('✅ Recibido: hola');
    // Aquí luego responderemos
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
