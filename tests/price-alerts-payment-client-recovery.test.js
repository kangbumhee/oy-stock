const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { requestPaymentPayload } = require('../api/price-alerts/_portone');

const root = path.join(__dirname, '..');
const alertsSource = fs.readFileSync(path.join(root, 'public/js/alerts.js'), 'utf8');
const membershipSource = fs.readFileSync(path.join(root, 'public/js/membership.js'), 'utf8');
const PAYMENT_ID = 'oypa_fixture_pending_123456789';

function paymentResponse(origin = 'https://olivestock.co.kr') {
  return {
    success: true, paymentId: PAYMENT_ID,
    plan: { amount: 30000, currency: 'KRW', durationDays: 30, autoRenew: false },
    requestPayment: requestPaymentPayload({ paymentId: PAYMENT_ID }, {
      storeId: 'store-fixture1234', channelKey: 'channel-key-fixture1234', publicSiteUrl: origin
    })
  };
}

function environment(options = {}) {
  const clock = { now: Date.parse('2026-09-24T00:00:00Z') };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const timers = new Map();
  let timerId = 0;
  let attempt = options.attempt || null;
  const elements = new Map();
  const calls = { create: 0, complete: 0, account: 0, sdk: 0, sdkLoad: 0, verified: 0, navigations: [], requests: [] };
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', disabled: false, checked: false, open: false,
      classList: { toggle() {} }, focus() {}, scrollIntoView() {}, checkValidity() { return true; }
    });
    return elements.get(id);
  }
  element('price-alert-pay-button');
  element('price-alert-paywall-message');
  element('membership-message');
  const url = new URL(options.url || 'https://olivestock.co.kr/');
  const context = {
    Date: Clock, URL, Promise, console, structuredClone,
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    location: { href: url.href, origin: url.origin, search: url.search, assign(target) { calls.navigations.push(target); } },
    document: { getElementById(id) { return elements.get(id) || null; } },
    UI: { showSyncStatus() {} },
    CONFIG: { PRICE_ALERT_PAYMENT_CREATE_API: '/api/price-alerts/payment/create', PRICE_ALERT_PAYMENT_COMPLETE_API: '/api/price-alerts/payment/complete' },
    Storage: {
      getPriceAlertDevice: () => ({ deviceId: 'FixtureDevice000000001', deviceSecret: 'FixtureSecret000000000000000000001' }),
      setPriceAlertDevice() { return true; }, replacePriceAlerts() {},
      getPriceAlertPaymentAttempt: () => attempt && structuredClone(attempt),
      setPriceAlertPaymentAttempt(value) { attempt = structuredClone(value); return true; },
      clearPriceAlertPaymentAttempt() { attempt = null; }
    },
    Membership: { busy: false, message(text) { element('membership-message').textContent = text; }, async requireVerifiedEmail() { calls.verified++; return true; } },
    async fetch(target, request) {
      calls.requests.push({ target, method: request.method, body: request.body });
      let body;
      if (target.endsWith('/create')) {
        calls.create++;
        if (options.createError) return { ok: false, status: options.createError.status, headers: { get: () => options.createError.retryAfter || null }, json: async () => ({ success: false, error: options.createError.code }) };
        body = options.created || paymentResponse(url.origin);
      } else if (target.endsWith('/complete')) {
        calls.complete++;
        body = options.completed || { success: true, paymentId: PAYMENT_ID, status: 'pending', entitlement: { active: false } };
      } else if (target === '/api/price-alerts/account') {
        calls.account++;
        if (options.accountError) return { ok: false, status: options.accountError.status, headers: { get: () => options.accountError.retryAfter || null }, json: async () => ({ success: false, error: options.accountError.code }) };
        body = options.account || { success: true, available: true, recoveryEnabled: true, account: { verified: true, email: 'fixture@example.com' } };
      } else throw new Error('Unexpected mock request: ' + target);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(alertsSource, context);
  const alerts = context.PriceAlerts;
  alerts.entitlementEnabled = true;
  alerts.paymentAvailable = true;
  alerts.entitlement = { active: false };
  alerts._newPaymentIdempotencyKey = () => 'fixture-idempotency-key-123456789';
  alerts._loadPortOne = async () => {
    calls.sdkLoad++;
    if (options.sdkLoadError) throw new Error('payment_sdk_unavailable');
    return { requestPayment(request) {
      calls.sdk++;
      assert.equal(request.paymentId, PAYMENT_ID);
      if (options.sdkReject) return Promise.reject({ code: 'MOCK_SDK_REJECTED', message: 'fixture SDK failure' });
      return Promise.resolve(options.sdkResult || {});
    } };
  };
  alerts.syncServiceWorkerAuth = () => {};
  return {
    alerts, context, calls, element, clock,
    attempt: () => attempt,
    message: () => element('price-alert-paywall-message').textContent,
    loadMembership() { vm.runInContext(membershipSource, context); context.Membership.trackVisit = () => {}; return context.Membership; },
    advance(milliseconds) {
      clock.now += milliseconds;
      const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn());
    }
  };
}

