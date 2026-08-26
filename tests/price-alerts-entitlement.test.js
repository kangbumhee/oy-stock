const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const {
  PASS_AMOUNT_KRW,
  PASS_DURATION_MS,
  applyLifetimePromotion,
  applyPaymentGrant,
  configuredPromotion,
  promotionDigest,
  promotionMatches,
  publicEntitlement,
  requireActiveEntitlement,
  revokePaymentGrant
} = require('../api/price-alerts/_entitlement');
const {
  appendIntentEvent,
  createPayment,
  reconcilePayment
} = require('../api/price-alerts/_payment-service');
const { readIntent, writeIntent } = require('../api/price-alerts/_payment-store');
const {
  configuredPortOne,
  getPayment,
  paymentContract,
  PortOneSafeError,
  preRegisterPayment,
  verifyPayment
} = require('../api/price-alerts/_portone');
const { configuredRatePolicy } = require('../api/price-alerts/_limits');
const {
  recordClaimsActiveCapacity,
  recordNeedsHourlyWork
} = require('../api/price-alerts/_registry');
const {
  cleanupInactiveDevices,
  deliverPendingForDevice,
  loadActiveDeviceEntries
} = require('../api/price-alerts/hourly')._test;
const { webhookPaymentId } = require('../api/price-alerts/payment-webhook')._test;

const DEVICE_ID = 'EntitlementDevice123456789';
const PAYMENT_ONE = 'oypa_1234567890abcdefghijklmnop';
const PAYMENT_TWO = 'oypa_abcdefghijklmnopqrstuvwx';
const TEST_DATA_KEY = '11'.repeat(32);

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function baseRecord(overrides = {}) {
  return {
    version: 1,
    deviceId: DEVICE_ID,
    secretHash: 'test-hash',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    push: { active: false, subscription: null },
    alerts: [],
    pendingNotifications: [],
    entitlement: { version: 1, grants: [], paymentCancellations: [] },
    pendingPayment: null,
    ...overrides
  };
}

function withEnv(values, fn) {
  const previous = {};
  Object.keys(values).forEach((key) => {
    previous[key] = process.env[key];
    if (values[key] == null) delete process.env[key];
    else process.env[key] = values[key];
  });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Object.keys(values).forEach((key) => {
        if (previous[key] == null) delete process.env[key];
        else process.env[key] = previous[key];
      });
    });
}

function portOneEnv() {
  return {
    PRICE_ALERT_ENTITLEMENT_ENABLED: 'true',
    PRICE_ALERT_DATA_KEY: TEST_DATA_KEY,
    PRICE_ALERT_PORTONE_STORE_ID: 'store-test123456',
    PRICE_ALERT_PORTONE_CHANNEL_KEY: 'channel-key-test123456',
    PRICE_ALERT_PORTONE_API_SECRET: 'test-api-secret-value-1234',
    PRICE_ALERT_PORTONE_EXPECTED_CHANNEL_TYPE: 'LIVE',
    PRICE_ALERT_PUBLIC_SITE_URL: 'https://olivestock.example'
  };
}

