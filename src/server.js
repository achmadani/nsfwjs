require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const Moderator = require('./moderator');

const port = Number(process.env.PORT || 3003);
const host = process.env.HOST || '0.0.0.0';
const maxFileSize = Number(process.env.MAX_FILE_SIZE_MB || 10) * 1024 * 1024;
const allowedMimeTypes = new Set((process.env.ALLOWED_MIME_TYPES || 'image/jpeg,image/png,image/webp,image/gif')
  .split(',').map((value) => value.trim()).filter(Boolean));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxFileSize, files: 1 },
  fileFilter: (request, file, callback) => {
    callback(null, allowedMimeTypes.has(file.mimetype));
  }
});

const app = express();
const moderator = new Moderator();

app.disable('x-powered-by');
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: `${Math.ceil(maxFileSize / 1024 / 1024)}mb` }));

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

    const result = await moderator.classify(request.file.buffer);
    return response.json({
      ...result,
      filename: request.file.originalname,
      mime_type: request.file.mimetype,
      size_bytes: request.file.size
    });
  } catch (error) {
    return next(error);
  }
});

app.use((error, request, response, next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return response.status(status).json({ error: error.message, code: error.code });
  }
  if (error && error.message === 'Unexpected field') {
    return response.status(400).json({ error: 'Use multipart field "image".' });
  }
  if (error) {
    console.error(error);
    return response.status(422).json({ error: 'The file could not be decoded or classified.' });
  }
  return next();
});

const server = app.listen(port, host, () => {
  console.log(`NSFW moderation API listening on http://${host}:${port}`);
  moderator.load().then(() => console.log('NSFWJS model loaded')).catch((error) => {
    console.error('Unable to load NSFWJS model:', error.message);
  });
});

const shutdown = (signal) => {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
