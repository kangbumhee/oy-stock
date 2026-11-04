const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { sendRankingResponse } = require('../api/oliveyoung/_ranking-response');

function response() {
  return {
    headers: {},
    statusCode: null,
    body: undefined,
    ended: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; },
    end() { this.ended = true; }
  };
}

test('ranking response validates its complete content and accepts weak/strong validators', () => {
  const body = { success: true, data: { updatedAt: 'fixed', dailyEstimatedSales: 12 } };
  const first = response();
  first.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
  sendRankingResponse({ headers: {} }, first, body);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body, body);
  assert.match(first.headers.etag, /^W\/"oy-ranking-[\w-]+"$/);
  assert.equal(first.headers['cache-control'], 'public, s-maxage=300, stale-while-revalidate=3600');

  for (const value of [first.headers.etag, first.headers.etag.slice(2), '"other", ' + first.headers.etag, '*']) {
    const next = response();
    sendRankingResponse({ headers: { 'if-none-match': value } }, next, body);
    assert.equal(next.statusCode, 304);
    assert.equal(next.body, undefined);
    assert.equal(next.ended, true);
    assert.equal(next.headers.etag, first.headers.etag);
  }

  const changed = response();
  sendRankingResponse({ headers: { 'if-none-match': first.headers.etag } }, changed, {
    success: true, data: { updatedAt: 'fixed', dailyEstimatedSales: 13 }
  });
  assert.equal(changed.statusCode, 200, 'rolling-window change must not be hidden by a fixed store timestamp');
  assert.notEqual(changed.headers.etag, first.headers.etag);
});

function loadHandler(stubs) {
  const file = path.resolve(__dirname, '../api/oliveyoung/hot-ranking-history.js');
  const compiled = new Module(file, module);
  compiled.filename = file;
  compiled.paths = Module._nodeModulePaths(path.dirname(file));
  compiled.require = function (id) {
    return id === './_hot-ranking-store' ? stubs : Module.prototype.require.call(this, id);
  };
  compiled._compile(fs.readFileSync(file, 'utf8'), file);
  return compiled.exports;
}

test('history still calculates requested and daily windows before validating the response', async () => {
  const oldToken = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = 'test-only-placeholder';
  const calls = [];
  let readCode = 200;
  const product = { goodsNo: 'A', rank: 1, goodsName: '상품', price: 1000 };
  const store = {
    updatedAt: '2026-11-04T00:00:00.000Z',
    lastRunAt: '2026-11-04T00:00:00.000Z',
    products: { A: product },
    runs: [],
    rankings: { global: { products: [product] }, categories: { '10000010001': { updatedAt: 'fixed', products: [product] } } }
  };
  const handler = loadHandler({
    readStore: async (opts) => {
      if (opts && opts.onRead) opts.onRead({ statusCode: readCode, bodyBytes: readCode === 304 ? 0 : 100 });
      return store;
    },
    computeEstimates: (_, opts) => {
      const hours = opts.windowMs / 3600000;
      calls.push({ hours, points: opts.maxChartPoints });
      return [{ goodsNo: 'A', dailyEstimatedSales: hours, dailyEstimatedRevenue: hours * 1000, windowEstimatedSales: hours, viewChart: [], salesChart: [], revenueChart: [] }];
    },
    fetchViewRanking: async () => { throw new Error('Unexpected live fallback'); }
  });
  try {
    for (const [range, hours, points] of [['1d', 24, 36], ['7d', 168, 48], ['30d', 720, 60]]) {
      calls.length = 0;
      const first = response();
      await handler({ method: 'GET', headers: {}, query: { size: '1', range, category: '10000010001' } }, first);
      assert.equal(first.statusCode, 200);
      assert.equal(first.body.data.estimates.A.windowEstimatedSales, hours);
      assert.equal(first.body.data.estimates.A.dailyEstimatedSales, 24);
      assert.deepEqual(calls, hours === 24 ? [{ hours, points }] : [{ hours, points }, { hours: 24, points: 36 }]);
      assert.equal(first.headers['x-oy-ranking-store'], 'downloaded');
      assert.equal(first.headers['cache-control'], 'public, s-maxage=300, stale-while-revalidate=3600');

      calls.length = 0;
      readCode = 304;
      const next = response();
      await handler({ method: 'GET', headers: { 'if-none-match': first.headers.etag }, query: { size: '1', range, category: '10000010001' } }, next);
      assert.equal(next.statusCode, 304);
      assert.ok(calls.length > 0, 'a validator must not skip current-time statistics');
      assert.equal(next.body, undefined);
      assert.equal(next.headers['x-oy-ranking-store'], 'revalidated');
      readCode = 200;
    }
    const custom = response();
    await handler({ method: 'GET', headers: {}, query: { size: '1', hours: '5' } }, custom);
    assert.equal(custom.body.data.range, 'custom');
    assert.equal(custom.body.data.windowHours, 5);
    assert.equal(custom.body.data.estimates.A.dailyEstimatedSales, 24);
  } finally {
    if (oldToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = oldToken;
  }
});
