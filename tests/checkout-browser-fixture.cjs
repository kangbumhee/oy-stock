// Local, offline checkout UI fixture. No API, email, or payment provider is contacted.
// Run: node tests/checkout-browser-fixture.cjs
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const port = Number(process.env.CHECKOUT_FIXTURE_PORT || 4179);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid fixture port');
const assets = new Map([
  ['/js/config.js', 'public/js/config.js'],
  ['/js/storage.js', 'public/js/storage.js'],
  ['/js/alerts.js', 'public/js/alerts.js'],
  ['/js/membership.js', 'public/js/membership.js'],
  ['/css/style.css', 'public/css/style.css']
]);

function browserFixture() {
  'use strict';
  var paymentId = 'oypa_browser_fixture_1234567890';
  var state = { scenario: 'limited', create: 0, complete: 0, sdk: 0, account: 0, limitIssued: false, completeStatus: 'pending' };
  var sdkResolve = null;
  var fixtureEmail = 'test@example.com';
  function display() {
    document.getElementById('fixture-counts').textContent =
      'create ' + state.create + ' / SDK ' + state.sdk + ' / complete ' + state.complete + ' / account ' + state.account;
  }
  function response(body, status, headers) {
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {})
    }));
  }
  function entitlement() {
    return { active: state.completeStatus === 'paid', lifetime: false, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() };
  }
  function checkout() {
    return {
      success: true, paymentId: paymentId, resumed: state.scenario === 'ready',
      plan: { amount: 30000, currency: 'KRW', durationDays: 30, autoRenew: false },
      requestPayment: {
        storeId: 'store-fixture1234', channelKey: 'channel-key-fixture1234', paymentId: paymentId,
        orderName: '올리브재고 가격 알림 30일 이용권', totalAmount: 30000, currency: 'KRW',
        payMethod: 'EASY_PAY', easyPay: { easyPayProvider: 'KAKAOPAY' },
        redirectUrl: location.origin + '/?priceAlertPayment=complete',
        noticeUrls: [location.origin + '/api/price-alerts/payment/webhook'],
        products: [{ id: 'price_alert_30d', name: '올리브재고 가격 알림 30일 이용권', amount: 30000, quantity: 1 }]
      }
    };
  }
  // Every application fetch is answered in memory. There is no native-fetch fallback.
  window.fetch = function (input, init) {
    var url = new URL(typeof input === 'string' ? input : input.url, location.origin);
    if (url.origin !== location.origin) return Promise.reject(new Error('External requests are disabled in this fixture'));
    var pathname = url.pathname;
    if (pathname === '/api/price-alerts/account') {
      state.account++;
      display();
      var body = init && init.body ? JSON.parse(init.body) : {};
      if (body.action === 'request-recovery' || body.action === 'request-verification') return response({ success: true, sent: true });
      if (body.action === 'recover') return response({
        success: true, account: { email: fixtureEmail, verified: true },
        credentials: { deviceId: 'BrowserFixtureDevice000001', deviceSecret: 'BrowserFixtureSecret000000000000000000001' }
      });
      return response({ success: true, available: true, recoveryEnabled: true, account: { email: fixtureEmail, verified: true } });
    }
    if (pathname === '/api/price-alerts/entitlement') return response({
      success: true, enabled: true, paymentAvailable: true, promotionAvailable: false, entitlement: entitlement()
    });
    if (pathname === '/api/price-alerts/alerts') return response({ success: true, alerts: [] });
    if (pathname === '/api/price-alerts/payment/create') {
      state.create++;
      display();
      if (state.scenario === 'limited' && !state.limitIssued) {
        state.limitIssued = true;
        return response({ success: false, error: 'rate_limit_exceeded' }, 429, { 'Retry-After': '8' });
      }
      if (state.scenario === 'reconcile') return response({ success: false, error: 'payment_reconciliation_required' }, 409);
      if (state.scenario === 'cancelled') return response({
        success: true, resumed: true, paymentId: paymentId, requestPayment: null,
        reconciliation: { paymentId: paymentId, status: 'cancelled', entitlement: { active: false } }
      });
      return response(checkout());
    }
    if (pathname === '/api/price-alerts/payment/complete') {
      state.complete++;
      display();
      return response({ success: true, paymentId: paymentId, status: state.completeStatus, entitlement: entitlement() });
    }
    return response({ success: false, error: 'fixture_unknown_route' }, 404);
  };
  window.PortOne = {
    requestPayment: function (request) {
      if (request.paymentId !== paymentId) throw new Error('Fixture payment identity mismatch');
      state.sdk++;
      display();
      if (state.scenario === 'sdk-error') return Promise.resolve({ code: 'FIXTURE_SDK_ERROR', message: '테스트용 결제창 오류입니다.' });
      document.getElementById('fixture-sdk').hidden = false;
      return new Promise(function (resolve) { sdkResolve = resolve; });
    }
  };
  window.UI = {
    showSyncStatus: function (message) { document.getElementById('fixture-status').textContent = message; },
    num: function (value) { return Number(value || 0).toLocaleString('ko-KR'); },
    esc: function (value) { var el = document.createElement('span'); el.textContent = String(value || ''); return el.innerHTML; },
    escAttr: function (value) { return this.esc(value).replace(/"/g, '&quot;'); }
  };
  document.getElementById('fixture-sdk-close').addEventListener('click', function () {
    state.completeStatus = 'cancelled';
    document.getElementById('fixture-sdk').hidden = true;
    var resolve = sdkResolve;
    sdkResolve = null;
    if (resolve) resolve({ code: 'USER_CANCEL', message: '모의 결제창을 닫았습니다.' });
  });
  document.addEventListener('click', function (event) {
    var close = event.target.closest('[data-action="closePriceAlert"]');
    if (close) PriceAlerts.closeModal();
    var link = event.target.closest('a');
    if (link) event.preventDefault();
  });
  PriceAlerts._ensureModal();
  PriceAlerts._bindModalForm();
  PriceAlerts._bindMembershipEntry();
  Membership.init();
  document.getElementById('membership-recovery-email').value = fixtureEmail;
  function selectScenario(scenario) {
    if (sdkResolve) {
      document.getElementById('fixture-status').textContent = '먼저 모의 결제창을 닫아 주세요.';
      return;
    }
    state.scenario = scenario;
    state.create = 0; state.complete = 0; state.sdk = 0; state.account = 0;
    state.limitIssued = false; state.completeStatus = 'pending';
    Storage.clearPriceAlertPaymentAttempt();
    if (PriceAlerts._paymentRetryTimer !== null) clearTimeout(PriceAlerts._paymentRetryTimer);
    PriceAlerts._paymentRetryTimer = null;
    PriceAlerts._paymentRetryAt = 0;
    PriceAlerts.paymentBusy = false;
    PriceAlerts.entitlementEnabled = true;
    PriceAlerts.paymentAvailable = true;
    PriceAlerts.promotionAvailable = false;
    PriceAlerts.entitlement = { active: false };
    Membership.message('', false);
    document.getElementById('fixture-status').textContent = '선택: ' + scenario + ' — 아래 실제 결제 버튼을 눌러 확인하세요.';
    document.querySelectorAll('[data-scenario]').forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.scenario === scenario)); });
    display();
    PriceAlerts.openMembership();
  }
  document.querySelectorAll('[data-scenario]').forEach(function (button) {
    button.addEventListener('click', function () { selectScenario(button.dataset.scenario); });
  });
  selectScenario('limited');
  window.fixtureState = state;
}

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>결제 화면 로컬 검증</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/css/style.css">
<style>body{background:#f1f5f2;font-family:Arial,sans-serif}.fixture-toolbar{position:fixed;top:0;left:0;right:0;z-index:20000;background:#f8faf9;border-bottom:1px solid #cbd5d1;padding:10px 16px;color:#17221b}.fixture-toolbar h1{font-size:16px;margin:0 0 7px}.fixture-buttons{display:flex;flex-wrap:wrap;gap:6px}.fixture-buttons button{padding:7px 10px;border:1px solid #9db5a4;border-radius:6px;background:white;font-size:12px;cursor:pointer}.fixture-buttons button[aria-pressed=true]{background:#d1fae5;border-color:#15803d}.fixture-toolbar p{font-size:12px;margin:5px 0 0}#fixture-counts{font-family:monospace}main{padding:190px 20px}.price-alert-modal{padding-top:170px;align-items:flex-start}.price-alert-dialog{max-height:calc(100dvh - 188px)}#fixture-sdk{position:fixed;inset:0;z-index:21000;background:rgba(0,0,0,.55);padding:180px 20px 20px}#fixture-sdk[hidden]{display:none}.fixture-sdk-box{max-width:390px;margin:auto;background:white;padding:26px;border-radius:16px;box-shadow:0 10px 60px #0004}.fixture-sdk-box h2{font-size:20px}.fixture-sdk-box p{margin:16px 0}.fixture-sdk-box button{padding:12px 16px;border:0;border-radius:8px;background:#fee500;color:#191919;font-weight:700}</style></head>
<body><aside class="fixture-toolbar"><h1>로컬 모의 결제 검증 · 실제 결제/메일/외부 API 연결 없음</h1><div class="fixture-buttons">
<button type="button" data-scenario="limited">429 · 8초 제한</button><button type="button" data-scenario="ready">복구 READY · 모의 결제창</button><button type="button" data-scenario="cancelled">복구 CANCELLED</button><button type="button" data-scenario="sdk-error">SDK 오류</button><button type="button" data-scenario="reconcile">409 · 이전 결제 확인</button></div><p id="fixture-status" role="status"></p><p id="fixture-counts"></p></aside>
<main><button type="button" id="price-alert-membership-entry">카카오페이로 30일 이용권 구매</button><input id="search-input" aria-label="모의 상품 검색"></main>
<section id="fixture-sdk" hidden><div class="fixture-sdk-box" role="dialog" aria-modal="true" aria-labelledby="fixture-sdk-title"><h2 id="fixture-sdk-title">모의 카카오페이 결제창</h2><p>실제 SDK 연결이나 결제는 발생하지 않습니다. 기존 결제 ID로 화면 호출된 상태입니다.</p><button id="fixture-sdk-close" type="button">모의 창 닫기 · 취소</button></div></section>
<script src="/js/config.js"></script><script src="/js/storage.js"></script><script src="/js/alerts.js"></script><script src="/js/membership.js"></script><script src="/fixture.js"></script></body></html>`;

const server = http.createServer((req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'");
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  let content;
  let type;
  if (pathname === '/') { content = html; type = 'text/html; charset=utf-8'; }
  else if (pathname === '/fixture.js') { content = '(' + browserFixture.toString() + ')();'; type = 'text/javascript; charset=utf-8'; }
  else if (assets.has(pathname)) {
    content = fs.readFileSync(path.join(root, assets.get(pathname)));
    type = pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
  } else { res.writeHead(404); res.end('Fixture route not found'); return; }
  res.writeHead(200, { 'Content-Type': type });
  res.end(req.method === 'HEAD' ? undefined : content);
});
server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ fixture: `http://127.0.0.1:${port}/`, mode: 'offline mocks only', pid: process.pid }));
});
