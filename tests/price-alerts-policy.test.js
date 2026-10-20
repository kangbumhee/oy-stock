const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC_ROOT = path.join(__dirname, '..', 'public');

function page(name) {
  return fs.readFileSync(path.join(PUBLIC_ROOT, name), 'utf8');
}

test('payment review pages expose the verified seller identity and customer contact', () => {
  const documents = [page('index.html'), page('payment-info.html'), page('privacy.html')];
  const required = [
    '뷰티강',
    '강범희',
    '525-08-01159',
    '제2022-경기김포-1917호',
    '경기도 김포시 태장로 755',
    '031-997-1999',
    'kbhjjan@naver.com'
  ];
  documents.forEach((document) => {
    required.forEach((value) => assert.ok(document.includes(value), `missing seller field: ${value}`));
  });
});

test('one-time pass policies publish price, term, refund, privacy, and no-auto-renew terms', () => {
  const home = page('index.html');
  const payment = page('payment-info.html');
  const terms = page('terms.html');
  const privacy = page('privacy.html');
  assert.match(payment, /30,000원/);
  assert.match(payment, /30일 이용권/);
  assert.match(payment, /자동결제[^<]*아님/);
  assert.match(payment, /7일 이내/);
  assert.match(payment, /3영업일 이내/);
  assert.match(terms, /60분 주기/);
  assert.match(terms, /자동결제·자동연장되지 않습니다/);
  assert.match(privacy, /계약·청약철회[^<]*5년/);
  assert.match(privacy, /소비자 불만[^<]*3년/);
  assert.match(home, /가격 알림 30일 이용권/);
  assert.match(home, /판매가격/);
  assert.match(home, /30,000원/);
  assert.match(home, /결제일부터 30일간/);
  assert.match(home, /자동결제·자동연장 없음/);
  assert.match(home, /"price": "30000"/);
  assert.match(home, /20261020-private-entry-1/);
});

test('checkout modal links all customer policies without caching private application documents', () => {
  const alerts = page(path.join('js', 'alerts.js'));
  const serviceWorker = page('sw.js');
  ['/payment-info.html', '/terms.html', '/privacy.html'].forEach((pathname) => {
    assert.ok(alerts.includes(pathname), `checkout link missing: ${pathname}`);
  });
  assert.doesNotMatch(serviceWorker, /caches\.(?:open|match)|cache\.(?:addAll|put)|addEventListener\('fetch'/);
  ['뷰티강', '강범희', '525-08-01159', '제2022-경기김포-1917호', '031-997-1999'].forEach((value) => {
    assert.ok(alerts.includes(value), `checkout seller field missing: ${value}`);
  });
});

test('private push worker purges only prior app caches and keeps subscriptions and action handlers', async () => {
  const handlers = new Map();
  const deleted = [];
  const lifecycle = [];
  vm.runInNewContext(page('sw.js'), {
    URL, Promise, Date,
    caches: {
      keys: async () => ['olivestock-app-v20260929-national-paid-1', 'unrelated-cache'],
      delete: async (key) => { deleted.push(key); return true; }
    },
    self: {
      addEventListener: (name, handler) => handlers.set(name, handler),
      skipWaiting: async () => lifecycle.push('skipWaiting'),
      clients: { claim: async () => lifecycle.push('claim') }
    }
  });
  for (const phase of ['install', 'activate']) {
    let pending;
    handlers.get(phase)({ waitUntil(value) { pending = value; } });
    await pending;
  }
  assert.deepEqual(deleted, ['olivestock-app-v20260929-national-paid-1', 'olivestock-app-v20260929-national-paid-1']);
  assert.deepEqual(lifecycle, ['skipWaiting', 'claim']);
  assert.equal(handlers.has('fetch'), false);
  for (const name of ['message', 'push', 'notificationclick']) assert.equal(handlers.has(name), true);
  assert.doesNotMatch(page('sw.js'), /registration\.unregister\s*\(/);
  const pwa = page(path.join('js', 'pwa.js'));
  assert.match(pwa, /register\('\/sw\.js\?v=20261020-private-entry-1', \{ updateViaCache: 'none' \}\)/);
});
