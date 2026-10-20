const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');

process.env.PRICE_ALERT_DATA_KEY = Buffer.alloc(32, 19).toString('base64');
const { consumeRateLimit, rateSubjectHash } = require('../api/price-alerts/_limits');
const http = require('../api/price-alerts/_http');
const entitlement = require('../api/price-alerts/_entitlement');
const DEVICE_A = 'AuthenticatedDeviceA12345';
const DEVICE_B = 'AuthenticatedDeviceB12345';
const req = (ip = '203.0.113.44', host = 'olivestock.co.kr') => ({
  method: 'POST', headers: { host, origin: `https://${host}`, 'x-vercel-forwarded-for': ip },
  body: { idempotencyKey: 'checkout-test-key-1234567890' }
});

function blob() {
  const rows = new Map();
  let revision = 0;
  return {
    rows,
    async get(key, options) {
      assert.equal(options.headers['Accept-Encoding'], 'identity');
      const row = rows.get(key);
      return row ? { stream: Readable.from([row.body]), blob: { etag: row.etag } } : null;
    },
    async put(key, body, options) {
      const old = rows.get(key);
      if ((old && !options.allowOverwrite) || (options.ifMatch && old?.etag !== options.ifMatch)) {
        throw Object.assign(new Error('CAS conflict'), { statusCode: 412 });
      }
      const row = { body, etag: `"counter-${++revision}"` };
      rows.set(key, row);
      return { etag: row.etag };
    }
  };
}

test('checkout quotas isolate authenticated devices on the same Wi-Fi', async () => {
  const memory = blob();
  const previous = process.env.PRICE_ALERT_PAYMENT_CREATE_LIMIT;
  process.env.PRICE_ALERT_PAYMENT_CREATE_LIMIT = '2';
  try {
    const deps = { ...memory, now: 1000, authenticatedDeviceId: DEVICE_A };
    await consumeRateLimit(req(), 'payment_create', deps);
    await consumeRateLimit(req(), 'payment_create', deps);
    await assert.rejects(consumeRateLimit(req(), 'payment_create', deps), { code: 'rate_limit_exceeded' });
    await consumeRateLimit(req(), 'payment_create', { ...deps, authenticatedDeviceId: DEVICE_B });
    assert.equal(memory.rows.size, 2);
  } finally {
    if (previous === undefined) delete process.env.PRICE_ALERT_PAYMENT_CREATE_LIMIT;
    else process.env.PRICE_ALERT_PAYMENT_CREATE_LIMIT = previous;
  }
});

test('authenticated device quota cannot reset by changing host or IP; raw headers do not select it', () => {
  const a = req();
  const b = req('198.51.100.1', 'oy-stock.vercel.app');
  for (const scope of ['payment_create', 'payment_complete']) {
    assert.equal(rateSubjectHash(a, scope, undefined, DEVICE_A), rateSubjectHash(b, scope, undefined, DEVICE_A));
    assert.notEqual(rateSubjectHash(a, scope), rateSubjectHash(a, scope, undefined, DEVICE_A));
    a.headers['x-price-alert-device-id'] = DEVICE_B;
    assert.equal(rateSubjectHash(a, scope), rateSubjectHash(req(), scope));
  }
  assert.equal(rateSubjectHash(a, 'account_verify', undefined, DEVICE_A), rateSubjectHash(a, 'account_verify'));
  assert.notEqual(rateSubjectHash(req('203.0.113.1'), 'payment_auth'), rateSubjectHash(req('203.0.113.2'), 'payment_auth'));
});

test('weak or missing counter validators fail closed without conditional writes', async () => {
  for (const etag of ['W/"weak"', '', 'unquoted']) {
    let writes = 0;
    await assert.rejects(consumeRateLimit(req(), 'payment_create', {
      now: 1000, authenticatedDeviceId: DEVICE_A,
      async get(_key, options) {
        assert.equal(options.headers['Accept-Encoding'], 'identity');
        return { stream: Readable.from([JSON.stringify({ version: 1, windowStartedAt: 1000, count: 1 })]), blob: { etag } };
      },
      async put() { writes++; }
    }), { code: 'rate_limit_unavailable', statusCode: 503 });
    assert.equal(writes, 0);
  }
});

function handlerHarness(file, overrides = {}) {
  const calls = [];
  const dependencies = {
    './_http': http,
    './_entitlement': entitlement,
    './_payment-service': {
      async createPayment() { calls.push('create'); return {}; },
      async reconcilePayment() { calls.push('reconcile'); return {}; }
    },
    './_portone': { configuredPortOne: () => ({}) },
    './_auth': { async authenticateDevice() { calls.push('auth'); return { created: false, record: { deviceId: DEVICE_A } }; } },
    './_account-service': { accountRecoveryEnabled: () => true, requireVerifiedAccount() { calls.push('verified'); } },
    './_limits': { async consumeRateLimit(_req, scope, options) { calls.push({ scope, ...options }); } },
    './_payment-diagnostics': { unexpectedPaymentDiagnostic: () => ({}) },
    ...overrides
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/price-alerts', file), 'utf8'), {
    module, console: { error() {} }, require(name) {
      assert.ok(dependencies[name], `Unexpected dependency ${name}`);
      return dependencies[name];
    }
  });
  const headers = {};
  const response = { setHeader(k, v) { headers[k] = v; }, end(body) { this.body = JSON.parse(body); } };
  return { calls, headers, response, handler: module.exports };
}

