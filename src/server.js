require('dotenv').config();

const os = require('os');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const Moderator = require('./moderator');
const KeyStore = require('./keyStore');
const { createAccessMiddleware } = require('./access');
const { RequestStats, ResourceMonitor, isAdminPath } = require('./stats');
const packageInfo = require('../package.json');

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === '') return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function parseTrustProxy(value) {
  if (value === undefined || value === '') return 'loopback';
  if (['true', 'false'].includes(value)) return value === 'true';
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

const port = Number(process.env.PORT || 3003);
const host = process.env.HOST || '0.0.0.0';
const maxFileSize = Number(process.env.MAX_FILE_SIZE_MB || 10) * 1024 * 1024;
const allowedMimeTypes = new Set((process.env.ALLOWED_MIME_TYPES || 'image/jpeg,image/png,image/webp,image/gif')
  .split(',').map((value) => value.trim()).filter(Boolean));
const localBypass = parseBoolean(process.env.LOCAL_BYPASS, true);
const apiKeysFile = process.env.API_KEYS_FILE || 'data/api-keys.json';
const resourceSampleMs = Math.max(200, Number(process.env.RESOURCE_SAMPLE_MS || 1000));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxFileSize, files: 1 },
  fileFilter: (request, file, callback) => {
    callback(null, allowedMimeTypes.has(file.mimetype));
  }
});

const app = express();
const moderator = new Moderator();
const keyStore = new KeyStore(apiKeysFile);
const stats = new RequestStats();
const monitor = new ResourceMonitor({
  intervalMs: resourceSampleMs,
  isReady: () => moderator.isReady(),
  tensorMemory: () => (moderator.isReady() ? moderator.tensorMemory() : null),
  counters: () => stats.counters()
});
const corsMiddleware = cors();

app.disable('x-powered-by');
// Hanya dipakai untuk menampilkan IP client (request.ip); tidak dipakai untuk
// menentukan akses localhost.
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
app.use(stats.middleware());
app.use(helmet());
// CORS hanya untuk API publik. Route admin sengaja tidak diberi CORS agar
// halaman dari origin lain tidak bisa membaca atau mengubah data admin.
app.use((request, response, next) => (isAdminPath(request.path) ? next() : corsMiddleware(request, response, next)));
// Autentikasi dijalankan sebelum body diparse/diupload, supaya request tanpa
// key tidak sempat membebani memori server.
app.use(createAccessMiddleware({
  keyStore,
  localBypass,
  localOnlyPrefixes: ['/admin']
}));
app.use(express.json({ limit: '100kb' }));

app.get('/health', (request, response) => {
  response.json({
    status: moderator.isReady() ? 'ok' : 'loading',
    model_loaded: moderator.isReady(),
    uptime_seconds: Math.round(process.uptime())
  });
});

app.post('/moderate', upload.single('image'), async (request, response, next) => {
  try {
    if (!request.file) {
      return response.status(400).json({
        error: 'An image file is required in multipart field "image".'
      });
    }

    const result = await monitor.track(() => moderator.classify(request.file.buffer));
    stats.recordModeration(request.access, result);
    return response.json({
      ...result,
      filename: request.file.originalname,
      mime_type: request.file.mimetype,
      size_bytes: request.file.size
    });
  } catch (error) {
    stats.recordModerationError();
    return next(error);
  }
});

// ---- Route khusus localhost ----

app.get('/admin', (request, response) => {
  response.redirect('/admin/dashboard/');
});

app.use('/admin/dashboard', express.static(path.join(__dirname, 'dashboard'), { index: 'index.html', maxAge: 0 }));

app.get('/admin/report', (request, response) => {
  const keys = keyStore.list();
  response.set('Cache-Control', 'no-store');
  response.json({
    generated_at: new Date().toISOString(),
    model_loaded: moderator.isReady(),
    ...stats.report(),
    resources: monitor.report({
      includeHistory: parseBoolean(request.query.history, false),
      historySince: request.query.history_since
    }),
    keys: {
      total: keys.length,
      active: keys.filter((key) => key.active).length,
      revoked: keys.filter((key) => !key.active).length
    },
    service: {
      name: packageInfo.name,
      version: packageInfo.version,
      hostname: os.hostname(),
      pid: process.pid,
      node_version: process.version,
      platform: `${process.platform}/${process.arch}`,
      ...moderator.info()
    },
    config: {
      port,
      host,
      local_bypass: localBypass,
      thresholds: moderator.thresholds,
      max_file_size_mb: maxFileSize / 1024 / 1024,
      allowed_mime_types: Array.from(allowedMimeTypes),
      resource_sample_ms: resourceSampleMs
    }
  });
});

app.get('/admin/keys', (request, response) => {
  response.set('Cache-Control', 'no-store');
  response.json({ keys: keyStore.list() });
});

app.post('/admin/keys', (request, response) => {
  try {
    const created = keyStore.create(request.body && request.body.name);
    return response.status(201).json({
      ...created.entry,
      key: created.key,
      warning: 'Store this key now. It cannot be shown again.'
    });
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
});

app.delete('/admin/keys/:id', (request, response) => {
  const revoked = keyStore.revoke(request.params.id);
  if (!revoked) return response.status(404).json({ error: 'Active key not found.' });
  return response.json(revoked);
});

app.use((request, response) => {
  response.status(404).json({ error: 'Not found.' });
});

app.use((error, request, response, next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return response.status(status).json({ error: error.message, code: error.code });
  }
  if (error && error.message === 'Unexpected field') {
    return response.status(400).json({ error: 'Use multipart field "image".' });
  }
  if (error && error.type === 'entity.parse.failed') {
    return response.status(400).json({ error: 'Invalid JSON body.' });
  }
  if (error && error.type === 'entity.too.large') {
    return response.status(413).json({ error: 'Request body too large.' });
  }
  if (error) {
    console.error(error);
    return response.status(422).json({ error: 'The file could not be decoded or classified.' });
  }
  return next();
});

monitor.start();

const server = app.listen(port, host, () => {
  console.log(`NSFW moderation API listening on http://${host}:${port}`);
  console.log(`Localhost bypass: ${localBypass ? 'enabled' : 'disabled'}; API keys: ${keyStore.filePath} (${keyStore.list().filter((key) => key.active).length} active)`);
  moderator.load().then(() => console.log('NSFWJS model loaded')).catch((error) => {
    console.error('Unable to load NSFWJS model:', error.message);
  });
});

const shutdown = (signal) => {
  console.log(`${signal} received, shutting down`);
  monitor.stop();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