function inMemoryPaymentDependencies(initialDevice) {
  let device = clone(initialDevice);
  const intents = new Map();
  let preRegisterCalls = 0;
  let activeReserved = false;
  let activeReservationCalls = 0;
  return {
    dependencies: {
      now: Date.parse('2026-08-26T01:00:00.000Z'),
      newPaymentId: () => PAYMENT_ONE,
      async reserveDeviceRegistration() {},
      async reserveActiveDevice() {
        activeReservationCalls += 1;
        if (activeReserved) return { created: false };
        activeReserved = true;
        return { created: true };
      },
      async releaseActiveDeviceReservation() {
        activeReserved = false;
        return true;
      },
      async mutateAuthenticatedDevice(_req, _options, mutation) {
        const outcome = await mutation(clone(device), { created: false });
        if (outcome.changed) device = clone(outcome.record);
        return { ...outcome, record: clone(device), value: outcome.value || {}, written: outcome.changed };
      },
      async mutateDevice(deviceId, mutation) {
        assert.equal(deviceId, DEVICE_ID);
        const outcome = await mutation(clone(device));
        if (outcome.changed) {
          device = clone(outcome.record);
          if (
            !recordClaimsActiveCapacity(
              device,
              Date.parse('2026-08-26T01:00:00.000Z')
            )
          ) {
            activeReserved = false;
          }
        }
        return { ...outcome, record: clone(device), value: outcome.value || {}, written: outcome.changed };
      },
      async readIntent(paymentId) {
        return { intent: clone(intents.get(paymentId) || null), etag: 'memory' };
      },
      async mutateIntent(paymentId, mutation) {
        const current = clone(intents.get(paymentId) || null);
        const outcome = await mutation(current);
        if (outcome.changed) intents.set(paymentId, clone(outcome.intent));
        return {
          ...outcome,
          intent: clone(outcome.intent === undefined ? current : outcome.intent),
          written: Boolean(outcome.changed)
        };
      },
      async preRegisterPayment() {
        preRegisterCalls += 1;
      }
    },
    getDevice: () => clone(device),
    getIntent: (paymentId) => clone(intents.get(paymentId) || null),
    setIntent: (intent) => intents.set(intent.paymentId, clone(intent)),
    preRegisterCalls: () => preRegisterCalls,
    activeReservationCalls: () => activeReservationCalls,
    activeReserved: () => activeReserved
  };
}

test('payment creation fixes the one-time 30-day contract and replays one pending idempotently', async () => {
  await withEnv(portOneEnv(), async () => {
    const config = configuredPortOne();
    const memory = inMemoryPaymentDependencies(baseRecord());
    const key = 'strong-idempotency-key-123456';
    const created = await createPayment({}, config, key, memory.dependencies);
    assert.equal(created.paymentId, PAYMENT_ONE);
    assert.deepEqual(created.plan, {
      amount: 30000,
      currency: 'KRW',
      durationDays: 30,
      autoRenew: false
    });
    assert.deepEqual(created.requestPayment, {
      storeId: config.storeId,
      channelKey: config.channelKey,
      paymentId: PAYMENT_ONE,
      orderName: '올리브재고 가격 알림 30일 이용권',
      totalAmount: 30000,
      currency: 'KRW',
      payMethod: 'EASY_PAY',
      easyPay: { easyPayProvider: 'KAKAOPAY' },
      redirectUrl: 'https://olivestock.example/?priceAlertPayment=complete',
      noticeUrls: ['https://olivestock.example/api/price-alerts/payment-webhook'],
      products: [
        {
          id: 'price_alert_30d',
          name: '올리브재고 가격 알림 30일 이용권',
          amount: 30000,
          quantity: 1
        }
      ]
    });
    assert.equal(memory.getIntent(PAYMENT_ONE).status, 'prepared');
    assert.deepEqual(
      memory.getIntent(PAYMENT_ONE).events.map((event) => event.type),
      ['created', 'pre_registered']
    );
    assert.equal(memory.getDevice().pendingPayment.status, 'prepared');
    assert.equal(memory.preRegisterCalls(), 1);
    assert.equal(memory.activeReserved(), true);

    const replay = await createPayment({}, config, key, memory.dependencies);
    assert.equal(replay.paymentId, PAYMENT_ONE);
    assert.equal(replay.idempotent, true);
    assert.equal(memory.preRegisterCalls(), 1);
    assert.equal(memory.activeReservationCalls(), 2);
    await assert.rejects(
      createPayment({}, config, 'different-strong-key-1234567', memory.dependencies),
      /payment_already_pending/
    );
  });
});

test('lifetime entitlement fails closed before any checkout or pre-registration', async () => {
  await withEnv(portOneEnv(), async () => {
    const record = baseRecord();
    applyLifetimePromotion(record, 'lifetime-promotion', '2026-08-01T00:00:00.000Z');
    const memory = inMemoryPaymentDependencies(record);
    await assert.rejects(
      createPayment({}, configuredPortOne(), 'strong-idempotency-key-123456', memory.dependencies),
      /lifetime_entitlement_active/
    );
    assert.equal(memory.preRegisterCalls(), 0);
    assert.equal(memory.getIntent(PAYMENT_ONE), null);
  });
});

