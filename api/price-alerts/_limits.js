const crypto = require('node:crypto');
const net = require('node:net');
const { BlobPreconditionFailedError, get, put } = require('@vercel/blob');
const { configuredDataKey } = require('./_crypto');
const { HttpError } = require('./_http');
const { configuredStoreRoot } = require('./_registry');

const RATE_COUNTER_VERSION = 1;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function configuredRatePolicy(scope) {
  if (scope === 'create') {
    return {
      limit: boundedInteger(process.env.PRICE_ALERT_CREATE_LIMIT, 8, 1, 1000),
      windowSeconds: boundedInteger(
        process.env.PRICE_ALERT_CREATE_WINDOW_SECONDS,
        3600,
        60,
        86400
      )
    };
  }
  const specialized = {
    payment_create: {
      limit: boundedInteger(process.env.PRICE_ALERT_PAYMENT_CREATE_LIMIT, 5, 1, 100),
      windowSeconds: boundedInteger(
        process.env.PRICE_ALERT_PAYMENT_CREATE_WINDOW_SECONDS,
        3600,
        60,
        86400
      )
    },
    payment_complete: {
      limit: boundedInteger(process.env.PRICE_ALERT_PAYMENT_COMPLETE_LIMIT, 30, 1, 1000),
      windowSeconds: boundedInteger(
        process.env.PRICE_ALERT_PAYMENT_COMPLETE_WINDOW_SECONDS,
        3600,
        60,
        86400
      )
    },
    promotion: {
      limit: boundedInteger(process.env.PRICE_ALERT_PROMOTION_LIMIT, 10, 1, 100),
      windowSeconds: boundedInteger(
        process.env.PRICE_ALERT_PROMOTION_WINDOW_SECONDS,
        3600,
        60,
        86400
      )
    },
    payment_webhook: {
      limit: boundedInteger(process.env.PRICE_ALERT_PAYMENT_WEBHOOK_LIMIT, 600, 10, 10000),
      windowSeconds: boundedInteger(
        process.env.PRICE_ALERT_PAYMENT_WEBHOOK_WINDOW_SECONDS,
        3600,
        60,
        86400
      )
    }
  };
  if (specialized[scope]) return specialized[scope];
  return {
    limit: boundedInteger(process.env.PRICE_ALERT_MUTATION_LIMIT, 120, 1, 10000),
    windowSeconds: boundedInteger(
      process.env.PRICE_ALERT_MUTATION_WINDOW_SECONDS,
      3600,
      60,
      86400
    )
  };
}

function normalizeNetwork(value) {
  const raw = String(value || '').split(',')[0].trim().replace(/^\[|\]$/g, '');
  if (net.isIP(raw) === 4) {
    const octets = raw.split('.');
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  if (net.isIP(raw) === 6) {
    const halves = raw.toLowerCase().split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
    const segments = halves.length > 1
      ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
      : left;
    return `${segments.slice(0, 4).map((part) => Number.parseInt(part || '0', 16).toString(16)).join(':')}::/64`;
  }
  return 'unknown';
}

function requestRateIdentity(req) {
  const headers = (req && req.headers) || {};
  const network = normalizeNetwork(
    headers['x-vercel-forwarded-for'] || headers['x-forwarded-for'] || ''
  );
  const host = String(headers['x-forwarded-host'] || headers.host || 'unknown')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .slice(0, 255);
  return `${network}|${host || 'unknown'}`;
}

function rateSubjectHash(req, scope, key) {
  return crypto
    .createHmac('sha256', key || configuredDataKey())
    .update('price-alert-rate:v1:')
    .update(String(scope || 'mutation'))
    .update(':')
    .update(requestRateIdentity(req))
    .digest('hex');
}

async function streamText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function isConflict(error) {
  return (
    error instanceof BlobPreconditionFailedError ||
    [409, 412].includes(Number(error && (error.status || error.statusCode)))
  );
}

async function readCounter(pathname, dependencies) {
  const read = (dependencies && dependencies.get) || get;
  const result = await read(pathname, {
    access: 'private',
    useCache: false,
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
  });
  if (!result) return null;
  const body = JSON.parse(await streamText(result.stream));
  if (
    !body ||
    body.version !== RATE_COUNTER_VERSION ||
    !Number.isFinite(body.windowStartedAt) ||
    !Number.isFinite(body.count)
  ) {
    throw new Error('invalid rate counter');
  }
  return { body, etag: result.blob && result.blob.etag };
}

async function writeCounter(pathname, body, etag, dependencies) {
  const write = (dependencies && dependencies.put) || put;
  return write(pathname, JSON.stringify(body), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: Boolean(etag),
    ...(etag ? { ifMatch: etag } : {}),
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

async function consumeRateLimit(req, scope, dependencies) {
  const policy = configuredRatePolicy(scope);
  const now = Number(
    dependencies && Number.isFinite(dependencies.now) ? dependencies.now : Date.now()
  );
  const subjectHash = rateSubjectHash(req, scope);
  const pathname = `${configuredStoreRoot()}limits/${scope}/${subjectHash}.json`;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const current = await readCounter(pathname, dependencies);
      const expired =
        !current || now - current.body.windowStartedAt >= policy.windowSeconds * 1000;
      const windowStartedAt = expired ? now : current.body.windowStartedAt;
      const count = expired ? 0 : current.body.count;
      const retryAfter = Math.max(
        1,
        Math.ceil((windowStartedAt + policy.windowSeconds * 1000 - now) / 1000)
      );
      if (count >= policy.limit) {
        throw new HttpError(429, 'rate_limit_exceeded', retryAfter);
      }
      await writeCounter(
        pathname,
        { version: RATE_COUNTER_VERSION, windowStartedAt, count: count + 1 },
        current && current.etag,
        dependencies
      );
      return { remaining: policy.limit - count - 1, retryAfter };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (isConflict(error) && attempt < 4) continue;
      throw new HttpError(503, 'rate_limit_unavailable', 60);
    }
  }
  throw new HttpError(503, 'rate_limit_unavailable', 60);
}

module.exports = {
  configuredRatePolicy,
  consumeRateLimit,
  normalizeNetwork,
  rateSubjectHash,
  requestRateIdentity
};
