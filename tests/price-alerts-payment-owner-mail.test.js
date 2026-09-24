const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { encryptJson, decryptJson } = require('../api/price-alerts/_crypto');
const { PASS_ORDER_NAME } = require('../api/price-alerts/_entitlement');
const { notifyOwnerPayment, retryOwnerPaymentNotifications, sendOwnerPaymentTest } = require('../api/price-alerts/_payment-owner-mail');

const OWNER = 'kbhjjan@gmail.com';
const NOW = Date.parse('2026-09-25T01:00:00.000Z');
const KEY = Buffer.alloc(32, 27);
const clone = (value) => JSON.parse(JSON.stringify(value));
const iso = (value) => new Date(value).toISOString();
const ENV = {
  PRICE_ALERT_PAYMENT_OWNER_MAIL_ENABLED: 'true',
  PRICE_ALERT_PAYMENT_OWNER_MAIL_START_AT: iso(NOW - 3600000),
  PRICE_ALERT_SMTP_HOST: 'smtp.example.com', PRICE_ALERT_SMTP_PORT: '465',
  PRICE_ALERT_SMTP_USER: 'service@example.com', PRICE_ALERT_SMTP_PASSWORD: 'mock-password',
  PRICE_ALERT_SMTP_FROM: 'service@example.com'
};

function event(type = 'paid', options = {}) {
  const paymentId = options.paymentId || 'oypa_owner_notification_00000001';
  const contract = {
    amount: 30000, currency: 'KRW', orderName: PASS_ORDER_NAME,
    storeId: 'store-owner-mail-test', channelKey: 'channel-key-owner-mail-test',
    channelType: 'LIVE', payMethod: 'EASY_PAY', easyPayProvider: 'KAKAOPAY'
  };
  const action = type === 'paid' ? 'paid' : type === 'cancelled' ? 'cancelled' : 'review_required';
  const reason = type === 'paid' ? 'verified_paid' : type === 'cancelled' ? 'verified_full_cancellation' : 'partial_cancellation';
  return {
    payment: { ...contract, paymentId,
      status: type === 'paid' ? 'PAID' : type === 'cancelled' ? 'CANCELLED' : 'PARTIAL_CANCELLED',
      cancelledAmount: type === 'paid' ? 0 : type === 'cancelled' ? 30000 : options.cancelledAmount || 1000,
      paidAt: iso(NOW - 2000), cancelledAt: iso(NOW - 1000)
    },
    intent: { paymentId, ownerDeviceId: 'OwnerMailDevice00000000001', contract,
      status: action, decisionReason: reason, createdAt: iso(NOW - 10000), expiresAt: iso(NOW + 86400000) },
    decision: { action, reason, ...(type === 'partial_cancelled' ? { suspendGrant: true } : {}) },
    ownerRecord: { deviceId: 'OwnerMailDevice00000000001', account: {
      email: 'buyer@example.com', verifiedAt: iso(NOW - 20000), indexLinked: true
    } },
    now: NOW
  };
}

