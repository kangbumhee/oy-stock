const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/alerts.js'), 'utf8');

function environment() {
  const elements = new Map();
  const context = {
    Date, Promise, String, Number, Error, setTimeout,
    CONFIG: { PRICE_ALERT_PAYMENT_COMPLETE_API: '/payment/complete', PRICE_ALERT_PROMOTION_API: '/promotion' },
    UI: { showSyncStatus(message) { context.notices.push(message); } },
    notices: [],
    Membership: { busy: false, async requireVerifiedEmail() {
      context.verificationChecks++;
      throw new Error('promotion must not require email');
    } },
    verificationChecks: 0,
    Storage: { clearPriceAlertPaymentAttempt() { context.clearedAttempts++; } },
    clearedAttempts: 0,
    document: { activeElement: null, getElementById(id) { return elements.get(id) || null; } }
  };
  function element(id) {
    const classes = new Set();
    const node = {
      id, textContent: '', value: '', disabled: false, required: false, isConnected: true,
      tabIndex: 0, events: {}, attributes: {},
      classList: {
        add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); },
        toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.events[name] = handler; },
      getClientRects() { return [{}]; },
      focus() { context.document.activeElement = this; }
    };
    elements.set(id, node);
    return node;
  }
  context.document.body = element('body');
  for (const id of [
    'price-alert-membership-entry', 'price-alert-title', 'price-alert-modal', 'price-alert-form',
    'price-alert-entitlement-status', 'price-alert-paywall', 'price-alert-setup',
    'price-alert-pay-button', 'price-alert-promo-button', 'price-alert-promo-input',
    'price-alert-target-input', 'price-alert-membership-summary', 'price-alert-paywall-message',
    'price-alert-membership-refresh', 'price-alert-membership-use', 'price-alert-error', 'search-input'
  ]) element(id);
  const close = element('fixture-close');
  elements.get('price-alert-modal').querySelector = () => close;
  elements.get('price-alert-form').querySelectorAll = () => [close];
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  const alerts = context.PriceAlerts;
  alerts._ensureModal = () => {};
  alerts.refreshEntitlement = () => {};
  alerts._loadModalOptions = () => { throw new Error('membership must not request product options'); };
  alerts.entitlementEnabled = true;
  alerts.paymentAvailable = true;
  alerts.promotionAvailable = true;
  alerts.entitlement = { active: false };
  elements.get('price-alert-membership-entry').focus();
  return { alerts, context, elements, close, get: id => elements.get(id) };
}

test('homepage offers a direct purchase dialog rather than requiring a product search', () => {
  const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(index, /<button type="button" id="price-alert-membership-entry"[^>]*aria-haspopup="dialog">카카오페이로 30일 이용권 구매<\/button>/);
  assert.match(index, /온라인 미노출 옵션의 근처·전국 매장 재고 조회 포함/);
  assert.doesNotMatch(index, />상품 검색 후 알림 설정<\/a>/);
});

test('purchase entry binds once and opens an access-only checkout without a product', () => {
  const { alerts, context, get, close } = environment();
  alerts._bindMembershipEntry();
  const handler = get('price-alert-membership-entry').events.click;
  alerts._bindMembershipEntry();
  assert.equal(get('price-alert-membership-entry').events.click, handler);
  handler();
  assert.equal(alerts.modalState.membershipOnly, true);
  assert.equal(alerts.modalState.accessOnly, true);
  assert.equal(alerts.modalState.goodsNo, undefined);
  assert.equal(get('price-alert-title').textContent, '올리브재고 30일 이용권');
  assert.equal(get('price-alert-pay-button').disabled, false);
  assert.equal(get('price-alert-target-input').disabled, true);
  assert.equal(get('price-alert-target-input').required, false);
  assert.equal(get('price-alert-membership-summary').classList.contains('hidden'), true);
  assert.equal(context.document.activeElement, close);
  assert.doesNotMatch(get('price-alert-paywall-message').textContent, /매장 재고 조회는 유료/);
});