test('full active capacity rejects checkout before intent or pre-registration', async () => {
  await withEnv(portOneEnv(), async () => {
    const memory = inMemoryPaymentDependencies(baseRecord());
    memory.dependencies.reserveActiveDevice = async () => {
      const error = new Error('active_device_capacity_reached');
      error.statusCode = 503;
      throw error;
    };
    await assert.rejects(
      createPayment(
        {},
        configuredPortOne(),
        'strong-idempotency-key-123456',
        memory.dependencies
      ),
      /active_device_capacity_reached/
    );
    assert.equal(memory.preRegisterCalls(), 0);
    assert.equal(memory.getIntent(PAYMENT_ONE), null);
    assert.equal(memory.getDevice().pendingPayment, null);
  });
});

test('non-retryable pre-registration failure abandons intent and releases payment capacity', async () => {
  await withEnv(portOneEnv(), async () => {
    const memory = inMemoryPaymentDependencies(baseRecord());
    memory.dependencies.preRegisterPayment = async () => {
      throw new PortOneSafeError('portone_pre_register_failed', false);
    };
    await assert.rejects(
      createPayment(
        {},
        configuredPortOne(),
        'strong-idempotency-key-123456',
        memory.dependencies
      ),
      /portone_pre_register_failed/
    );
    assert.equal(memory.getIntent(PAYMENT_ONE).status, 'abandoned');
    assert.equal(memory.getDevice().pendingPayment, null);
    assert.equal(memory.activeReserved(), false);
  });
});

test('PortOne pre-registration and GET use only the exact server contract and authoritative response', async () => {
  await withEnv(portOneEnv(), async () => {
    const config = configuredPortOne();
    const requests = [];
    const mockFetch = async (url, options) => {
      requests.push({ url, options });
      if (options.method === 'POST') return { status: 200 };
      return {
        status: 200,
        headers: { get: () => null },
        async text() {
          return JSON.stringify({
            id: PAYMENT_ONE,
            status: 'PAID',
            amount: { total: 30000, cancelled: 0 },
            currency: 'KRW',
            storeId: config.storeId,
            channel: { key: config.channelKey, type: 'LIVE' },
            paymentMethod: { type: 'PaymentMethodEasyPay', provider: 'KAKAOPAY' },
            paidAt: '2026-08-26T00:30:00.000Z'
          });
        }
      };
    };
    const intent = { paymentId: PAYMENT_ONE };
    await preRegisterPayment(config, intent, 'strong-idempotency-key-123456', { fetch: mockFetch });
    const payment = await getPayment(config, PAYMENT_ONE, { fetch: mockFetch });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.headers.Authorization, `PortOne ${config.apiSecret}`);
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      storeId: config.storeId,
      totalAmount: 30000,
      currency: 'KRW'
    });
    assert.equal(payment.payMethod, 'EASY_PAY');
    assert.equal(payment.easyPayProvider, 'KAKAOPAY');
  });
});

test('encrypted canonical payment intent Blob hides ownership and uses ETag CAS', async () => {
  await withEnv(portOneEnv(), async () => {
    let stored = null;
    const intent = {
      version: 1,
      revision: 1,
      paymentId: PAYMENT_ONE,
      ownerDeviceId: DEVICE_ID,
      idempotencyHash: 'hash',
      status: 'created',
      contract: paymentContract(configuredPortOne()),
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      expiresAt: '2026-08-27T00:00:00.000Z'
    };
    await writeIntent(intent, { etag: '' }, {
      async put(pathname, body, options) {
        assert.equal(options.access, 'private');
        stored = { pathname, body: String(body), options, etag: 'etag-1' };
        return { pathname, etag: 'etag-1' };
      }
    });
    assert.equal(stored.body.includes(DEVICE_ID), false);
    assert.equal(stored.body.includes(PAYMENT_ONE), false);
    assert.equal(stored.pathname.includes(PAYMENT_ONE), false);
    const loaded = await readIntent(PAYMENT_ONE, {
      async get(pathname, options) {
        assert.equal(pathname, stored.pathname);
        assert.equal(options.access, 'private');
        assert.equal(options.useCache, false);
        return { stream: Readable.from([stored.body]), blob: { etag: 'etag-1' } };
      }
    });
    assert.equal(loaded.intent.ownerDeviceId, DEVICE_ID);
    assert.equal(loaded.etag, 'etag-1');
  });
});

