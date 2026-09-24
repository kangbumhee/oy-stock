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
    UI: { showSyncStatus() {} },
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

test('promotion remains available through direct checkout and lifetime access is visible after activation', async () => {
  const { alerts, get } = environment();
  alerts.openMembership();
  get('price-alert-promo-input').value = 'fixture-code';
  alerts._request = async (url, opts) => {
    assert.equal(url, '/promotion');
    assert.equal(opts.body.code, 'fixture-code');
    return { entitlement: { active: true, lifetime: true } };
  };
  await alerts.applyPromotion();
  assert.equal(get('price-alert-promo-input').value, '');
  assert.equal(get('price-alert-entitlement-status').textContent, '평생 이용권 활성');
  assert.equal(get('price-alert-membership-summary').classList.contains('hidden'), false);
  assert.equal(alerts.modalState.membershipOnly, true);
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