test('checkout redirects exact aliases before account/create requests without forwarding query credentials', async () => {
  for (const host of ['oy-stock.vercel.app', 'www.olivestock.co.kr']) {
    const env = environment({ url: `https://${host}/?paymentId=private-return&key=private-key#private-fragment` });
    await env.alerts.startPayment();
    await env.alerts.startPayment();
    assert.deepEqual(env.calls.navigations, ['https://olivestock.co.kr/']);
    assert.equal(env.calls.verified, 0);
    assert.equal(env.calls.requests.length, 0);
    assert.equal(env.calls.sdk, 0);
    assert.equal(env.attempt(), null);
  }
});

test('unknown hosts cannot redirect or create payment while canonical and loopback origins work', async () => {
  for (const url of ['https://oy-stock.vercel.app.attacker.example/', 'https://preview.example/', 'https://olivestock.co.kr:444/']) {
    const env = environment({ url });
    await env.alerts.startPayment();
    assert.equal(env.calls.requests.length, 0);
    assert.equal(env.calls.navigations.length, 0);
    assert.match(env.message(), /공식 주소/);
  }
  for (const url of ['https://olivestock.co.kr/', 'http://localhost:5173/', 'http://127.0.0.1:5173/', 'http://[::1]:5173/']) {
    const env = environment({ url });
    await env.alerts.startPayment();
    assert.equal(env.calls.create, 1);
    assert.equal(env.calls.sdk, 1);
    assert.equal(env.calls.complete, 1);
  }
});

test('contract origin validation remains strict after canonical routing', async () => {
  const env = environment({ created: paymentResponse('https://different.example') });
  await env.alerts.startPayment();
  assert.equal(env.calls.create, 1);
  assert.equal(env.calls.sdk, 0);
  assert.equal(env.calls.complete, 0);
  assert.match(env.message(), /일치하지 않아/);
});

test('429 preserves Retry-After, disables retry, and re-enables only after its deadline', async () => {
  const env = environment({ createError: { status: 429, code: 'rate_limit_exceeded', retryAfter: '37' } });
  await env.alerts.startPayment();
  const retained = structuredClone(env.attempt());
  assert.equal(env.element('price-alert-pay-button').disabled, true);
  assert.match(env.message(), /37초/);
  await env.alerts.startPayment();
  assert.equal(env.calls.create, 1);
  assert.equal(env.calls.sdk, 0);
  assert.equal(env.calls.complete, 0);
  assert.deepEqual(env.attempt(), retained);
  env.advance(36000);
  assert.equal(env.element('price-alert-pay-button').disabled, true);
  assert.match(env.message(), /1초/);
  env.advance(1000);
  assert.equal(env.element('price-alert-pay-button').disabled, false);
  await env.alerts.startPayment();
  assert.equal(env.calls.create, 2);
  assert.equal(env.attempt().idempotencyKey, retained.idempotencyKey);
});

test('Retry-After accepts HTTP dates and missing retry information uses a bounded default', async () => {
  const deadline = new Date(Date.parse('2026-09-24T00:00:00Z') + 120000).toUTCString();
  const dated = environment({ createError: { status: 429, code: 'rate_limit_exceeded', retryAfter: deadline } });
  await dated.alerts.startPayment();
  assert.equal(dated.alerts._paymentRetrySeconds(), 120);
  assert.match(dated.message(), /2분/);
  const missing = environment({ createError: { status: 429, code: 'rate_limit_exceeded' } });
  await missing.alerts.startPayment();
  assert.equal(missing.alerts._paymentRetrySeconds(), 60);
});

test('existing payment conflicts have actionable recovery guidance without deleting the attempt', async () => {
  const env = environment({ createError: { status: 409, code: 'payment_already_pending' } });
  await env.alerts.startPayment();
  assert.match(env.message(), /기존 결제 요청/);
  assert.match(env.message(), /복구/);
  assert.ok(env.attempt());
  assert.equal(env.calls.sdk, 0);
});

