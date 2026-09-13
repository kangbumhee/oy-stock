import test from 'node:test';
import assert from 'node:assert/strict';
import { createHiddenStockService, authorizedHiddenService } from './hidden-stock-service.mjs';
import { createHiddenIndexStore, emptyHiddenIndex, mergeDiscovery } from './hidden-stock-index.mjs';
import { backfillConfig, runBackfill } from '../scripts/backfill-hidden-stock.mjs';
import { createHiddenOptionDiscovery } from './hidden-option-discovery.mjs';

const SECRET = 'test-secret-not-for-deployment-1234567890';
const GOODS = 'A000000255680';
const SKU = '8800289469145';
let clock = Date.parse('2026-09-13T03:00:00Z');
const result = (complete = true, hidden = true) => ({ options: [
  { goodsNo: GOODS, optionNumber: '001', productId: SKU, hidden, name: '한교동 테스트 옵션', goodsName: '테스트 미스트', evidence: [{ source: 'private-index-only' }] }
], relatedGoodsNos: [], coverage: { complete, reason: complete ? '' : 'review_unavailable' } });
function memoryIndex(seed = emptyHiddenIndex()) {
  let value = structuredClone(seed), etag = 1;
  return createHiddenIndexStore({ now: () => ++clock,
    read: async () => ({ value: structuredClone(value), etag: String(etag) }),
    write: async (next, expected) => { assert.equal(expected, String(etag)); value = structuredClone(next); etag++; }
  });
}
async function invoke(handler, url, { authorization = `Bearer ${SECRET}`, method = 'GET' } = {}) {
  const headers = {};
  const res = { setHeader: (key, value) => { headers[key] = value; }, removeHeader: key => { delete headers[key]; },
    end: raw => { res.data = JSON.parse(raw); } };
  await handler({ method, url, headers: { authorization } }, res);
  return { status: res.statusCode, headers, data: res.data };
}

test('internal route rejects absent, wrong and unicode bearer before any index/upstream access', async () => {
  const fail = () => { throw new Error('must not be reached'); };
  const handler = createHiddenStockService({ secret: () => SECRET, request: fail, index: { read: fail } });
  for (const authorization of ['', 'Bearer bad', `Bearer ${'é'.repeat(SECRET.length)}`]) {
    const res = await invoke(handler, '/api/hidden-stock?action=options&goodsNo=' + GOODS, { authorization });
    assert.equal(res.status, 401);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
  }
  assert.equal(authorizedHiddenService({ headers: {} }, ''), false);
});

test('paid options expose only verified hidden rows and omit evidence/private aliases', async () => {
  const handler = createHiddenStockService({ secret: () => SECRET, index: memoryIndex(), now: () => ++clock,
    request: async () => ({}), discoveryFactory: () => async () => result() });
  const res = await invoke(handler, '/api/hidden-stock?action=options&goodsNo=' + GOODS);
  assert.equal(res.status, 200);
  assert.equal(res.data.options.length, 1);
  assert.equal(res.data.options[0].productId, SKU);
  assert.equal(res.data.options[0].evidence, undefined);
  assert.equal(res.data.options[0].price, undefined);
});

test('scan resumes each parent, checkpoints next page, and retries unresolved products', async () => {
  const index = memoryIndex();
  let complete = false;
  const handler = createHiddenStockService({ secret: () => SECRET, index, now: () => ++clock,
    request: async ({ body }) => ({ status: 'SUCCESS', data: { serachList: [{ goodsNumber: GOODS }], nextPage: false, totalCount: 1 } }),
    discoveryFactory: () => async () => result(complete) });
  let res = await invoke(handler, '/api/hidden-stock?action=scan', { method: 'POST' });
  assert.equal(res.data.scan.enumerationComplete, true);
  assert.equal(res.data.scan.complete, false);
  assert.equal(res.data.scan.processed, 1);
  assert.equal(Object.keys(res.data.scan.failures).length, 1);
  complete = true;
  res = await invoke(handler, '/api/hidden-stock?action=scan', { method: 'POST' });
  assert.equal(res.data.scan.complete, true);
  assert.equal(res.data.scan.retryAttempts, 1);
  assert.equal(res.data.coverage.allPhysicalInventoryGuaranteed, false);
});