test('active membership shows expiry and included benefits without reopening payment or product setup', () => {
  const { alerts, get } = environment();
  alerts.entitlement = { active: true, expiresAt: '2026-10-24T00:00:00.000Z' };
  alerts.openMembership();
  const state = alerts.modalState;
  alerts._continueAlertSetup(state);
  assert.equal(alerts.modalState, state);
  assert.equal(get('price-alert-modal').classList.contains('hidden'), false);
  assert.equal(get('price-alert-membership-summary').classList.contains('hidden'), false);
  assert.equal(get('price-alert-paywall').classList.contains('hidden'), true);
  assert.equal(get('price-alert-setup').classList.contains('hidden'), true);
  assert.match(get('price-alert-entitlement-status').textContent, /이용권 만료/);
  assert.equal(get('price-alert-membership-entry').textContent, '내 이용권 확인');
  alerts.saveFromModal = () => { throw new Error('must not save a product-less alert'); };
  get('price-alert-form').events.submit({ preventDefault() {} });
});

test('only a verified paid response activates membership; pending and mismatched responses do not', async () => {
  const paymentId = 'oypa_membership_test_1234567890';
  for (const response of [
    { paymentId, status: 'pending', entitlement: { active: false } },
    { paymentId: 'oypa_different_123456789012345', status: 'paid', entitlement: { active: true } },
    { paymentId, status: 'paid', entitlement: { active: true, expiresAt: '2026-10-24T00:00:00.000Z' } }
  ]) {
    const { alerts, context, get } = environment();
    alerts.openMembership();
    alerts._request = async () => response;
    await alerts._completePayment(paymentId);
    const paid = response.paymentId === paymentId && response.status === 'paid';
    assert.equal(alerts._hasActiveEntitlement(), paid);
    assert.equal(context.clearedAttempts, paid ? 1 : 0);
    assert.equal(get('price-alert-membership-summary').classList.contains('hidden'), !paid);
    assert.equal(alerts.modalState.membershipOnly, true);
  }
});

test('a code response activates a finite 30-day pass without email checks and displays its real expiry', async () => {
  const { alerts, context, get } = environment();
  const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
  alerts.openMembership();
  get('price-alert-promo-input').value = 'fixture-code';
  alerts._request = async (url, opts) => {
    assert.equal(url, '/promotion');
    assert.equal(opts.body.code, 'fixture-code');
    return { idempotent: false, entitlement: { active: true, lifetime: false, expiresAt } };
  };
  await alerts.applyPromotion();
  assert.equal(context.verificationChecks, 0);
  assert.equal(get('price-alert-promo-input').value, '');
  assert.match(get('price-alert-entitlement-status').textContent, /이용권 만료/);
  assert.equal(alerts.entitlement.expiresAt, expiresAt);
  assert.match(context.notices[0], /무료 30일 이용권이 적용/);
  assert.equal(get('price-alert-membership-summary').classList.contains('hidden'), false);
  assert.equal(alerts.modalState.membershipOnly, true);
});

test('existing lifetime responses remain lifetime and are never described as a new free grant', async () => {
  const { alerts, context, get } = environment();
  alerts.openMembership();
  get('price-alert-promo-input').value = 'fixture-code';
  alerts._request = async () => ({ idempotent: true, entitlement: { active: true, lifetime: true, expiresAt: null } });
  await alerts.applyPromotion();
  assert.equal(get('price-alert-entitlement-status').textContent, '평생 이용권 활성');
  assert.match(context.notices[0], /기존 평생 이용권이 유지/);
  assert.doesNotMatch(context.notices[0], /적용되었습니다/);
});

