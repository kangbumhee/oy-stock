const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  COOKIE_NAME, DEFAULT_PUBLIC_SITE_URL, configuredPublicSiteOrigin,
  createSessionToken, createSiteAccessHandler, retiredServicePassThrough
} = require('../api/_site-access');

const ORIGIN = 'https://oyb8.vercel.app';
const NOW = Date.parse('2026-11-16T00:00:00Z');
const retiredHosts = ['oy-stock.vercel.app', 'olivestock.co.kr', 'www.olivestock.co.kr'];
const otherAliases = ['oy-stock-kbhs-projects-ee1427b6.vercel.app', 'oy-stock-unique-deployment.vercel.app', 'unknown.example'];
const configuration = { promotion: {}, signingKey: crypto.randomBytes(32) };

function handler(overrides = {}) {
  return createSiteAccessHandler({
    configuredPublicSiteOrigin: () => ORIGIN,
    configuredSiteAccess: () => configuration,
    consumeRateLimit: async () => { throw new Error('Closure must not consume entry quota'); },
    allowLocalhost: false, now: () => NOW, ...overrides
  });
}

test('public origin is HTTPS-only, exact and fails closed for invalid or retired configuration', () => {
  assert.equal(DEFAULT_PUBLIC_SITE_URL, ORIGIN);
  assert.equal(configuredPublicSiteOrigin({}), ORIGIN);
  assert.equal(configuredPublicSiteOrigin({ OY_PUBLIC_SITE_URL: ' HTTPS://OYB8.VERCEL.APP/ ' }), ORIGIN);
  assert.equal(configuredPublicSiteOrigin({ OY_PUBLIC_SITE_URL: 'https://replacement.example' }), 'https://replacement.example');
  for (const value of ['', 'http://oyb8.vercel.app', 'https://oyb8.vercel.app/path',
    'https://user:pass@oyb8.vercel.app', 'https://oyb8.vercel.app?x=1', 'https://oyb8.vercel.app#x',
    'https://oyb8.vercel.app:8443', 'https://localhost', 'https://127.0.0.1', 'https://[::1]',
    ...retiredHosts.map(host => `https://${host}`)]) {
    assert.equal(configuredPublicSiteOrigin({ OY_PUBLIC_SITE_URL: value }), null, value);
  }
});

test('retired, previous project, unique and unknown aliases close every public route before auth', async () => {
  const close = handler({ configuredSiteAccess: () => { throw new Error('Entry configuration must not be read'); } });
  for (const host of [...retiredHosts, ...otherAliases]) {
    for (const path of ['/', '/index.html', '/public/index.html', '/en', '/service-status', '/service-status.html',
      '/js/app.js', '/css/style.css', '/data/stock-detail.json', '/public/data/stock-detail.json',
      '/api/oliveyoung/search', '/api/oliveyoung/hidden-stock', '/api/price-alerts/account',
      '/api/oliveyoung/hot-ranking-history', '/api/oliveyoung/hot-ranking-history.js',
      '/api/oliveyoung/landing-proxy?check=1', '/sw.js', '/public/sw.js', '/_entry', '/_entry/logout']) {
      const response = await close(new Request(`https://${host}${path}`));
      assert.equal(response.status, 410, `${host}${path}`);
      assert.equal(response.headers.get('location'), null);
      assert.match(response.headers.get('content-type'), /^text\/html/);
    }
  }
});