test('catalog failure is unavailable, never full enumeration complete', async () => {
  const index = memoryIndex();
  const handler = createHiddenStockService({ secret: () => SECRET, index, request: async () => ({ status: 'FAIL' }) });
  const res = await invoke(handler, '/api/hidden-stock?action=scan', { method: 'POST' });
  assert.equal(res.status, 503);
  assert.equal((await index.read()).scan.complete, false);
});

test('hidden-only keyword is searchable from the private index when current online search is empty', async () => {
  const seed = emptyHiddenIndex();
  mergeDiscovery(seed, GOODS, result(), clock);
  const handler = createHiddenStockService({ secret: () => SECRET, index: memoryIndex(seed), now: () => ++clock,
    request: async () => ({ status: 'SUCCESS', data: { serachList: [], nextPage: false, totalCount: 0 } }) });
  const res = await invoke(handler, '/api/hidden-stock?action=search&keyword=' + encodeURIComponent('한교동'));
  assert.equal(res.status, 200);
  assert.equal(res.data.options[0].productId, SKU);
  assert.equal(res.data.coverage.complete, false);
  assert.equal(res.data.coverage.queryDiscoveryComplete, true);
});

test('changed index restarts result paging so a newly inserted earlier key cannot be missed', async () => {
  const seed = emptyHiddenIndex();
  for (let i = 1; i <= 35; i++) {
    const id = 'A' + String(i).padStart(12, '0');
    const r = result(); r.options[0].goodsNo = id;
    mergeDiscovery(seed, id, r, clock);
  }
  const index = memoryIndex(seed);
  const handler = createHiddenStockService({ secret: () => SECRET, index, now: () => ++clock,
    request: async () => ({ status: 'SUCCESS', data: { serachList: [], nextPage: false, totalCount: 0 } }) });
  const first = await invoke(handler, '/api/hidden-stock?action=search&keyword=한교동');
  assert.equal(first.data.options.length, 30);
  assert.ok(first.data.nextCursor);
  await index.mutate(value => { const r = result(); r.options[0].goodsNo = 'A000000000000'; mergeDiscovery(value, r.options[0].goodsNo, r, ++clock); });
  const next = await invoke(handler, '/api/hidden-stock?action=search&keyword=한교동&cursor=' + first.data.nextCursor);
  assert.equal(next.data.options[0].goodsNo, 'A000000000000');
});

test('stores validates identity, allows verified normal options, and does not turn missing quantity into zero', async () => {
  const seed = emptyHiddenIndex(); mergeDiscovery(seed, GOODS, result(true, false), clock);
  let stockCalls = 0;
  const handler = createHiddenStockService({ secret: () => SECRET, index: memoryIndex(seed), now: () => ++clock,
    discoveryFactory: () => async () => result(true, false),
    request: async ({ path }) => { assert.match(path, /stock-stores$/); stockCalls++;
      return { status: 'SUCCESS', data: { stockDisplayYn: true, storeList: stockCalls === 1 ? [{ storeCode: 'test1', storeName: '테스트점', remainQuantity: null }] : [] } }; } });
  const invalid = await invoke(handler, `/api/hidden-stock?action=stores&goodsNo=${GOODS}&productId=1234567890`);
  assert.equal(invalid.status, 404); assert.equal(stockCalls, 0);
  const valid = await invoke(handler, `/api/hidden-stock?action=stores&goodsNo=${GOODS}&productId=${SKU}`);
  assert.equal(valid.status, 200); assert.equal(valid.data.stores[0].qty, null);
  assert.equal(valid.data.option.hidden, false); assert.ok(valid.data.nextCursor);
});

