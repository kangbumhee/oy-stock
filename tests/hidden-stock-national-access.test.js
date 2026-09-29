const test = require('node:test');
const assert = require('node:assert/strict');
const { createHiddenStockHandler } = require('../api/oliveyoung/_hidden-stock-access');
const { HttpError } = require('../api/price-alerts/_http');
const {
  applyPaymentGrant, applyLifetimePromotion, revokePaymentGrant, requireActiveEntitlement
} = require('../api/price-alerts/_entitlement');

const NOW = Date.parse('2026-09-29T00:00:00Z');
const SECRET = 'national-access-fixture-secret-1234567890';
const GOODS = 'A000000255680';
const SKU = '8800289469145';
const PAYMENT = 'oypa_1234567890abcdefghijklmnop';
const QUERY = { action: 'all-stores', goodsNo: GOODS, productId: SKU };
const RESULT = { success: true, goodsNo: GOODS, storeLookupStatus: 'ok', options: [
  { productId: SKU, stores: [{ name: 'fixture store', qty: 12 }] }
] };

function paidRecord(when = NOW - 60000) {
  const record = {};
  applyPaymentGrant(record, PAYMENT, new Date(when).toISOString());
  return record;
}

function request(query = QUERY) {
  return { method: 'GET', query, headers: { host: 'olivestock.co.kr',
    origin: 'https://olivestock.co.kr', 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' } };
}

function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    removeHeader(key) { delete this.headers[key.toLowerCase()]; },
    end(raw) { this.raw = raw; this.body = JSON.parse(raw); } };
}

function fixture(overrides = {}) {
  const calls = { auth: 0, upstream: [], rate: 0 };
  const deps = {
    async authenticateDevice(req, options) { calls.auth++; assert.equal(options.allowCreate, false); return { record: paidRecord() }; },
    requireActiveEntitlement(record) { return requireActiveEntitlement(record, NOW); },
    async consumeRateLimit() { calls.rate++; },
    getEnvironment() { return { HIDDEN_STOCK_SERVICE_SECRET: SECRET }; },
    async fetch(url, options) { calls.upstream.push({ url, options }); return Response.json(RESULT); },
    ...overrides
  };
  return { handler: createHiddenStockHandler(deps), calls };
}

function assertPrivate(res) {
  assert.equal(res.headers['cache-control'], 'private, no-store, max-age=0');
  assert.equal(res.headers['cdn-cache-control'], 'no-store');
  assert.equal(res.headers['vercel-cdn-cache-control'], 'no-store');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(res.raw.includes(SECRET), false);
}

test.before(() => { process.env.PRICE_ALERT_ENTITLEMENT_ENABLED = 'true'; });

test('national inventory accepts paid and lifetime access and rechecks before releasing stock', async () => {
  const lifetime = {};
  applyLifetimePromotion(lifetime, 'fixture-promotion-digest', new Date(NOW).toISOString());
  for (const record of [paidRecord(), lifetime]) {
    let authReads = 0;
    const { handler, calls } = fixture({
      async authenticateDevice(req, options) { authReads++; assert.equal(options.allowCreate, false); return { record }; }
    });
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, RESULT);
    assert.equal(authReads, 2);
    assert.equal(calls.upstream.length, 1);
    const upstream = calls.upstream[0];
    const target = new URL(upstream.url);
    assert.equal(target.pathname, '/api/stock-all');
    assert.deepEqual([...target.searchParams], [['goodsNo', GOODS], ['productId', SKU]]);
    assert.equal(upstream.options.headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(upstream.options.redirect, 'error');
    assert.equal(upstream.options.cache, 'no-store');
    assert.equal(upstream.options.credentials, 'omit');
    assertPrivate(res);
  }
});

test('anonymous, free, expired and revoked access cannot start a national lookup', async () => {
  const revoked = paidRecord();
  revokePaymentGrant(revoked, PAYMENT, new Date(NOW).toISOString());
  for (const [record, status] of [[null, 401], [{}, 402], [paidRecord(NOW - 40 * 86400000), 402], [revoked, 402]]) {
    const { handler, calls } = fixture({ async authenticateDevice() {
      if (!record) throw new HttpError(401, 'device_auth_required');
      return { record };
    } });
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, status);
    assert.equal(calls.upstream.length, 0);
    assert.equal(calls.rate, 0);
    assertPrivate(res);
  }
});

