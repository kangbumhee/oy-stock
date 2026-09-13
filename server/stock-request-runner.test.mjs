import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createStockRequestRunner, isCompleteStockResult, stockFailure, stockLookupHttpStatus, stockResponseState, stockRetryDelay } from './stock-request-runner.mjs';

const body = (productId = '8809506312905', extras = {}) => ({
  productId, lat: 37.6152, lon: 126.7156, pageIdx: 1, searchWords: '', mapLat: 37.6152, mapLon: 126.7156, ...extras
});
const success = (stores = []) => ({ ok: true, status: 200, data: { status: 'SUCCESS', code: 200, data: { storeList: stores } } });
const store = { storeCode: 'D001', storeName: '검증 매장', remainQuantity: 8, distance: 1.2 };

test('only a validated SUCCESS storeList is authoritative, including a genuine empty array', () => {
  assert.equal(stockResponseState(success()).ok, true);
  assert.equal(stockResponseState(success([store])).stores[0].remainQuantity, 8);
  for (const bad of [
    { ok: true, status: 200, data: { status: 'SUCCESS', data: {} } },
    { ok: true, status: 200, data: { status: 'SUCCESS', code: 429, data: { storeList: [] } } },
    { ok: true, status: 200, data: { status: 'ERROR', data: { storeList: [] } } },
    { ok: false, status: 429, data: { status: 'SUCCESS', data: { storeList: [] } } },
    { ok: true, status: 200, data: { status: 'SUCCESS', data: { storeList: [], stockDisplayYn: false } } },
    { ok: false, status: 0 }, null
  ]) assert.equal(stockResponseState(bad).ok, false);
});

test('upstream Retry-After seconds and HTTP dates are honored, not shortened', () => {
  assert.equal(stockRetryDelay('120', 0), 120);
  assert.equal(stockRetryDelay('Thu, 01 Jan 1970 00:03:00 GMT', 0), 180);
  assert.equal(stockRetryDelay(null, 0), 60);
  assert.equal(stockRetryDelay('not a date', 0), 60);
});

test('concurrent users and option requests share one serial paced budget', async () => {
  let clock = 0; let active = 0; let peak = 0;
  const starts = [];
  const run = createStockRequestRunner(async () => {
    starts.push(clock); peak = Math.max(peak, ++active);
    await Promise.resolve(); clock += 20; active--;
    return success([store]);
  }, { now: () => clock, sleep: async (ms) => { clock += ms; } });
  const result = await Promise.all(['1', '2', '3', '4'].map((pid) => run(body(pid))));
  assert.equal(peak, 1);
  assert.deepEqual(starts, [0, 1000, 2000, 3000]);
  assert.ok(result.every((row) => stockResponseState(row).ok));
});

test('same SKU/location/page joins one flight; cache returns isolated real observations', async () => {
  let count = 0; let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const run = createStockRequestRunner(async () => { count++; await wait; return success([store]); }, { minIntervalMs: 0 });
  const one = run(body()); const two = run(body()); release();
  const results = await Promise.all([one, two]);
  assert.equal(count, 1);
  results[0].data.data.storeList[0].remainQuantity = 0;
  assert.equal(results[1].data.data.storeList[0].remainQuantity, 8);
  assert.equal((await run(body())).data.data.storeList[0].remainQuantity, 8);
  assert.equal(count, 1);
  await run(body('8809506312905', { pageIdx: 2 }));
  await run(body('8809506312905', { lat: 37.5 }));
  assert.equal(count, 3);
});

test('expired cache rechecks; errors and malformed empty responses are never cached', async () => {
  let clock = 0; let calls = 0;
  const run = createStockRequestRunner(async () => {
    calls++;
    return calls <= 2 ? { ok: true, status: 200, data: { status: 'SUCCESS', data: {} } } : success([store]);
  }, { now: () => clock, sleep: async (ms) => { clock += ms; }, cacheTtlMs: 100, minIntervalMs: 0 });
  assert.equal(stockResponseState(await run(body())).ok, false);
  assert.equal(stockResponseState(await run(body())).ok, false);
  assert.equal(stockResponseState(await run(body())).ok, true);
  await run(body()); assert.equal(calls, 3);
  clock += 101; await run(body()); assert.equal(calls, 4);
});