test('partial discovery is briefly cached so store pages do not repeatedly crawl reviews', async () => {
  const seed = emptyHiddenIndex(); mergeDiscovery(seed, GOODS, result(false), clock);
  let discoveries = 0;
  const handler = createHiddenStockService({ secret: () => SECRET, index: memoryIndex(seed), now: () => ++clock,
    discoveryFactory: () => async () => { discoveries++; return result(false); },
    request: async () => ({ status: 'SUCCESS', data: { stockDisplayYn: true, storeList: [] } }) });
  const res = await invoke(handler, `/api/hidden-stock?action=stores&goodsNo=${GOODS}&productId=${SKU}`);
  assert.equal(res.status, 200); assert.equal(discoveries, 0);
  clock += 60001;
  await invoke(handler, `/api/hidden-stock?action=options&goodsNo=${GOODS}`);
  assert.equal(discoveries, 1);
});

test('backfill CLI bounds work, avoids redirecting bearer and reports no credentials', async () => {
  const config = backfillConfig(['--steps', '2', '--refresh'], { HIDDEN_STOCK_SERVICE_SECRET: SECRET });
  const calls = [], logs = [];
  const out = await runBackfill(config, { fetchImpl: async (url, opts) => {
    calls.push({ url: String(url), opts });
    return { ok: true, text: async () => JSON.stringify({ success: true, scan: { processed: calls.length } }) };
  }, pause: async () => {}, report: message => logs.push(message) });
  assert.equal(out.complete, false); assert.equal(calls.length, 2);
  assert.match(calls[0].url, /refresh=1/); assert.doesNotMatch(calls[1].url, /refresh=/);
  assert.equal(calls[0].opts.redirect, 'error'); assert.ok(logs.every(line => !line.includes(SECRET)));
  assert.throws(() => backfillConfig(['--steps', '1001'], { HIDDEN_STOCK_SERVICE_SECRET: SECRET }));
  assert.throws(() => backfillConfig([], { HIDDEN_STOCK_SERVICE_SECRET: SECRET, HIDDEN_STOCK_SERVICE_URL: 'https://evil.example' }));
});

test('scheduled collect is service-only, status is read-only and search reports collection progress', async () => {
  const documents = new Map();
  let revision = 0;
  const index = createHiddenIndexStore({ now: () => ++clock,
    readDocument: async path => structuredClone(documents.get(path) || { value: null, etag: null }),
    writeDocument: async (path, value, expected) => {
      assert.equal(expected, documents.get(path)?.etag || null);
      const etag = String(++revision);
      documents.set(path, { value: structuredClone(value), etag });
      return { etag };
    }
  });
  let requests = 0;
  const handler = createHiddenStockService({ secret: () => SECRET, index, now: () => ++clock,
    request: async () => { requests++; return { status: 'SUCCESS', data: { serachList: [{ goodsNumber: GOODS }], nextPage: false, totalCount: 1 } }; },
    discoveryFactory: () => async () => result() });
  for (const action of ['status', 'collect']) {
    const denied = await invoke(handler, '/api/hidden-stock?action=' + action, { authorization: '', method: action === 'collect' ? 'POST' : 'GET' });
    assert.equal(denied.status, 401);
  }
  assert.equal(requests, 0);
  const before = await invoke(handler, '/api/hidden-stock?action=status');
  assert.equal(before.status, 200); assert.equal(before.data.collection.checkedProducts, 0);
  assert.equal(requests, 0);
  const collected = await invoke(handler, '/api/hidden-stock?action=collect', { method: 'POST' });
  assert.equal(collected.status, 200); assert.equal(collected.data.collection.checkedProducts, 1);
  const searched = await invoke(handler, '/api/hidden-stock?action=search&keyword=한교동');
  assert.equal(searched.data.coverage.processedProducts, 1);
  assert.equal(searched.data.coverage.officialTotal, 1);
  assert.equal(searched.data.coverage.allPhysicalInventoryGuaranteed, false);
});

test('root-only scheduled cache does not skip interactive related discovery', async () => {
  const seed = emptyHiddenIndex();
  const root = result(); root.coverage.scope = 'official-public-product-option-and-review-evidence';
  mergeDiscovery(seed, GOODS, root, clock);
  let discoveries = 0;
  const handler = createHiddenStockService({ secret: () => SECRET, index: memoryIndex(seed), now: () => ++clock,
    request: async () => ({}), discoveryFactory: () => async () => { discoveries++; return result(); } });
  const response = await invoke(handler, `/api/hidden-stock?action=options&goodsNo=${GOODS}`);
  assert.equal(response.status, 200); assert.equal(discoveries, 1);
});

