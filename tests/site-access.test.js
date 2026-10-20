const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  COOKIE_NAME,
  SESSION_SECONDS,
  configuredSiteAccess,
  createSessionToken,
  createSiteAccessHandler,
  operationalPassThrough,
  verifySessionToken
} = require('../api/_site-access');

const HOST = 'oy-stock.vercel.app';
const ORIGIN = `https://${HOST}`;
const NOW = Date.parse('2026-10-20T00:00:00Z');
// Deliberately unrelated synthetic fixture; never use a deployed promotion code.
const FIXTURE_PASSWORD = 'fixture-only-password';
const fixturePepper = 'fixture-only-pepper-32-characters';
const configuration = {
  promotion: {
    pepper: fixturePepper,
    digest: crypto.createHmac('sha256', fixturePepper).update(FIXTURE_PASSWORD).digest()
  },
  signingKey: crypto.randomBytes(32)
};

function request(path = '/', options = {}) {
  return new Request(`${ORIGIN}${path}`, options);
}

function entry(password, options = {}) {
  return request('/_entry', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...options.headers },
    body: new URLSearchParams({ password }),
    ...options
  });
}

function createHandler(overrides = {}) {
  return createSiteAccessHandler({
    configuredSiteAccess: () => configuration,
    now: () => NOW,
    consumeRateLimit: async () => {},
    ...overrides
  });
}

test('entry page contains only a password field, no app content or secrets', async () => {
  const response = await createHandler()(request('/'));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /type="password"/);
  assert.match(html, /aria-label="비밀번호"/);
  assert.doesNotMatch(html, /<button|<h[1-6]|올리브|상품|재고|회원|fixture-only|signingKey/);
  assert.match(html, /caches\.delete/);
  assert.match(html, /olivestock-app-/);
  assert.doesNotMatch(html, /\.unregister\(/);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(response.headers.get('content-security-policy'), /form-action 'self'/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  // Chrome can send Origin:null on POST forms when policy is no-referrer.
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
});

test('valid password sets a secure session cookie and redirects without leaking password', async () => {
  const calls = [];
  const handler = createHandler({ consumeRateLimit: async (req, scope) => calls.push(scope) });
  const response = await handler(entry(FIXTURE_PASSWORD));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/');
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^__Host-oy-entry=/);
  assert.match(cookie, /Path=\/; HttpOnly; Secure; SameSite=Strict$/);
  assert.doesNotMatch(cookie, /Max-Age|Expires|fixture-only/);
  assert.deepEqual(calls, ['site_entry']);
  assert.equal(await handler(request('/api/oliveyoung/search?keyword=test', {
    headers: { cookie: cookie.split(';')[0] }
  })), null);
});

test('wrong password is denied after a rate-limit check', async () => {
  let checks = 0;
  const response = await createHandler({ consumeRateLimit: async () => checks++ })(entry('incorrect-password'));
  assert.equal(response.status, 401);
  assert.equal(checks, 1);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(await response.text(), /비밀번호를 확인해 주세요/);
});

test('entry quota cannot be split by a client supplied forwarded host', async () => {
  let actualHeaders;
  const handler = createHandler({ consumeRateLimit: async (req) => { actualHeaders = req.headers; } });
  await handler(entry('incorrect-password', { headers: {
    origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded',
    'x-forwarded-host': 'attacker.example'
  } }));
  assert.equal(actualHeaders.host, HOST);
  assert.equal(actualHeaders['x-forwarded-host'], HOST);
});

test('token checks expiry, host, tampering, malformed cookies and rotation', async () => {
  const token = createSessionToken(HOST, configuration, NOW);
  assert.equal(verifySessionToken(token, HOST, configuration, NOW), true);
  assert.equal(verifySessionToken(token, HOST, configuration, NOW + SESSION_SECONDS * 1000), false);
  assert.equal(verifySessionToken(token, 'another.vercel.app', configuration, NOW), false);
  assert.equal(verifySessionToken(`${token.slice(0, -2)}aa`, HOST, configuration, NOW), false);
  assert.equal(verifySessionToken(token, HOST, { ...configuration, signingKey: crypto.randomBytes(32) }, NOW), false);
  assert.equal(verifySessionToken(token, HOST, null, NOW), false);
  assert.equal(verifySessionToken('garbage', HOST, configuration, NOW), false);
  const response = await createHandler()(request('/api/oliveyoung/search', {
    headers: { cookie: `${COOKIE_NAME}=${token}; ${COOKIE_NAME}=duplicate` }
  }));
  assert.equal(response.status, 401);
});

test('all inventory, API and raw alias paths deny unauthenticated access', async () => {
  const handler = createHandler();
  for (const path of [
    '/api/oliveyoung/search', '/api/oliveyoung/inventory.js',
    '/api/oliveyoung/landing-proxy', '/api/oliveyoung/landing-proxy.js?check=0',
    '/api/price-alerts/payment-webhook.js', '/api/_site-access.js',
    '/data/stock-detail.json', '/public/data/stock-detail.json',
    '/js/app.js', '/public/js/app.js', '/css/style.css'
  ]) {
    const response = await handler(request(path));
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), { success: false, error: 'site_access_required' });
  }
  const response = await handler(request('/public/index.html'));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /type="password"/);
});