test('closure is immutable by entry cookie, request method or spoofed forwarding headers', async () => {
  const close = handler();
  for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS', 'PUT', 'DELETE']) {
    const token = createSessionToken('oy-stock.vercel.app', configuration, NOW);
    const response = await close(new Request('https://oy-stock.vercel.app/_entry', {
      method, headers: { cookie: `${COOKIE_NAME}=${token}`, origin: ORIGIN, host: 'oyb8.vercel.app', 'x-forwarded-host': 'oyb8.vercel.app' }
    }));
    assert.equal(response.status, 410, method);
    const body = await response.text();
    if (method === 'HEAD') assert.equal(body, '');
    else {
      assert.match(body, /사이트 운영 종료/);
      assert.doesNotMatch(body, /oyb8|vercel\.app|https?:|<form|<input|password|stock-detail/);
    }
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
    assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('only HTTPS canonical host retains the password gate and valid host-bound entry session', async () => {
  const access = handler();
  const gate = await access(new Request(`${ORIGIN}/`));
  assert.equal(gate.status, 200);
  assert.match(await gate.text(), /type="password"/);
  assert.equal((await access(new Request(`${ORIGIN}/api/oliveyoung/search`))).status, 401);
  const token = createSessionToken('oyb8.vercel.app', configuration, NOW);
  assert.equal(await access(new Request(`${ORIGIN}/api/oliveyoung/search`, { headers: { cookie: `${COOKIE_NAME}=${token}` } })), null);
  for (const url of ['http://oyb8.vercel.app/', 'https://oyb8.vercel.app:8443/', 'http://oy-stock.vercel.app/']) {
    assert.equal((await access(new Request(url))).status, 410, url);
  }
});

test('invalid canonical configuration closes every host rather than weakening the gate', async () => {
  const close = handler({ configuredPublicSiteOrigin: () => null });
  assert.equal((await close(new Request(`${ORIGIN}/`))).status, 410);
  assert.equal((await close(new Request('https://unknown.example/'))).status, 410);
});

test('public service-status is exact, read-only and canonical-host-only', async () => {
  const access = handler({ configuredSiteAccess: () => { throw new Error('Public status must not depend on entry secrets'); } });
  for (const method of ['GET', 'HEAD']) assert.equal(await access(new Request(`${ORIGIN}/service-status`, { method })), null);
  const gated = handler();
  for (const path of ['/service-status/', '/service-status.html', '/public/service-status.html', '/service-status/anything']) {
    assert.notEqual(await gated(new Request(`${ORIGIN}${path}`)), null, path);
  }
  assert.notEqual(await gated(new Request(`${ORIGIN}/service-status`, { method: 'POST' })), null);
  for (const host of [...retiredHosts, ...otherAliases]) {
    assert.equal((await access(new Request(`https://${host}/service-status`))).status, 410);
  }
});

test('retired hosts pass only exact POST payment callbacks and the authenticated Pro Route relay', async () => {
  const access = handler({ configuredSiteAccess: () => { throw new Error('Existing server callbacks keep their own authentication'); } });
  const paths = ['/api/price-alerts/payment/webhook', '/api/price-alerts/payment/complete',
    '/api/price-alerts/payment-webhook', '/api/price-alerts/payment-complete', '/api/ph-guide'];
  for (const host of retiredHosts) {
    for (const path of paths.flatMap(path => [path, `${path}.js`])) {
      assert.equal(await access(new Request(`https://${host}${path}`, { method: 'POST' })), null, `${host}${path}`);
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        assert.equal((await access(new Request(`https://${host}${path}`, { method }))).status, 410);
      }
    }
    for (const path of ['/api/price-alerts/payment/create', '/api/ph-guide/', '/api/ph-guide/status',
      '/api/price-alerts/payment/webhook/extra', '/api/price-alerts/payment-webhookx', '/api%2Fph-guide']) {
      assert.equal((await access(new Request(`https://${host}${path}`, { method: 'POST' }))).status, 410, path);
    }
  }
  for (const host of otherAliases) assert.equal((await access(new Request(`https://${host}/api/ph-guide`, { method: 'POST' }))).status, 410);
  assert.equal((await access(new Request('https://oy-stock.vercel.app:8443/api/ph-guide', { method: 'POST' }))).status, 410);
});

test('old cron callbacks require an exact configured server Bearer token, never a query fallback', async () => {
  const env = { CRON_SECRET: 'synthetic-cron-fixture' };
  const access = handler({ retiredServicePassThrough: (req, url) => retiredServicePassThrough(req, url, env) });
  for (const host of retiredHosts) {
    for (const path of ['/api/oliveyoung/hot-ranking-cron', '/api/price-alerts/hourly']) {
      for (const method of ['GET', 'POST']) assert.equal(await access(new Request(`https://${host}${path}`, {
        method, headers: { authorization: `Bearer ${env.CRON_SECRET}` }
      })), null);
      for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: env.CRON_SECRET }]) {
        assert.equal((await access(new Request(`https://${host}${path}?secret=${env.CRON_SECRET}`, { headers }))).status, 410);
      }
      assert.equal((await access(new Request(`https://${host}${path}`, {
        method: 'HEAD', headers: { authorization: `Bearer ${env.CRON_SECRET}` }
      }))).status, 410);
      assert.equal(retiredServicePassThrough(new Request(`https://${host}${path}`, {
        headers: { authorization: 'Bearer anything' }
      }), undefined, {}), false);
    }
  }
});

test('localhost is an explicit development-only allowance and never opens arbitrary aliases', async () => {
  const dev = handler({ allowLocalhost: true });
  for (const host of ['localhost:4100', '127.0.0.1:4100', '[::1]:4100']) {
    assert.equal((await dev(new Request(`http://${host}/`))).status, 200);
    assert.equal((await handler()(new Request(`http://${host}/`))).status, 410);
  }
  assert.equal((await dev(new Request('http://unknown.example/'))).status, 410);
});
