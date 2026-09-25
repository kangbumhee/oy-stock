const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const membershipSource = fs.readFileSync(path.join(root, 'public/js/membership.js'), 'utf8');
const alertsSource = fs.readFileSync(path.join(root, 'public/js/alerts.js'), 'utf8');
const NOTICE_KEY = 'oy_membership_notice_day_v1';
const NOW = Date.parse('2026-09-25T03:00:00.000Z');

function browserStorage(values, behavior = {}) {
  return {
    getItem(key) {
      if (behavior.readFails) throw new Error('storage blocked');
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (behavior.writeFails) throw new Error('storage quota unavailable');
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); }
  };
}

function sharedLocks() {
  const tails = new Map();
  const calls = [];
  return {
    calls,
    request(name, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      calls.push({ name, mode: options.mode || 'exclusive' });
      const previous = tails.get(name) || Promise.resolve();
      const task = previous.catch(() => {}).then(() => callback({ name, mode: 'exclusive' }));
      tails.set(name, task.catch(() => {}));
      return task;
    }
  };
}

function browser(options = {}) {
  const local = options.local || new Map();
  const session = options.session || new Map();
  const clock = { now: options.now || NOW };
  const calls = { render: 0, visit: 0, opened: 0, reentries: [] };
  const behavior = { failOpen: false, incompleteOpen: false, reentry: false };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const title = { textContent: '' };
  const modalClasses = new Set(['hidden']);
  const modal = {
    classList: { contains: (name) => modalClasses.has(name), remove: (name) => modalClasses.delete(name), add: (name) => modalClasses.add(name) },
    getAttribute(name) { return name === 'aria-hidden' ? String(modalClasses.has('hidden')) : null; }
  };
  const document = {
    hidden: false, visibilityState: 'visible',
    getElementById(id) { return id === 'price-alert-title' ? title : id === 'price-alert-modal' ? modal : null; }
  };
  const context = {
    Date: Clock, Promise, URL, console,
    localStorage: browserStorage(local, options.localBehavior),
    sessionStorage: browserStorage(session, options.sessionBehavior),
    navigator: options.locks ? { locks: options.locks } : {},
    location: { search: '', origin: 'https://olivestock.co.kr', href: 'https://olivestock.co.kr/' },
    document, Storage: { _key: (key) => 'oy_' + key }, CONFIG: {}, UI: {},
    setTimeout, clearTimeout
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(alertsSource, context, { filename: 'alerts.js' });
  vm.runInContext(membershipSource, context, { filename: 'membership.js' });
  const alerts = context.PriceAlerts;
  alerts.entitlement = { active: true, lifetime: options.lifetime === true, expiresAt: new Date(NOW + 7 * 86400000).toISOString() };
  alerts.openAccess = function (_callback, accessOptions) {
    calls.opened++;
    if (behavior.failOpen) throw new Error('modal unavailable');
    if (behavior.incompleteOpen) return;
    this.modalState = { accessOnly: true, membershipOnly: accessOptions.membershipOnly === true };
    modalClasses.delete('hidden');
    title.textContent = '올리브재고 30일 이용권';
    if (behavior.reentry) calls.reentries.push(Promise.resolve(context.Membership.onEntitlement()));
  };
  context.Membership.render = () => { calls.render++; };
  context.Membership.trackVisit = () => { calls.visit++; };
  return {
    context, membership: context.Membership, alerts, document, title, local, session, calls, clock, behavior,
    close() { alerts.modalState = null; modalClasses.add('hidden'); },
    async notify() { await context.Membership.onEntitlement(); }
  };
}

test('paid and lifetime automatic notices each appear once per browser day', async () => {
  for (const lifetime of [false, true]) {
    const env = browser({ lifetime });
    await env.notify();
    assert.equal(env.calls.opened, 1);
    assert.equal(env.local.get(NOTICE_KEY), '2026-09-25');
    assert.equal(env.membership.dailyNoticeDay, '2026-09-25');
    assert.equal(env.alerts.modalState.membershipOnly, true);
    if (lifetime) assert.equal(env.title.textContent, '평생 이용권 사용 중입니다');
    else assert.match(env.title.textContent, /유료 이용기간 \d+일 남았어요/);
    env.close();
    await env.notify();
    await env.notify();
    assert.equal(env.calls.opened, 1);
    assert.equal(env.calls.render, 3);
    assert.equal(env.calls.visit, 3);
  }
});

test('same-day reload and a second tab share persisted browser-day suppression', async () => {
  const local = new Map();
  const initial = browser({ local });
  await initial.notify();
  initial.close();
  const reload = browser({ local });
  const anotherTab = browser({ local, lifetime: true });
  await reload.notify();
  await anotherTab.notify();
  assert.equal(initial.calls.opened, 1);
  assert.equal(reload.calls.opened, 0);
  assert.equal(anotherTab.calls.opened, 0);
});

test('Korean midnight permits the next notice in an already open page and a reloaded page', async () => {
  const env = browser({ now: Date.parse('2026-09-25T14:59:59.999Z') });
  await env.notify();
  assert.equal(env.local.get(NOTICE_KEY), '2026-09-25');
  env.close();
  env.clock.now++;
  await env.notify();
  assert.equal(env.calls.opened, 2);
  assert.equal(env.local.get(NOTICE_KEY), '2026-09-26');
  env.close();
  await env.notify();
  assert.equal(env.calls.opened, 2);
  const nextDay = browser({ local: env.local, now: Date.parse('2026-09-26T15:00:00.000Z') });
  await nextDay.notify();
  assert.equal(nextDay.calls.opened, 1);
  assert.equal(env.local.get(NOTICE_KEY), '2026-09-27');
});

test('manual membership entry remains available after the automatic notice is suppressed', async () => {
  const env = browser();
  await env.notify();
  env.close();
  await env.notify();
  assert.equal(env.calls.opened, 1);
  env.alerts.openMembership();
  assert.equal(env.calls.opened, 2);
  assert.equal(env.alerts.modalState.membershipOnly, true);
  env.close();
  env.alerts.openMembership();
  assert.equal(env.calls.opened, 3);
  assert.equal(env.local.get(NOTICE_KEY), '2026-09-25');
});

test('unavailable, inactive or expired entitlement never consumes a daily notice', async () => {
  for (const entitlement of [null, { active: false }, { active: false, lifetime: false, expiresAt: new Date(NOW - 1000).toISOString() }]) {
    const env = browser();
    env.alerts.entitlement = entitlement;
    await env.notify();
    assert.equal(env.calls.opened, 0);
    assert.equal(env.local.has(NOTICE_KEY), false);
    assert.equal(env.calls.render, 1);
    assert.equal(env.calls.visit, 1);
    env.alerts.entitlement = { active: true, lifetime: true };
    await env.notify();
    assert.equal(env.calls.opened, 1);
  }
});

test('existing modal, payment return and hidden page skip without consuming the daily notice', async () => {
  const cases = [
    { block: (env) => { env.alerts.modalState = { goodsNo: 'product-selected' }; }, unblock: (env) => { env.close(); } },
    { block: (env) => { env.context.location.search = '?priceAlertPayment=complete&paymentId=fixture'; }, unblock: (env) => { env.context.location.search = ''; } },
    { block: (env) => { env.document.hidden = true; env.document.visibilityState = 'hidden'; }, unblock: (env) => { env.document.hidden = false; env.document.visibilityState = 'visible'; } }
  ];
  for (const scenario of cases) {
    const env = browser();
    scenario.block(env);
    await env.notify();
    assert.equal(env.calls.opened, 0);
    assert.equal(env.local.has(NOTICE_KEY), false);
    assert.equal(env.session.has(NOTICE_KEY), false);
    scenario.unblock(env);
    await env.notify();
    assert.equal(env.calls.opened, 1);
    assert.equal(env.local.get(NOTICE_KEY), '2026-09-25');
  }
});

test('failed or incomplete modal opening does not consume the date and can be retried', async () => {
  for (const failure of ['failOpen', 'incompleteOpen']) {
    const env = browser();
    env.behavior[failure] = true;
    await assert.doesNotReject(() => env.notify());
    assert.equal(env.local.has(NOTICE_KEY), false);
    assert.equal(env.session.has(NOTICE_KEY), false);
    assert.notEqual(env.membership.dailyNoticeDay, '2026-09-25');
    env.behavior[failure] = false;
    await env.notify();
    assert.equal(env.calls.opened, 2);
    assert.equal(env.local.get(NOTICE_KEY), '2026-09-25');
  }
});

test('blocked local storage falls back to session storage across same-tab reloads', async () => {
  for (const localBehavior of [{ readFails: true, writeFails: true }, { writeFails: true }]) {
    const session = new Map();
    const env = browser({ localBehavior, session });
    await env.notify();
    assert.equal(env.calls.opened, 1);
    assert.equal(session.get(NOTICE_KEY), '2026-09-25');
    env.close();
    const reload = browser({ localBehavior, session });
    await reload.notify();
    assert.equal(reload.calls.opened, 0);
  }
});

test('unavailable persistent and session storage still avoid repeated notices in the open document', async () => {
  const env = browser({ localBehavior: { readFails: true, writeFails: true }, sessionBehavior: { readFails: true, writeFails: true } });
  await assert.doesNotReject(() => env.notify());
  env.close();
  await assert.doesNotReject(() => env.notify());
  assert.equal(env.calls.opened, 1);
  assert.equal(env.membership.dailyNoticeDay, '2026-09-25');
});

test('malformed and old stored values do not permanently suppress future membership notices', async () => {
  for (const value of ['undefined', '{bad-json', '2026-09-24', '']) {
    const local = new Map([[NOTICE_KEY, value]]);
    const env = browser({ local });
    await env.notify();
    assert.equal(env.calls.opened, 1);
    assert.equal(local.get(NOTICE_KEY), '2026-09-25');
  }
});

test('membership refresh reentry while the modal opens cannot open a second notice', async () => {
  const env = browser();
  env.behavior.reentry = true;
  await env.notify();
  await Promise.all(env.calls.reentries);
  assert.equal(env.calls.opened, 1);
  assert.equal(env.local.get(NOTICE_KEY), '2026-09-25');
});

test('exclusive browser locks serialize simultaneous notices from two tabs', async () => {
  const local = new Map();
  const locks = sharedLocks();
  const first = browser({ local, locks });
  const second = browser({ local, locks, lifetime: true });
  await Promise.all([first.notify(), second.notify()]);
  assert.equal(first.calls.opened + second.calls.opened, 1);
  assert.ok(locks.calls.length >= 2);
  assert.ok(locks.calls.every((call) => call.name === NOTICE_KEY && call.mode === 'exclusive'));
  assert.equal(local.get(NOTICE_KEY), '2026-09-25');
});

test('lock wait rechecks a page that became hidden before it may show the notice', async () => {
  let unlock;
  const barrier = new Promise((resolve) => { unlock = resolve; });
  const locks = { request(_name, options, callback) {
    if (typeof options === 'function') callback = options;
    return barrier.then(() => callback());
  } };
  const env = browser({ locks });
  const pending = env.notify();
  env.document.hidden = true;
  env.document.visibilityState = 'hidden';
  unlock();
  await pending;
  assert.equal(env.calls.opened, 0);
  assert.equal(env.local.has(NOTICE_KEY), false);
  env.document.hidden = false;
  env.document.visibilityState = 'visible';
  await env.notify();
  assert.equal(env.calls.opened, 1);
});

test('rejected lock access cannot leave an unhandled rejection or consume a notice without displaying', async () => {
  const env = browser({ locks: { request: () => Promise.reject(new Error('locks unavailable')) } });
  await assert.doesNotReject(() => env.notify());
  assert.ok(env.calls.opened <= 1);
  if (env.calls.opened === 0) assert.equal(env.local.has(NOTICE_KEY), false);
  else assert.equal(env.local.get(NOTICE_KEY), '2026-09-25');
});
