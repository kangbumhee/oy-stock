const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createDeviceRecord } = require('../api/price-alerts/_core');
const { paymentContract } = require('../api/price-alerts/_portone');

const NOW = Date.parse('2026-09-25T04:00:00Z');
const ID = 'OwnerPaymentMailDevice00000001';
const PAYMENT_ID = 'oypa_owner_mail_integration_000001';
const CONFIG = { storeId: 'store-test', channelKey: 'channel-test', expectedChannelType: 'LIVE' };
const clone = (value) => JSON.parse(JSON.stringify(value));

function load(file, overrides) {
  const filename = path.join(__dirname, '../api/price-alerts', file);
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, process, Buffer, URL, console,
    require: (key) => overrides[key] || nativeRequire(key)
  }, { filename });
  return module.exports;
}

function reconciliation(notify, options = {}) {
  const calls = [];
  const service = load('_payment-service.js', {
    './_payment-owner-mail': { notifyOwnerPayment: notify }
  });
  let intent = {
    paymentId: PAYMENT_ID, ownerDeviceId: ID, status: 'prepared',
    contract: paymentContract(CONFIG), events: [],
    createdAt: new Date(NOW - 60000).toISOString(),
    expiresAt: new Date(NOW + 60000).toISOString()
  };
  let record = createDeviceRecord(ID, 'OwnerPaymentMailSecret000000000000001', new Date(NOW).toISOString());
  record.account = { email: 'buyer@example.com', verifiedAt: new Date(NOW).toISOString() };
  const deps = {
    now: NOW,
    async readIntent() { return { intent: clone(intent) }; },
    async getPayment() {
      calls.push('provider');
      if (options.providerError) throw new Error('provider-unavailable');
      return {
        ...intent.contract, paymentId: PAYMENT_ID, status: 'PAID', amount: 30000,
        cancelledAmount: 0, paidAt: new Date(NOW).toISOString()
      };
    },
    async mutateDevice(_id, mutate) {
      const result = await mutate(clone(record));
      record = result.record;
      calls.push('device-saved');
      return result;
    },
    async mutateIntent(_id, mutate) {
      if (options.concurrentCancel) intent.status = 'cancelled';
      if (options.concurrentPartial) {
        intent.status = 'review_required';
        intent.decisionReason = 'partial_cancellation';
      }
      const result = await mutate(clone(intent));
      intent = result.intent;
      calls.push('intent-saved');
      return result;
    }
  };
  return {
    calls, record: () => record,
    run: () => service.reconcilePayment(PAYMENT_ID, ID, CONFIG, deps)
  };
}

test('owner mail runs after authoritative lookup and both financial writes', async () => {
  let captured;
  const h = reconciliation(async (input) => {
    h.calls.push('mail'); captured = input;
    return { state: 'queued' };
  });
  const result = await h.run();
  assert.deepEqual(h.calls, ['provider', 'device-saved', 'intent-saved', 'mail']);
  assert.equal(captured.intent.status, 'paid');
  assert.equal(captured.payment.paymentId, PAYMENT_ID);
  assert.equal(captured.ownerRecord.account.email, 'buyer@example.com');
  assert.equal(result.status, 'paid');
  assert.equal(result.ownerNotification.state, 'queued');
});

test('mail failure cannot roll back verified paid entitlement', async () => {
  const h = reconciliation(async () => { throw new Error('private SMTP data must not escape'); });
  const result = await h.run();
  assert.equal(result.status, 'paid');
  assert.equal(result.ownerNotification.state, 'queue_error');
  assert.equal(h.record().entitlement.grants.length, 1);
  assert.ok(!JSON.stringify(result).includes('private SMTP'));
});

test('mail receives latest cancelled CAS state instead of stale prepared read', async () => {
  let captured;
  const h = reconciliation(async (input) => { captured = input; return { state: 'ignored' }; }, { concurrentCancel: true });
  await h.run();
  assert.equal(captured.intent.status, 'cancelled');
  assert.equal(captured.payment.status, 'PAID');
});

test('provider lookup failure never queues an owner mail', async () => {
  let sent = false;
  const h = reconciliation(async () => { sent = true; }, { providerError: true });
  await assert.rejects(h.run(), /provider-unavailable/);
  assert.equal(sent, false);
});

test('concurrent partial cancellation is not overwritten by stale paid intent', async () => {
  let captured;
  const h = reconciliation(async (input) => { captured = input; return { state: 'ignored' }; }, { concurrentPartial: true });
  await h.run();
  assert.equal(captured.intent.status, 'review_required');
  assert.equal(captured.intent.decisionReason, 'partial_cancellation');
});

function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = JSON.parse(body); } };
}

test('webhook retries only failed durable queue writes, not queued SMTP outages', async () => {
  for (const state of ['queue_error', 'queued', 'sent', 'failed', 'ignored']) {
    const handler = load('payment-webhook.js', {
      './_limits': { consumeRateLimit: async () => {} },
      './_portone': { configuredPortOne: () => CONFIG },
      './_payment-service': { reconcilePayment: async () => ({ paymentId: PAYMENT_ID, status: 'paid', ownerNotification: { state } }) }
    });
    const res = response();
    await handler({ method: 'POST', body: { type: 'Transaction.Paid', data: { paymentId: PAYMENT_ID } } }, res);
    assert.equal(res.statusCode, state === 'queue_error' ? 503 : 200);
    if (state === 'queue_error') {
      assert.equal(res.headers['Retry-After'], '60');
      assert.equal(res.body.error, 'payment_notification_queue_unavailable');
    }
  }
});

test('hourly retries owner mail before zero-active-customer early return, only after cron auth', async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'owner-mail-cron-test';
  let retries = 0;
  const handler = load('hourly.js', {
    './_payment-owner-mail': { async retryOwnerPaymentNotifications() { retries++; return { sent: 1 }; } },
    './_registry': {
      async listActiveDeviceRefs() { assert.equal(retries, 1); return { refs: [], unreadableCount: 0 }; },
      configuredRegistryPolicy: () => ({ maintenanceMaxPerRun: 100 }),
      listStaleRegistryRefs: async () => ({ refs: [], unreadableCount: 0 })
    }
  });
  try {
    const denied = response();
    await handler({ method: 'GET', headers: {} }, denied);
    assert.equal(denied.statusCode, 401);
    assert.equal(retries, 0);
    const res = response();
    await handler({ method: 'GET', headers: { authorization: 'Bearer owner-mail-cron-test' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(retries, 1);
    assert.equal(res.body.alerts, 0);
    assert.equal(res.body.ownerPaymentMail.sent, 1);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});