test('only exact operational methods and safe health queries pass through', async () => {
  for (const [path, method] of [
    ['/api/oliveyoung/landing-proxy?check=1', 'GET'],
    ['/api/oliveyoung/landing-proxy.js?check=true', 'GET'],
    ['/api/oliveyoung/landing-proxy?check=true', 'HEAD'],
    ['/api/oliveyoung/hot-ranking-history', 'GET'],
    ['/api/oliveyoung/hot-ranking-history.js', 'HEAD'],
    ['/api/oliveyoung/hot-ranking-cron', 'POST'],
    ['/api/price-alerts/hourly', 'GET'],
    ['/api/price-alerts/payment/webhook', 'POST'],
    ['/api/price-alerts/payment/complete', 'POST'],
    ['/api/ph-guide', 'POST'], ['/sw.js', 'GET'], ['/public/sw.js', 'HEAD']
  ]) {
    assert.equal(operationalPassThrough(request(path, { method })), true, `${method} ${path}`);
    assert.equal(await createHandler()(request(path, { method })), null);
  }
  for (const [path, method] of [
    ['/api/oliveyoung/landing-proxy?check=1', 'POST'],
    ['/api/oliveyoung/hot-ranking-history', 'POST'],
    ['/api/price-alerts/payment/webhook', 'GET'],
    ['/api/ph-guide', 'GET'], ['/public/sw.js/extra', 'GET'],
    ['/api/price-alerts/hourly/extra', 'GET']
  ]) assert.equal(operationalPassThrough(request(path, { method })), false, `${method} ${path}`);
});

test('cross-origin, missing-origin and unexpected entry methods fail closed', async () => {
  const handler = createHandler();
  assert.equal((await handler(entry(FIXTURE_PASSWORD, {
    headers: { origin: 'https://other.example', 'content-type': 'application/x-www-form-urlencoded' }
  }))).status, 403);
  assert.equal((await handler(request('/_entry', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=x'
  }))).status, 403);
  assert.equal((await handler(request('/_entry'))).status, 405);
  assert.equal((await handler(entry(FIXTURE_PASSWORD, {
    headers: { origin: ORIGIN, 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' }
  }))).status, 403);
});

test('body limits, malformed form and wrong content type never establish access', async () => {
  const handler = createHandler();
  for (const [body, contentType, status] of [
    ['password=' + 'a'.repeat(3000), 'application/x-www-form-urlencoded', 413],
    ['password=a&password=b', 'application/x-www-form-urlencoded', 400],
    ['{"password":"x"}', 'application/json', 415]
  ]) {
    const response = await handler(request('/_entry', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': contentType }, body
    }));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('rate-limit and storage failure fail closed with generic messages', async () => {
  for (const [error, status] of [
    [{ statusCode: 429, retryAfter: 120 }, 429],
    [new Error('private storage configuration details'), 503]
  ]) {
    const response = await createHandler({ consumeRateLimit: async () => { throw error; } })(entry(FIXTURE_PASSWORD));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.doesNotMatch(await response.text(), /private storage|fixture-only/);
  }
});

test('missing configuration denies entry and data but preserves operational jobs', async () => {
  const handler = createHandler({ configuredSiteAccess: () => null });
  assert.equal((await handler(request('/'))).status, 503);
  assert.equal((await handler(request('/data/stock-detail.json'))).status, 503);
  assert.equal((await handler(entry(FIXTURE_PASSWORD))).status, 503);
  assert.equal(await handler(request('/api/oliveyoung/landing-proxy?check=1')), null);
});

test('logout is same-origin POST only and expires the host-only cookie', async () => {
  const handler = createHandler();
  assert.equal((await handler(request('/_entry/logout'))).status, 405);
  assert.equal((await handler(request('/_entry/logout', { method: 'POST' }))).status, 403);
  const response = await handler(request('/_entry/logout', { method: 'POST', headers: { origin: ORIGIN } }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0$/);
});

test('production configuration derives a purpose-specific key from existing promo settings', () => {
  const oldPepper = process.env.PRICE_ALERT_PROMO_CODE_PEPPER;
  const oldDigest = process.env.PRICE_ALERT_PROMO_CODE_DIGEST;
  try {
    process.env.PRICE_ALERT_PROMO_CODE_PEPPER = fixturePepper;
    process.env.PRICE_ALERT_PROMO_CODE_DIGEST = configuration.promotion.digest.toString('hex');
    const config = configuredSiteAccess();
    assert.equal(config.signingKey.length, 32);
    assert.notDeepEqual(config.signingKey, config.promotion.digest);
    assert.equal(verifySessionToken(createSessionToken(HOST, config, NOW), HOST, config, NOW), true);
    process.env.PRICE_ALERT_PROMO_CODE_PEPPER = '';
    assert.equal(configuredSiteAccess(), null);
  } finally {
    if (oldPepper == null) delete process.env.PRICE_ALERT_PROMO_CODE_PEPPER;
    else process.env.PRICE_ALERT_PROMO_CODE_PEPPER = oldPepper;
    if (oldDigest == null) delete process.env.PRICE_ALERT_PROMO_CODE_DIGEST;
    else process.env.PRICE_ALERT_PROMO_CODE_DIGEST = oldDigest;
  }
});