function memory() {
  const rows = new Map();
  const messages = [];
  const options = [];
  let revision = 0;
  let time = NOW;
  const env = { ...ENV };
  const behavior = { smtpFailure: false, beforeSend: null, beforePut: null, beforeDelete: null, beforeGet: null };
  const deps = {
    env, dataKey: KEY, clock: () => time,
    async get(pathname, config) {
      assert.equal(config.access, 'private');
      assert.equal(config.headers['Accept-Encoding'], 'identity');
      if (behavior.beforeGet) await behavior.beforeGet(pathname);
      const row = rows.get(pathname);
      return row ? { stream: Readable.from([row.text]), blob: { etag: row.etag } } : null;
    },
    async put(pathname, text, config) {
      assert.equal(config.access, 'private');
      assert.equal(config.addRandomSuffix, false);
      assert.equal(config.contentType, 'application/octet-stream');
      const body = decryptJson(text, KEY);
      if (behavior.beforePut) await behavior.beforePut(pathname, body, config);
      const prior = rows.get(pathname);
      if ((prior && !config.allowOverwrite) || (config.ifMatch && prior?.etag !== config.ifMatch)) {
        throw Object.assign(new Error('CAS conflict'), { statusCode: 412 });
      }
      const etag = `"mail-${++revision}"`;
      rows.set(pathname, { text, etag });
      return { etag };
    },
    async del(pathname) {
      if (behavior.beforeDelete) await behavior.beforeDelete(pathname);
      rows.delete(pathname);
    },
    async list({ prefix, cursor, limit }) {
      const paths = [...rows.keys()].filter((key) => key.startsWith(prefix)).sort();
      const remaining = paths.filter((key) => !cursor || key > cursor);
      const page = remaining.slice(0, limit);
      return { blobs: page.map((pathname) => ({ pathname })), hasMore: remaining.length > page.length, cursor: page.at(-1) };
    },
    createTransport(config) {
      options.push(config);
      return {
        async sendMail(message) {
          messages.push(message);
          if (behavior.beforeSend) await behavior.beforeSend(message);
          if (behavior.smtpFailure) throw new Error('private SMTP details never propagated');
          return { accepted: [OWNER], rejected: [] };
        },
        close() {}
      };
    }
  };
  return {
    deps, rows, messages, options, behavior, env,
    advance: (ms) => { time += ms; },
    entries: (kind) => [...rows].filter(([path]) => path.includes(`/${kind}/`))
      .map(([path, row]) => ({ path, body: decryptJson(row.text, KEY), etag: row.etag })),
    replace(path, body, etag) { rows.set(path, { text: encryptJson(body, KEY), etag: etag || `"mail-${++revision}"` }); }
  };
}

test('owner notifications require enabled flag and an explicit valid event cutoff', async () => {
  for (const changes of [
    { PRICE_ALERT_PAYMENT_OWNER_MAIL_ENABLED: '' },
    { PRICE_ALERT_PAYMENT_OWNER_MAIL_ENABLED: 'false' },
    { PRICE_ALERT_PAYMENT_OWNER_MAIL_START_AT: '' },
    { PRICE_ALERT_PAYMENT_OWNER_MAIL_START_AT: 'yesterday' }
  ]) {
    const env = memory();
    Object.assign(env.env, changes);
    assert.deepEqual(await notifyOwnerPayment(event(), env.deps), { state: 'disabled' });
    assert.equal((await retryOwnerPaymentNotifications(env.deps)).enabled, false);
    assert.deepEqual(await sendOwnerPaymentTest(env.deps), { state: 'disabled' });
    assert.equal(env.rows.size, 0);
    assert.equal(env.messages.length, 0);
  }
});

test('enabled flag tolerates surrounding CLI pipe CRLF whitespace', async () => {
  const env = memory();
  env.env.PRICE_ALERT_PAYMENT_OWNER_MAIL_ENABLED = ' true\r\n';
  assert.equal((await notifyOwnerPayment(event(), env.deps)).state, 'sent');
});

test('verified payment sends a fixed-recipient TLS mail and keeps only an encrypted receipt', async () => {
  const env = memory();
  const context = event();
  context.to = 'attacker@example.com';
  context.payment.to = 'attacker@example.com';
  assert.deepEqual(await notifyOwnerPayment(context, env.deps), { state: 'sent' });
  assert.equal(env.messages.length, 1);
  const message = env.messages[0];
  assert.equal(message.to, OWNER);
  assert.equal(message.from, ENV.PRICE_ALERT_SMTP_FROM);
  assert.equal(message.disableFileAccess, true);
  assert.equal(message.disableUrlAccess, true);
  assert.match(message.subject, /결제 승인.*30,000원/);
  assert.match(message.text, /buyer@example.com/);
  assert.doesNotMatch(message.text, /mock-password|secret|channel-key|store-owner/);
  assert.equal(env.options[0].requireTLS, true);
  assert.equal(env.options[0].secure, true);
  assert.equal(env.options[0].tls.rejectUnauthorized, true);
  assert.equal(env.options[0].tls.minVersion, 'TLSv1.2');
  assert.equal(env.options[0].logger, false);
  assert.equal(env.options[0].debug, false);
  assert.ok(env.options[0].socketTimeout <= 20000);
  assert.equal(env.entries('pending').length, 0);
  assert.equal(env.entries('receipts')[0].body.state, 'sent');
  assert.ok([...env.rows.keys()].every((pathname) => !pathname.includes(context.payment.paymentId)));
  assert.ok([...env.rows.values()].every((row) => !row.text.includes('buyer@example.com')));
});

