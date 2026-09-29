const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const project = path.join(__dirname, '..');
const sources = ['app', 'ui', 'alerts', 'hidden-stock'].map(name =>
  fs.readFileSync(path.join(project, 'public/js/' + name + '.js'), 'utf8'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const option = (productId, stores = []) => ({ productId, optionNumber: productId === 'SKU-A' ? '001' : '002',
  name: '옵션 ' + productId, onlineQty: 12, storeLookupStatus: 'ok', stores, totalStores: stores.length,
  inStock: stores.filter(store => store.qty > 0).length, totalQty: stores.reduce((sum, store) => sum + store.qty, 0) });
const detail = (productId, storeName = '유료 전국 매장') => ({ success: true, goodsNo: 'A0001', goodsName: '테스트 상품',
  source: 'live-all', inventoryScope: 'store', storeLookupStatus: 'ok',
  options: [option(productId, [{ name: storeName, qty: 7, region: '전국' }])] });
const response = (data, status = 200, retryAfter = '') => ({ ok: status >= 200 && status < 300, status,
  headers: { get(name) { return name.toLowerCase() === 'retry-after' ? retryAfter : null; } },
  async json() { return data; }, async text() { return JSON.stringify(data); } });

function environment({ active = true, lifetime = false } = {}) {
  let now = Date.parse('2026-09-29T00:00:00Z');
  let timerId = 0;
  const elements = new Map();
  const listeners = {};
  const intervals = [];
  const calls = [];
  const accessCallbacks = [];
  const statuses = [];
  let buttons = [];
  let context;
  function node(id = '') {
    const classes = new Set();
    return { id, innerHTML: '', textContent: '', dataset: {}, isConnected: true, scrollTop: 0,
      classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); },
        contains(value) { return classes.has(value); }, toggle() {} },
      querySelector() { return null; }, querySelectorAll() { return []; }, scrollIntoView() {},
      remove() { elements.delete(id); this.isConnected = false; } };
  }
  const root = node('popup-root');
  let rootHtml = '';
  Object.defineProperty(root, 'innerHTML', {
    get() { return rootHtml; },
    set(value) {
      rootHtml = value;
      buttons.forEach(button => { button.isConnected = false; });
      const panel = elements.get('all-stock-panel');
      if (panel) panel.remove();
      buttons = Array.from(value.matchAll(/<button\b([^>]*data-action="loadAllStockOpt"[^>]*)>([^<]*)<\/button>/g), match => {
        const button = node();
        button.dataset = { action: 'loadAllStockOpt', goodsno: match[1].match(/data-goodsno="([^"]+)"/)[1],
          productid: match[1].match(/data-productid="([^"]+)"/)[1] };
        button.textContent = match[2];
        return button;
      });
    }
  });
  function insertPanel(position, html) {
    const panel = node('all-stock-panel'); panel.innerHTML = html; elements.set(panel.id, panel);
  }
  const content = { scrollTop: 0, insertAdjacentHTML: insertPanel };
  root.querySelector = selector => selector === '.popup-content' ? content : null;
  root.contains = value => buttons.includes(value) || value.fixtureAction === true;
  elements.set(root.id, root);
  const controls = () => (context.UI._stockPopupDetail?.options || []).map(() => node());
  context = {
    URL, URLSearchParams, AbortController, Promise, Error, Number, String, Array, Map, Set,
    Date: class extends Date { static now() { return now; } }, console,
    CONFIG: { DEFAULT_LAT: 37.6152, DEFAULT_LNG: 126.7156, REALTIME_API: 'https://fixture-stock.a.run.app/api/stock',
      OY_PRODUCT_URL: 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=', STOCK_RETRY_COOLDOWN_MS: 30000 },
    document: {
      readyState: 'loading', hidden: false, activeElement: null, body: { style: {} },
      addEventListener(type, handler) { listeners[type] = handler; },
      getElementById(id) { return elements.get(id) || null; },
      querySelector(selector) {
        if (selector === '.popup-footer' || selector === '.popup-content') return rootHtml ? content : null;
        const goods = selector.match(/data-goodsno="([^"]+)"/);
        return goods && rootHtml.includes('data-goodsno="' + goods[1] + '"') ? root : null;
      },
      querySelectorAll(selector) {
        if (selector === '[data-action="loadAllStockOpt"]') return buttons;
        return selector === '.opt-tab' || selector === '.opt-panel' ? controls() : [];
      }
    },
    Storage: { isFavorite() { return false; }, getOnlineDetails() { return {}; }, setOnlineDetail() {},
      getPriceAlertDevice() { return context.device; } },
    device: { deviceId: 'fixture-device', deviceSecret: 'fixture-secret' },
    setTimeout() { return ++timerId; }, clearTimeout() {},
    setInterval(handler) { intervals.push(handler); },
    addEventListener(type, handler) { listeners[type] = handler; },
    async fetch(url, opts) { calls.push({ url, opts }); return context.network(url, opts); },
    async network(url) {
      const params = new URL(url, 'https://site.test').searchParams;
      return response(detail(params.get('productId') || 'SKU-A'));
    }
  };
  context.window = context;
  vm.createContext(context);
  sources.forEach(source => vm.runInContext(source, context));
  context.UI.esc = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  context.UI.updateCardBadge = () => {};
  context.UI.showSyncStatus = message => statuses.push(message);
  context.App._recordVelocitySnapshot = () => {};
  context.App._productMetaForGoodsNo = () => ({});
  context.App._resumePendingOnlineEnrich = () => {};
  context.PriceAlerts.productControlHtml = () => '';
  context.PriceAlerts.refreshControls = () => {};
  context.PriceAlerts.refreshEntitlement = async () => context.PriceAlerts.entitlement;
  context.PriceAlerts.openAccess = callback => accessCallbacks.push(callback);
  function grant() { context.PriceAlerts.entitlement = { active: true, lifetime, expiresAt: new Date(now + 60000).toISOString() }; }
  if (active) grant(); else context.PriceAlerts.entitlement = { active: false };
  context.HiddenStock.init();
  function open(goodsNo = 'A0001') {
    context.UI.showDetailPopup({ ...detail('SKU-A', '무료 주변 매장'), goodsNo,
      source: 'live', options: [option('SKU-A', [{ name: '무료 주변 매장', qty: 3 }]), option('SKU-B')] }, goodsNo);
  }
  open();
  return { context, ui: context.UI, feature: context.HiddenStock, alerts: context.PriceAlerts,
    root, elements, listeners, calls, accessCallbacks, statuses, grant, open,
    button(index = 0) { return buttons[index]; },
    click(index = 0) {
      const button = buttons[index];
      assert.ok(button, 'the nationwide button is rendered');
      context.UI._handlePopupRootClick({ target: { closest() { return button; } }, preventDefault() {}, stopPropagation() {} });
      return button;
    },
    advance(ms) { now += ms; }, guardTick() { intervals.forEach(handler => handler()); },
    html() { return root.innerHTML + (elements.get('all-stock-panel')?.innerHTML || ''); }
  };
}

