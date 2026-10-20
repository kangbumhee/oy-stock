const assert = require('node:assert/strict');
const test = require('node:test');
const config = require('../reports/olivestock-domain-block-firewall-20261020.json');

function denied(url, method = 'GET') {
  const request = new URL(url);
  return config.value.conditionGroup.some(({ conditions }) => conditions.every((condition) => {
    const candidate = condition.type === 'host' ? request.hostname
      : condition.type === 'path' ? request.pathname
        : condition.type === 'method' ? method : request.searchParams.get(condition.key) || '';
    const matches = new RegExp(condition.value).test(candidate);
    return condition.neg ? !matches : matches;
  }));
}

test('public site and data are denied on both retired hosts only', () => {
  for (const host of ['olivestock.co.kr', 'www.olivestock.co.kr']) {
    for (const path of ['/', '/index.html', '/public/index.html', '/blog/test', '/js/app.js',
      '/data/stock-detail.json', '/public/data/stock-detail.json', '/admin',
      '/api/oliveyoung/search?keyword=x', '/api/oliveyoung/inventory.js',
      '/api/price-alerts/payment/create', '/?priceAlertPayment=complete']) {
      for (const method of ['GET', 'HEAD', 'POST']) assert.equal(denied(`https://${host}${path}`, method), true, `${host}${path} ${method}`);
    }
  }
  for (const host of ['oy-stock.vercel.app', 'orders.olivestock.co.kr', 'olivestock.co.kr.example.org']) {
    assert.equal(denied(`https://${host}/`), false);
  }
});

test('existing read-only machine checks are preserved without opening link issuance', () => {
  for (const host of ['olivestock.co.kr', 'www.olivestock.co.kr']) {
    const base = `https://${host}/api/oliveyoung/landing-proxy`;
    assert.equal(denied(`${base}?check=1`), false);
    assert.equal(denied(`${base}?check=true`), false);
    assert.equal(denied(base), true);
    assert.equal(denied(`${base}?check=0`), true);
    assert.equal(denied(`${base}?check=1`, 'POST'), true);
    assert.equal(denied(`https://${host}/api/oliveyoung/hot-ranking-history?size=128`), false);
  }
});

test('only existing callback/relay methods and cron paths are excluded', () => {
  for (const path of ['/api/price-alerts/payment/webhook', '/api/price-alerts/payment/complete', '/api/ph-guide']) {
    assert.equal(denied(`https://olivestock.co.kr${path}`, 'POST'), false);
    assert.equal(denied(`https://olivestock.co.kr${path}`, 'GET'), true);
    assert.equal(denied(`https://olivestock.co.kr${path}/extra`, 'POST'), true);
  }
  for (const path of ['/api/price-alerts/hourly', '/api/oliveyoung/hot-ranking-cron']) {
    assert.equal(denied(`https://olivestock.co.kr${path}`), false);
    assert.equal(denied(`https://olivestock.co.kr${path}`, 'POST'), false);
    assert.equal(denied(`https://olivestock.co.kr${path}`, 'DELETE'), true);
  }
  assert.equal(config.value.action.mitigate.actionDuration, null);
  assert.equal(config.value.action.mitigate.action, 'deny');
});