test('parallel duplicate events, browser completion and cron share one durable send lease', async () => {
  const env = memory();
  const results = await Promise.all(Array.from({ length: 12 }, () => notifyOwnerPayment(event(), env.deps)));
  assert.ok(results.every((result) => ['sent', 'queued'].includes(result.state)));
  assert.equal(env.messages.length, 1);
  assert.deepEqual(await notifyOwnerPayment(event(), env.deps), { state: 'sent' });
  await Promise.all([retryOwnerPaymentNotifications(env.deps), retryOwnerPaymentNotifications(env.deps)]);
  assert.equal(env.messages.length, 1);
});

test('approval, increasing partial cancellation and full cancellation each notify once', async () => {
  const env = memory();
  const fixtures = [event(), event('partial_cancelled'), event('partial_cancelled', { cancelledAmount: 5000 }), event('cancelled')];
  for (const fixture of fixtures) {
    assert.equal((await notifyOwnerPayment(fixture, env.deps)).state, 'sent');
    assert.equal((await notifyOwnerPayment(fixture, env.deps)).state, 'sent');
  }
  assert.equal(env.messages.length, 4);
  assert.equal(new Set(env.messages.map((message) => message.messageId)).size, 4);
  assert.match(env.messages[1].text, /누적 취소금액: 1,000원/);
  assert.match(env.messages[2].text, /남은 결제금액: 25,000원/);
  assert.match(env.messages[3].subject, /전액 취소/);
});

test('forged events, stale PAID and incomplete or mismatching partial contracts never queue', async () => {
  const changes = [
    (c) => { c.payment.status = 'READY'; },
    (c) => { c.payment.paymentId += 'foreign'; },
    (c) => { c.payment.storeId = 'store-other-000'; },
    (c) => { c.payment.channelKey = 'channel-key-other-000'; },
    (c) => { c.payment.amount = 1; },
    (c) => { c.payment.currency = 'USD'; },
    (c) => { c.payment.channelType = 'TEST'; },
    (c) => { c.payment.payMethod = 'CARD'; },
    (c) => { c.payment.easyPayProvider = 'OTHER'; },
    (c) => { c.intent.contract.orderName = 'Unrelated product'; },
    (c) => { c.intent.status = 'cancelled'; c.intent.decisionReason = 'verified_full_cancellation'; },
    (c) => { c.decision.reason = 'already_cancelled'; }
  ];
  for (const type of ['paid', 'partial_cancelled', 'cancelled']) {
    for (const change of changes) {
      if (type === 'cancelled' && changes.indexOf(change) === 10) continue;
      const env = memory();
      const context = event(type);
      change(context);
      assert.equal((await notifyOwnerPayment(context, env.deps)).state, 'ignored');
      assert.equal(env.messages.length, 0);
      assert.equal(env.rows.size, 0);
    }
  }
  for (const amount of [null, 0, -1, 0.5, 30000, 30001]) {
    const env = memory();
    const context = event('partial_cancelled');
    context.payment.cancelledAmount = amount;
    assert.equal((await notifyOwnerPayment(context, env.deps)).state, 'ignored');
  }
});

