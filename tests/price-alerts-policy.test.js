const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
  assert.match(home, /20260906-affiliate-popup-1/);
});

test('checkout modal links all customer policies and the service worker caches them', () => {
  const alerts = page(path.join('js', 'alerts.js'));
  const serviceWorker = page('sw.js');
  ['/payment-info.html', '/terms.html', '/privacy.html'].forEach((pathname) => {
    assert.ok(alerts.includes(pathname), `checkout link missing: ${pathname}`);
    assert.ok(serviceWorker.includes(`'${pathname}'`), `offline policy missing: ${pathname}`);
  });
  ['뷰티강', '강범희', '525-08-01159', '제2022-경기김포-1917호', '031-997-1999'].forEach((value) => {
    assert.ok(alerts.includes(value), `checkout seller field missing: ${value}`);
  });
});