test('payment grants are exact-once and full cancellation recomputes stacked intervals', () => {
  const record = baseRecord();
  const first = applyPaymentGrant(record, PAYMENT_ONE, '2026-08-01T00:00:00.000Z');
  const duplicate = applyPaymentGrant(record, PAYMENT_ONE, '2026-08-01T00:00:00.000Z');
  const second = applyPaymentGrant(record, PAYMENT_TWO, '2026-08-02T00:00:00.000Z');
  assert.equal(first.changed, true);
  assert.equal(duplicate.changed, false);
  assert.equal(second.changed, true);
  const secondGrant = record.entitlement.grants.find((grant) => grant.paymentId === PAYMENT_TWO);
  assert.equal(
    Date.parse(secondGrant.startsAt),
    Date.parse('2026-08-01T00:00:00.000Z') + PASS_DURATION_MS
  );
  revokePaymentGrant(record, PAYMENT_ONE, '2026-08-03T00:00:00.000Z');
  assert.equal(secondGrant.startsAt, '2026-08-02T00:00:00.000Z');
  assert.equal(Date.parse(secondGrant.endsAt), Date.parse(secondGrant.startsAt) + PASS_DURATION_MS);
  const stalePaid = applyPaymentGrant(record, PAYMENT_ONE, '2026-08-04T00:00:00.000Z');
  assert.equal(stalePaid.changed, false);
  assert.equal(stalePaid.cancelled, true);
});

test('authoritative PAID grants once and authoritative full cancellation revokes that grant', async () => {
  await withEnv(portOneEnv(), async () => {
    const config = configuredPortOne();
    const contract = paymentContract(config);
    const pending = {
      paymentId: PAYMENT_ONE,
      ownerDeviceId: DEVICE_ID,
      idempotencyHash: 'hash',
      status: 'prepared',
      contract,
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      expiresAt: '2026-08-27T00:00:00.000Z'
    };
    const memory = inMemoryPaymentDependencies(baseRecord({ pendingPayment: clone(pending) }));
    memory.setIntent({ version: 1, revision: 1, ...clone(pending) });
    let providerStatus = 'PAID';
    memory.dependencies.now = Date.parse('2026-08-28T00:00:00.000Z');
    memory.dependencies.getPayment = async () => ({
      paymentId: PAYMENT_ONE,
      status: providerStatus,
      amount: PASS_AMOUNT_KRW,
      cancelledAmount: providerStatus === 'CANCELLED' ? PASS_AMOUNT_KRW : 0,
      currency: 'KRW',
      storeId: config.storeId,
      channelKey: config.channelKey,
      channelType: 'LIVE',
      payMethod: 'EASY_PAY',
      easyPayProvider: 'KAKAOPAY',
      paidAt: '2026-08-26T00:30:00.000Z',
      cancelledAt: providerStatus === 'CANCELLED' ? '2026-08-26T01:30:00.000Z' : ''
    });

    const paid = await reconcilePayment(PAYMENT_ONE, DEVICE_ID, config, memory.dependencies);
    const duplicate = await reconcilePayment(PAYMENT_ONE, DEVICE_ID, config, memory.dependencies);
    assert.equal(paid.status, 'paid');
    assert.equal(duplicate.idempotent, true);
    assert.equal(memory.getDevice().entitlement.grants.length, 1);
    assert.equal(memory.getDevice().pendingPayment, null);
    assert.deepEqual(
      memory.getIntent(PAYMENT_ONE).events.map((event) => event.type),
      ['grant', 'idempotent']
    );

    providerStatus = 'CANCELLED';
    const cancelled = await reconcilePayment(PAYMENT_ONE, null, config, memory.dependencies);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(publicEntitlement(memory.getDevice(), memory.dependencies.now).active, false);
    assert.equal(memory.getDevice().entitlement.paymentCancellations.length, 1);
    assert.deepEqual(
      memory.getIntent(PAYMENT_ONE).events.map((event) => event.type),
      ['grant', 'idempotent', 'revoke']
    );
  });
});

