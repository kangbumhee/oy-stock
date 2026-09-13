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

test('free search never loads premium names, counts or identifiers; only generic access CTA', async () => {
  const env = environment(false);
  env.context.response = { options: [option] };
  await env.feature.search('사용자 검색어');
  assert.equal(env.context.calls.length, 0);
  assert.match(env.html(), /이용권 확인/);
  assert.doesNotMatch(env.html(), /fixture-sku|비공개 테스트 옵션|1개/);
  await env.feature.openOptions('public-product');
  assert.equal(env.context.accessOpened, 1);
  assert.equal(env.context.calls.length, 0);
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
  env.context.PriceAlerts._request = async () => { throw new Error('unavailable'); };
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

test('expired entitlement clears premium memory and DOM before any further request', async () => {
  const env = environment();
  env.context.response = { options: [option] };
  await env.feature.search('미스트');
  env.context.PriceAlerts.entitlement.expiresAt = new Date(Date.now() - 1).toISOString();
  env.feature._guard();
  assert.equal(env.feature.searchState, null);
  assert.doesNotMatch(env.html(), /비공개 테스트 옵션/);
  await assert.rejects(env.feature._request({ action: 'search' }), /access_required/);
  assert.equal(env.context.calls.length, 1);
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
  let resolve;
  env.context.PriceAlerts._request = () => new Promise(r => { resolve = r; });
  const pending = env.feature.search('미스트');
  await new Promise(setImmediate);
  env.context.deviceId = 'new-device';
  env.listeners.storage();
  resolve({ options: [option] });
  await pending;
  assert.equal(env.feature.searchState, null);
  assert.equal(env.context.PriceAlerts.entitlement, null);
  assert.doesNotMatch(env.html(), /비공개 테스트 옵션/);
});

test('server authorization failure clears all premium rows and closes panel', async () => {
  for (const status of [401, 402, 403]) {
    const env = environment();
    env.context.response = { options: [option] };
    await env.feature.search('미스트');
    env.context.PriceAlerts._request = async () => { const e = new Error('denied'); e.status = status; throw e; };
    await env.feature.openStores(option);
    assert.equal(env.feature.searchState, null);
    assert.equal(env.feature.panelState, null);
    assert.equal(env.elements.has('hidden-stock-panel'), false);
    assert.doesNotMatch(env.html(), /비공개 테스트 옵션/);
  }
});

test('lifetime access still requires active server entitlement; pagehide clears premium data', async () => {
  const env = environment();
  env.context.PriceAlerts.entitlement = { active: true, lifetime: true };
  env.context.response = { options: [option] };
  await env.feature.search('미스트');
  assert.equal(env.feature.searchState.options.length, 1);
  env.listeners.pagehide();
  assert.equal(env.feature.searchState, null);
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
  for (const asset of ['css/style.css', 'js/ui.js', 'js/app.js', 'js/alerts.js', 'js/hidden-stock.js']) {
    assert.ok(index.includes('/' + asset + '?v=20260913-hidden-nearby-2'));
    assert.ok(sw.includes('/' + asset + '?v=20260913-hidden-nearby-2'));
  }
});

test('dedicated access dialog has no fake product and never starts price-alert option lookup', () => {
  const env = environment();
  const alertsSource = fs.readFileSync(path.join(root, 'public/js/alerts.js'), 'utf8');
  vm.runInContext(alertsSource, env.context);
  for (const id of ['price-alert-title', 'price-alert-modal']) {
    env.elements.set(id, { textContent: '', classList: { add() {}, remove() {} }, setAttribute() {} });
  }
  const alerts = env.context.PriceAlerts;
  alerts._ensureModal = () => {};
  alerts._bindModalForm = () => {};
  alerts._setModalError = () => {};
  alerts._renderEntitlement = () => {};
  alerts.refreshEntitlement = () => {};
  alerts._loadModalOptions = () => { throw new Error('unexpected product option request'); };
  let continued = 0;
  alerts.openAccess(() => continued++);
  assert.equal(alerts.modalState.accessOnly, true);
  assert.equal(alerts.modalState.goodsNo, undefined);
  alerts.entitlement = { active: true, lifetime: true };
  alerts._continueAlertSetup(alerts.modalState);
  assert.equal(continued, 1);
  assert.equal(alerts.modalState, null);
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
  assert.match(html, /width="72" height="72"/);
  assert.match(html, /테스트 상품 참고 이미지/);
  for (const image of ['', 'javascript:alert(1)', 'https://oliveyoung.co.kr.evil.test/x', 'https://user:pass@image.oliveyoung.co.kr/x']) {
    const invalid = env.feature._imageHtml({ ...option, image });
    assert.doesNotMatch(invalid, /<img /);
    assert.match(invalid, /이미지 준비 중/);
  }
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
