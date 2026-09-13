const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
  MAX_RESPONSE_BYTES,
  UPSTREAM_TIMEOUT_MS,
  boundedJson,
  configuredService,
  createHiddenStockHandler,
  normalizedQuery
} = require('../api/oliveyoung/_hidden-stock-access');
const { HttpError } = require('../api/price-alerts/_http');
const {
  applyPaymentGrant,
  applyLifetimePromotion,
  revokePaymentGrant,
  requireActiveEntitlement
} = require('../api/price-alerts/_entitlement');

const NOW = Date.parse('2026-09-13T01:00:00.000Z');
const SERVICE_SECRET = 'fixture-service-secret-1234567890-abcdef';
const GOODS_NO = 'A000000255680';
const PRODUCT_ID = '8800289469145';
const PAYMENT_ID = 'oypa_1234567890abcdefghijklmnop';

function paidRecord() {
  const record = {};
  applyPaymentGrant(record, PAYMENT_ID, new Date(NOW - 60 * 1000).toISOString());
  return record;
}

function request(query = { action: 'search', keyword: '한교동' }, headers = {}) {
  return {
    method: 'GET',
    query,
    headers: {
      host: 'olivestock.co.kr',
      origin: 'https://olivestock.co.kr',
      'x-forwarded-proto': 'https',
      'sec-fetch-site': 'same-origin',
      'x-price-alert-device-id': 'fixture-device-id-123456',
      'x-price-alert-device-secret': 'fixture-device-secret-1234567890-abcdef',
      ...headers
    }
  };
}

function response() {
  return {
    headers: {},
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    removeHeader(key) { delete this.headers[key.toLowerCase()]; },
    end(text) { this.body = JSON.parse(text); this.text = text; }
  };
}

function dependencies(overrides = {}) {
  const calls = { auth: [], rate: [], upstream: [] };
  const deps = {
    async authenticateDevice(req, options) {
      calls.auth.push({ req, options });
      return { record: paidRecord() };
    },
    requireActiveEntitlement(record) { return requireActiveEntitlement(record, NOW); },
    async consumeRateLimit(req, scope) { calls.rate.push({ req, scope }); },
    getEnvironment() { return { HIDDEN_STOCK_SERVICE_SECRET: SERVICE_SECRET }; },
    async fetch(url, options) {
      calls.upstream.push({ url, options });
      return new Response(JSON.stringify({ success: true, products: [], nextCursor: null }));
    },
    ...overrides
  };
  return { deps, calls };
}

async function withEntitlementEnabled(fn) {
  const previous = process.env.PRICE_ALERT_ENTITLEMENT_ENABLED;
  process.env.PRICE_ALERT_ENTITLEMENT_ENABLED = 'true';
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.PRICE_ALERT_ENTITLEMENT_ENABLED;
    else process.env.PRICE_ALERT_ENTITLEMENT_ENABLED = previous;
  }
}

test('missing or invalid device auth returns 401 before rate counter or upstream retrieval', async () => {
  for (const code of ['device_auth_required', 'device_auth_failed']) {
    const { deps, calls } = dependencies({
      async authenticateDevice(req, options) {
        assert.deepEqual(options, { allowCreate: false });
        throw new HttpError(401, code);
      }
    });
    const res = response();
    await createHiddenStockHandler(deps)(request(), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, code);
    assert.equal(calls.rate.length, 0);
    assert.equal(calls.upstream.length, 0);
  }
});

test('production authenticator rejects absent device credentials without creating a user record', async () => {
  const { deps, calls } = dependencies();
  delete deps.authenticateDevice;
  const req = request();
  delete req.headers['x-price-alert-device-id'];
  delete req.headers['x-price-alert-device-secret'];
  const res = response();
  await createHiddenStockHandler(deps)(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'device_auth_required');
  assert.equal(calls.rate.length, 0);
  assert.equal(calls.upstream.length, 0);
});