test('partial cancellation before a grant blocks entitlement, clears outbox, and releases pending capacity claim', async () => {
  await withEnv(portOneEnv(), async () => {
    const config = configuredPortOne();
    const pending = {
      paymentId: PAYMENT_ONE,
      ownerDeviceId: DEVICE_ID,
      idempotencyHash: 'hash',
      status: 'prepared',
      contract: paymentContract(config),
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      expiresAt: '2026-08-27T00:00:00.000Z'
    };
    const memory = inMemoryPaymentDependencies(
      baseRecord({
        pendingPayment: clone(pending),
        pendingNotifications: [{ eventKey: 'PartialBeforeGrantEvent12345' }]
      })
    );
    memory.setIntent({ version: 1, revision: 1, ...clone(pending) });
    memory.dependencies.getPayment = async () => ({
      paymentId: PAYMENT_ONE,
      status: 'PARTIAL_CANCELLED',
      amount: PASS_AMOUNT_KRW,
      cancelledAmount: 1000,
      currency: 'KRW',
      storeId: config.storeId,
      channelKey: config.channelKey,
      channelType: 'LIVE',
      payMethod: 'EASY_PAY',
      easyPayProvider: 'KAKAOPAY',
      paidAt: '',
      cancelledAt: '2026-08-26T00:30:00.000Z'
    });

    const result = await reconcilePayment(PAYMENT_ONE, DEVICE_ID, config, memory.dependencies);
    const record = memory.getDevice();
    assert.equal(result.status, 'review_required');
    assert.equal(result.entitlement.active, false);
    assert.equal(record.entitlement.grants.length, 0);
    assert.equal(record.entitlement.paymentCancellations.length, 1);
    assert.equal(record.pendingPayment.status, 'review_required');
    assert.equal(record.pendingNotifications.length, 0);
    assert.equal(
      recordClaimsActiveCapacity(record, Date.parse('2026-08-26T01:00:00.000Z')),
      false
    );
  });
});

test('partial cancellation after PAID immediately revokes that grant and remains sticky on stale PAID', async () => {
  await withEnv(portOneEnv(), async () => {
    const config = configuredPortOne();
    const pending = {
      paymentId: PAYMENT_ONE,
      ownerDeviceId: DEVICE_ID,
      idempotencyHash: 'hash',
      status: 'prepared',
      contract: paymentContract(config),
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      expiresAt: '2026-08-27T00:00:00.000Z'
    };
    const memory = inMemoryPaymentDependencies(
      baseRecord({
        pendingPayment: clone(pending),
        pendingNotifications: [{ eventKey: 'PartialAfterPaidEvent123456' }]
      })
    );
    memory.setIntent({ version: 1, revision: 1, ...clone(pending) });
    let providerStatus = 'PAID';
    memory.dependencies.getPayment = async () => ({
      paymentId: PAYMENT_ONE,
      status: providerStatus,
      amount: PASS_AMOUNT_KRW,
      cancelledAmount: providerStatus === 'PARTIAL_CANCELLED' ? 1000 : 0,
      currency: 'KRW',
      storeId: config.storeId,
      channelKey: config.channelKey,
      channelType: 'LIVE',
      payMethod: 'EASY_PAY',
      easyPayProvider: 'KAKAOPAY',
      paidAt: '2026-08-26T00:15:00.000Z',
      cancelledAt:
        providerStatus === 'PARTIAL_CANCELLED' ? '2026-08-26T01:00:00.000Z' : ''
    });

    assert.equal(
      (await reconcilePayment(PAYMENT_ONE, DEVICE_ID, config, memory.dependencies)).status,
      'paid'
    );
    providerStatus = 'PARTIAL_CANCELLED';
    const partial = await reconcilePayment(PAYMENT_ONE, null, config, memory.dependencies);
    let record = memory.getDevice();
    assert.equal(partial.status, 'review_required');
    assert.equal(partial.entitlement.active, false);
    assert.ok(record.entitlement.grants[0].revokedAt);
    assert.equal(record.pendingNotifications.length, 0);
    assert.equal(
      recordClaimsActiveCapacity(record, Date.parse('2026-08-26T01:00:00.000Z')),
      false
    );
    assert.equal(memory.getIntent(PAYMENT_ONE).decisionReason, 'partial_cancellation');

    providerStatus = 'PAID';
    const stalePaid = await reconcilePayment(PAYMENT_ONE, null, config, memory.dependencies);
    record = memory.getDevice();
    assert.equal(stalePaid.status, 'review_required');
    assert.equal(stalePaid.entitlement.active, false);
    assert.ok(record.entitlement.grants[0].revokedAt);
  });
});