test('free nationwide click opens the paywall without any inventory request; direct helpers fail closed', async () => {
  const env = environment({ active: false });
  assert.match(env.html(), /이 옵션 전국 재고 보기 · 유료/);
  env.click();
  await tick();
  assert.equal(env.accessCallbacks.length, 1);
  assert.equal(env.calls.length, 0);
  assert.equal(env.elements.has('all-stock-panel'), false);
  await assert.rejects(env.ui.fetchAllStock('A0001', 'SKU-A'), error => error.status === 402);
  await assert.rejects(env.feature._request({ action: 'all-stores', goodsNo: 'A0001', productId: 'SKU-A' }), error => error.status === 402);
  env.ui.showAllStockPanel(detail('SKU-A'));
  assert.equal(env.calls.length, 0);
  assert.doesNotMatch(env.html(), /유료 전국 매장/);
});

test('a missing authorization module blocks nationwide inventory and uses an available paywall', async () => {
  for (const missing of ['HiddenStock', 'PriceAlerts', 'both']) {
    const env = environment();
    if (missing !== 'PriceAlerts') env.context.HiddenStock = undefined;
    if (missing !== 'HiddenStock') env.context.PriceAlerts = undefined;
    assert.doesNotThrow(() => env.click());
    await assert.rejects(env.ui.fetchAllStock('A0001', 'SKU-A'), error => error.status === 402);
    assert.equal(env.calls.length, 0);
    assert.equal(env.accessCallbacks.length, missing === 'HiddenStock' ? 1 : 0);
    assert.equal(env.elements.has('all-stock-panel'), false);
  }
});

for (const lifetime of [false, true]) {
  test((lifetime ? 'lifetime' : 'unexpired paid') + ' access sends the exact selected SKU through the same-origin credentialed gateway', async () => {
    const env = environment({ lifetime });
    if (lifetime) env.alerts.entitlement.expiresAt = '2000-01-01T00:00:00Z';
    env.ui.switchTab(1);
    env.click(1);
    await tick();
    assert.equal(env.calls.length, 1);
    const { url, opts } = env.calls[0];
    assert.ok(url.startsWith('/api/oliveyoung/hidden-stock?'));
    assert.deepEqual(Object.fromEntries(new URL(url, 'https://site.test').searchParams),
      { action: 'all-stores', goodsNo: 'A0001', productId: 'SKU-B' });
    assert.equal(opts.credentials, 'same-origin');
    assert.equal(opts.headers['X-Price-Alert-Device-Id'], 'fixture-device');
    assert.equal(opts.headers['X-Price-Alert-Device-Secret'], 'fixture-secret');
    assert.doesNotMatch(url, /fixture-device|fixture-secret|run\.app/);
    assert.match(env.html(), /유료 전국 매장/);
    assert.equal(env.accessCallbacks.length, 0);
  });
}