test('code redemption is independent of missing, unverified, busy or unavailable email services', async () => {
  for (const state of ['missing', 'unverified', 'busy', 'unavailable']) {
    const { alerts, context, get } = environment();
    alerts.openMembership();
    if (state === 'missing') delete context.Membership;
    else {
      context.Membership.busy = state === 'busy';
      context.Membership.account = { verified: false };
      context.Membership.state = { available: false };
      context.Membership.requireVerifiedEmail = async () => {
        throw new Error('must not check the email service');
      };
    }
    get('price-alert-promo-input').value = 'fixture-code';
    let requests = 0;
    alerts._request = async (url, options) => {
      requests++;
      assert.equal(url, '/promotion');
      assert.equal(options.method, 'POST');
      assert.equal(options.body.code, 'fixture-code');
      return { idempotent: false, entitlement: { active: true, lifetime: false,
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() } };
    };
    await alerts.applyPromotion();
    assert.equal(requests, 1);
    assert.equal(get('price-alert-promo-input').value, '');
    assert.equal(alerts.paymentBusy, false);
    assert.equal(alerts._hasActiveEntitlement(), true);
    assert.equal(context.verificationChecks, 0);
    assert.match(context.notices[0], /무료 30일 이용권이 적용/);
  }
});

test('promotion capacity and registry failures explain the actual limit without granting access', async () => {
  for (const [code, message] of [
    ['active_device_capacity_reached', /현재 이용 가능 인원이 가득 찼습니다.*관리자에게 이용 한도 확대/],
    ['device_capacity_reached', /현재 등록 가능한 브라우저 수가 가득 찼습니다.*관리자에게 등록 한도 확대/],
    ['device_registry_unavailable', /이용권 수용량을 확인하지 못했습니다.*잠시 후 다시 시도/]
  ]) {
    const { alerts, context, get } = environment();
    alerts.openMembership();
    get('price-alert-promo-input').value = 'fixture-code';
    let requests = 0;
    alerts._request = async () => {
      requests++;
      throw Object.assign(new Error('fixture internal failure'), { status: 503, code, retryAfter: 3600 });
    };
    await alerts.applyPromotion();
    assert.match(get('price-alert-paywall-message').textContent, message);
    assert.doesNotMatch(get('price-alert-paywall-message').textContent, /유효하지 않은|이메일 인증|fixture internal/);
    assert.equal(get('price-alert-paywall-message').classList.contains('error'), true);
    assert.equal(alerts._hasActiveEntitlement(), false);
    assert.equal(alerts.paymentBusy, false);
    assert.equal(alerts.paymentAvailable, true);
    assert.equal(alerts.promotionAvailable, true);
    assert.equal(requests, 1);
    assert.equal(context.verificationChecks, 0);
    assert.equal(context.notices.length, 0);
  }
});

test('promotion rate-limit codes and HTTP 429 show Retry-After without changing payment cooldown rules', async () => {
  for (const [error, wait] of [
    [{ code: 'rate_limited', retryAfter: 37 }, /약 37초 후/],
    [{ code: 'rate_limit_exceeded', retryAfter: 120 }, /약 2분 후/],
    [{ status: 429 }, /약 1분 후/],
    [{ status: 429, code: 'unknown_response', retryAfter: 61 }, /약 2분 후/]
  ]) {
    const { alerts, context, get } = environment();
    alerts.openMembership();
    get('price-alert-promo-input').value = 'fixture-code';
    alerts._request = async () => { throw Object.assign(new Error('fixture internal failure'), error); };
    await alerts.applyPromotion();
    assert.match(get('price-alert-paywall-message').textContent, /무료 이용 코드 요청이 많아 잠시 제한/);
    assert.match(get('price-alert-paywall-message').textContent, wait);
    assert.equal(alerts._hasActiveEntitlement(), false);
    assert.equal(alerts.paymentBusy, false);
    assert.equal(alerts._paymentRetryAt, 0);
    assert.equal(get('price-alert-promo-button').disabled, false);
    assert.equal(context.verificationChecks, 0);
    assert.equal(context.notices.length, 0);
  }
});