test('cutoff uses verified provider time with inclusive boundary and rejects future or malformed times', async () => {
  for (const [offset, expected] of [[-1, 'ignored'], [0, 'sent'], [1, 'sent']]) {
    const env = memory();
    const context = event();
    env.env.PRICE_ALERT_PAYMENT_OWNER_MAIL_START_AT = iso(NOW - 2000);
    context.payment.paidAt = iso(NOW - 2000 + offset);
    assert.equal((await notifyOwnerPayment(context, env.deps)).state, expected);
  }
  for (const type of ['paid', 'partial_cancelled', 'cancelled']) {
    for (const value of ['', 'invalid', iso(NOW + 1), iso(NOW - 20000)]) {
      const env = memory();
      const context = event(type);
      context.payment[type === 'paid' ? 'paidAt' : 'cancelledAt'] = value;
      assert.equal((await notifyOwnerPayment(context, env.deps)).state, 'ignored');
    }
  }
  const env = memory();
  const context = event();
  context.intent.expiresAt = iso(NOW - 3000);
  assert.equal((await notifyOwnerPayment(context, env.deps)).state, 'ignored');
});

test('customer identity is optional and only copied from the matching verified owner', async () => {
  for (const change of [
    (c) => { c.ownerRecord.deviceId = 'another-device'; },
    (c) => { c.ownerRecord.account.indexLinked = false; },
    (c) => { c.ownerRecord.account.verifiedAt = ''; },
    (c) => { c.ownerRecord.account.email = 'buyer@example.com\r\nBcc:bad@example.com'; }
  ]) {
    const env = memory();
    const context = event();
    change(context);
    assert.equal((await notifyOwnerPayment(context, env.deps)).state, 'sent');
    assert.doesNotMatch(env.messages[0].text, /고객 이메일|Bcc/);
  }
});

test('SMTP errors remain queued, obey backoff and stop after five durable attempts', async () => {
  const env = memory();
  env.behavior.smtpFailure = true;
  assert.equal((await notifyOwnerPayment(event(), env.deps)).state, 'queued');
  assert.equal(env.entries('pending')[0].body.attempts, 1);
  await notifyOwnerPayment(event(), env.deps);
  await retryOwnerPaymentNotifications(env.deps);
  assert.equal(env.messages.length, 1);
  for (let i = 1; i < 5; i++) {
    env.advance(3 * 3600000);
    await retryOwnerPaymentNotifications(env.deps);
  }
  assert.equal(env.messages.length, 5);
  assert.equal(new Set(env.messages.map((message) => message.messageId)).size, 1);
  assert.equal(env.entries('pending').length, 0);
  assert.equal(env.entries('receipts')[0].body.state, 'failed');
  assert.equal((await notifyOwnerPayment(event(), env.deps)).state, 'failed');
  await retryOwnerPaymentNotifications(env.deps);
  assert.equal(env.messages.length, 5);
});

test('missing SMTP configuration is retryable and never leaks exception details', async () => {
  const env = memory();
  env.env.PRICE_ALERT_SMTP_PASSWORD = '';
  assert.deepEqual(await notifyOwnerPayment(event(), env.deps), { state: 'queued' });
  assert.equal(env.messages.length, 0);
  assert.equal(env.entries('pending')[0].body.attempts, 1);
});

test('queue write errors are distinct from SMTP errors and return safe queue_error', async () => {
  const env = memory();
  env.behavior.beforePut = () => { throw new Error('private provider response'); };
  assert.deepEqual(await notifyOwnerPayment(event(), env.deps), { state: 'queue_error' });
  assert.equal(env.messages.length, 0);
  const retry = await retryOwnerPaymentNotifications({ ...env.deps, list: async () => { throw new Error('private'); } });
  assert.equal(retry.errors, 1);
  assert.ok(!JSON.stringify(retry).includes('private'));
});

test('a weak validator fails closed without sending or overwriting the pending queue', async () => {
  const env = memory();
  env.behavior.smtpFailure = true;
  await notifyOwnerPayment(event(), env.deps);
  const pending = env.entries('pending')[0];
  env.replace(pending.path, pending.body, 'W/"weak"');
  env.advance(60001);
  const result = await retryOwnerPaymentNotifications(env.deps);
  assert.equal(result.errors, 1);
  assert.equal(env.messages.length, 1);
});

