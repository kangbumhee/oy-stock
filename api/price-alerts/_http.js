const MAX_JSON_BODY_BYTES = 16 * 1024;

class HttpError extends Error {
  constructor(statusCode, code, retryAfter) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfter = Number.isFinite(Number(retryAfter))
      ? Math.max(1, Math.ceil(Number(retryAfter)))
      : null;
  }
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function methodNotAllowed(res, methods) {
  res.setHeader('Allow', methods.join(', '));
  sendJson(res, 405, { success: false, error: 'method_not_allowed' });
}

function assertSameOrigin(req) {
  const headers = req.headers || {};
  const fetchSite = String(headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') throw new HttpError(403, 'cross_site_request_denied');

  const origin = String(headers.origin || '').trim();
  if (!origin) return;
  const host = String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim();
  const forwardedProto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim();
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch (_) {
    throw new HttpError(403, 'origin_mismatch');
  }
  if (
    !host ||
    originUrl.host !== host ||
    !['http:', 'https:'].includes(originUrl.protocol) ||
    (forwardedProto && originUrl.protocol !== `${forwardedProto}:`)
  ) {
    throw new HttpError(403, 'origin_mismatch');
  }
}

async function readJson(req, maxBytes) {
  const limit = maxBytes || MAX_JSON_BODY_BYTES;
  const contentLength = Number((req.headers && req.headers['content-length']) || 0);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new HttpError(413, 'request_too_large');
  }

  if (req.body != null) {
    const raw = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body);
    if (Buffer.byteLength(raw, 'utf8') > limit) throw new HttpError(413, 'request_too_large');
    try {
      return typeof req.body === 'object' && !Buffer.isBuffer(req.body)
        ? req.body
        : JSON.parse(raw || '{}');
    } catch (_) {
      throw new HttpError(400, 'invalid_json');
    }
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request_too_large');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch (_) {
    throw new HttpError(400, 'invalid_json');
  }
}

function deviceCredentials(req) {
  const headers = req.headers || {};
  return {
    deviceId: headers['x-price-alert-device-id'],
    deviceSecret: headers['x-price-alert-device-secret']
  };
}

function handleHttpError(res, error) {
  if (error instanceof HttpError) {
    if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    sendJson(res, error.statusCode, { success: false, error: error.code });
    return;
  }
  sendJson(res, 500, { success: false, error: 'internal_error' });
}

module.exports = {
  HttpError,
  assertSameOrigin,
  deviceCredentials,
  handleHttpError,
  methodNotAllowed,
  readJson,
  sendJson
};