test('replaying an expired one-time pass does not claim activation or resume paid access', async () => {
  const { alerts, context, get } = environment();
  let resumed = 0;
  alerts.openAccess(() => { resumed++; });
  get('price-alert-promo-input').value = 'fixture-code';
  alerts._request = async () => ({ idempotent: true, entitlement: { active: false, lifetime: false, expiresAt: '2020-01-01T00:00:00Z' } });
  await alerts.applyPromotion();
  assert.equal(resumed, 0);
  assert.equal(alerts._hasActiveEntitlement(), false);
  assert.equal(context.notices.length, 0);
  assert.match(get('price-alert-paywall-message').textContent, /이미 사용한 무료 30일 이용권/);
});

test('malformed and expired active promotion responses fail closed rather than granting UI access', async () => {
  for (const entitlement of [{ active: true, lifetime: false }, { active: true, expiresAt: 'invalid' },
    { active: true, lifetime: false, expiresAt: '2020-01-01T00:00:00Z' }]) {
    const { alerts, context, get } = environment();
    alerts.openMembership();
    get('price-alert-promo-input').value = 'fixture-code';
    alerts._request = async () => ({ idempotent: false, entitlement });
    await alerts.applyPromotion();
    assert.equal(alerts._hasActiveEntitlement(), false);
    assert.equal(context.notices.length, 0);
    assert.equal(get('price-alert-promo-input').value, '');
  }
});

test('concurrent code clicks post one redemption while payment preflight remains serialized', async () => {
  const { alerts, get } = environment();
  let release;
  let requests = 0;
  alerts.openMembership();
  get('price-alert-promo-input').value = 'fixture-code';
  alerts._request = () => {
    requests++;
    return new Promise(resolve => { release = resolve; });
  };
  const applying = alerts.applyPromotion();
  assert.equal(get('price-alert-promo-button').disabled, true);
  await alerts.applyPromotion();
  assert.equal(requests, 1);
  release({ idempotent: false, entitlement: { active: true, lifetime: false,
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() } });
  await applying;
  alerts._emailCheckBusy = true;
  await alerts.applyPromotion();
  assert.equal(requests, 1);
  assert.equal(alerts.paymentBusy, false);
});

test('promotion copy promises one finite invitation and preserves the separate site-password boundary', () => {
  const admin = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');
  assert.match(source, /30일 무료 이용 코드/);
  assert.match(source, /이메일 인증 없이 사이트 입장 비밀번호만 입력/);
  assert.match(source, /같은 브라우저 인증정보 기준으로 한 번만/);
  assert.match(source, /저장데이터 삭제·재설치 시 이전 이용권을 복구할 수 없/);
  assert.match(source, /다른 브라우저와 공유되지 않/);
  assert.doesNotMatch(source, /Membership\.requireVerifiedEmail\(\{ purpose: 'promotion' \}\)/);
  assert.doesNotMatch(source, /평생 이용 프로모션 코드|평생 가격 알림 이용권이 활성화되었습니다/);
  assert.match(admin, /초대 코드를 변경해도 사이트 입장 비밀번호는 변경되지/);
  assert.match(admin, /이메일 인증 없이 브라우저 인증정보당/);
  assert.match(admin, /이미 사용한 브라우저에 30일권이 다시 지급되지/);
});

test('existing paid-stock access still resumes its callback and restores originating focus', () => {
  const { alerts, context, get } = environment();
  let continued = 0;
  alerts.openAccess(() => { continued++; });
  assert.equal(get('price-alert-title').textContent, '유료 이용자만 사용 가능합니다');
  alerts.entitlement = { active: true, lifetime: true };
  alerts._continueAlertSetup(alerts.modalState);
  assert.equal(continued, 1);
  assert.equal(alerts.modalState, null);
  assert.equal(context.document.activeElement, get('price-alert-membership-entry'));
});

test('membership action returns to the search tab and focuses search without creating an alert', async () => {
  const { alerts, context, get } = environment();
  assert.match(source, /id="price-alert-membership-use"[^>]*data-action="tabSearch"/);
  alerts.openMembership();
  get('price-alert-membership-use').events.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(alerts.modalState, null);
  assert.equal(get('price-alert-modal').attributes['aria-hidden'], 'true');
  assert.equal(context.document.activeElement, get('search-input'));
});
