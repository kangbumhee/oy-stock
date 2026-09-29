import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.OY_SERVER_DISABLE_START = '1';
const SECRET = 'national-access-fixture-secret-1234567890';
process.env.HIDDEN_STOCK_SERVICE_SECRET = SECRET;
const { createNationalStockHandler, server } = await import('./server.mjs');
const GOODS = 'A000000255680';
const SKU = '8800289469145';
const query = `?goodsNo=${GOODS}&productId=${SKU}`;
const calls = [];
let failLookup = false;
const payload = { success: true, goodsNo: GOODS, storeLookupStatus: 'partial', retryAfterSeconds: 30,
  options: [{ productId: SKU, stores: [{ name: 'fixture store', qty: 12 }], storeLookupStatus: 'partial' }] };
const handler = createNationalStockHandler({
  async ensureSession() { calls.push('ready'); },
  async getStockAllRegions(goodsNo, productId) {
    calls.push([goodsNo, productId]);
    if (failLookup) throw new Error(`provider failure ${SECRET}`);
    return payload;
  }
});
const isolated = http.createServer((req, res) => handler(req, res, new URL(req.url, 'http://localhost')));
await Promise.all([server, isolated].map(instance => new Promise(resolve => instance.listen(0, '127.0.0.1', resolve))));
const actualOrigin = `http://127.0.0.1:${server.address().port}`;
const fixtureOrigin = `http://127.0.0.1:${isolated.address().port}`;
test.after(async () => { await Promise.all([server, isolated].map(instance => new Promise(resolve => instance.close(resolve)))); });

function request(origin, suffix = query, options = {}) {
  const { token, ...init } = options;
  return fetch(origin + '/api/stock-all' + suffix, { ...init, headers: {
    Origin: 'https://olivestock.co.kr', ...(token ? { Authorization: `Bearer ${token}` } : {})
  } });
}

function assertPrivate(res) {
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
  assert.equal(res.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(res.headers.get('cdn-cache-control'), 'no-store');
}

test('actual Cloud Run route rejects direct browser access before public wildcard CORS', async () => {
  for (const token of [undefined, 'wrong-token']) {
    const res = await request(actualOrigin, query, { token });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { success: false, error: 'unauthorized' });
    assertPrivate(res);
  }
  const nearby = await fetch(actualOrigin + '/api/stock');
  assert.equal(nearby.status, 400);
  assert.equal(nearby.headers.get('access-control-allow-origin'), '*');
  assert.notEqual((await nearby.json()).error, 'unauthorized');
});

test('national endpoint permits GET only, including rejecting CORS preflight', async () => {
  for (const method of ['POST', 'PUT', 'OPTIONS', 'DELETE']) {
    const res = await request(actualOrigin, query, { token: SECRET, method });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET');
    assertPrivate(res);
  }
});

test('national endpoint fails closed without a configured service secret', async () => {
  const previous = process.env.HIDDEN_STOCK_SERVICE_SECRET;
  try {
    for (const secret of ['', 'short']) {
      process.env.HIDDEN_STOCK_SERVICE_SECRET = secret;
      const res = await request(actualOrigin, query, { token: secret || SECRET });
      assert.equal(res.status, 401);
      assertPrivate(res);
    }
  } finally { process.env.HIDDEN_STOCK_SERVICE_SECRET = previous; }
});

test('national query is exactly one valid goodsNo and productId with no optional all-option dump', async () => {
  const invalid = [ '', `?goodsNo=${GOODS}`, `?productId=${SKU}`, `${query}&productId=${SKU}`,
    `${query}&goodsNo=${GOODS}`, `${query}&scope=nearby`, `${query}&lat=37`,
    `?goodsNo=invalid&productId=${SKU}`, `?goodsNo=${GOODS}&productId=invalid`, `${query}&action=stores` ];
  for (const suffix of invalid) {
    const res = await request(actualOrigin, suffix, { token: SECRET });
    assert.equal(res.status, 400);
    assertPrivate(res);
    assert.match((await res.json()).error, /^invalid_(query|goods_no|product_id)$/);
  }
});

test('service-authorized national lookup preserves the selected SKU and partial response', async () => {
  const res = await request(fixtureOrigin, query, { token: SECRET });
  assert.equal(res.status, 200);
  assertPrivate(res);
  assert.equal(res.headers.get('retry-after'), '30');
  assert.deepEqual(await res.json(), payload);
  assert.deepEqual(calls, ['ready', [GOODS, SKU]]);
});

test('national transport errors never expose provider errors or service credentials', async () => {
  failLookup = true;
  try {
    const res = await request(fixtureOrigin, query, { token: SECRET });
    assert.equal(res.status, 503);
    assertPrivate(res);
    assert.equal(res.headers.get('retry-after'), '5');
    assert.deepEqual(await res.json(), { success: false, error: 'stock_unavailable' });
  } finally { failLookup = false; }
});