test('429 stops all queued upstream requests and allows recovery after Retry-After', async () => {
  let clock = 0; let calls = 0;
  const run = createStockRequestRunner(async () => {
    calls++;
    return calls === 1 ? { ok: false, status: 429, retryAfter: '90' } : success([store]);
  }, { now: () => clock, sleep: async (ms) => { clock += ms; } });
  const result = await Promise.all(['a', 'b', 'c'].map((pid) => run(body(pid))));
  assert.equal(calls, 1);
  assert.ok(result.every((row) => row.status === 429 && row.retryAfterSeconds === 90));
  clock += 89000;
  assert.equal((await run(body('a'))).retryAfterSeconds, 1);
  assert.equal(calls, 1);
  clock += 1000;
  assert.equal(stockResponseState(await run(body('a'))).ok, true);
  assert.equal(calls, 2);
});

test('successful cached SKU can still be read during another SKU cooldown', async () => {
  let calls = 0;
  const run = createStockRequestRunner(async () => ++calls === 1 ? success([store]) : { ok: false, status: 429 }, { minIntervalMs: 0 });
  await run(body('a')); await run(body('b'));
  assert.equal(stockResponseState(await run(body('a'))).ok, true);
  assert.equal(calls, 2);
});

test('bounded queue rejects excess/expired work without scheduling extra requests', async () => {
  let clock = 0; let calls = 0; let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const run = createStockRequestRunner(async () => { calls++; await wait; return success(); }, {
    now: () => clock, sleep: async (ms) => { clock += ms; }, maxQueue: 1, maxWaitMs: 500
  });
  const one = run(body('a')); const two = run(body('b'));
  const rejected = await run(body('c'));
  assert.equal(rejected.error, 'stock_queue_busy');
  clock = 1000; release();
  await one;
  assert.equal((await two).error, 'stock_queue_busy');
  assert.equal(calls, 1);
});

test('a caller deadline stops late queued or new work before its fetch timeout can overrun', async () => {
  let clock = 0; let calls = 0;
  const run = createStockRequestRunner(async () => { calls++; clock += 4500; return success([store]); }, {
    now: () => clock, sleep: async (ms) => { clock += ms; }
  });
  await run(body('a'), { deadlineAt: 6000 });
  const late = await run(body('b'), { deadlineAt: 6000 });
  assert.equal(late.error, 'stock_lookup_timeout');
  assert.equal(calls, 1);
});

test('lookup HTTP status and response caching distinguish failure, partial, online and real empty', () => {
  assert.equal(stockLookupHttpStatus({ success: true, storeLookupStatus: 'unavailable', storeLookupError: 'stock_rate_limited' }), 429);
  assert.equal(stockLookupHttpStatus({ success: false, storeLookupStatus: 'unavailable' }), 503);
  assert.equal(stockLookupHttpStatus({ success: true, storeLookupStatus: 'partial' }), 200);
  assert.equal(stockLookupHttpStatus({ success: true, storeLookupStatus: 'ok', options: [] }), 200);
  assert.equal(isCompleteStockResult({ success: true, storeLookupStatus: 'partial' }), false);
  assert.equal(isCompleteStockResult({ success: true, storeLookupStatus: 'unavailable' }), false);
  assert.equal(isCompleteStockResult({ success: true, storeLookupStatus: 'skipped' }), false);
  assert.equal(isCompleteStockResult({ success: true, storeLookupStatus: 'skipped' }, true), true);
  assert.equal(isCompleteStockResult({ success: true, storeLookupStatus: 'ok' }), true);
});