test('wrong amount, provider, store, and partial cancellation require review and never grant', async () => {
  await withEnv(portOneEnv(), async () => {
    const config = configuredPortOne();
    const contract = paymentContract(config);
    const basePayment = {
      paymentId: PAYMENT_ONE,
      status: 'PAID',
      amount: PASS_AMOUNT_KRW,
      cancelledAmount: 0,
      currency: 'KRW',
      storeId: config.storeId,
      channelKey: config.channelKey,
      channelType: 'LIVE',
      payMethod: 'EASY_PAY',
      easyPayProvider: 'KAKAOPAY',
      paidAt: '2026-08-26T00:30:00.000Z',
      cancelledAt: ''
    };
    const intent = {
      version: 1,
      revision: 1,
      paymentId: PAYMENT_ONE,
      ownerDeviceId: DEVICE_ID,
      idempotencyHash: 'hash',
      status: 'prepared',
      contract,
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      expiresAt: '2026-08-27T00:00:00.000Z'
    };
    for (const payment of [
      { ...basePayment, amount: 29999 },
      { ...basePayment, easyPayProvider: 'NAVERPAY' },
      { ...basePayment, storeId: 'store-other123456' },
      {
        ...basePayment,
        status: 'PARTIAL_CANCELLED',
        cancelledAmount: 1000,
        cancelledAt: '2026-08-26T00:45:00.000Z'
      }
    ]) {
      assert.equal(verifyPayment(payment, intent).action, 'review_required');
    }

    const memory = inMemoryPaymentDependencies(baseRecord());
    memory.setIntent(intent);
    memory.dependencies.getPayment = async () => ({ ...basePayment, amount: 29999 });
    const result = await reconcilePayment(PAYMENT_ONE, DEVICE_ID, config, memory.dependencies);
    assert.equal(result.status, 'review_required');
    assert.equal(memory.getDevice().entitlement.grants.length, 0);
  });
});

test('valid promotion is lifetime and reusable across devices while invalid checks stay generic', async () => {
  const code = 'TEST-LIFETIME-CODE';
  const pepper = 'test-promotion-pepper-value';
  const digest = promotionDigest(code, pepper);
  await withEnv(
    {
      PRICE_ALERT_ENTITLEMENT_ENABLED: 'true',
      PRICE_ALERT_PROMO_CODE_PEPPER: pepper,
      PRICE_ALERT_PROMO_CODE_DIGEST: digest
    },
    () => {
      const configuration = configuredPromotion();
      assert.equal(promotionMatches(code, configuration), true);
      assert.equal(promotionMatches('WRONG-CODE', configuration), false);
      const firstDevice = baseRecord();
      const secondDevice = baseRecord({ deviceId: 'SecondEntitlementDevice123' });
      assert.equal(applyLifetimePromotion(firstDevice, configuration.publicId).changed, true);
      assert.equal(applyLifetimePromotion(firstDevice, configuration.publicId).changed, false);
      assert.equal(applyLifetimePromotion(secondDevice, configuration.publicId).changed, true);
      assert.equal(publicEntitlement(firstDevice).lifetime, true);
      assert.equal(publicEntitlement(secondDevice).lifetime, true);
    }
  );
});

