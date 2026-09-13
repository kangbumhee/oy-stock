const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/hidden-stock.js'), 'utf8');
function environment(active = true) {
  const elements = new Map();
  const listeners = {};
  let context;
  function node(id = '') {
    return {
      id, innerHTML: '', hidden: false, dataset: {}, isConnected: true,
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, addEventListener() {},
      contains(value) { return value === this; },
      querySelector() { return this; }, querySelectorAll() { return [this]; },
      focus() { context.document.activeElement = this; },
      remove() { elements.delete(this.id); this.isConnected = false; }
    };
  }
  elements.set('hidden-stock-search', node('hidden-stock-search'));
  context = {
    URL, URLSearchParams, AbortController, Map, Date, Number, Promise, Error, String,
    App: { lat: 37.6152, lng: 126.7156, locationName: '김포 사우' },
    setTimeout, clearTimeout, setInterval() {},
    document: {
      activeElement: null, hidden: false,
      getElementById(id) { return elements.get(id) || null; },
      createElement() { return node(); },
      addEventListener(type, fn) { listeners[type] = fn; },
      body: { classList: { add() {}, remove() {} }, appendChild(item) { elements.set(item.id, item); } }
    },
    addEventListener(type, fn) { listeners[type] = fn; },
    UI: { esc(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); } },
    async fetch(url, opts) {
      context.calls.push({ url, opts, public: true });
      return { ok: true, status: 200, async json() { return context.response; } };
    },
    PriceAlerts: {
      entitlement: active ? { active: true, expiresAt: new Date(Date.now() + 60000).toISOString() } : { active: false },
      _apiHeaders() { return { 'X-Price-Alert-Device-Id': context.deviceId, 'X-Price-Alert-Device-Secret': 'test-device-secret' }; },
      async refreshEntitlement() { return this.entitlement; },
      async _request(url, opts) { context.calls.push({ url, opts }); return context.response; },
      openAccess(callback) { context.accessOpened++; context.accessCallback = callback; }
    },
    deviceId: 'test-device', calls: [], accessOpened: 0,
    response: { success: true, options: [], coverage: { complete: false } }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  context.HiddenStock.init();
  return { context, feature: context.HiddenStock, elements, listeners, html: () => elements.get('hidden-stock-search').innerHTML };
}
const option = { goodsNo: 'fixture-product', productId: 'fixture-sku', optionNumber: '001', name: '비공개 테스트 옵션', goodsName: '테스트 상품', hidden: true };

function accessDialogEnvironment() {
  const env = environment(false);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/alerts.js'), 'utf8'), env.context);
  function element(id) {
    const classes = new Set();
    const item = { id, textContent: '', disabled: false, tabIndex: 0, visible: true, isConnected: true, attributes: {}, events: {},
      classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); } },
      setAttribute(name, value) { item.attributes[name] = value; },
      addEventListener(name, handler) { item.events[name] = handler; },
      getClientRects() { return item.visible ? [{}] : []; },
      focus() { env.context.document.activeElement = item; }
    };
    env.elements.set(id, item);
    return item;
  }
  const title = element('price-alert-title');
  const modal = element('price-alert-modal');
  const form = element('price-alert-form');
  const close = element('fixture-close');
  const promo = element('price-alert-promo-input');
  const last = element('price-alert-entitlement-refresh');
  const origin = element('fixture-image-button');
  const controls = [close, promo, last];
  modal.classList.add('hidden');
  modal.querySelector = selector => selector === '.price-alert-close' ? close : null;
  form.querySelectorAll = () => controls;
  const alerts = env.context.PriceAlerts;
  alerts._ensureModal = () => {};
  alerts._setModalError = () => {};
  alerts._renderEntitlement = () => {};
  alerts.refreshEntitlement = () => {};
  alerts._loadModalOptions = () => { throw new Error('unexpected product option request'); };
  origin.focus();
  function key(key, shiftKey = false) {
    const event = { key, shiftKey, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    form.events.keydown(event);
    return event;
  }
  return { ...env, alerts, title, modal, form, close, promo, last, origin, controls, key, element };
}

test('free search and option previews show product images, names and reference prices without a payment prompt', async () => {
  const env = environment(false);
  env.context.PriceAlerts.refreshEntitlement = () => { throw new Error('preview must not wait for entitlement'); };
  env.context.App.products = [{ goodsNumber: option.goodsNo, priceToPay: 23800 }];
  env.context.response = { options: [{ ...option, image: 'https://image.oliveyoung.co.kr/product.png' }] };
  await env.feature.search('사용자 검색어');
  assert.equal(env.context.calls.length, 1);
  assert.equal(env.context.calls[0].public, true);
  assert.equal(env.context.calls[0].opts.credentials, 'omit');
  assert.equal(env.context.calls[0].opts.cache, 'no-store');
  assert.deepEqual(Object.keys(env.context.calls[0].opts.headers), ['Accept']);
  assert.match(env.html(), /비공개 테스트 옵션/);
  assert.match(env.html(), /<img data-hidden-image/);
  assert.match(env.html(), /class="hidden-stock-options grid"/);
  assert.match(env.html(), /class="hidden-stock-option card"/);
  assert.match(env.html(), /<h3 id="hidden-stock-search-title">온라인에 없는 매장 상품<\/h3>/);
  assert.match(env.html(), /실제 옵션·매장 가격과 다를 수 있습니다/);
  assert.match(env.html(), /<button type="button" class="card-img hidden-stock-preview"[^>]+aria-haspopup="dialog"[^>]+aria-label="테스트 상품 · 비공개 테스트 옵션 · 근처 매장 재고 확인, 유료 이용자 전용"/);
  const cards = env.feature._optionRows(env.feature.searchState.options, 'search');
  assert.match(cards, /class="card-body"/);
  assert.match(cards, /class="card-name hidden-stock-card-name"[^>]*>테스트 상품<\/button>/);
  assert.match(cards, /class="hidden-stock-card-option"[^>]*>비공개 테스트 옵션<\/p>/);
  assert.match(cards, /23,800원/);
  assert.match(cards, /온라인 상품 참고가/);
  assert.doesNotMatch(cards, /hidden-stock-button|data-action="buyNow"/);
  assert.doesNotMatch(env.html(), /data-hidden-action="access"/);
  await env.feature.openOptions('public-product');
  assert.match(env.elements.get('hidden-stock-panel').innerHTML, /비공개 테스트 옵션/);
  assert.match(env.elements.get('hidden-stock-panel').innerHTML, /class="hidden-stock-options grid"/);
  assert.match(env.elements.get('hidden-stock-panel').innerHTML, /온라인에 없는 매장 상품/);
  assert.match(env.elements.get('hidden-stock-panel').innerHTML, /23,800원/);
  assert.doesNotMatch(env.elements.get('hidden-stock-panel').innerHTML, /<h4|hidden-stock-product/);
  assert.equal(env.context.accessOpened, 0);
  assert.equal(env.context.calls.length, 2);
  assert.doesNotMatch(env.feature.productButtonHtml('fixture-product'), /이용권/);
  env.feature._guard();
  env.feature.onEntitlementChange();
  assert.match(env.html(), /비공개 테스트 옵션/);
  assert.equal(env.feature.panelState.mode, 'options');
});