const source = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
function functionSource(name, nextName) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(`\n${nextName}`, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
function sandbox(extra) {
  return { console: { log() {}, error() {} }, structuredClone, Date, Map,
    STOCK_DETAIL_TOTAL_TIMEOUT_MS: 35000, OY_API_FETCH_TIMEOUT_MS: 3500,
    stockResponseState, stockFailure, isCompleteStockResult,
    unwrapPayload: (json) => json?.data || {},
    yn: (value) => value === true || value === 'Y', compactApiFailure: () => 'unavailable',
    ...extra };
}

test('nearby seven-option fanout stops after the first failed request and reports all unknown', async () => {
  let calls = 0;
  const ctx = sandbox({ requestStockStores: async () => { calls++; return stockFailure('stock_rate_limited', 429, 60); } });
  vm.createContext(ctx);
  vm.runInContext(functionSource('oyPostStockStoresBatch', 'async function getNearbyStoresByProductIds') +
    functionSource('getNearbyStoresByProductIds', 'function isGoodsInfoSuccess'), ctx);
  const result = await ctx.getNearbyStoresByProductIds(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 37, 126);
  assert.equal(calls, 1);
  assert.equal(result._meta.failed, 7);
  assert.equal(result._meta.succeeded, 0);
  assert.equal(result._meta.retryAfterSeconds, 60);
  assert.ok(Object.values(result._meta.byProduct).every((status) => status === 'unavailable'));
});

test('nearby valid empty is successful while malformed store payload remains unavailable', async () => {
  let calls = 0;
  const ctx = sandbox({ requestStockStores: async () => ++calls === 1 ? success() : { ok: true, status: 200, data: { status: 'SUCCESS', data: {} } } });
  vm.createContext(ctx);
  vm.runInContext(functionSource('oyPostStockStoresBatch', 'async function getNearbyStoresByProductIds') +
    functionSource('getNearbyStoresByProductIds', 'function isGoodsInfoSuccess'), ctx);
  const result = await ctx.getNearbyStoresByProductIds(['a', 'b'], 37, 126);
  assert.equal(result._meta.byProduct.a, 'ok');
  assert.equal(result._meta.byProduct.b, 'unavailable');
  assert.equal(result._meta.succeeded, 1);
  assert.equal(result._meta.failed, 1);
});

test('actual stock-detail builder retains online metadata but never marks failed stores sold out', async () => {
  const ctx = sandbox({
    requestStockStores: async () => stockFailure('stock_rate_limited', 429, 90),
    getGoodsInfoResponse: async () => ({ ok: true, data: { status: 'SUCCESS', data: { goodsUploadUrl: '', goodsInfo: {
      goodsName: '[산리오] 에스네이처 아쿠아 스쿠알란', itemCount: 1, priceToPay: 21900,
      availableItems: [{ legacyItemNumber: '8809506312905', itemName: '더블기획', quantity: 2644, deliveredToday: true }]
    } } } }),
    publicFieldsFromStockOption: () => ({})
  });
  vm.createContext(ctx);
  vm.runInContext(functionSource('oyPostStockStoresBatch', 'async function getNearbyStoresByProductIds') +
    functionSource('getNearbyStoresByProductIds', 'function isGoodsInfoSuccess') +
    functionSource('getStockDetailBody', 'const REGIONS ='), ctx);
  const result = await ctx.getStockDetailBody('A000000263782', 37.6152, 126.7156);
  assert.equal(result.status, 'unknown');
  assert.equal(result.storeLookupStatus, 'unavailable');
  assert.equal(result.options[0].onlineQty, 2644);
  assert.equal(result.options[0].deliveredToday, true);
  assert.equal(result.options[0].storeLookupError, 'stock_rate_limited');
  assert.equal(result.retryAfterSeconds, 90);
  assert.equal(stockLookupHttpStatus(result), 429);
  const online = await ctx.getStockDetailBody('A000000263782', 37.6152, 126.7156, false, true);
  assert.equal(online.options[0].storeLookupStatus, 'skipped');
  assert.equal(stockLookupHttpStatus(online), 200);
});

test('full stock details coalesce concurrent fresh requests and cache only complete observations', async () => {
  let calls = 0; let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const ctx = sandbox({
    detailResponseCacheKey: (goodsNo, lat, lng, withOnline, onlineOnly) => `${goodsNo}|${lat}|${lng}|${withOnline}|${onlineOnly}`,
    detailResponseCache: new Map(), detailResponseFlights: new Map(), DETAIL_RESPONSE_TTL_MS: 180000,
    pruneDetailResponseCache() {},
    getStockDetailBody: async () => { calls++; await wait; return {
      success: true, storeLookupStatus: calls === 1 ? 'partial' : 'ok', options: [{ stores: [{ qty: 8 }] }]
    }; }
  });
  vm.createContext(ctx);
  vm.runInContext(functionSource('getStockDetail', 'async function getStockDetailCached') +
    functionSource('getStockDetailCached', 'async function getStockDetailBody'), ctx);
  const one = ctx.getStockDetail('A000000263782', 37, 126, false, false, true);
  const two = ctx.getStockDetail('A000000263782', 37, 126, false, false, true);
  release(); await Promise.all([one, two]);
  assert.equal(calls, 1);
  assert.equal(ctx.detailResponseCache.size, 0);
  await ctx.getStockDetail('A000000263782', 37, 126);
  await ctx.getStockDetail('A000000263782', 37, 126);
  assert.equal(calls, 2);
  assert.equal(ctx.detailResponseCache.size, 1);
});

test('national partial retains observed stores, fails remaining options, and never caches coverage gaps', async () => {
  let calls = 0; let writes = 0;
  const ctx = sandbox({
    allRegionsResponseCacheKey: () => 'key', allRegionsResponseCache: { get() {}, set() { writes++; } },
    ALL_REGIONS_RESPONSE_TTL_MS: 180000, pruneAllRegionsResponseCache() {},
    getGoodsInfoResponse: async () => ({ ok: true, data: { status: 'SUCCESS', data: { goodsInfo: {
      goodsName: '두 옵션 상품', availableItems: [{ legacyItemNumber: 'a', itemName: '옵션 A' }, { legacyItemNumber: 'b', itemName: '옵션 B' }]
    } } } }),
    requestStockStores: async () => ++calls === 1 ? success([store]) : stockFailure('stock_rate_limited', 429, 60),
    publicFieldsFromStockOption: () => ({}), sleep: async () => {},
    REGIONS: [{ name: '서울', lat: 37, lng: 126 }, { name: '부산', lat: 35, lng: 129 }]
  });
  vm.createContext(ctx);
  const start = source.indexOf('async function getStockAllRegionsBody(');
  // The next declarations after this function are unrelated HTTP/auth helpers.
  const closing = /\r?\n}\r?\n/.exec(source.slice(start));
  assert.ok(closing);
  const bodyEnd = start + closing.index + closing[0].length;
  vm.runInContext(source.slice(start, bodyEnd), ctx);
  const result = await ctx.getStockAllRegionsBody('A000000263782', null);
  assert.equal(calls, 2);
  assert.equal(writes, 0);
  assert.equal(result.storeLookupStatus, 'partial');
  assert.equal(result.options[0].stores[0].qty, 8);
  assert.equal(result.options[0].storeLookupStatus, 'partial');
  assert.equal(result.options[1].storeLookupStatus, 'unavailable');
  assert.equal(result.retryAfterSeconds, 60);
});

test('normal stock routes no longer reset the shared browser on a timeout or national failure', () => {
  const handlers = source.slice(source.indexOf("if (url.pathname === '/api/stock')"));
  assert.doesNotMatch(handlers, /sessionReady\s*=\s*false/);
  assert.doesNotMatch(source, /oyPostWithRetry/);
  assert.match(handlers, /res\.writeHead\(stockLookupHttpStatus\(out\)/);
  assert.match(handlers, /res\.writeHead\(stockLookupHttpStatus\(result\)/);
});