test('entitlement or device revocation during lookup discards returned national stock', async () => {
  for (const revokedIdentity of [false, true]) {
    let reads = 0;
    const { handler, calls } = fixture({ async authenticateDevice() {
      if (++reads === 1) return { record: paidRecord() };
      if (revokedIdentity) throw new HttpError(401, 'device_auth_failed');
      return { record: {} };
    } });
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, revokedIdentity ? 401 : 402);
    assert.equal(calls.upstream.length, 1);
    assert.equal(res.raw.includes('fixture store'), false);
    assertPrivate(res);
  }
});

test('national query rejects extra fields, duplicates, missing identifiers and non-GET methods', async () => {
  const invalidRequests = [
    request({ ...QUERY, scope: 'nearby' }), request({ ...QUERY, cursor: 'cursor' }),
    request({ ...QUERY, productId: '' }), request({ ...QUERY, goodsNo: 'bad' }),
    request({ ...QUERY, productId: ['123456', SKU] }),
    { ...request(), url: '/api/oliveyoung/hidden-stock?action=all-stores&goodsNo=' + GOODS + '&productId=' + SKU + '&productId=' + SKU },
    { ...request(), url: '/api/oliveyoung/hidden-stock?action=options&action=all-stores&goodsNo=' + GOODS },
    { ...request(), method: 'POST' }, { ...request(), method: 'OPTIONS' }
  ];
  for (const req of invalidRequests) {
    const { handler, calls } = fixture();
    const res = response();
    await handler(req, res);
    assert.equal(res.statusCode, req.method === 'GET' ? 400 : 405);
    assert.equal(calls.auth, 0);
    assert.equal(calls.upstream.length, 0);
    assertPrivate(res);
  }
});

test('national gateway fails closed for cross-site, unavailable entitlement configuration and service failures', async () => {
  const cases = [
    { request: { ...request(), headers: { ...request().headers, origin: 'https://other.example', 'sec-fetch-site': 'cross-site' } }, status: 403 },
    { overrides: { requireActiveEntitlement() { throw new HttpError(503, 'entitlement_not_configured'); } }, status: 503 },
    { overrides: { getEnvironment() { return {}; } }, status: 503 },
    { overrides: { async fetch() { return Response.json({ success: false, error: SECRET }, { status: 503 }); } }, status: 503 },
    { overrides: { async fetch() { return Response.json({ ...RESULT, debug: SECRET }); } }, status: 502 },
    { overrides: { async fetch() { throw new Error(SECRET); } }, status: 503 },
    { overrides: { async fetch() { return Response.json({ error: 'unauthorized' }, { status: 401 }); } }, status: 503 }
  ];
  for (const entry of cases) {
    const { handler } = fixture(entry.overrides);
    const res = response();
    await handler(entry.request || request(), res);
    assert.equal(res.statusCode, entry.status);
    assertPrivate(res);
  }
});

test('national partial coverage is preserved and existing stores routing is unchanged', async () => {
  const partial = { ...RESULT, storeLookupStatus: 'partial', retryAfterMs: 60000 };
  const { handler } = fixture({ async fetch() { return Response.json(partial); } });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, partial);

  const existing = fixture();
  const storesRes = response();
  await existing.handler(request({ action: 'stores', goodsNo: GOODS, productId: SKU, scope: 'nearby', lat: '37', lng: '126' }), storesRes);
  assert.equal(storesRes.statusCode, 200);
  assert.equal(existing.calls.auth, 1);
  assert.equal(new URL(existing.calls.upstream[0].url).pathname, '/api/hidden-stock');
});

test('national failures preserve a bounded retry delay without reflecting upstream diagnostics', async () => {
  for (const [header, bodyRetry, expected] of [['12', 30, 30], ['999999999', 0, 86400], ['bad', 5, 5], ['-2', -10, null]]) {
    const { handler } = fixture({ async fetch() { return Response.json({ success: false, error: SECRET,
      retryAfterSeconds: bodyRetry }, { status: 429, headers: { 'Retry-After': header } }); } });
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, 429);
    if (expected === null) {
      assert.equal(res.headers['retry-after'], undefined);
      assert.equal(res.body.retryAfterSeconds, undefined);
    } else {
      assert.equal(res.headers['retry-after'], String(expected));
      assert.equal(res.body.retryAfterSeconds, expected);
      assert.equal(res.body.retryAfterMs, expected * 1000);
    }
    assertPrivate(res);
  }
});
