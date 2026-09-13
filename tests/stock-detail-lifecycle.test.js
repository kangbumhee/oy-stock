const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const project = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(project, 'public/js/app.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(project, 'public/js/ui.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const option = (pid, state = 'skipped', stores = []) => ({ productId: pid, optionNumber: pid === 'SKU-A' ? '001' : '002', name: '옵션 ' + pid,
  onlineQty: 12, image: '/fixture.png', storeLookupStatus: state, totalStores: stores.length,
  inStock: stores.filter(s => s.qty > 0).length, totalQty: stores.reduce((n, s) => n + (s.qty || 0), 0), stores });
const detail = (overrides = {}) => ({ success: true, goodsNo: 'A0001', goodsName: '테스트 상품', price: 21900,
  source: 'live-online', inventoryScope: 'online', storeLookupStatus: 'skipped', options: [option('SKU-A'), option('SKU-B')], ...overrides });
const fullDetail = (overrides = {}) => detail({ source: 'live', inventoryScope: 'store', storeLookupStatus: 'ok',
  options: [option('SKU-A', 'ok', [{ name: '검증 매장', qty: 5, dist: 1 }]), option('SKU-B', 'ok')], ...overrides });

function environment() {
  let now = 1000000;
  const timers = new Map();
  let timerId = 0;
  const root = { innerHTML: '', dataset: {}, querySelector() { return { scrollTop: 0 }; }, querySelectorAll() { return []; }, contains() { return true; } };
  let context;
  const controls = () => (context.UI._stockPopupDetail?.options || []).map((_, i) => ({ classList: { toggle() {} }, querySelector() { return null; }, index: i }));
  context = {
    URL, URLSearchParams, AbortController, Promise, Error, Number, String, Array, Set, Map,
    Date: class extends Date { static now() { return now; } },
    CONFIG: { DEFAULT_LAT: 37.6152, DEFAULT_LNG: 126.7156, REALTIME_API: 'https://stock.test/api/stock',
      OY_PRODUCT_URL: 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=', STOCK_RETRY_COOLDOWN_MS: 30000 },
    document: {
      readyState: 'loading', addEventListener() {}, body: { style: {} },
      getElementById(id) { return id === 'popup-root' ? root : null; },
      querySelector(selector) {
        if (selector.includes('[data-goodsno=')) {
          const id = selector.match(/data-goodsno="([^"]+)"/)[1];
          return root.innerHTML.includes('data-goodsno="' + id + '"') ? {} : null;
        }
        return null;
      },
      querySelectorAll(selector) { return selector === '.opt-tab' || selector === '.opt-panel' ? controls() : []; }
    },
    Storage: { isFavorite() { return false; }, getOnlineDetails() { return {}; }, setOnlineDetail() {} },
    setTimeout(fn, ms) { timers.set(++timerId, { fn, at: now + ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); }, console,
    fetch() { throw new Error('Unexpected network request'); }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(appSource, context);
  vm.runInContext(uiSource, context);
  context.UI.esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  context.UI.updateCardBadge = () => {};
  context.App._recordVelocitySnapshot = () => {};
  context.App._productMetaForGoodsNo = () => ({});
  context.App._resumePendingOnlineEnrich = () => {};
  return { context, app: context.App, ui: context.UI, root,
    advance(ms) { now += ms; },
    open(goodsNo = 'A0001') { context.UI.showPopupStockSkeleton({ goodsNo, goodsName: '테스트 상품' }); },
    html() { return root.innerHTML; } };
}

test('online-first skipped and pending are not rendered as nearby sold out', () => {
  const env = environment();
  env.ui.showDetailPopup(detail({ status: 'soldout' }), 'A0001');
  assert.match(env.html(), /주변 매장 재고 조회 중/);
  assert.match(env.html(), /아직 품절 여부를 확인하지 않았습니다/);
  assert.doesNotMatch(env.html(), /🔴 주변 매장 재고 없음|주변 매장 전체 품절/);
  assert.match(env.html(), /21,900원|21,900/);
  assert.match(env.html(), /온라인 재고 12개/);
});

test('genuine successful empty lookup is distinct from missing legacy evidence', () => {
  const env = environment();
  env.ui.showDetailPopup(fullDetail({ options: [option('SKU-A', 'ok')], status: 'soldout' }), 'A0001');
  assert.match(env.html(), /주변 매장 재고 없음/);
  assert.match(env.html(), /주변 매장 전체 품절/);
  env.ui.showDetailPopup(fullDetail({ storeLookupStatus: undefined, options: [{ productId: 'SKU-A', name: '옵션', stores: [] }], status: 'soldout' }), 'A0001');
  assert.match(env.html(), /주변 매장 재고 미확인/);
  assert.doesNotMatch(env.html(), /주변 매장 전체 품절|주변 매장 재고 없음/);
});

test('partial responses report unknown only for failed options and preserve successful rows', () => {
  const env = environment();
  env.ui.showDetailPopup(fullDetail({ status: 'soldout', storeLookupStatus: 'partial', options: [option('SKU-A', 'ok', [{ name: '확인 매장', qty: 3 }]), option('SKU-B', 'unavailable')] }), 'A0001');
  assert.match(env.html(), /일부 옵션만 확인/);
  assert.match(env.html(), /확인 매장/);
  assert.match(env.html(), /주변 매장 재고 미확인/);
  assert.doesNotMatch(env.html(), /주변 매장 전체 품절|🔴 주변 매장 재고 없음/);
});

test('missing store quantity is never represented as zero or sold out', () => {
  const env = environment();
  env.ui.showDetailPopup(fullDetail({ options: [option('SKU-A', 'ok', [{ name: '수량 미확인', qty: null }])] }), 'A0001');
  assert.match(env.html(), /재고 미확인/);
  assert.doesNotMatch(env.html(), />품절</);
});

test('full failure persists unavailable plus cooldown retry and retains online price/stock', async () => {
  const env = environment();
  env.open();
  const full = deferred();
  const calls = [];
  env.app._fetchJsonWithTimeout = async url => { calls.push(url); return url.includes('onlineOnly') ? detail() : full.promise; };
  const task = env.app._loadRealtimeDetailIntoPopup('A0001', '테스트 상품');
  await tick();
  assert.match(env.html(), /주변 매장 재고 조회 중/);
  env.ui.switchTab(1);
  full.reject(Object.assign(new Error('HTTP 429'), { retryAfterMs: 30000 }));
  await task;
  assert.match(env.html(), /주변 매장 재고를 확인하지 못했습니다. 품절 여부는 미확인입니다/);
  assert.match(env.html(), /data-action="retryStoreStock"[^>]+ disabled/);
  assert.match(env.html(), /온라인 재고 12개/);
  assert.match(env.html(), /21,900/);
  assert.equal(env.ui._selectedStockOption.productId, 'SKU-B');
  assert.doesNotMatch(env.html(), /주변 매장 재고 조회 중|주변 매장 재고 없음/);
  await env.app.retryStoreStock('A0001');
  assert.equal(calls.length, 2);
  env.advance(30001);
  env.app._fetchJsonWithTimeout = async url => { calls.push(url); return fullDetail({ options: [option('SKU-B', 'ok', [{ name: '회복 매장', qty: 7 }]), option('SKU-A', 'ok')] }); };
  await env.app.retryStoreStock('A0001');
  assert.equal(calls.length, 3);
  assert.equal(calls.filter(url => url.includes('onlineOnly')).length, 1);
  assert.equal(env.ui._selectedStockOption.productId, 'SKU-B');
  assert.match(env.html(), /회복 매장/);
  assert.doesNotMatch(env.html(), /다시 조회|품절 여부는 미확인입니다/);
});

test('all-failed payload after online failure can retain safe returned product metadata', async () => {
  const env = environment(); env.open();
  env.app._fetchJsonWithTimeout = async url => {
    if (url.includes('onlineOnly')) throw new Error('timeout');
    throw Object.assign(new Error('stock_rate_limited'), { data: fullDetail({ success: false, storeLookupStatus: 'unavailable', options: [option('SKU-A', 'unavailable')] }) });
  };
  await env.app._loadRealtimeDetailIntoPopup('A0001', '상품');
  assert.match(env.html(), /온라인 재고 12개/);
  assert.match(env.html(), /주변 매장 재고 미확인/);
});

test('selected exact SKU and optionNumber survive reordered full response', async () => {
  const env = environment(); env.open();
  const full = deferred();
  env.app._fetchJsonWithTimeout = async url => url.includes('onlineOnly') ? detail() : full.promise;
  const task = env.app._loadRealtimeDetailIntoPopup('A0001', '상품');
  await tick(); env.ui.switchTab(1);
  full.resolve(fullDetail({ options: [option('SKU-B', 'ok'), option('SKU-A', 'ok')] }));
  await task;
  assert.equal(env.ui._selectedStockOption.productId, 'SKU-B');
  assert.match(env.html(), /class="opt-panel active" data-panel="0"/);
});

test('closed popup rejects late detail response and does not reopen', async () => {
  const env = environment(); env.open();
  const response = deferred();
  env.app._fetchJsonWithTimeout = () => response.promise;
  const task = env.app._loadRealtimeDetailIntoPopup('A0001', '상품');
  env.ui.closePopup(); response.resolve(detail()); await task;
  assert.equal(env.html(), '');
});

test('same-goods reopening reuses one network operation but only new session can render', async () => {
  const env = environment(); env.open();
  const online = deferred(); const full = deferred(); let count = 0;
  env.app._fetchJsonWithTimeout = url => { count++; return url.includes('onlineOnly') ? online.promise : full.promise; };
  const old = env.app._loadRealtimeDetailIntoPopup('A0001', '상품');
  env.ui.closePopup(); env.open();
  const current = env.app._loadRealtimeDetailIntoPopup('A0001', '상품');
  assert.equal(count, 1);
  online.resolve(detail()); await tick();
  assert.equal(count, 2);
  env.ui.switchTab(1); full.resolve(fullDetail()); await Promise.all([old, current]);
  assert.equal(env.ui._selectedStockOption.productId, 'SKU-B');
});

test('different product popup is protected from old full response', async () => {
  const env = environment(); env.open();
  const full = deferred();
  env.app._fetchJsonWithTimeout = url => url.includes('onlineOnly') ? Promise.resolve(detail()) : full.promise;
  const old = env.app._loadRealtimeDetailIntoPopup('A0001', '상품'); await tick();
  env.open('A0002'); const current = env.html();
  full.resolve(fullDetail()); await old;
  assert.equal(env.html(), current);
});

test('fresh online cache avoids duplicate online call, pauses background, and keeps exact metadata', async () => {
  const env = environment(); env.open(); let aborts = 0; const calls = [];
  const cached = detail({ options: [Object.assign(option('SKU-A'), { priceToPay: 19000 })] });
  env.context.Storage.getOnlineDetails = () => ({ A0001: cached });
  env.app.batchAbortController = { abort() { aborts++; } };
  env.app._fetchJsonWithTimeout = async url => { calls.push(url); return fullDetail(); };
  await env.app._loadRealtimeDetailIntoPopup('A0001', '상품');
  assert.equal(aborts, 1); assert.equal(calls.length, 1); assert.doesNotMatch(calls[0], /onlineOnly/);
  const snapshot = env.app._onlineOnlySnapshot(cached);
  assert.equal(snapshot.options[0].optionNumber, '001');
  assert.equal(snapshot.options[0].priceToPay, 19000);
  assert.equal(snapshot.options[0].storeLookupStatus, 'skipped');
});

test('rendering and option switching do not request nationwide data', () => {
  const env = environment(); let calls = 0;
  env.ui.fetchAllStock = () => { calls++; return Promise.resolve(fullDetail()); };
  env.ui.showDetailPopup(fullDetail(), 'A0001'); env.ui.switchTab(1);
  assert.equal(calls, 0);
  assert.doesNotMatch(uiSource, /prefetchAllStockForDetail|prefetchAllStockButton/);
});

test('national HTTP failure is not cached and retries are bounded by cooldown', async () => {
  const env = environment(); let calls = 0;
  env.context.fetch = async () => { calls++; return { ok: false, status: 429, headers: { get() { return '30'; } }, async json() { return { success: true, options: [option('SKU-A', 'ok')] }; } }; };
  await assert.rejects(env.ui.fetchAllStock('A0001', 'SKU-A'));
  await assert.rejects(env.ui.fetchAllStock('A0001', 'SKU-A'));
  assert.equal(calls, 1); assert.equal(Object.keys(env.ui._allStockCache).length, 0);
  env.advance(30001);
  env.context.fetch = async () => { calls++; return { ok: true, async json() { return fullDetail({ options: [option('SKU-A', 'ok')] }); } }; };
  const result = await env.ui.fetchAllStock('A0001', 'SKU-A');
  assert.equal(result.storeLookupStatus, 'ok'); assert.equal(calls, 2);
});

test('national success with unavailable or ambiguous empty option is rejected', async () => {
  for (const result of [fullDetail({ storeLookupStatus: 'unavailable', options: [option('SKU-A', 'unavailable')] }),
    fullDetail({ storeLookupStatus: undefined, options: [{ productId: 'SKU-A', stores: [] }] })]) {
    const env = environment(); env.context.fetch = async () => ({ ok: true, async json() { return result; } });
    await assert.rejects(env.ui.fetchAllStock('A0001', 'SKU-A'));
    assert.equal(Object.keys(env.ui._allStockCache).length, 0);
  }
});

test('national partial keeps explicit failure state and is not cached as complete', async () => {
  const env = environment();
  const partial = fullDetail({ storeLookupStatus: 'partial', options: [option('SKU-A', 'partial', [{ name: '확인', qty: 2 }])] });
  env.context.fetch = async () => ({ ok: true, async json() { return partial; } });
  assert.equal((await env.ui.fetchAllStock('A0001', 'SKU-A')).storeLookupStatus, 'partial');
  assert.equal(Object.keys(env.ui._allStockCache).length, 0);
});

test('nationwide completion is ignored after switching away and back to original option', async () => {
  const env = environment(); env.ui.showDetailPopup(fullDetail(), 'A0001');
  const response = deferred(); let panels = 0;
  env.ui.fetchAllStock = () => response.promise;
  env.ui.showAllStockPanel = () => { panels++; };
  const button = { dataset: { action: 'loadAllStockOpt', goodsno: 'A0001', productid: 'SKU-A' }, isConnected: true,
    classList: { contains() { return false; }, add() {}, remove() {} } };
  env.ui._handlePopupRootClick({ target: { closest() { return button; } }, preventDefault() {}, stopPropagation() {} });
  env.ui.switchTab(1); env.ui.switchTab(0);
  response.resolve(fullDetail()); await tick();
  assert.equal(panels, 0);
});

test('popup fetch HTTP errors retain retry information and payload without treating it as success', async () => {
  const env = environment();
  env.context.fetch = async () => ({ ok: false, status: 429, headers: { get() { return '45'; } }, async text() { return JSON.stringify({ error: 'stock_rate_limited', retryAfterMs: 50000, options: [] }); } });
  await assert.rejects(env.app._fetchJsonWithTimeout('/fixture', 1000), error => {
    assert.equal(error.status, 429); assert.equal(error.retryAfterMs, 50000);
    assert.equal(error.data.error, 'stock_rate_limited'); return true;
  });
});

test('reopening during cooldown does not restart the waiting period', async () => {
  const env = environment(); env.open();
  env.app._fetchJsonWithTimeout = async url => {
    if (url.includes('onlineOnly')) return detail();
    throw new Error('HTTP 429');
  };
  await env.app._loadRealtimeDetailIntoPopup('A0001', '상품');
  const url = env.app._stockDetailUrl('A0001');
  const until = env.app._stockDetailFailures[url].until;
  env.advance(20000); env.ui.closePopup(); env.open();
  await env.app._loadRealtimeDetailIntoPopup('A0001', '상품');
  assert.equal(env.app._stockDetailFailures[url].until, until);
  assert.match(env.html(), /10초 후 매장 재고 다시 조회/);
});

test('failed fresh lookup never restores old cached store rows as current confirmation', async () => {
  const env = environment();
  env.app.detailData = { products: { A0001: fullDetail() } };
  env.open(); env.app._fetchJsonWithTimeout = async () => { throw new Error('timeout'); };
  await env.app._loadRealtimeDetailIntoPopup('A0001', '상품');
  assert.match(env.html(), /주변 매장 재고 미확인/);
  assert.doesNotMatch(env.html(), /검증 매장/);
});

test('top-level ok does not override every option explicitly unavailable', () => {
  const env = environment();
  assert.equal(env.app._hasUsableStoreDetail(fullDetail({ options: [option('SKU-A', 'unavailable')] })), false);
});