test('granting access resumes the originally selected SKU once without a new click', async () => {
  const env = environment({ active: false });
  env.ui.switchTab(1); env.click(1);
  assert.equal(env.calls.length, 0);
  env.grant(); env.accessCallbacks[0]();
  await tick();
  assert.equal(env.calls.length, 1);
  assert.equal(new URL(env.calls[0].url, 'https://site.test').searchParams.get('productId'), 'SKU-B');
  assert.match(env.html(), /유료 전국 매장/);
});

test('every completed paid click reauthorizes instead of displaying previously cached inventory', async () => {
  const env = environment();
  env.ui._allStockCache['A0001|SKU-A'] = detail('SKU-A', '이전 계정 매장');
  env.click(); await tick();
  assert.equal(env.calls.length, 1);
  assert.doesNotMatch(env.html(), /이전 계정 매장/);
  env.click(); await tick();
  assert.equal(env.calls.length, 2);
});

for (const change of ['expiry', 'revocation', 'device-id', 'device-secret']) {
  test(change + ' clears visible nationwide rows and aborts/discards in-flight results', async () => {
    const env = environment();
    env.click(); await tick();
    assert.match(env.html(), /유료 전국 매장/);
    const pending = deferred();
    env.context.network = () => pending.promise;
    env.click();
    const signal = env.calls[1].opts.signal;
    env.ui._allStockCache['A0001|SKU-A'] = detail('SKU-A');
    if (change === 'expiry') { env.advance(60001); env.guardTick(); }
    if (change === 'revocation') { env.alerts.entitlement.active = false; env.feature.onEntitlementChange(); }
    if (change === 'device-id') { env.context.device.deviceId = 'fixture-next-device'; env.listeners.storage(); }
    if (change === 'device-secret') { env.context.device.deviceSecret = 'fixture-next-secret'; env.listeners.storage(); }
    assert.equal(signal.aborted, true);
    assert.equal(env.feature._premiumRequests.length, 0);
    assert.equal(env.ui._allStockVisible, false);
    assert.equal(env.elements.has('all-stock-panel'), false);
    assert.equal(Object.keys(env.ui._allStockCache).length, 0);
    assert.equal(Object.keys(env.ui._allStockInflight).length, 0);
    assert.equal(Object.keys(env.ui._allStockFailures).length, 0);
    assert.equal(env.button().classList.contains('loading'), false);
    pending.resolve(response(detail('SKU-A', '늦게 도착한 유료 매장')));
    await tick();
    assert.doesNotMatch(env.html(), /유료 전국 매장|늦게 도착한 유료 매장/);
    assert.match(env.html(), /무료 주변 매장/);
    assert.equal(env.accessCallbacks.length, 0, 'discarded responses do not reopen payment');
  });
}

test('expiry clears a completed nationwide panel even with no pending request or hidden-stock panel', async () => {
  const env = environment(); env.click(); await tick();
  assert.equal(env.feature._premiumRequests.length, 0);
  assert.equal(env.feature.panelState, null);
  env.advance(60001); env.guardTick();
  assert.equal(env.elements.has('all-stock-panel'), false);
  assert.match(env.button().textContent, /이 옵션 전국 재고 보기 · 유료/);
});

test('a discarded old-account 401 cannot reopen payment after storage recovery activates a new account', async () => {
  const env = environment();
  const pending = deferred();
  env.context.network = () => pending.promise;
  env.click();
  const oldRequest = env.ui._allStockInflight['A0001|SKU-A'];
  const oldSignal = env.calls[0].opts.signal;
  env.context.device = { deviceId: 'fixture-recovered-device', deviceSecret: 'fixture-recovered-secret' };
  env.listeners.storage();
  assert.equal(oldSignal.aborted, true);
  assert.equal(env.alerts.entitlement, null);
  env.grant();
  const newEntitlement = env.alerts.entitlement;
  env.context.network = async () => response(detail('SKU-A', '새 계정 전국 매장'));
  env.click(); await tick();
  assert.equal(newEntitlement.active, true);
  assert.match(env.html(), /새 계정 전국 매장/);
  pending.resolve(response({ success: false, error: 'device_auth_failed' }, 401));
  await assert.rejects(oldRequest, error => error.status === 401 && error.discarded === true);
  await tick();
  assert.equal(env.alerts.entitlement, newEntitlement);
  assert.equal(env.alerts.entitlement.active, true);
  assert.equal(env.accessCallbacks.length, 0, 'an old discarded denial must not reopen the paywall');
  assert.equal(env.calls.length, 2);
  assert.match(env.html(), /새 계정 전국 매장/);
  assert.match(env.button().textContent, /조회완료/);
});