test('SMTP success followed by receipt failure recovers sent state without resending', async () => {
  const env = memory();
  env.behavior.beforePut = (path) => { if (path.includes('/receipts/')) throw new Error('receipt write failed'); };
  assert.equal((await notifyOwnerPayment(event(), env.deps)).state, 'queue_error');
  assert.equal(env.entries('pending')[0].body.state, 'sent');
  assert.equal(env.messages.length, 1);
  env.behavior.beforePut = null;
  await retryOwnerPaymentNotifications(env.deps);
  assert.equal(env.messages.length, 1);
  assert.equal(env.entries('receipts')[0].body.state, 'sent');
  assert.equal(env.entries('pending').length, 0);
});

test('receipt success followed by delete failure and racing requeue never resends', async () => {
  const env = memory();
  let savedPending;
  env.behavior.beforeDelete = (path) => {
    savedPending = env.entries('pending').find((entry) => entry.path === path);
    throw new Error('delete failed');
  };
  assert.equal((await notifyOwnerPayment(event(), env.deps)).state, 'queue_error');
  assert.equal(env.entries('receipts').length, 1);
  env.behavior.beforeDelete = null;
  await retryOwnerPaymentNotifications(env.deps);
  assert.equal(env.entries('pending').length, 0);
  env.replace(savedPending.path, { ...savedPending.body, state: 'queued', attempts: 0 });
  await Promise.all([retryOwnerPaymentNotifications(env.deps), notifyOwnerPayment(event(), env.deps)]);
  assert.equal(env.messages.length, 1);
  assert.equal(env.entries('pending').length, 0);
});

test('a receipt appearing during queue creation is checked again before SMTP', async () => {
  const env = memory();
  env.behavior.beforePut = (path, body) => {
    if (path.includes('/pending/') && body.state === 'queued') {
      env.replace(path.replace('/pending/', '/receipts/'), { version: 1, id: body.id, state: 'sent', completedAt: iso(NOW) });
    }
  };
  assert.equal((await notifyOwnerPayment(event(), env.deps)).state, 'sent');
  assert.equal(env.messages.length, 0);
  assert.equal(env.entries('pending').length, 0);
});

test('expired fifth-attempt lease becomes a terminal receipt without a sixth SMTP attempt', async () => {
  const env = memory();
  env.behavior.smtpFailure = true;
  await notifyOwnerPayment(event(), env.deps);
  const pending = env.entries('pending')[0];
  env.replace(pending.path, { ...pending.body, state: 'sending', attempts: 5, leaseId: 'dead-worker', leaseUntil: iso(NOW - 1) });
  await retryOwnerPaymentNotifications(env.deps);
  assert.equal(env.messages.length, 1);
  assert.equal(env.entries('receipts')[0].body.state, 'failed');
});

test('a worker whose lease was replaced cannot overwrite the new owner outcome', async () => {
  const env = memory();
  env.behavior.beforeSend = () => {
    const pending = env.entries('pending')[0];
    env.replace(pending.path, { ...pending.body, leaseId: 'replacement-worker', leaseUntil: iso(NOW + 600000) });
  };
  assert.equal((await notifyOwnerPayment(event(), env.deps)).state, 'queued');
  assert.equal(env.entries('pending')[0].body.leaseId, 'replacement-worker');
  assert.equal(env.entries('pending')[0].body.state, 'sending');
  assert.equal(env.entries('receipts').length, 0);
});

