const { authenticateDevice } = require('../price-alerts/_auth');
const { requireActiveEntitlement } = require('../price-alerts/_entitlement');
const { HttpError, assertSameOrigin } = require('../price-alerts/_http');
const { consumeRateLimit } = require('../price-alerts/_limits');

const DEFAULT_SERVICE_URL = 'https://oy-stock-api-3596046881.asia-northeast3.run.app';
const UPSTREAM_TIMEOUT_MS = 45000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CURSOR_LENGTH = 2048;
const REQUEST_FIELDS = {
  search: new Set(['action', 'keyword', 'cursor']),
  options: new Set(['action', 'goodsNo']),
  stores: new Set(['action', 'goodsNo', 'productId', 'cursor', 'scope', 'lat', 'lng'])
};
const PUBLIC_ERRORS = new Set([
  'device_auth_required', 'device_auth_failed', 'entitlement_required',
  'entitlement_not_configured', 'cross_site_request_denied', 'origin_mismatch',
  'rate_limit_exceeded', 'rate_limit_unavailable', 'invalid_query',
  'invalid_action', 'invalid_keyword', 'invalid_goods_no', 'invalid_product_id',
  'invalid_cursor', 'invalid_scope', 'invalid_location', 'hidden_stock_not_configured', 'hidden_stock_unavailable',
  'hidden_stock_timeout', 'hidden_stock_invalid_response', 'method_not_allowed'
]);
const UPSTREAM_ERRORS = new Set([
  'invalid_query', 'invalid_action', 'invalid_keyword', 'invalid_goods_no',
  'invalid_product_id', 'invalid_cursor', 'invalid_scope', 'invalid_location', 'product_not_found', 'option_not_found',
  'catalog_unavailable', 'hidden_stock_unavailable', 'rate_limit_exceeded',
  'upstream_unavailable', 'upstream_timeout', 'upstream_blocked', 'request_timeout'
]);

function setPrivateHeaders(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin, X-Price-Alert-Device-Id, X-Price-Alert-Device-Secret');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Never add permissive CORS to a response containing paid-only information.
  if (typeof res.removeHeader === 'function') {
    res.removeHeader('Access-Control-Allow-Origin');
    res.removeHeader('Access-Control-Allow-Credentials');
  }
}

function sendPrivateJson(res, status, body) {
  setPrivateHeaders(res);
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function queryFields(req) {
  const values = Object.create(null);
  const url = String(req.url || '');
  if (url.includes('?')) {
    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    for (const [key, value] of query) {
      if (Object.hasOwn(values, key)) throw new HttpError(400, 'invalid_query');
      values[key] = value;
    }
  } else {
    const query = req.query || {};
    for (const key of Object.keys(query)) {
      if (typeof query[key] !== 'string') throw new HttpError(400, 'invalid_query');
      values[key] = query[key];
    }
  }
  return values;
}

function normalizedQuery(req) {
  const fields = queryFields(req);
  const action = fields.action;
  const allowed = REQUEST_FIELDS[action];
  if (!Object.hasOwn(REQUEST_FIELDS, action) || !allowed) {
    throw new HttpError(400, 'invalid_action');
  }
  if (Object.keys(fields).some((key) => !allowed.has(key))) {
    throw new HttpError(400, 'invalid_query');
  }
  const query = new URLSearchParams({ action });
  if (action === 'search') {
    const keyword = String(fields.keyword || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!keyword || keyword.length > 120 || /[\u0000-\u001f\u007f]/.test(fields.keyword || '')) {
      throw new HttpError(400, 'invalid_keyword');
    }
    query.set('keyword', keyword);
  } else {
    const goodsNo = String(fields.goodsNo || '').trim().toUpperCase();
    if (!/^[AB]\d{6,20}$/.test(goodsNo)) throw new HttpError(400, 'invalid_goods_no');
    query.set('goodsNo', goodsNo);
  }
  if (action === 'stores') {
    const productId = String(fields.productId || '').trim();
    if (!/^\d{6,20}$/.test(productId)) throw new HttpError(400, 'invalid_product_id');
    query.set('productId', productId);
    const scope = Object.hasOwn(fields, 'scope') ? fields.scope : 'national';
    if (!['nearby', 'national'].includes(scope)) throw new HttpError(400, 'invalid_scope');
    if (Object.hasOwn(fields, 'scope')) query.set('scope', scope);
    const locationProvided = Object.hasOwn(fields, 'lat') || Object.hasOwn(fields, 'lng');
    if (scope === 'nearby' && !locationProvided) throw new HttpError(400, 'invalid_location');
    if (locationProvided) {
      for (const [key, limit] of [['lat', 90], ['lng', 180]]) {
        const value = fields[key];
        if (typeof value !== 'string' || value.length > 32 || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,3})?$/.test(value) ||
          !Number.isFinite(Number(value)) || Math.abs(Number(value)) > limit) {
          throw new HttpError(400, 'invalid_location');
        }
        query.set(key, String(Number(value)));
      }
    }
  }
  if (Object.hasOwn(fields, 'cursor')) {
    const cursor = fields.cursor;
    if (!cursor || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_.~-]+$/.test(cursor)) {
      throw new HttpError(400, 'invalid_cursor');
    }
    query.set('cursor', cursor);
  }
  return query;
}