test('free, expired, refunded and revoked lifetime users are denied regardless of client paid claims', async () => {
  await withEntitlementEnabled(async () => {
    const expired = {};
    applyPaymentGrant(expired, PAYMENT_ID, '2026-07-01T00:00:00.000Z');
    const refunded = paidRecord();
    revokePaymentGrant(refunded, PAYMENT_ID, new Date(NOW).toISOString());
    const revokedLifetime = {};
    applyLifetimePromotion(revokedLifetime, 'fixture-promotion', new Date(NOW).toISOString());
    revokedLifetime.entitlement.grants[0].revokedAt = new Date(NOW).toISOString();
    for (const record of [{}, expired, refunded, revokedLifetime, { entitlement: { active: true } }]) {
      const { deps, calls } = dependencies({ async authenticateDevice() { return { record }; } });
      const req = request();
      req.body = { active: true, paid: true, lifetime: true, entitlement: { active: true } };
      req.headers['x-paid-member'] = 'true';
      const res = response();
      await createHiddenStockHandler(deps)(req, res);
      assert.equal(res.statusCode, 402);
      assert.equal(res.body.error, 'entitlement_required');
      assert.equal(calls.rate.length, 0);
      assert.equal(calls.upstream.length, 0);
    }
  });
});

test('paid and lifetime grants permit retrieval only after server authentication and entitlement check', async () => {
  await withEntitlementEnabled(async () => {
    const lifetime = {};
    applyLifetimePromotion(lifetime, 'fixture-promotion', '2020-01-01T00:00:00.000Z');
    for (const record of [paidRecord(), lifetime]) {
      const sequence = [];
      const { deps, calls } = dependencies({
        async authenticateDevice(req, options) {
          assert.deepEqual(options, { allowCreate: false });
          sequence.push('auth');
          return { record };
        },
        requireActiveEntitlement(value) {
          sequence.push('entitlement');
          return requireActiveEntitlement(value, NOW);
        },
        async consumeRateLimit(req, scope) {
          assert.equal(scope, 'hidden_stock');
          sequence.push('rate');
        }
      });
      const originalFetch = deps.fetch;
      deps.fetch = (...args) => { sequence.push('fetch'); return originalFetch(...args); };
      const res = response();
      await createHiddenStockHandler(deps)(request(), res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(sequence, ['auth', 'entitlement', 'rate', 'fetch']);
      assert.equal(calls.upstream.length, 1);
    }
  });
});

test('configured paid gate never opens when entitlement feature is disabled', async () => {
  const previous = process.env.PRICE_ALERT_ENTITLEMENT_ENABLED;
  process.env.PRICE_ALERT_ENTITLEMENT_ENABLED = 'false';
  try {
    const { deps, calls } = dependencies();
    const res = response();
    await createHiddenStockHandler(deps)(request(), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'entitlement_not_configured');
    assert.equal(calls.upstream.length, 0);
  } finally {
    if (previous === undefined) delete process.env.PRICE_ALERT_ENTITLEMENT_ENABLED;
    else process.env.PRICE_ALERT_ENTITLEMENT_ENABLED = previous;
  }
});

test('only normalized parameters and service token reach Cloud Run; device credentials never forward', async () => {
  await withEntitlementEnabled(async () => {
    const queries = [
      { action: 'search', keyword: '  한교동   에디션  ', cursor: 'page_abc.123-xyz' },
      { action: 'options', goodsNo: ` ${GOODS_NO.toLowerCase()} ` },
      { action: 'stores', goodsNo: GOODS_NO, productId: PRODUCT_ID, cursor: 'opaque-2' },
      { action: 'stores', goodsNo: GOODS_NO, productId: PRODUCT_ID, scope: 'nearby', lat: '37.615200', lng: '126.715600' },
      { action: 'stores', goodsNo: GOODS_NO, productId: PRODUCT_ID, scope: 'national', lat: '37.6152', lng: '126.7156' }
    ];
    for (const query of queries) {
      const { deps, calls } = dependencies();
      const res = response();
      await createHiddenStockHandler(deps)(request(query, { cookie: 'do-not-forward-cookie', authorization: 'do-not-forward-auth' }), res);
      assert.equal(res.statusCode, 200);
      const { url, options } = calls.upstream[0];
      const target = new URL(url);
      assert.equal(target.origin, 'https://oy-stock-api-3596046881.asia-northeast3.run.app');
      assert.equal(target.pathname, '/api/hidden-stock');
      assert.equal(target.searchParams.get('action'), query.action);
      if (query.action === 'search') assert.equal(target.searchParams.get('keyword'), '한교동 에디션');
      else assert.equal(target.searchParams.get('goodsNo'), GOODS_NO);
      if (query.scope) {
        assert.equal(target.searchParams.get('scope'), query.scope);
        assert.equal(target.searchParams.get('lat'), '37.6152');
        assert.equal(target.searchParams.get('lng'), '126.7156');
      }
      assert.deepEqual(options.headers, { Accept: 'application/json', Authorization: `Bearer ${SERVICE_SECRET}` });
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(JSON.stringify(options).includes('fixture-device'), false);
      assert.equal(url.includes(SERVICE_SECRET), false);
      assert.equal(res.text.includes(SERVICE_SECRET), false);
    }
    assert.equal(UPSTREAM_TIMEOUT_MS, 45000);
  });
});

test('success and denial responses are private and never send permissive CORS', async () => {
  await withEntitlementEnabled(async () => {
    for (const authenticated of [true, false]) {
      const { deps } = dependencies(authenticated ? {} : {
        async authenticateDevice() { throw new HttpError(401, 'device_auth_required'); }
      });
      const res = response();
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      await createHiddenStockHandler(deps)(request(), res);
      assert.equal(res.headers['cache-control'], 'private, no-store, max-age=0');
      assert.equal(res.headers['cdn-cache-control'], 'no-store');
      assert.equal(res.headers['vercel-cdn-cache-control'], 'no-store');
      assert.match(res.headers.vary, /X-Price-Alert-Device-Id/);
      assert.match(res.headers.vary, /X-Price-Alert-Device-Secret/);
      assert.equal(res.headers['access-control-allow-origin'], undefined);
      assert.equal(res.headers['access-control-allow-credentials'], undefined);
      assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
    }
  });
});

test('cross-site, mismatched origins and non-GET methods cannot fetch paid data', async () => {
  for (const req of [
    request(undefined, { 'sec-fetch-site': 'cross-site' }),
    request(undefined, { origin: 'https://attacker.example' }),
    request(undefined, { origin: 'http://olivestock.co.kr' }),
    { ...request(), method: 'POST' },
    { ...request(), method: 'OPTIONS' }
  ]) {
    const { deps, calls } = dependencies();
    const res = response();
    await createHiddenStockHandler(deps)(req, res);
    assert.equal(res.statusCode, req.method === 'GET' ? 403 : 405);
    assert.equal(calls.auth.length, 0);
    assert.equal(calls.upstream.length, 0);
  }
});

test('strict query allowlist rejects URL injection, invalid identifiers, duplicate fields and unbounded cursors', async () => {
  const invalidQueries = [
    { action: 'search', keyword: '미스트', url: 'http://169.254.169.254' },
    { action: 'search', keyword: '미스트', active: 'true' },
    { action: 'search', keyword: '' },
    { action: 'search', keyword: 'a'.repeat(121) },
    { action: 'search', keyword: 'abc\r\nHost: evil' },
    { action: 'search', keyword: ['one', 'two'] },
    { action: 'search', keyword: '미스트', cursor: 'x'.repeat(2049) },
    { action: 'search', keyword: '미스트', cursor: 'https://evil.example' },
    { action: 'options', goodsNo: `../${GOODS_NO}` },
    { action: 'options', goodsNo: GOODS_NO, cursor: 'ignored-maybe' },
    { action: 'stores', goodsNo: GOODS_NO, productId: 'https://evil.example' },
    { action: 'stores', goodsNo: GOODS_NO, productId: '123' },
    { action: 'stores', goodsNo: GOODS_NO },
    { action: 'toString' },
    { action: 'constructor' },
    { action: 'unknown' },
    {}
  ];
  for (const query of invalidQueries) {
    const { deps, calls } = dependencies();
    const res = response();
    await createHiddenStockHandler(deps)(request(query), res);
    assert.equal(res.statusCode, 400, JSON.stringify(query));
    assert.equal(calls.upstream.length, 0);
  }
  assert.throws(() => normalizedQuery({ url: '/api/oliveyoung/hidden-stock?action=search&keyword=one&keyword=two' }), /invalid_query/);
});

test('nearby gateway validates scope and paired coordinates without accepting authority or arbitrary search words', async () => {
  const base = { action: 'stores', goodsNo: GOODS_NO, productId: PRODUCT_ID };
  for (const [extra, error] of [
    [{ scope: '' }, 'invalid_scope'], [{ scope: 'all' }, 'invalid_scope'],
    [{ scope: 'nearby' }, 'invalid_location'], [{ scope: 'nearby', lat: '37' }, 'invalid_location'],
    [{ lat: '37' }, 'invalid_location'], [{ lng: '127' }, 'invalid_location'],
    ...['', ' ', 'NaN', 'Infinity', '0x25', '91', '-91'].map(lat => [{ scope: 'nearby', lat, lng: '127' }, 'invalid_location']),
    ...['181', '-181'].map(lng => [{ scope: 'nearby', lat: '37', lng }, 'invalid_location']),
    [{ scope: 'nearby', lat: '37', lng: '127', searchWords: 'private' }, 'invalid_query'],
    [{ scope: 'nearby', lat: '37', lng: '127', active: 'true' }, 'invalid_query']
  ]) {
    const { deps, calls } = dependencies();
    const res = response();
    await createHiddenStockHandler(deps)(request({ ...base, ...extra }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(extra));
    assert.equal(res.body.error, error);
    assert.equal(calls.auth.length, 0);
    assert.equal(calls.upstream.length, 0);
  }
  assert.equal(normalizedQuery(request(base)).has('scope'), false);
  const normalized = normalizedQuery(request({ ...base, scope: 'nearby', lat: '-0', lng: '0.00000001' }));
  assert.equal(normalized.get('lat'), '0');
  assert.equal(Number(normalized.get('lng')), 0.00000001);
  assert.throws(() => normalizedQuery({ url: '/api/oliveyoung/hidden-stock?action=stores&goodsNo=' + GOODS_NO +
    '&productId=' + PRODUCT_ID + '&scope=nearby&lat=37&lat=38&lng=127' }), /invalid_query/);
});

test('nearby and national modes both retain the server-side paid entitlement gate', async () => {
  await withEntitlementEnabled(async () => {
    for (const scope of ['nearby', 'national']) {
      const { deps, calls } = dependencies({ async authenticateDevice() { return { record: {} }; } });
      const res = response();
      await createHiddenStockHandler(deps)(request({ action: 'stores', goodsNo: GOODS_NO, productId: PRODUCT_ID,
        scope, lat: '37.6152', lng: '126.7156' }), res);
      assert.equal(res.statusCode, 402);
      assert.equal(calls.rate.length, 0);
      assert.equal(calls.upstream.length, 0);
      assert.equal(res.headers['cache-control'], 'private, no-store, max-age=0');
    }
  });
});

test('missing service secret and unsafe configured destinations fail closed with 503', async () => {
  await withEntitlementEnabled(async () => {
    for (const env of [
      {},
      { HIDDEN_STOCK_SERVICE_SECRET: 'short' },
      { HIDDEN_STOCK_SERVICE_SECRET: `${SERVICE_SECRET}\r\nInjected: header` },
      ...['http://localhost', 'https://169.254.169.254', 'https://evil.example', 'https://valid.run.app@evil.example',
        'https://valid.run.app/path', 'https://valid.run.app?url=https://evil.example', 'https://valid.run.app#ignored',
        'https://user:password@valid.run.app', 'https://valid.run.app:1234'].map((url) => ({
        HIDDEN_STOCK_SERVICE_SECRET: SERVICE_SECRET, HIDDEN_STOCK_SERVICE_URL: url
      }))
    ]) {
      const { deps, calls } = dependencies({ getEnvironment() { return env; } });
      const res = response();
      await createHiddenStockHandler(deps)(request(), res);
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.error, 'hidden_stock_not_configured');
      assert.equal(calls.upstream.length, 0);
      assert.equal(calls.rate.length, 0);
      assert.equal(res.text.includes(SERVICE_SECRET), false);
    }
    assert.equal(configuredService({ HIDDEN_STOCK_SERVICE_SECRET: SERVICE_SECRET,
      HIDDEN_STOCK_SERVICE_URL: 'https://another-service-abc.asia-northeast3.run.app/' }).url.pathname, '/api/hidden-stock');
  });
});

test('upstream status/error is sanitized and internal service authorization is not reported as user 401', async () => {
  await withEntitlementEnabled(async () => {
    for (const [status, error, expectedStatus, expectedError] of [
      [401, 'service_secret_missing', 503, 'hidden_stock_unavailable'],
      [403, 'service_secret_wrong', 503, 'hidden_stock_unavailable'],
      [503, 'internal url and secret ' + SERVICE_SECRET, 503, 'hidden_stock_unavailable'],
      [429, 'rate_limit_exceeded', 429, 'rate_limit_exceeded'],
      [404, 'option_not_found', 404, 'option_not_found'],
      [500, 'stacktrace', 502, 'hidden_stock_unavailable']
    ]) {
      const { deps } = dependencies({ async fetch() {
        return new Response(JSON.stringify({ success: false, error, message: SERVICE_SECRET, debug: 'private' }), { status });
      } });
      const res = response();
      await createHiddenStockHandler(deps)(request(), res);
      assert.equal(res.statusCode, expectedStatus);
      assert.deepEqual(res.body, { success: false, error: expectedError });
      assert.equal(res.text.includes(SERVICE_SECRET), false);
    }
  });
});

test('secret reflection, malformed and oversized upstream payloads are never relayed', async () => {
  await withEntitlementEnabled(async () => {
    for (const makeResponse of [
      () => new Response(JSON.stringify({ success: true, debug: SERVICE_SECRET })),
      () => new Response('not-json'),
      () => new Response('[]'),
      () => new Response(JSON.stringify({ success: false })),
      () => new Response('{}', { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } }),
      () => new Response(JSON.stringify({ success: true, text: 'x'.repeat(MAX_RESPONSE_BYTES) }))
    ]) {
      const { deps } = dependencies({ async fetch() { return makeResponse(); } });
      const res = response();
      await createHiddenStockHandler(deps)(request(), res);
      assert.equal(res.statusCode, 502);
      assert.deepEqual(res.body, { success: false, error: 'hidden_stock_invalid_response' });
      assert.equal(res.text.includes(SERVICE_SECRET), false);
    }
  });
});

