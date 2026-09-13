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

const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

function hostnameOf(hostHeader) {
  const host = String(hostHeader || '').trim().toLowerCase();
  if (host.charAt(0) === '[') return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0];
}

// Route admin dibuka lewat browser (dashboard). Tanpa pengecekan ini, situs
// lain yang dibuka di browser yang sama bisa memanggil 127.0.0.1 (CSRF), atau
// memakai domain yang di-resolve ke 127.0.0.1 (DNS rebinding).
function adminBrowserCheck(request) {
  const host = String(request.headers.host || '').toLowerCase();
  if (LOOPBACK_HOSTNAMES.indexOf(hostnameOf(host)) === -1) {
    return 'Host header must be localhost, 127.0.0.1, or [::1].';
  }
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let originHost = null;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch (error) {
      originHost = null;
    }
    if (originHost !== host) return 'Cross-origin requests are not allowed.';
  }
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return 'Cross-site requests are not allowed.';
  }
  return null;
}

function extractApiKey(request) {
  const headerKey = request.get('x-api-key');
  if (headerKey) return headerKey.trim();
  const authorization = request.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1].trim() : null;
}

function createAccessMiddleware({ keyStore, localBypass, localOnlyPrefixes }) {
  return (request, response, next) => {
    const local = isLocalRequest(request, { localBypass });
    const localOnly = localOnlyPrefixes.some((prefix) => request.path === prefix || request.path.startsWith(`${prefix}/`));

    const reject = (status, reason, message) => {
      request.access = { local, client: null, allowed: false, reason };
      return response.status(status).json({ error: message, code: reason });
    };

    if (localOnly && !local) {
      return reject(403, 'local_only', 'This route is only available from localhost.');
    }
    if (localOnly) {
      const problem = adminBrowserCheck(request);
      if (problem) return reject(403, 'cross_site', problem);
    }

    if (local) {
      request.access = { local: true, client: { id: 'localhost', name: 'localhost' }, allowed: true };
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
    return next();
  };
}

module.exports = {
  createAccessMiddleware,
  isLocalRequest,
  isLoopbackAddress,
  adminBrowserCheck,
  PROXY_HEADERS
};