test('foreground interruption swallowed by discovery safeRequest still preserves the collector queue without a failure', { timeout: 3000 }, async () => {
  const documents = new Map();
  let revision = 0;
  const index = createHiddenIndexStore({ now: () => ++clock,
    readDocument: async path => structuredClone(documents.get(path) || { value: null, etag: null }),
    writeDocument: async (path, value, expected) => {
      assert.equal(expected, documents.get(path)?.etag || null);
      const etag = String(++revision);
      documents.set(path, { value: structuredClone(value), etag });
      return { etag };
    }
  });
  let backgroundEntered, foregroundEntered, releaseBackground, releaseForeground;
  const enteredBackground = new Promise(resolve => { backgroundEntered = resolve; });
  const enteredForeground = new Promise(resolve => { foregroundEntered = resolve; });
  const backgroundGate = new Promise(resolve => { releaseBackground = resolve; });
  const foregroundGate = new Promise(resolve => { releaseForeground = resolve; });
  const providerPaths = [];
  const foregroundGoods = 'A000000270000';
  const handler = createHiddenStockService({ secret: () => SECRET, index, now: () => ++clock,
    request: async ({ path }) => {
      providerPaths.push(path);
      if (path.endsWith('product-search-v3')) return { status: 'SUCCESS', data: {
        serachList: [{ goodsNumber: GOODS }], nextPage: false, totalCount: 1
      } };
      assert.ok(path.endsWith('stock-goods-info-option'));
      backgroundEntered();
      await backgroundGate;
      return { status: 'ERROR' };
    },
    discoveryFactory: options => options.maxRelatedDepth === 0 ? createHiddenOptionDiscovery(options) : async () => {
      foregroundEntered();
      await foregroundGate;
      const found = result();
      found.options[0].goodsNo = foregroundGoods;
      return found;
    }
  });
  const background = invoke(handler, '/api/hidden-stock?action=collect', { method: 'POST' });
  await enteredBackground;
  const foreground = invoke(handler, '/api/hidden-stock?action=options&goodsNo=' + foregroundGoods);
  try {
    await enteredForeground;
    releaseBackground();
    const response = await background;
    assert.equal(response.status, 200);
    assert.equal(response.data.progress.phase, 'foreground_priority');
    assert.equal(response.data.progress.failed, 0);
    assert.equal(response.data.collection.queueRemaining, 1);
    assert.equal(response.data.collection.consecutiveFailures, 0);
    const state = (await index.readScan({ fresh: true })).collection;
    assert.equal(state.known[GOODS].attempts, 0);
    assert.ok(state.queued[GOODS]);
    assert.equal(await index.readProduct(GOODS), null);
    // The core swallowed fallback/count background_yield errors as partial
    // evidence, but the service's post-discovery guard restored interruption.
    assert.equal(providerPaths.length, 2);
  } finally {
    releaseBackground(); releaseForeground();
    await background;
    assert.equal((await foreground).status, 200);
  }
});

test('legacy scan refresh preserves an existing scheduled collection checkpoint', async () => {
  const seed = emptyHiddenIndex();
  const collection = { version: 1, marker: 'preserve-queue-and-lease', queued: { [GOODS]: { dueAt: '2026-09-13T02:00:00.000Z' } } };
  seed.scan.collection = collection;
  seed.scan.page = 9;
  const index = memoryIndex(seed);
  const handler = createHiddenStockService({ secret: () => SECRET, index, now: () => ++clock,
    request: async () => ({ status: 'SUCCESS', data: { serachList: [], nextPage: false, totalCount: 0 } }) });
  const response = await invoke(handler, '/api/hidden-stock?action=scan&refresh=1', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual((await index.read({ fresh: true })).scan.collection, collection);
});