test('authorized pages merge by goodsNo + optionNumber + SKU and preserve pagination', async () => {
  const env = environment();
  env.context.response = { options: [option, option], nextCursor: 'signed-page-2', coverage: { complete: false } };
  await env.feature.search('미스트');
  assert.equal(env.feature.searchState.options.length, 1);
  assert.match(env.html(), /일부 범위/);
  env.context.response = { options: [option, { ...option, goodsNo: 'other-product' }], nextCursor: null, coverage: { complete: true } };
  await env.feature.loadSearch();
  assert.equal(env.feature.searchState.options.length, 2);
  assert.match(env.context.calls[1].url, /cursor=signed-page-2/);
  assert.ok(env.context.calls[0].opts.signal);
  assert.match(env.html(), /이번 조회 범위 확인 완료/);
});

test('first requests omit empty cursors and options requests never send a cursor', async () => {
  const env = environment();
  await env.feature.search('미스트');
  assert.equal(new URL('https://local.test' + env.context.calls[0].url).searchParams.has('cursor'), false);
  await env.feature.openOptions('fixture-product');
  assert.equal(new URL('https://local.test' + env.context.calls[1].url).searchParams.has('cursor'), false);
  await env.feature._request({ action: 'options', goodsNo: 'fixture-product', cursor: 'unused-cursor' });
  assert.equal(new URL('https://local.test' + env.context.calls[2].url).searchParams.has('cursor'), false);
});

test('network errors remain errors, preserving loaded partial rows instead of asserting no stock', async () => {
  const env = environment();
  env.context.response = { options: [option], nextCursor: 'cursor' };
  await env.feature.search('미스트');
  env.context.fetch = async () => { throw new Error('unavailable'); };
  await env.feature.loadSearch();
  assert.match(env.html(), /비공개 테스트 옵션/);
  assert.match(env.html(), /품절을 뜻하지 않습니다/);
  assert.match(env.html(), /다시 조회/);
});

test('normal-option full-store access is gated and unknown store quantities differ from zero', async () => {
  const free = environment(false);
  await free.feature.openStores(option);
  assert.equal(free.context.accessOpened, 1);
  assert.equal(free.context.calls.length, 0);
  const env = environment();
  env.context.response = { stores: [{ code: 'a', name: 'A 매장', qty: null }, { code: 'b', name: 'B 매장', qty: 0 }], nextCursor: 'stores-2' };
  await env.feature.openStores(option);
  assert.match(env.elements.get('hidden-stock-panel').innerHTML, /수량 확인 불가/);
  assert.match(env.elements.get('hidden-stock-panel').innerHTML, /조회 시점 재고 0개/);
  assert.match(env.elements.get('hidden-stock-panel').innerHTML, /온라인 판매 여부 확인 불가/);
  env.context.response = { stores: [{ code: 'a', name: 'A 매장', qty: 3 }, { code: 'c', name: 'C 매장', qty: 4 }], coverage: { complete: false } };
  await env.feature.loadPanel();
  assert.equal(env.feature.panelState.stores.length, 3);
  assert.equal(env.feature.panelState.stores[0].qty, 3);
  assert.match(env.context.calls[1].url, /cursor=stores-2/);
});

test('online sold-out normal options advertise paid nearby lookup without claiming offline availability', () => {
  const env = environment();
  const soldOut = { ...option, hidden: false, onlineQty: 0 };
  const html = env.feature.normalStoreButtonHtml(option.goodsNo, soldOut, {});
  assert.match(html, /data-scope="nearby"/);
  assert.match(html, /온라인 품절 옵션 · 근처 매장 재고 확인 · 이용권/);
  assert.match(html, /온라인 품절과 매장 재고는 별개/);
  assert.doesNotMatch(html, /판매중|재고 있음/);
  for (const onlineQty of [null, undefined, '', ' ', false, -1, 'invalid', 5]) {
    assert.equal(env.feature.isOnlineSoldOutOption({ onlineQty }), false);
    assert.match(env.feature.normalStoreButtonHtml(option.goodsNo, { ...option, onlineQty }, {}), /data-scope="national"/);
  }
  assert.equal(env.feature.isOnlineSoldOutOption({ onlineQty: '0' }), true);
  assert.equal(env.feature.isOnlineSoldOutOption({ soldOut: true }), true);
});