test('entitlement gates alerts and hourly work; expired records lose active index without losing alerts or pushes', async () => {
  await withEnv({ PRICE_ALERT_ENTITLEMENT_ENABLED: 'true' }, async () => {
    const expired = baseRecord({
      alerts: [{ goodsNo: 'A000000154189', enabled: true }],
      entitlement: {
        version: 1,
        grants: [
          {
            source: 'payment',
            paymentId: PAYMENT_ONE,
            grantedAt: '2026-01-01T00:00:00.000Z',
            startsAt: '2026-01-01T00:00:00.000Z',
            endsAt: '2026-01-31T00:00:00.000Z',
            revokedAt: null
          }
        ]
      },
      push: {
        active: true,
        subscription: {
          endpoint: 'https://fcm.googleapis.com/fcm/send/device',
          keys: { p256dh: 'A'.repeat(88), auth: 'B'.repeat(22) }
        }
      },
      pendingNotifications: [
        {
          type: 'price-change',
          eventKey: 'ExpiredPendingEvent12345678',
          goodsNo: 'A000000154189'
        }
      ]
    });
    assert.throws(() => requireActiveEntitlement(expired), /entitlement_required/);
    assert.equal(recordNeedsHourlyWork(expired), false);
    let state = clone(expired);
    const synced = [];
    const loaded = await loadActiveDeviceEntries({
      async listActiveDeviceRefs() {
        return { refs: [{ deviceId: DEVICE_ID }], unreadableCount: 0 };
      },
      async readDevice() {
        return { record: clone(state), blobs: [] };
      },
      async mutateDevice(_deviceId, mutation) {
        const outcome = await mutation(clone(state));
        if (outcome.changed) state = clone(outcome.record);
        return { ...outcome, record: clone(state), value: outcome.value || {} };
      },
      async syncDeviceIndexes(record) {
        synced.push(clone(record));
      },
      async deleteDeviceIndexes() {}
    });
    assert.equal(loaded.devices.length, 0);
    assert.equal(synced[0].alerts.length, 1);
    assert.equal(state.pendingNotifications.length, 0);
    applyLifetimePromotion(state, 'renewed-lifetime', '2026-08-26T00:00:00.000Z');
    let pushes = 0;
    const delivery = await deliverPendingForDevice(DEVICE_ID, {
      async readDevice() {
        return { record: clone(state), blobs: [] };
      },
      async sendNotification() {
        pushes += 1;
      }
    });
    assert.equal(delivery.sent, 0);
    assert.equal(pushes, 0);
  });
});

test('TTL cleanup preserves a lifetime entitlement even when it has no alerts', async () => {
  const lifetime = baseRecord({ updatedAt: '2026-01-01T00:00:00.000Z' });
  applyLifetimePromotion(lifetime, 'lifetime-promotion', '2026-01-01T00:00:00.000Z');
  let state = clone(lifetime);
  const result = await cleanupInactiveDevices(Date.parse('2026-08-26T00:00:00.000Z'), {
    async listStaleRegistryRefs() {
      return { refs: [{ deviceId: DEVICE_ID }], shard: '0', unreadableCount: 0 };
    },
    async mutateDevice(_deviceId, mutation) {
      const outcome = await mutation(clone(state));
      if (outcome.changed) state = clone(outcome.record);
      return { ...outcome, value: outcome.value || {}, changed: outcome.changed };
    },
    async deleteDeviceIndexes() {}
  });
  assert.equal(result.cleaned, 0);
  assert.equal(state.deletedAt, undefined);
  assert.equal(publicEntitlement(state).lifetime, true);
});

test('payment and promotion rate policies are independently bounded', () => {
  assert.equal(configuredRatePolicy('payment_create').limit, 5);
  assert.equal(configuredRatePolicy('payment_complete').limit, 30);
  assert.equal(configuredRatePolicy('payment_webhook').limit, 600);
  assert.equal(configuredRatePolicy('promotion').limit, 10);
});

test('payment intent audit events are bounded and contain only safe status metadata', () => {
  const intent = { events: [] };
  for (let index = 0; index < 55; index += 1) {
    appendIntentEvent(
      intent,
      `provider_decision_${index}`,
      '2026-08-26T00:00:00.000Z',
      'review_required',
      `contract_reason_${index}`
    );
  }
  assert.equal(intent.events.length, 50);
  assert.deepEqual(Object.keys(intent.events[0]).sort(), ['at', 'reason', 'status', 'type']);
  assert.equal(JSON.stringify(intent.events).includes('apiSecret'), false);
});

test('webhook content is only a known payment-id trigger', () => {
  assert.equal(
    webhookPaymentId({
      type: 'Transaction.Paid',
      data: { paymentId: PAYMENT_ONE, status: 'PAID', amount: 1 }
    }),
    PAYMENT_ONE
  );
  assert.equal(
    webhookPaymentId({ type: 'Forged.Grant', data: { paymentId: PAYMENT_ONE } }),
    ''
  );
  assert.equal(
    webhookPaymentId({ type: 'Transaction.Paid', data: { paymentId: '../../invalid' } }),
    ''
  );
});