test('a server access denial clears data, prompts payment and permits immediate retry after reauthorization', async () => {
  for (const status of [401, 402, 403]) {
    const env = environment();
    env.context.network = async () => response({ success: false, error: 'entitlement_required' }, status);
    env.click(); await tick();
    assert.equal(env.alerts.entitlement, null);
    assert.equal(env.accessCallbacks.length, 1);
    assert.equal(env.elements.has('all-stock-panel'), false);
    assert.equal(Object.keys(env.ui._allStockFailures).length, 0);
    assert.equal(env.button().classList.contains('loading'), false);
    assert.match(env.button().textContent, /이 옵션 전국 재고 보기 · 유료/);
    env.grant();
    env.context.network = async () => response(detail('SKU-A'));
    env.accessCallbacks[0](); await tick();
    assert.equal(env.calls.length, 2);
    assert.match(env.html(), /유료 전국 매장/);
  }
});

test('the authenticated gateway Retry-After is honored before a national retry', async () => {
  const env = environment();
  env.context.network = async () => response({ success: false, error: 'stock_rate_limited' }, 429, '45');
  await assert.rejects(env.ui.fetchAllStock('A0001', 'SKU-A'), error => error.status === 429);
  assert.equal(env.calls.length, 1);
  env.advance(30001);
  await assert.rejects(env.ui.fetchAllStock('A0001', 'SKU-A'));
  assert.equal(env.calls.length, 1, 'the server still requires 15 seconds before another request');
  env.advance(15000);
  env.context.network = async () => response(detail('SKU-A'));
  await env.ui.fetchAllStock('A0001', 'SKU-A');
  assert.equal(env.calls.length, 2);
});

for (const change of ['another-option', 'away-and-back', 'closed', 'reopened']) {
  test('payment callback after ' + change + ' cannot replay the old nationwide click', async () => {
    const env = environment({ active: false }); env.click();
    if (change === 'another-option') env.ui.switchTab(1);
    if (change === 'away-and-back') { env.ui.switchTab(1); env.ui.switchTab(0); }
    if (change === 'closed') env.ui.closePopup();
    if (change === 'reopened') { env.ui.closePopup(); env.open(); }
    env.grant(); env.accessCallbacks[0](); await tick();
    assert.equal(env.calls.length, 0);
    assert.equal(env.elements.has('all-stock-panel'), false);
  });
}

test('a free user can still load normal nearby stock and manually retry without sending credentials to Cloud Run', async () => {
  const env = environment({ active: false });
  env.context.network = async url => {
    const data = { ...detail('SKU-A', '무료 주변 매장'), source: 'live' };
    if (url.includes('onlineOnly')) {
      data.source = 'live-online'; data.inventoryScope = 'online'; data.storeLookupStatus = 'skipped';
      data.options = [{ ...option('SKU-A'), storeLookupStatus: 'skipped' }];
    }
    return response(data);
  };
  env.ui.showPopupStockSkeleton({ goodsNo: 'A0001', goodsName: '테스트 상품' });
  await env.context.App._loadRealtimeDetailIntoPopup('A0001', '테스트 상품');
  assert.equal(env.calls.length, 2);
  assert.match(env.html(), /무료 주변 매장/);
  await env.context.App.retryStoreStock('A0001');
  assert.equal(env.calls.length, 3);
  assert.equal(env.accessCallbacks.length, 0);
  for (const { url, opts } of env.calls) {
    assert.ok(url.startsWith(env.context.CONFIG.REALTIME_API));
    assert.doesNotMatch(url, /all=1|all-stores|fixture-device|fixture-secret/);
    assert.equal(Object.keys(opts.headers || {}).some(key => /price-alert/i.test(key)), false);
  }
});

test('rendering and switching normal options do not prefetch nationwide inventory or show payment', () => {
  const env = environment({ active: false });
  env.open(); env.ui.switchTab(1); env.ui.switchTab(0);
  assert.equal(env.calls.length, 0);
  assert.equal(env.accessCallbacks.length, 0);
  assert.match(env.html(), /무료 주변 매장/);
});