test('sold-out normal option CTA gates free access then resumes exact SKU nearby and nationwide', async () => {
  const env = environment(false);
  const dataset = { hiddenAction: 'normal-stores', scope: 'nearby', goodsno: 'A000000227778',
    productid: '8809923821608', optionnumber: '008', optionname: '[립칠러 미니 증정] 인 살몬', goodsname: '투슬래시포 립 쉐이퍼' };
  env.feature._handleAction({ dataset });
  assert.equal(env.context.accessOpened, 1);
  assert.equal(env.context.calls.length, 0);
  env.context.PriceAlerts.entitlement = { active: true, lifetime: true };
  env.context.response = { stores: [{ code: 'fixture-near', name: '모의 매장', qty: 2 }], coverage: { complete: true } };
  await env.context.accessCallback();
  const nearby = new URL(env.context.calls[0].url, 'https://fixture.test');
  assert.equal(nearby.searchParams.get('goodsNo'), dataset.goodsno);
  assert.equal(nearby.searchParams.get('productId'), dataset.productid);
  assert.equal(nearby.searchParams.get('scope'), 'nearby');
  assert.equal(env.feature.panelState.option.optionNumber, '008');
  assert.match(env.elements.get('hidden-stock-panel').innerHTML, /전국 재고 조회/);
  await env.feature.openNational();
  const national = new URL(env.context.calls[1].url, 'https://fixture.test');
  assert.equal(national.searchParams.get('productId'), dataset.productid);
  assert.equal(national.searchParams.get('scope'), 'national');
});

test('expired entitlement clears paid inventory but preserves public previews before any further stock request', async () => {
  const env = environment();
  env.context.response = { options: [option] };
  await env.feature.search('미스트');
  await env.feature.openOptions(option.goodsNo);
  const optionsParent = env.feature.panelState;
  env.context.response = { stores: [{ code: 'private-store', name: '유료매장', qty: 7 }] };
  await env.feature.openStores(option);
  const stockState = env.feature.panelState;
  env.context.PriceAlerts.entitlement.expiresAt = new Date(Date.now() - 1).toISOString();
  env.feature._guard();
  assert.equal(stockState.stores.length, 0);
  assert.equal(env.feature.panelState, optionsParent);
  assert.match(env.html(), /비공개 테스트 옵션/);
  assert.doesNotMatch(env.elements.get('hidden-stock-panel').innerHTML, /유료매장|재고 7개/);
  await assert.rejects(env.feature._request({ action: 'stores' }), /access_required/);
  assert.equal(env.context.calls.length, 3);
});

test('continuous store lookup is sequential, bounded to 60 requests, and honestly leaves a continuation', async () => {
  const env = environment();
  env.context.response = { stores: [], nextCursor: 'next' };
  await env.feature.openStores(option, 'national');
  let inFlight = 0, maxInFlight = 0, calls = 0;
  env.feature._pace = async () => {};
  env.context.PriceAlerts._request = async () => {
    calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(setImmediate);
    inFlight--;
    return { stores: [{ code: 'same', name: '같은 매장', qty: 1 }], nextCursor: 'next' };
  };
  const task = env.feature.startContinuousStores();
  await env.feature.startContinuousStores();
  await task;
  assert.equal(calls, 60);
  assert.equal(maxInFlight, 1);
  assert.equal(env.feature.panelState.stores.length, 1);
  assert.equal(env.feature.panelState.autoLimited, true);
  assert.match(env.elements.get('hidden-stock-panel').innerHTML, /아직 남은 범위/);
  assert.doesNotMatch(env.elements.get('hidden-stock-panel').innerHTML, /범위 확인 완료/);
});

test('continuous store pause stops after in-flight page and close prevents late repaint', async () => {
  for (const action of ['pause', 'close']) {
    const env = environment();
    env.context.response = { stores: [], nextCursor: 'next' };
    await env.feature.openStores(option, 'national');
    let resolve, calls = 0;
    env.context.PriceAlerts._request = () => { calls++; return new Promise(r => { resolve = r; }); };
    const task = env.feature.startContinuousStores();
    if (action === 'pause') env.feature.pauseContinuousStores();
    else env.feature.closePanel();
    resolve({ stores: [], nextCursor: 'next' });
    await task;
    assert.equal(calls, 1);
    if (action === 'pause') assert.equal(env.feature.panelState.auto, false);
    else assert.equal(env.elements.has('hidden-stock-panel'), false);
  }
});

test('continuous store lookup stops at a request error and does not claim completed coverage', async () => {
  const env = environment();
  env.context.response = { stores: [], nextCursor: 'next' };
  await env.feature.openStores(option, 'national');
  let calls = 0;
  env.context.PriceAlerts._request = async () => { calls++; throw new Error('upstream unavailable'); };
  await env.feature.startContinuousStores();
  assert.equal(calls, 1);
  assert.equal(env.feature.panelState.auto, false);
  assert.match(env.elements.get('hidden-stock-panel').innerHTML, /조회하지 못했습니다/);
});

test('device rotation invalidates in-flight premium data and cannot repaint it', async () => {
  const env = environment();
  env.context.response = { options: [option] };
  await env.feature.search('미스트');
  let resolve;
  env.context.PriceAlerts._request = () => new Promise(r => { resolve = r; });
  const pending = env.feature.openStores(option);
  await new Promise(setImmediate);
  env.context.deviceId = 'new-device';
  env.listeners.storage();
  resolve({ stores: [{ code: 'private', qty: 8 }] });
  await pending;
  assert.equal(env.feature.panelState, null);
  assert.equal(env.feature.searchState.options.length, 1);
  assert.equal(env.context.PriceAlerts.entitlement, null);
  assert.match(env.html(), /비공개 테스트 옵션/);
});

