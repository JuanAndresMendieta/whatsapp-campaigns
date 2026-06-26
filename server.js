'use strict';

const BEARER_TOKEN    = "EAAS1VLtqlw4BRrY8t8jOsIcjIHdGi0HkVp3Je7amC4S6YEFnrbF0g35IKjAcwNyi0vnbDVrDcTqNsbirCqG39RtTDg6EnuKfJnN0ppkfvlcwBXRTTQTJlqOsMoKCh8GlMCrLwnJZC7CyqhDs2rwr8zxuJ73YAPmYcnM1i45OV8rpyH196Mmp21vZBU8zLWuQZDZD";
const PHONE_NUMBER_ID = "1178313532031768";
const TEMPLATE_NAME   = "campanas_cda";
const TEMPLATE_LANG   = "es_CO";

const express = require('express');
const https   = require('https');
const crypto  = require('crypto');
const path    = require('path');
const multer  = require('multer');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const campaigns = new Map();

function createCampaign(total) {
  const id = crypto.randomUUID();
  campaigns.set(id, {
    id,
    total,
    sent    : 0,
    errors  : 0,
    pending : total,
    running : true,
    log     : [],
    createdAt: new Date().toISOString(),
  });
  return id;
}

function sendWhatsApp(phone, { texto }) {
  const payload = JSON.stringify({
    messaging_product: 'whatsapp',
    to  : phone,
    type: 'template',
    template: {
      name    : TEMPLATE_NAME,
      language: { code: TEMPLATE_LANG },
      components: [
        {
          type      : 'header',
          parameters: [],
        },
        {
          type      : 'body',
          parameters: [{ type: 'text', text: texto }],
        }
      ],
    },
  });

  console.log('Payload enviado:', payload);

  return new Promise(resolve => {
    const options = {
      hostname: 'graph.facebook.com',
      path    : `/v25.0/${PHONE_NUMBER_ID}/messages`,
      method  : 'POST',
      headers : {
        'Authorization' : `Bearer ${BEARER_TOKEN}`,
        'Content-Type'  : 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        console.log('Respuesta Meta RAW:', raw);
        try {
          const json = JSON.parse(raw);
          if (res.statusCode === 200) {
            resolve({ ok: true, messageId: json.messages?.[0]?.id ?? '' });
          } else {
            resolve({ ok: false, error: json.error?.message ?? `HTTP ${res.statusCode}` });
          }
        } catch {
          resolve({ ok: false, error: 'Respuesta inválida de la API' });
        }
      });
    });

    req.setTimeout(12000, () => {
      req.destroy();
      resolve({ ok: false, error: 'Timeout' });
    });
    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.write(payload);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const BATCH_SIZE  = 20;
const BATCH_DELAY = 1000;
const MSG_DELAY   = 150;

function sendSummaryNotification(camp, durationMin) {
  const text =
    `✅ Campaña terminada\nTotal: ${camp.total}\nEnviados: ${camp.sent}\nErrores: ${camp.errors}\nDuración: ${durationMin} minutos`;

  const payload = JSON.stringify({
    messaging_product: 'whatsapp',
    to  : '573177903748',
    type: 'text',
    text: { body: text },
  });

  const options = {
    hostname: 'graph.facebook.com',
    path    : `/v25.0/${PHONE_NUMBER_ID.trim()}/messages`,
    method  : 'POST',
    headers : {
      'Authorization' : `Bearer ${BEARER_TOKEN}`,
      'Content-Type'  : 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  const req = https.request(options, res => {
    let raw = '';
    res.on('data', chunk => { raw += chunk; });
    res.on('end', () => {
      if (res.statusCode !== 200)
        console.error('[resumen] Error al enviar notificación:', raw);
    });
  });

  req.on('error', err => console.error('[resumen] Error de red:', err.message));
  req.write(payload);
  req.end();

  const payload2 = JSON.stringify({
    messaging_product: 'whatsapp',
    to  : '573232005614',
    type: 'text',
    text: { body: text },
  });

  const options2 = {
    hostname: 'graph.facebook.com',
    path    : `/v25.0/${PHONE_NUMBER_ID.trim()}/messages`,
    method  : 'POST',
    headers : {
      'Authorization' : `Bearer ${BEARER_TOKEN}`,
      'Content-Type'  : 'application/json',
      'Content-Length': Buffer.byteLength(payload2),
    },
  };

  const req2 = https.request(options2, res => {
    let raw = '';
    res.on('data', chunk => { raw += chunk; });
    res.on('end', () => {
      if (res.statusCode !== 200)
        console.error('[resumen] Error al enviar notificación (2):', raw);
    });
  });

  req2.on('error', err => console.error('[resumen] Error de red (2):', err.message));
  req2.write(payload2);
  req2.end();
}

async function runCampaign(id, contactos, config) {
  const camp      = campaigns.get(id);
  const startTime = Date.now();

  for (let i = 0; i < contactos.length; i += BATCH_SIZE) {
    const batch = contactos.slice(i, i + BATCH_SIZE);

    for (let j = 0; j < batch.length; j++) {
      const phone  = batch[j];
      const result = await sendWhatsApp(phone, config);

      camp.log.push({
        phone,
        status   : result.ok ? 'OK' : 'ERROR',
        detail   : result.ok ? (result.messageId || '') : result.error,
        timestamp: new Date().toISOString(),
      });

      camp.pending--;
      result.ok ? camp.sent++ : camp.errors++;

      if (j < batch.length - 1) await sleep(MSG_DELAY);
    }

    if (i + BATCH_SIZE < contactos.length) await sleep(BATCH_DELAY);
  }

  camp.running = false;

  const durationMin = ((Date.now() - startTime) / 60000).toFixed(1);
  sendSummaryNotification(camp, durationMin);
}

function cleanPhone(raw) {
  return String(raw).replace(/[^\d]/g, '');
}

function parseCsvPhones(buffer) {
  const lines = buffer.toString('utf8').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  const col = headers.findIndex(h => h === 'telefono');
  if (col === -1) return [];
  return lines.slice(1)
    .map(line => cleanPhone(line.split(',')[col] ?? ''))
    .filter(Boolean);
}

app.post('/api/campaign/start', upload.single('csv'), (req, res) => {
  const { variableText, contactos: contactosStr } = req.body ?? {};
  const texto = variableText;

  if (!texto)
    return res.status(400).json({ error: 'Falta campo obligatorio: variableText' });

  let contactos = [];

  if (contactosStr && typeof contactosStr === 'string') {
    contactos = contactosStr.split(',').map(cleanPhone).filter(Boolean);
  } else if (req.file) {
    contactos = parseCsvPhones(req.file.buffer);
  } else {
    return res.status(400).json({ error: 'Se requiere un archivo CSV o el campo "contactos" con números separados por comas' });
  }

  if (contactos.length === 0)
    return res.status(400).json({ error: 'No se encontraron números de teléfono válidos' });

  const config     = { texto };
  const campaniaId = createCampaign(contactos.length);

  res.json({ ok: true, total: contactos.length, campaniaId });

  runCampaign(campaniaId, contactos, config).catch(err => {
    console.error(`[${campaniaId}] Error de campaña:`, err);
    const camp = campaigns.get(campaniaId);
    if (camp) camp.running = false;
  });
});

app.post('/enviar-campana', (req, res) => {
  const { texto, contactos } = req.body ?? {};

  if (!texto)
    return res.status(400).json({ error: 'Falta campo obligatorio: texto' });

  if (!Array.isArray(contactos) || contactos.length === 0)
    return res.status(400).json({ error: 'contactos debe ser un array no vacío de teléfonos' });

  const config     = { texto };
  const campaniaId = createCampaign(contactos.length);

  res.json({ ok: true, total: contactos.length, campaniaId });

  runCampaign(campaniaId, contactos, config).catch(err => {
    console.error(`[${campaniaId}] Error de campaña:`, err);
    const camp = campaigns.get(campaniaId);
    if (camp) camp.running = false;
  });
});

app.get('/status/:campaniaId', (req, res) => {
  const camp = campaigns.get(req.params.campaniaId);

  if (!camp)
    return res.status(404).json({ error: 'Campaña no encontrada' });

  res.json({
    campaniaId: camp.id,
    running   : camp.running,
    total     : camp.total,
    sent      : camp.sent,
    errors    : camp.errors,
    pending   : camp.pending,
    createdAt : camp.createdAt,
    log       : camp.log,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));