test('an expired recovered payment requests reconciliation without opening another checkout', async () => {
  const env = environment({ createError: { status: 409, code: 'payment_reconciliation_required' } });
  await env.alerts.startPayment();
  assert.match(env.message(), /이전 결제 상태를 확인/);
  assert.match(env.message(), /새 결제를 시작하지 않았습니다/);
  assert.equal(env.calls.sdk, 0);
  assert.ok(env.attempt());
});

test('SDK error results and rejections remain visible and only reconcile the same payment on retry', async () => {
  for (const options of [{ sdkResult: { code: 'MOCK_SDK_ERROR', message: 'fixture UI failure' } }, { sdkReject: true }]) {
    const env = environment(options);
    await env.alerts.startPayment();
    assert.match(env.message(), /MOCK_SDK_/);
    assert.equal(env.attempt().providerInvoked, true);
    assert.equal(env.alerts._hasActiveEntitlement(), false);
    await env.alerts.startPayment();
    assert.equal(env.calls.create, 1);
    assert.equal(env.calls.sdk, 1);
    assert.equal(env.calls.complete, 2);
    assert.ok(env.calls.requests.filter(row => row.target.endsWith('/complete')).every(row => JSON.parse(row.body).paymentId === PAYMENT_ID));
  }
});

test('an SDK load failure keeps the existing attempt available without reporting payment success', async () => {
  const env = environment({ sdkLoadError: true });
  await env.alerts.startPayment();
  assert.equal(env.calls.sdk, 0);
  assert.equal(env.calls.complete, 1);
  assert.equal(env.attempt().providerInvoked, false);
  assert.equal(env.attempt().paymentId, PAYMENT_ID);
  assert.equal(env.alerts._hasActiveEntitlement(), false);
  assert.match(env.message(), /콘텐츠 차단 설정/);
});

test('recovery reconciliation displays server state without opening SDK or creating another payment', async () => {
  for (const status of ['paid', 'cancelled', 'abandoned', 'pending', 'review_required']) {
    const reconciliation = { success: true, paymentId: PAYMENT_ID, status, entitlement: { active: status === 'paid', lifetime: false } };
    const env = environment({ created: { ...paymentResponse(), resumed: true, requestPayment: null, reconciliation } });
    await env.alerts.startPayment();
    assert.equal(env.calls.create, 1);
    assert.equal(env.calls.sdk, 0);
    assert.equal(env.calls.complete, 0);
    assert.equal(env.alerts._hasActiveEntitlement(), status === 'paid');
    if (['paid', 'cancelled', 'abandoned'].includes(status)) assert.equal(env.attempt(), null);
    else assert.equal(env.attempt().providerInvoked, true);
  }
});

test('mismatched reconciliation identity cannot grant access or open SDK', async () => {
  const env = environment({ created: { ...paymentResponse(), resumed: true, requestPayment: null, reconciliation: { paymentId: 'oypa_wrong_fixture_1234567890', status: 'paid', entitlement: { active: true } } } });
  await env.alerts.startPayment();
  assert.equal(env.alerts._hasActiveEntitlement(), false);
  assert.equal(env.calls.sdk, 0);
  assert.equal(env.calls.complete, 0);
  assert.match(env.message(), /일치하지 않아/);
});

test('a server-approved resumed checkout uses its existing payment identity after an explicit click', async () => {
  const env = environment({ created: { ...paymentResponse(), resumed: true } });
  assert.equal(env.calls.sdk, 0);
  await env.alerts.startPayment();
  assert.equal(env.calls.sdk, 1);
  assert.equal(env.attempt().paymentId, PAYMENT_ID);
  assert.equal(env.attempt().providerInvoked, true);
});

test('account actions on an alias navigate before sending email or recovery requests', async () => {
  const env = environment({ url: 'https://oy-stock.vercel.app/' });
  const membership = env.loadMembership();
  await membership.submit('request-recovery');
  assert.deepEqual(env.calls.navigations, ['https://olivestock.co.kr/']);
  assert.equal(env.calls.account, 0);
});

test('an account-read 429 is not misreported as unverified email and prevents checkout retries', async () => {
  const env = environment({ accountError: { status: 429, code: 'rate_limit_exceeded', retryAfter: '120' } });
  env.loadMembership();
  await env.alerts.startPayment();
  assert.match(env.element('membership-message').textContent, /2분/);
  assert.doesNotMatch(env.element('membership-message').textContent, /인증을 완료/);
  assert.equal(env.calls.create, 0);
  assert.equal(env.element('price-alert-pay-button').disabled, true);
  await env.alerts.startPayment();
  assert.equal(env.calls.account, 1);
});