test('server authorization failure clears all premium rows and closes panel', async () => {
  for (const status of [401, 402, 403]) {
    const env = environment();
    env.context.response = { options: [option] };
    await env.feature.search('미스트');
    env.context.PriceAlerts._request = async () => { const e = new Error('denied'); e.status = status; throw e; };
    await env.feature.openStores(option);
    assert.equal(env.feature.searchState.options.length, 1);
    assert.equal(env.feature.panelState, null);
    assert.equal(env.elements.has('hidden-stock-panel'), false);
    assert.match(env.html(), /비공개 테스트 옵션/);
  }
});

test('lifetime access still requires active server entitlement; pagehide clears premium data', async () => {
  const env = environment();
  env.context.PriceAlerts.entitlement = { active: true, lifetime: true };
  env.context.response = { options: [option] };
  await env.feature.search('미스트');
  assert.equal(env.feature.searchState.options.length, 1);
  env.context.response = { stores: [{ code: 'private', qty: 8 }] };
  await env.feature.openStores(option);
  const state = env.feature.panelState;
  env.listeners.pagehide();
  assert.equal(env.feature.searchState.options.length, 1);
  assert.equal(state.stores.length, 0);
  assert.equal(env.feature.panelState, null);
  env.context.PriceAlerts.entitlement.active = false;
  assert.equal(env.feature._hasAccess(), false);
});

test('premium markup escapes option text and no premium data is persisted or baked into public assets', async () => {
  const env = environment();
  env.context.response = { options: [{ ...option, name: '<img src=x onerror=alert(1)>' }] };
  await env.feature.search('미스트');
  assert.match(env.html(), /&lt;img/);
  assert.doesNotMatch(env.html(), /<img src=x/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|caches\.put|8800289469145|A000000255680/);
  const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
  assert.match(sw, /url\.pathname === '\/api\/oliveyoung\/hidden-stock'\) return/);
  const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  for (const asset of ['js/alerts.js', 'js/hidden-stock.js', 'js/ui.js', 'js/app.js', 'js/config.js', 'css/style.css']) {
    const assetVersion = index.match(new RegExp('/' + asset.replace(/\./g, '\\.') + '\\?v=([^"\']+)'))[1];
    assert.ok(sw.includes('/' + asset + '?v=' + assetVersion), asset + ' must use the same version in the page and service worker');
  }
});

test('dedicated access dialog states paid-only access, focuses close and restores the image before continuing', () => {
  const env = accessDialogEnvironment();
  const { alerts } = env;
  let continued = 0;
  alerts.openAccess(() => { assert.equal(env.context.document.activeElement, env.origin); continued++; });
  assert.equal(alerts.modalState.accessOnly, true);
  assert.equal(alerts.modalState.goodsNo, undefined);
  assert.equal(alerts.modalState.returnFocus, env.origin);
  assert.equal(env.title.textContent, '유료 이용자만 사용 가능합니다');
  assert.equal(env.context.document.activeElement, env.close);
  assert.equal(env.modal.classList.contains('hidden'), false);
  assert.equal(env.modal.attributes['aria-hidden'], 'false');
  alerts.entitlement = { active: true, lifetime: true };
  alerts._continueAlertSetup(alerts.modalState);
  assert.equal(continued, 1);
  assert.equal(alerts.modalState, null);
  assert.equal(env.modal.classList.contains('hidden'), true);
  assert.equal(env.modal.attributes['aria-hidden'], 'true');
});

test('access dialog Tab loops through visible enabled controls and keeps focus inside if none remain', () => {
  const env = accessDialogEnvironment();
  env.alerts.openAccess();
  const disabled = env.element('fixture-disabled');
  disabled.disabled = true;
  const hidden = env.element('fixture-hidden');
  hidden.visible = false;
  const untabbable = env.element('fixture-untabbable');
  untabbable.tabIndex = -1;
  env.controls.push(disabled, hidden, untabbable);
  env.last.focus();
  assert.equal(env.key('Tab').prevented, true);
  assert.equal(env.context.document.activeElement, env.close);
  assert.equal(env.key('Tab', true).prevented, true);
  assert.equal(env.context.document.activeElement, env.last);
  env.promo.focus();
  assert.equal(env.key('Tab').prevented, false, 'normal forward focus movement stays native');
  env.origin.focus();
  assert.equal(env.key('Tab').prevented, true);
  assert.equal(env.context.document.activeElement, env.close);
  env.controls.forEach(control => { control.disabled = true; });
  assert.equal(env.key('Tab').prevented, true);
  assert.equal(env.context.document.activeElement, env.form);
  assert.equal(env.form.attributes.tabindex, '-1');
});

test('access Escape respects loading, restores connected image focus, and does not affect ordinary alert dialogs', () => {
  const env = accessDialogEnvironment();
  env.alerts.openAccess();
  const state = env.alerts.modalState;
  env.alerts.loading = true;
  const busyEscape = env.key('Escape');
  assert.equal(busyEscape.prevented, true);
  assert.equal(busyEscape.stopped, true);
  assert.equal(env.alerts.modalState, state);
  assert.equal(env.modal.classList.contains('hidden'), false);
  env.alerts.loading = false;
  env.key('Escape');
  assert.equal(env.alerts.modalState, null);
  assert.equal(env.context.document.activeElement, env.origin);
  env.alerts.openAccess();
  env.origin.isConnected = false;
  env.key('Escape');
  assert.equal(env.alerts.modalState, null);
  assert.equal(env.context.document.activeElement, env.close, 'removed image is not refocused');
  const ordinary = { accessOnly: false, goodsNo: 'ordinary-product' };
  env.alerts.modalState = ordinary;
  env.last.focus();
  assert.equal(env.key('Tab').prevented, false);
  const ordinaryEscape = env.key('Escape');
  assert.equal(ordinaryEscape.prevented, false);
  assert.equal(ordinaryEscape.stopped, false);
  assert.equal(env.alerts.modalState, ordinary);
  assert.equal(env.context.document.activeElement, env.last);
});

