const test = require('node:test');
const assert = require('node:assert/strict');
const landing = require('../api/oliveyoung/landing-proxy');
const shorten = require('../api/oliveyoung/shorten-proxy');
const queue = require('../api/oliveyoung/curator-queue');
const redirect = require('../api/oliveyoung/curator-redirect');
const proxy = require('../api/proxy');
const { getOfficialCookieHeader } = require('../api/oliveyoung/search')._test;

function response() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body = '') { this.body = body; }
  };
}

test('removed landing, shortener and queue APIs do no provider or workflow work', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => { calls++; throw new Error('unexpected upstream call'); });
  for (const handler of [landing, shorten, queue]) {
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      const res = response();
      await handler({ method, query: { check: '1', goodsNo: 'A000000171423' }, body: { goodsNo: 'A000000171423' } }, res);
      assert.equal(res.statusCode, 410);
      assert.match(res.headers['cache-control'], /no-store/);
      assert.deepEqual(JSON.parse(res.body), {
        success: false, removed: true, error: 'curator_link_generation_removed'
      });
    }
  }
  assert.equal(calls, 0);
});

test('legacy purchase bookmark opens only the ordinary official product and ignores old tracking input', async (t) => {
  t.mock.method(global, 'fetch', async () => { throw new Error('unexpected upstream call'); });
  const res = response();
  await redirect({ method: 'GET', query: {
    goodsNo: 'a000000171423', direct: '1', url: 'https://attacker.example/',
    affiliateActivityId: 'old-fixture', affiliatePartnerId: 'old-partner'
  } }, res);
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location,
    'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=A000000171423');
  assert.doesNotMatch(res.headers.location, /utm_|affiliate|oy\.run/);
  for (const query of [{ resolve: '1' }, { check: '1' }, { format: 'json' }, { format: 'debug' }]) {
    const disabled = response();
    await redirect({ method: 'GET', query: { ...query, goodsNo: 'A000000171423' } }, disabled);
    assert.equal(disabled.statusCode, 410);
  }
  const invalid = response();
  await redirect({ method: 'GET', query: { goodsNo: 'https://attacker.example/' } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.headers.location, undefined);
});

test('generic proxy cannot reintroduce removed curator APIs', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => { calls++; throw new Error('unexpected upstream call'); });
  for (const path of [
    '/api/oliveyoung/landing-proxy', '/api/oliveyoung/shorten-proxy',
    '/api/oliveyoung/curator-queue', '/api/oliveyoung/curator-redirect',
    '/api/oliveyoung/%63urator-queue', '/api/oliveyoung/x/../landing-proxy.js'
  ]) {
    const res = response();
    await proxy({ method: 'GET', query: { path } }, res);
    assert.equal(res.statusCode, 410, path);
  }
  assert.equal(calls, 0);
});

test('public search does not reuse the removed curator account cookie', () => {
  const names = ['OY_REFRESH_COOKIE', 'OY_CURATOR_COOKIE', 'OLIVEYOUNG_SEARCH_COOKIE'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.OY_REFRESH_COOKIE = 'fixture-curator-cookie';
    process.env.OY_CURATOR_COOKIE = 'fixture-old-curator-cookie';
    delete process.env.OLIVEYOUNG_SEARCH_COOKIE;
    assert.equal(getOfficialCookieHeader(), '');
    process.env.OLIVEYOUNG_SEARCH_COOKIE = 'fixture-public-search-cookie';
    assert.equal(getOfficialCookieHeader(), 'fixture-public-search-cookie');
  } finally {
    for (const name of names) {
      if (saved[name] == null) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