test('retry processes at most twenty sends even if persisting post-send state fails', async () => {
  const env = memory();
  env.behavior.smtpFailure = true;
  for (let i = 0; i < 25; i++) {
    await notifyOwnerPayment(event('paid', { paymentId: `oypa_owner_notifications_${String(i).padStart(8, '0')}` }), env.deps);
  }
  env.advance(60001);
  env.behavior.smtpFailure = false;
  env.behavior.beforePut = (_path, body) => { if (body.state === 'sent') throw new Error('sent write failed'); };
  const result = await retryOwnerPaymentNotifications(env.deps);
  assert.equal(result.attempted, 20);
  assert.equal(result.errors, 20);
  assert.equal(env.messages.length, 45);
});

test('retry stops starting sends at the 45-second execution budget', async () => {
  const env = memory();
  env.behavior.smtpFailure = true;
  for (let i = 0; i < 4; i++) {
    await notifyOwnerPayment(event('paid', { paymentId: `oypa_budget_notification_${String(i).padStart(8, '0')}` }), env.deps);
  }
  env.advance(60001);
  env.behavior.smtpFailure = false;
  env.behavior.beforeSend = () => env.advance(23000);
  const result = await retryOwnerPaymentNotifications(env.deps);
  assert.equal(result.attempted, 2);
  assert.equal(env.messages.length, 6);
});

test('retry scan is bounded at 1000 and treats malformed listed paths as errors', async () => {
  const env = memory();
  let calls = 0;
  env.deps.list = async ({ prefix, limit }) => ({
    blobs: Array.from({ length: limit }, (_, i) => ({ pathname: `${prefix}invalid-${calls}-${i}.enc` })),
    hasMore: true, cursor: String(++calls)
  });
  const result = await retryOwnerPaymentNotifications(env.deps);
  assert.equal(result.scanned, 1000);
  assert.equal(result.errors, 1000);
  assert.equal(calls, 10);
  assert.equal(env.messages.length, 0);
});

test('a final receipt read finishing after the deadline cannot start SMTP', async () => {
  const env = memory();
  let receiptReads = 0;
  env.behavior.beforeGet = (path) => {
    if (path.includes('/receipts/') && ++receiptReads === 3) env.advance(46000);
  };
  assert.equal((await notifyOwnerPayment(event(), env.deps)).state, 'queue_error');
  assert.equal(env.messages.length, 0);
  assert.equal(env.entries('pending')[0].body.state, 'sending');
});

test('Blob operations receive a deadline abort signal and bounded retries return safely', async () => {
  const env = memory();
  let observedAbort = false;
  const result = await retryOwnerPaymentNotifications({
    ...env.deps, budgetMs: 15,
    list: ({ abortSignal }) => new Promise((_, reject) => {
      abortSignal.addEventListener('abort', () => { observedAbort = true; reject(new Error('aborted')); }, { once: true });
    })
  });
  assert.equal(observedAbort, true);
  assert.equal(result.errors, 1);
  assert.equal(env.messages.length, 0);
});

test('SMTP deadline destroys its actual owned socket and blocks late DNS reconnection', async () => {
  const env = memory();
  let socket;
  let destroyed = false;
  let connectCalls = 0;
  const result = await sendOwnerPaymentTest({
    ...env.deps, budgetMs: 15,
    createSocket: () => ({ connect() { connectCalls++; }, destroy() { destroyed = true; } }),
    createTransport: (options) => {
      socket = options.socket;
      return { sendMail: () => new Promise(() => {}), close() {} };
    }
  });
  assert.equal(result.state, 'failed');
  assert.equal(destroyed, true);
  assert.throws(() => socket.connect(465, 'smtp.example.com'), /owner_mail_socket_closed/);
  assert.equal(connectCalls, 0);
});

test('operator test is explicitly labeled, fixed-recipient and never queues a transaction', async () => {
  const env = memory();
  assert.equal((await sendOwnerPaymentTest(env.deps)).state, 'sent');
  assert.equal(env.rows.size, 0);
  assert.equal(env.messages.length, 1);
  assert.equal(env.messages[0].to, OWNER);
  assert.match(env.messages[0].subject, /테스트 \(실결제 아님\)/);
  assert.match(env.messages[0].text, /실제 결제·취소·이용권 변경은 발생하지 않았습니다/);
});