test('access-only checkout keeps hidden target-price input disabled and not required', () => {
  const env = environment();
  const headers = env.context.PriceAlerts._apiHeaders;
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/alerts.js'), 'utf8'), env.context);
  const target = { disabled: false, required: true };
  env.elements.set('price-alert-target-input', target);
  const alerts = env.context.PriceAlerts;
  alerts._apiHeaders = headers;
  alerts.modalState = { accessOnly: true };
  alerts.entitlement = { active: true, lifetime: true };
  alerts._renderEntitlement();
  assert.equal(target.disabled, true);
  assert.equal(target.required, false);
});

test('official images have safe src, useful alt and dimensions; untrusted or missing images use fallback', () => {
  const env = environment();
  const html = env.feature._imageHtml({ ...option, image: 'https://image.oliveyoung.co.kr/product.png' });
  assert.match(html, /<img data-hidden-image="1"/);
  assert.match(html, /width="320" height="320"/);
  assert.match(html, /테스트 상품 참고 이미지/);
  for (const image of ['', 'javascript:alert(1)', 'https://oliveyoung.co.kr.evil.test/x', 'https://user:pass@image.oliveyoung.co.kr/x']) {
    const invalid = env.feature._imageHtml({ ...option, image });
    assert.doesNotMatch(invalid, /<img /);
    assert.match(invalid, /이미지 준비 중/);
  }
});