test('create validates auth/email before choosing a persisted device quota', async () => {
  const h = handlerHarness('payment-create.js');
  await h.handler(req(), h.response);
  assert.equal(h.response.statusCode, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ scope: 'payment_auth' }, 'auth', 'verified', { scope: 'payment_create', authenticatedDeviceId: DEVICE_A }, 'create']);
});

test('bad payload, unauthenticated and unverified requests do not spend checkout quota', async () => {
  const fixtures = [
    { request: { ...req(), body: { idempotencyKey: 'short' } }, overrides: {}, status: 400 },
    { request: req(), overrides: { './_auth': { async authenticateDevice() { throw new http.HttpError(401, 'device_auth_failed'); } } }, status: 401 },
    { request: req(), overrides: { './_account-service': { accountRecoveryEnabled: () => true, requireVerifiedAccount() { throw new http.HttpError(403, 'email_verification_required'); } } }, status: 403 }
  ];
  for (const fixture of fixtures) {
    const h = handlerHarness('payment-create.js', fixture.overrides);
    await h.handler(fixture.request, h.response);
    assert.equal(h.response.statusCode, fixture.status);
    assert.ok(!h.calls.some(value => value?.scope === 'payment_create' || value === 'create'));
  }
});

test('legacy unregistered clients cannot choose a fresh device-based checkout bucket', async () => {
  const h = handlerHarness('payment-create.js', {
    './_auth': { async authenticateDevice() { return { created: true, record: { deviceId: DEVICE_A } }; } },
    './_account-service': { accountRecoveryEnabled: () => false }
  });
  await h.handler(req(), h.response);
  assert.equal(h.response.statusCode, 200);
  assert.equal(h.calls.find(value => value?.scope === 'payment_create').authenticatedDeviceId, undefined);
});

test('completion authenticates before applying its own device quota', async () => {
  const h = handlerHarness('payment-complete.js');
  await h.handler({ ...req(), body: { paymentId: 'oypa_testpayment123456789012345' } }, h.response);
  assert.equal(h.response.statusCode, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ scope: 'payment_auth' }, 'auth', { scope: 'payment_complete', authenticatedDeviceId: DEVICE_A }, 'reconcile']);
});

test('member host no longer redirects to the retired domain and middleware gates every path', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'));
  assert.equal(config.routes, undefined, 'legacy custom routes must not run before the entry proxy');
  const redirects = config.redirects.filter(route => route.has);
  assert.deepEqual(redirects.map(route => route.has[0].value).sort(), ['www.olivestock.co.kr']);
  assert.equal(config.proxy.entrypoint, 'site-access-proxy.ts');
  assert.equal(config.proxy.matcher, undefined);
  for (const route of redirects) {
    const pattern = new RegExp('^' + route.source.replace('/:path(', '/(') + '$');
    for (const url of ['/', '/index.html', '/payment-info.html']) assert.ok(pattern.test(url));
    for (const url of ['/api/price-alerts/account', '/js/alerts.js', '/sw.js']) assert.equal(pattern.test(url), false);
    assert.equal(route.permanent, false);
    assert.equal(route.destination, 'https://olivestock.co.kr/:path');
  }
});

test('modern rewrites target generated functions and scheduled machine endpoints remain configured', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'));
  for (const action of ['create', 'complete', 'webhook']) {
    const rewrite = config.rewrites.find(route => route.source === '/api/price-alerts/payment/' + action);
    assert.equal(rewrite?.destination, '/api/price-alerts/payment-' + action);
    assert.ok(fs.existsSync(path.join(__dirname, '..', rewrite.destination + '.js')));
  }
  for (const [endpoint, schedule] of [
    ['/api/oliveyoung/hot-ranking-cron', '0 * * * *'],
    ['/api/price-alerts/hourly', '7 * * * *']
  ]) {
    const functionPath = endpoint.slice(1) + '.js';
    assert.ok(fs.existsSync(path.join(__dirname, '..', functionPath)));
    assert.equal(config.functions[functionPath].maxDuration, 800);
    assert.ok(config.crons.some(cron => cron.path === endpoint && cron.schedule === schedule));
  }
  const dataHeaders = config.headers.find(route => route.source === '/data/:path*');
  assert.ok(dataHeaders.headers.some(header => header.key === 'Cache-Control' && header.value === 'private, no-store'));
});