test('streamed response limit is enforced before accepting JSON', async () => {
  let consumed = 0;
  async function* chunks() {
    for (let i = 0; i < 10; i += 1) {
      consumed += 1;
      yield Buffer.alloc(1024);
    }
  }
  await assert.rejects(() => boundedJson({
    headers: new Headers(), body: Readable.from(chunks())
  }, 2048), /hidden_stock_invalid_response/);
  assert.ok(consumed < 10);
});

test('a reflected service secret containing JSON escape characters is also blocked', async () => {
  await withEntitlementEnabled(async () => {
    const escapedSecret = `${SERVICE_SECRET}\\\"escaped`;
    const { deps } = dependencies({
      getEnvironment() { return { HIDDEN_STOCK_SERVICE_SECRET: escapedSecret }; },
      async fetch() { return new Response(JSON.stringify({ success: true, debug: `prefix:${escapedSecret}:suffix` })); }
    });
    const res = response();
    await createHiddenStockHandler(deps)(request(), res);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.body, { success: false, error: 'hidden_stock_invalid_response' });
  });
});

test('network errors are generic, request timeouts are 504, rate errors block upstream', async () => {
  await withEntitlementEnabled(async () => {
    for (const [error, expectedStatus, code] of [
      [new Error(`failure with ${SERVICE_SECRET}`), 503, 'hidden_stock_unavailable'],
      [new DOMException('aborted', 'AbortError'), 504, 'hidden_stock_timeout']
    ]) {
      const { deps } = dependencies({ async fetch() { throw error; } });
      const res = response();
      await createHiddenStockHandler(deps)(request(), res);
      assert.equal(res.statusCode, expectedStatus);
      assert.equal(res.body.error, code);
      assert.equal(res.text.includes(SERVICE_SECRET), false);
    }
    const { deps, calls } = dependencies({ async consumeRateLimit() { throw new HttpError(429, 'rate_limit_exceeded', 20); } });
    const res = response();
    await createHiddenStockHandler(deps)(request(), res);
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '20');
    assert.equal(calls.upstream.length, 0);
  });
});