test('product cards show names and sourced prices but never expose stock or unrelated normal purchase actions', () => {
  const env = environment(false);
  env.context.App.products = [{ goodsNo: option.goodsNo, priceToPay: 23800 }];
  const html = env.feature._optionRows([{ ...option, image: 'https://image.oliveyoung.co.kr/product.png',
    price: 9900, qty: 12, stores: [{ name: '테스트 비공개 매장', qty: 12 }] }], 'search');
  assert.match(html, /data-hidden-action="stores"/);
  assert.match(html, /data-source="search" data-index="0"/);
  assert.doesNotMatch(html, /data-action=|바로구매|재고 12|9,?900|테스트 비공개 매장/);
  assert.equal((html.match(/<button /g) || []).length, 2, 'both image and visible product name use the paid inventory gate');
  assert.equal((html.match(/data-hidden-action="stores"/g) || []).length, 2);
  assert.match(html, />테스트 상품<\/button>/);
  assert.match(html, />비공개 테스트 옵션<\/p>/);
  assert.match(html, /23,800원/);
  assert.match(html, /온라인 상품 참고가/);
  assert.match(html, /aria-label="테스트 상품 · 비공개 테스트 옵션/);
  const css = fs.readFileSync(path.join(root, 'public/css/style.css'), 'utf8');
  assert.match(css, /\.hidden-stock-option \.hidden-stock-preview\{[^}]*padding:0[^}]*border:0/);
  assert.match(css, /\.hidden-stock-option:focus-within\{outline:3px solid/);
  assert.match(css, /\.hidden-stock-option \.hidden-stock-image img\{object-fit:contain/);
});

test('reference prices accept only bounded positive whole won amounts', () => {
  const env = environment(false);
  for (const value of [1, 23800, 100000000, '23800', '00023800']) {
    assert.equal(env.feature._positivePrice(value), Number(value));
  }
  for (const value of [0, -1, 1.5, 100000001, NaN, Infinity, null, undefined, true, false,
    '', '0', '-1', '1.5', '23,800', ' 23800 ', '1e4', '23800원', [], {}, '<script>']) {
    assert.equal(env.feature._positivePrice(value), null, String(value));
  }
});

test('exact SKU option prices take priority without turning an online reference into a store price', () => {
  const env = environment(false);
  env.context.App.products = [{ goodsNumber: option.goodsNo, priceToPay: 23800 }];
  env.context.App.detailData = { products: { [option.goodsNo]: {
    goodsNo: option.goodsNo, price: 33300, updatedAt: '2026-09-13T05:00:00.000Z',
    options: [{ productId: 'another-sku', optionNumber: '001', priceToPay: 1 },
      { productId: option.productId, optionNumber: option.optionNumber, priceToPay: '21900' }]
  } } };
  const price = env.feature._cardPrice(option);
  assert.equal(price.amount, 21900);
  assert.equal(price.label, '온라인 옵션 참고가');
  const html = env.feature._cardPriceHtml(option);
  assert.match(html, /21,900원/);
  assert.match(html, /온라인 옵션 참고가/);
  assert.doesNotMatch(html, /매장 판매가|매장 가격|23,800|33,300/);
  delete env.context.App.detailData.products[option.goodsNo].options[1].optionNumber;
  assert.equal(env.feature._cardPrice(option).amount, 21900, 'exact SKU may be used if no option number contradicts it');
});

test('same SKU with a conflicting option number is never used as the selected option price', () => {
  const env = environment(false);
  env.context.App.detailData = { products: { [option.goodsNo]: {
    goodsNo: option.goodsNo,
    options: [{ productId: option.productId, optionNumber: 'other-option', priceToPay: 1900 }]
  } } };
  assert.equal(env.feature._cardPrice(option).amount, null);
  assert.equal(env.feature._cardPrice(option).label, '매장 가격 확인 필요');
  env.context.App.products = [{ goodsNo: option.goodsNo, priceToPay: 23800 }];
  assert.equal(env.feature._cardPrice(option).amount, 23800);
  assert.equal(env.feature._cardPrice(option).label, '온라인 상품 참고가', 'product fallback remains explicitly different from an exact option price');
});

test('reference price fallback is limited to the same goods number and labels collected prices separately', () => {
  const env = environment(false);
  env.context.App.products = [{ goodsNo: 'other-product', priceToPay: 7777 },
    { goodsNumber: option.goodsNo, priceToPay: 23800 }];
  env.context.App.detailData = { products: { [option.goodsNo]: {
    goodsNo: option.goodsNo, price: 33300, options: []
  } } };
  assert.equal(env.feature._cardPrice(option).amount, 23800);
  assert.equal(env.feature._cardPrice(option).label, '온라인 상품 참고가');
  env.context.App.products.pop();
  assert.equal(env.feature._cardPrice(option).amount, 33300);
  assert.equal(env.feature._cardPrice(option).label, '최근 수집 참고가');
  env.context.App.detailData.products[option.goodsNo].goodsNo = 'other-product';
  env.context.App.detailData.products[option.goodsNo].options = [
    { productId: option.productId, optionNumber: option.optionNumber, priceToPay: 9999 }
  ];
  assert.equal(env.feature._cardPrice(option).amount, null, 'a mismatched detail payload cannot supply even an otherwise matching SKU');
  assert.match(env.feature._cardPriceHtml(option), /매장 가격 확인 필요/);
  assert.doesNotMatch(env.feature._cardPriceHtml(option), /0원|7,777|9,999|33,300/);
});

test('invalid, unrelated and unsourced values never become a hidden option card price', () => {
  const env = environment(false);
  env.context.App.products = [null, undefined, { goodsNumber: option.goodsNo, priceToPay: 0 }];
  env.context.App.detailData = { products: { [option.goodsNo]: {
    goodsNo: option.goodsNo, price: -1,
    options: [null, undefined, { productId: 'different-sku', optionNumber: option.optionNumber, priceToPay: 12900 },
      { productId: option.productId, optionNumber: option.optionNumber, price: 9900, priceToPay: null }]
  } } };
  const unknown = env.feature._cardPrice({ ...option, price: 9900, priceToPay: 7900 });
  assert.equal(unknown.amount, null);
  assert.equal(unknown.label, '매장 가격 확인 필요');
  assert.equal(env.feature._cardPrice({ ...option, productId: '' }).amount, null, 'a missing SKU cannot match an option price');
  delete env.context.App;
  assert.equal(env.feature._cardPrice(option).amount, null, 'the preview can render before the main app metadata arrives');
});

test('late reference price updates change only price nodes and preserve image focus, scroll and paid dialogs', () => {
  const env = environment(false);
  function priceNode(index) {
    let html = '', writes = 0;
    return { dataset: { hiddenPriceIndex: String(index) },
      get innerHTML() { return html; }, set innerHTML(value) { html = value; writes++; },
      get writes() { return writes; } };
  }
  const searchPrice = priceNode(0), unknownPrice = priceNode(9), panelPrice = priceNode(0);
  const root = env.elements.get('hidden-stock-search');
  const imageButton = { isConnected: true };
  root.innerHTML = '<fixture-search-card-with-image-button>';
  root.scrollTop = 500;
  root.querySelectorAll = selector => {
    assert.equal(selector, '[data-hidden-price-index]');
    return [searchPrice, unknownPrice];
  };
  const panel = { innerHTML: '<fixture-options-dialog>', scrollTop: 250,
    querySelectorAll: () => [panelPrice] };
  env.elements.set('hidden-stock-panel', panel);
  env.feature.searchState = { mode: 'search', options: [option] };
  env.feature.panelState = { mode: 'options', options: [option] };
  env.context.document.activeElement = imageButton;
  env.context.App.products = [{ goodsNumber: option.goodsNo, priceToPay: 23800 }];
  env.feature._renderSearch = () => assert.fail('price refresh must not rebuild image buttons');
  env.feature._renderPanel = () => assert.fail('price refresh must not rebuild an open dialog');
  env.feature.refreshCardPrices();
  assert.match(searchPrice.innerHTML, /23,800원/);
  assert.match(panelPrice.innerHTML, /23,800원/);
  assert.equal(unknownPrice.writes, 0);
  assert.equal(env.context.document.activeElement, imageButton);
  assert.equal(root.innerHTML, '<fixture-search-card-with-image-button>');
  assert.equal(panel.innerHTML, '<fixture-options-dialog>');
  assert.equal(root.scrollTop, 500);
  assert.equal(panel.scrollTop, 250);
  env.feature.refreshCardPrices();
  assert.equal(searchPrice.writes, 1, 'unchanged reference prices avoid DOM rewrites');
  assert.equal(panelPrice.writes, 1);
  env.feature.panelState = { mode: 'stores', stores: [{ code: 'paid-store', qty: 7 }] };
  env.context.App.products[0].priceToPay = 21900;
  env.feature.refreshCardPrices();
  assert.match(searchPrice.innerHTML, /21,900원/);
  assert.match(panelPrice.innerHTML, /23,800원/, 'paid inventory dialog is not touched');
  assert.equal(panelPrice.writes, 1);
  assert.equal(env.context.document.activeElement, imageButton);
  assert.equal(env.context.calls.length, 0, 'existing public metadata is reused without network requests');
});

test('paid inventory popup restores selected product image and details with a separate nationwide footer', async () => {
  const env = environment();
  const selected = { ...option, image: 'https://image.oliveyoung.co.kr/product.png' };
  env.context.response = { stores: [{ code: 'near', name: '근처 매장', dist: 0.25, qty: 3 }], coverage: { complete: true } };
  await env.feature.openStores(selected);
  const html = env.elements.get('hidden-stock-panel').innerHTML;
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /hidden-stock-option-summary hidden-stock-selected/);
  assert.match(html, /<img data-hidden-image="1" src="https:\/\/image.oliveyoung.co.kr\/product.png"/);
  assert.match(html, /<p class="hidden-stock-product">테스트 상품<\/p><h4>비공개 테스트 옵션<\/h4>/);
  assert.match(html, /재고 3개/);
  assert.ok(html.indexOf('data-hidden-action="national-stores"') > html.indexOf('근처 매장</strong>'));
});

test('hidden option opens nearby first at the selected location and sorts known distances before unknowns', async () => {
  const env = environment();
  env.context.response = { stores: [{ code: 'far', dist: 5, qty: 0 }, { code: 'unknown', dist: null, qty: null },
    { code: 'near', dist: 0.37, qty: 2 }], coverage: { complete: true } };
  await env.feature.openStores(option);
  const params = new URL('https://local.test' + env.context.calls[0].url).searchParams;
  assert.equal(params.get('scope'), 'nearby');
  assert.equal(params.get('lat'), '37.6152');
  assert.equal(params.get('lng'), '126.7156');
  assert.deepEqual(Array.from(env.feature.panelState.stores, s => s.code), ['near', 'far', 'unknown']);
  const html = env.elements.get('hidden-stock-panel').innerHTML;
  assert.match(html, /김포 사우 기준/);
  assert.match(html, /0.37km/);
  assert.match(html, /거리 미확인/);
  assert.match(html, /data-hidden-action="national-stores"/);
  assert.ok(html.indexOf('national-stores') > html.indexOf('</ul>'));
  await env.feature.startContinuousStores();
  assert.equal(env.context.calls.length, 1, 'no national lookup before explicit click');
});

test('national action has a separate cursor and restores the nearby snapshot without a request', async () => {
  const env = environment();
  env.context.response = { stores: [{ code: 'near', dist: 0.1 }], nextCursor: 'nearby-cursor' };
  await env.feature.openStores(option);
  const nearby = env.feature.panelState;
  env.context.response = { stores: [{ code: 'national', dist: 300 }], nextCursor: null, coverage: { complete: true } };
  await env.feature.openNational();
  const params = new URL('https://local.test' + env.context.calls[1].url).searchParams;
  assert.equal(params.get('scope'), 'national');
  assert.equal(params.has('cursor'), false);
  assert.equal(params.get('lng'), '126.7156');
  assert.equal(env.feature.panelState.stores[0].code, 'national');
  env.feature.backPanel('nearby');
  assert.equal(env.feature.panelState, nearby);
  assert.equal(env.feature.panelState.nextCursor, 'nearby-cursor');
  assert.equal(env.context.calls.length, 2);
});

test('missing location does not invent nearest results but permits an explicit national lookup', async () => {
  const env = environment();
  env.context.App = {};
  await env.feature.openStores(option);
  assert.equal(env.context.calls.length, 0);
  assert.match(env.elements.get('hidden-stock-panel').innerHTML, /상단에서 지역을 선택/);
  env.context.response = { stores: [], coverage: { complete: false } };
  await env.feature.openNational();
  assert.equal(env.context.calls.length, 1);
  assert.match(env.context.calls[0].url, /scope=national/);
});

test('leaving national lookup discards its delayed result and does not pollute the nearby list', async () => {
  const env = environment();
  env.context.response = { stores: [{ code: 'near', dist: 1 }] };
  await env.feature.openStores(option);
  let resolve;
  env.context.PriceAlerts._request = () => new Promise(r => { resolve = r; });
  const pending = env.feature.openNational();
  env.feature.backPanel('nearby');
  resolve({ stores: [{ code: 'far' }], nextCursor: 'next' });
  await pending;
  assert.equal(env.feature.panelState.scope, 'nearby');
  assert.deepEqual(Array.from(env.feature.panelState.stores, s => s.code), ['near']);
});

test('nearby displays ten stores before the national footer and expands cached rows without extra requests', async () => {
  const env = environment();
  env.context.response = { stores: Array.from({length:25}, (_,i)=>({code:String(i),name:'매장'+i,dist:i})), coverage:{complete:true} };
  await env.feature.openStores(option);
  assert.equal((env.elements.get('hidden-stock-panel').innerHTML.match(/<li>/g)||[]).length, 10);
  assert.match(env.elements.get('hidden-stock-panel').innerHTML, /근처 매장 더 보기/);
  await env.feature.showNearbyMore();
  assert.equal((env.elements.get('hidden-stock-panel').innerHTML.match(/<li>/g)||[]).length, 20);
  assert.equal(env.context.calls.length, 1);
  await env.feature.showNearbyMore();
  assert.equal((env.elements.get('hidden-stock-panel').innerHTML.match(/<li>/g)||[]).length, 25);
  assert.doesNotMatch(env.elements.get('hidden-stock-panel').innerHTML, /근처 매장 더 보기/);
});

test('public previews work without the payment module and malformed public replies show an error', async () => {
  const env = environment(false);
  delete env.context.PriceAlerts;
  env.context.response = { options: [option] };
  await env.feature.search('미스트');
  await env.feature.openOptions(option.goodsNo);
  assert.equal(env.feature.searchState.options.length, 1);
  assert.equal(env.feature.panelState.options.length, 1);
  env.context.fetch = async () => ({ ok: false, status: 503, async json() { return { success: false, error: 'unavailable' }; } });
  await env.feature.loadSearch();
  assert.match(env.html(), /품절을 뜻하지 않습니다/);
  assert.match(env.html(), /비공개 테스트 옵션/);
});

test('inventory click opens payment only then resumes the exact selected option on grant', async () => {
  const env = environment(false);
  const selected = { ...option, productId: 'selected-sku', name: '선택한 옵션' };
  env.context.response = { options: [option, selected] };
  await env.feature.search('미스트');
  const preview = env.feature.searchState;
  const originFocus = { isConnected: true, focus() {} };
  env.context.document.activeElement = originFocus;
  env.feature._handleAction({ dataset: { hiddenAction: 'stores', source: 'search', index: '1' } });
  assert.equal(env.context.accessOpened, 1);
  assert.equal(env.context.calls.length, 1, 'no inventory request before entitlement');
  assert.equal(env.feature.searchState, preview);
  assert.equal(env.feature.panelState, null, 'dismissing payment leaves public preview untouched');
  env.context.PriceAlerts.entitlement = { active: true, lifetime: true };
  env.context.response = { stores: [{ code: 'paid', name: '유료 매장', qty: 2 }] };
  env.context.document.activeElement = { isConnected: false };
  env.context.accessCallback();
  await new Promise(setImmediate);
  assert.equal(env.feature.panelState.option.productId, 'selected-sku');
  assert.equal(env.feature._returnFocus, originFocus);
  assert.equal(env.feature.panelState.scope, 'nearby');
  assert.match(env.context.calls[1].url, /productId=selected-sku/);
  assert.equal(env.context.calls[1].public, undefined);
});

test('public requests survive identity changes while pending stock requests are aborted and discarded', async () => {
  const env = environment();
  let resolvePreview;
  env.context.fetch = () => new Promise(resolve => { resolvePreview = resolve; });
  const preview = env.feature.search('미스트');
  env.context.deviceId = 'next-device';
  env.listeners.storage();
  resolvePreview({ ok: true, status: 200, async json() { return { options: [option] }; } });
  await preview;
  assert.match(env.html(), /비공개 테스트 옵션/);
  env.context.PriceAlerts.entitlement = { active: true, lifetime: true };
  let resolveStores, signal;
  env.context.PriceAlerts._request = (url, opts) => { signal = opts.signal; return new Promise(resolve => { resolveStores = resolve; }); };
  const pending = env.feature.openStores(option);
  env.context.PriceAlerts.entitlement.active = false;
  env.feature.onEntitlementChange();
  assert.equal(signal.aborted, true);
  assert.equal(env.feature._premiumRequests.length, 0);
  resolveStores({ stores: [{ code: 'private', name: '비공개 매장', qty: 99 }] });
  await pending;
  assert.equal(env.feature.panelState, null);
  assert.match(env.html(), /비공개 테스트 옵션/);
  assert.doesNotMatch(env.html(), /비공개 매장|재고 99개/);
});

test('national pages reorder by quantity descending, keep zero before unknown and tie by distance stably', async () => {
  const env = environment();
  env.context.response = { stores: [
    { code: 'zero', name: '품절 매장', dist: 0.01, qty: 0 },
    { code: 'unknown', name: '수량 미확인', dist: 0, qty: null },
    { code: 'two-far', dist: 3, qty: 2 },
    { code: 'six', dist: 5, qty: 6 }
  ], nextCursor: 'national-page-2' };
  await env.feature.openStores(option, 'national');
  env.context.response = { stores: [
    { code: 'nineteen', dist: 300, qty: 19 },
    { code: 'two-near', dist: 0.02, qty: 2 },
    { code: 'two-tie', dist: 0.02, qty: 2 },
    { code: 'invalid', dist: 0.01, qty: '50' },
    { code: 'negative', dist: 0.02, qty: -1 }
  ], coverage: { complete: true } };
  await env.feature.loadPanel();
  assert.deepEqual(Array.from(env.feature.panelState.stores, row => row.code),
    ['nineteen', 'six', 'two-near', 'two-tie', 'two-far', 'zero', 'unknown', 'invalid', 'negative']);
  const html = env.elements.get('hidden-stock-panel').innerHTML;
  assert.match(html, /조회된 매장 중 재고 많은 순/);
  assert.doesNotMatch(html, /기준 · 가까운 매장순/);
});

test('entitlement notifications do not rerender free preview or detach its payment trigger', async () => {
  const env = environment(false);
  env.context.response = { options: [option] };
  await env.feature.search('미스트');
  let renders = 0;
  env.feature._renderSearch = () => { renders++; };
  env.feature.onEntitlementChange();
  env.context.PriceAlerts.entitlement = { active: true, lifetime: true };
  env.feature.onEntitlementChange();
  env.context.PriceAlerts.entitlement.active = false;
  env.feature.onEntitlementChange();
  env.feature.clearPremium();
  assert.equal(renders, 0);
});

test('revocation clears nationwide and nearby snapshots together and restores the free option panel', async () => {
  const env = environment();
  env.context.response = { options: [option] };
  await env.feature.openOptions(option.goodsNo);
  const preview = env.feature.panelState;
  env.context.response = { stores: [{ code: 'near', qty: 5 }], nextCursor: 'near-next' };
  await env.feature.openStores(option);
  const nearby = env.feature.panelState;
  env.context.response = { stores: [{ code: 'national', qty: 9 }], coverage: { complete: true } };
  await env.feature.openNational();
  const national = env.feature.panelState;
  env.context.PriceAlerts.entitlement.active = false;
  env.feature.onEntitlementChange();
  for (const state of [nearby, national]) {
    assert.equal(state.stores.length, 0);
    assert.equal(state.nextCursor, null);
    assert.equal(state.coverage, null);
    assert.equal(state.auto, false);
  }
  assert.equal(env.feature.panelState, preview);
  assert.match(env.elements.get('hidden-stock-panel').innerHTML, /비공개 테스트 옵션/);
});
