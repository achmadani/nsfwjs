// Header yang dipasang reverse proxy / tunnel. Jika salah satu ada, request
// dianggap berasal dari luar walaupun socket-nya dari 127.0.0.1 — kalau tidak,
// semua trafik internet yang lewat nginx/cloudflared akan lolos tanpa key.
const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
  'x-forwarded-host',
  'x-forwarded-proto',
  'cf-connecting-ip',
  'true-client-ip',
  'x-client-ip'
];

function isLoopbackAddress(address) {
  if (!address) return false;
  return address === '::1' || /^127\./.test(address) || /^::ffff:127\./.test(address);
}

function isLocalRequest(request, { localBypass }) {
  if (!localBypass) return false;
  const socketAddress = request.socket && request.socket.remoteAddress;
  if (!isLoopbackAddress(socketAddress)) return false;
  return !PROXY_HEADERS.some((header) => request.headers[header] !== undefined);
}

function extractApiKey(request) {
  const headerKey = request.get('x-api-key');
  if (headerKey) return headerKey.trim();
  const authorization = request.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1].trim() : null;
}

function createAccessMiddleware({ keyStore, stats, localBypass, localOnlyPrefixes }) {
  return (request, response, next) => {
    const local = isLocalRequest(request, { localBypass });
    const localOnly = localOnlyPrefixes.some((prefix) => request.path === prefix || request.path.startsWith(`${prefix}/`));

    const reject = (status, reason, message) => {
      request.access = { local, client: null, allowed: false, reason };
      stats.recordAccess(request.access);
      return response.status(status).json({ error: message, code: reason });
    };

    if (localOnly && !local) {
      return reject(403, 'local_only', 'This route is only available from localhost.');
    }

    if (local) {
      request.access = { local: true, client: { id: 'localhost', name: 'localhost' }, allowed: true };
      stats.recordAccess(request.access);
      return next();
    }

    const key = extractApiKey(request);
    if (!key) {
      return reject(401, 'missing_key', 'API key required. Send it in the "X-API-Key" header.');
    }

    const result = keyStore.verify(key);
    if (!result) {
      return reject(401, 'invalid_key', 'Invalid API key.');
    }
    if (result.revoked) {
      return reject(401, 'revoked_key', 'API key has been revoked.');
    }

    request.access = {
      local: false,
      client: { id: result.entry.id, name: result.entry.name },
      allowed: true
    };
    stats.recordAccess(request.access);
    return next();
  };
}

module.exports = {
  createAccessMiddleware,
  isLocalRequest,
  isLoopbackAddress,
  PROXY_HEADERS
};