function configuredService(env = process.env) {
  const secret = String(env.HIDDEN_STOCK_SERVICE_SECRET || '');
  if (!/^[\x21-\x7e]{32,256}$/.test(secret)) {
    throw new HttpError(503, 'hidden_stock_not_configured');
  }
  let url;
  try {
    url = new URL(String(env.HIDDEN_STOCK_SERVICE_URL || DEFAULT_SERVICE_URL));
  } catch (_) {
    throw new HttpError(503, 'hidden_stock_not_configured');
  }
  if (
    url.protocol !== 'https:' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.run\.app$/.test(url.hostname) ||
    url.username || url.password || url.port || url.search || url.hash ||
    !['', '/'].includes(url.pathname)
  ) {
    throw new HttpError(503, 'hidden_stock_not_configured');
  }
  url.pathname = '/api/hidden-stock';
  return { url, secret };
}

async function boundedJson(response, limit = MAX_RESPONSE_BYTES) {
  const rawLength = response.headers && response.headers.get('content-length');
  const declaredLength = rawLength == null ? null : Number(rawLength);
  if (declaredLength != null && (!Number.isFinite(declaredLength) || declaredLength > limit)) {
    if (response.body && typeof response.body.cancel === 'function') await response.body.cancel();
    throw new HttpError(502, 'hidden_stock_invalid_response');
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    throw new HttpError(502, 'hidden_stock_invalid_response');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) throw new HttpError(502, 'hidden_stock_invalid_response');
    chunks.push(bytes);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_) {
    throw new HttpError(502, 'hidden_stock_invalid_response');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(502, 'hidden_stock_invalid_response');
  }
  return body;
}

function createHiddenStockHandler(dependencies = {}) {
  const authenticate = dependencies.authenticateDevice || authenticateDevice;
  const requireEntitlement = dependencies.requireActiveEntitlement || requireActiveEntitlement;
  const rateLimit = dependencies.consumeRateLimit || consumeRateLimit;
  const fetchUpstream = dependencies.fetch || globalThis.fetch;
  const getEnvironment = dependencies.getEnvironment || (() => process.env);

  return async function hiddenStockHandler(req, res) {
    setPrivateHeaders(res);
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return sendPrivateJson(res, 405, { success: false, error: 'method_not_allowed' });
    }
    let timeout;
    try {
      assertSameOrigin(req);
      const query = normalizedQuery(req);
      // The record comes only from server storage. Do not accept client entitlement flags.
      const loaded = await authenticate(req, { allowCreate: false });
      if (!loaded || !loaded.record) throw new HttpError(401, 'device_auth_failed');
      requireEntitlement(loaded.record);
      const service = configuredService(getEnvironment());
      await rateLimit(req, 'hidden_stock');
      const target = new URL(service.url);
      target.search = query.toString();
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      const upstream = await fetchUpstream(target.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${service.secret}`
        },
        signal: controller.signal,
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit'
      });
      // A service authentication failure is an operator configuration issue, not a user login failure.
      if ([401, 403].includes(upstream.status)) {
        if (upstream.body && typeof upstream.body.cancel === 'function') await upstream.body.cancel();
        throw new HttpError(503, 'hidden_stock_unavailable');
      }
      const body = await boundedJson(upstream);
      if (!upstream.ok) {
        const status = [400, 404, 409, 429, 502, 503, 504].includes(upstream.status)
          ? upstream.status : 502;
        const code = UPSTREAM_ERRORS.has(body.error) ? body.error : 'hidden_stock_unavailable';
        return sendPrivateJson(res, status, { success: false, error: code });
      }
      const serialized = JSON.stringify(body);
      const escapedSecret = JSON.stringify(service.secret).slice(1, -1);
      if (body.success !== true || serialized.includes(service.secret) || serialized.includes(escapedSecret)) {
        throw new HttpError(502, 'hidden_stock_invalid_response');
      }
      return sendPrivateJson(res, 200, body);
    } catch (error) {
      const timedOut = error && ['AbortError', 'TimeoutError'].includes(error.name);
      const recognized = error instanceof HttpError && PUBLIC_ERRORS.has(error.code);
      const status = timedOut ? 504 : recognized ? error.statusCode : 503;
      const code = timedOut ? 'hidden_stock_timeout' : recognized ? error.code : 'hidden_stock_unavailable';
      if (recognized && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      return sendPrivateJson(res, status, { success: false, error: code });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}

module.exports = {
  DEFAULT_SERVICE_URL,
  UPSTREAM_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_CURSOR_LENGTH,
  boundedJson,
  configuredService,
  createHiddenStockHandler,
  normalizedQuery,
  setPrivateHeaders
};
