const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeviceRecord, verifyDeviceSecret, hashDeviceSecret } = require('../api/price-alerts/_core');
const { codeDigest, recoverAccount } = require('../api/price-alerts/_account-service');
const { createPayment, reconcilePayment } = require('../api/price-alerts/_payment-service');
const { paymentContract, PortOneSafeError } = require('../api/price-alerts/_portone');
const { HttpError, deviceCredentials } = require('../api/price-alerts/_http');

const ID = 'PaymentRecoveryOwner000000001';
const OTHER_ID = 'PaymentRecoveryOther000000002';
const SECRET = 'OriginalRecoverySecret000000000000000001';
const OTHER_SECRET = 'AnotherRecoverySecret000000000000000002';
const EMAIL = 'recovery-payment@example.com';
const CODE = 'ABCDE12345ABCDE12345ABCDE';
const PAYMENT_ID = 'oypa_recovery_checkout_000000000001';
const NEXT_ID = 'oypa_recovery_checkout_000000000002';
const OLD_KEY = 'recovery-original-key-0000001';
const NEW_KEY = 'recovery-new-browser-key-00001';
const NOW = Date.parse('2026-09-24T01:00:00Z');
const CONFIG = {
  storeId: 'store-recovery-test', channelKey: 'channel-key-recovery-test',
  expectedChannelType: 'LIVE', publicSiteUrl: 'https://olivestock.example'
};
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const request = (id = ID, secret = SECRET) => ({ headers: {
  'x-price-alert-device-id': id, 'x-price-alert-device-secret': secret
} });

async function environment(run) {
  const values = {
    PRICE_ALERT_DATA_KEY: '31'.repeat(32), PRICE_ALERT_ACCOUNT_RECOVERY_ENABLED: 'true',
    PRICE_ALERT_ENTITLEMENT_ENABLED: 'true'
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { await run(); } finally {
    for (const key of Object.keys(values)) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function memory() {
  let record = createDeviceRecord(ID, SECRET, new Date(NOW).toISOString());
  record.account = { email: EMAIL, indexLinked: true, verifiedAt: new Date(NOW).toISOString(), credentialVersion: 0 };
  const intents = new Map();
  let preparations = 0;
  let lookups = 0;
  let providerResult = { paymentId: PAYMENT_ID, status: 'READY' };
  const deps = {
    now: NOW, newPaymentId: () => PAYMENT_ID,
    reserveActiveDevice: async () => ({ created: false }), reserveDeviceRegistration: async () => {},
    configuredAccountMail: () => ({ configured: true }),
    readAccountIndex: async () => ({ index: { deviceId: ID } }),
    async mutateDevice(id, mutation) {
      assert.equal(id, ID);
      const outcome = await mutation(clone(record));
      if (outcome.changed) record = clone(outcome.record);
      return { ...outcome, record: clone(record), value: outcome.value || {}, written: Boolean(outcome.changed) };
    },
    async mutateAuthenticatedDevice(req, _options, mutation) {
      const credentials = deviceCredentials(req);
      if (credentials.deviceId !== ID || !verifyDeviceSecret(ID, credentials.deviceSecret, record.secretHash)) {
        throw new HttpError(401, 'device_auth_failed');
      }
      return deps.mutateDevice(ID, (current) => mutation(current, { created: false }));
    },
    async mutateIntent(id, mutation) {
      const outcome = await mutation(clone(intents.get(id) || null));
      if (outcome.changed) intents.set(id, clone(outcome.intent));
      return { ...outcome, intent: clone(outcome.intent), written: Boolean(outcome.changed) };
    },
    async readIntent(id) { return { intent: clone(intents.get(id) || null) }; },
    async preRegisterPayment() { preparations += 1; },
    async getPayment() {
      lookups += 1;
      if (providerResult instanceof Error) throw providerResult;
      return clone(providerResult);
    }
  };
  return {
    deps, record: () => clone(record), intent: () => clone(intents.get(PAYMENT_ID)),
    setRecord: (next) => { record = clone(next); },
    setIntent: (next) => { intents.set(next.paymentId, clone(next)); },
    setProvider: (value) => { providerResult = value; },
    preparations: () => preparations, lookups: () => lookups,
    async recover() {
      deps.now += 60000;
      const challenge = {
        id: 'payment-recovery-challenge-001', email: EMAIL, purpose: 'recovery',
        createdAt: new Date(deps.now).toISOString(), expiresAt: new Date(deps.now + 600000).toISOString(),
        attempts: 0, consumedAt: null
      };
      challenge.codeHash = codeDigest(CODE, EMAIL, 'recovery', challenge.id);
      record.account.recoveryChallenge = challenge;
      const response = await recoverAccount(request(OTHER_ID, OTHER_SECRET), EMAIL, CODE, deps);
      return request(response.credentials.deviceId, response.credentials.deviceSecret);
    }
  };
}

function finalProvider(status = 'PAID') {
  const contract = paymentContract(CONFIG);
  return {
    ...contract, paymentId: PAYMENT_ID, status, amount: 30000,
    cancelledAmount: status === 'CANCELLED' ? 30000 : 0,
    paidAt: new Date(NOW + 30000).toISOString(), cancelledAt: new Date(NOW + 45000).toISOString()
  };
}

test('recovered browser resumes the original prepared ID and immutable hash after authoritative READY', async () => environment(async () => {
  const env = memory();
  await createPayment(request(), CONFIG, OLD_KEY, env.deps);
  const before = env.intent();
  const recoveredRequest = await env.recover();
  const result = await createPayment(recoveredRequest, CONFIG, NEW_KEY, env.deps);
  assert.equal(result.resumed, true);
  assert.equal(result.idempotent, true);
  assert.equal(result.paymentId, PAYMENT_ID);
  assert.equal(result.requestPayment.paymentId, PAYMENT_ID);
  assert.equal(env.intent().idempotencyHash, before.idempotencyHash);
  assert.equal(env.record().pendingPayment.idempotencyHash, before.idempotencyHash);
  assert.equal(env.preparations(), 1);
  assert.equal(env.lookups(), 1);
  assert.equal(env.record().entitlement?.grants?.length || 0, 0);
  await createPayment(recoveredRequest, CONFIG, NEW_KEY, env.deps);
  assert.equal(env.lookups(), 2, 'each recovery retry rechecks provider before handoff');
  assert.equal(env.preparations(), 1);
}));

test('authoritative provider 404 permits only the original unexpired recovered payment', async () => environment(async () => {
  const env = memory();
  await createPayment(request(), CONFIG, OLD_KEY, env.deps);
  const recoveredRequest = await env.recover();
  env.setProvider(new PortOneSafeError('portone_lookup_failed', false, 404));
  const result = await createPayment(recoveredRequest, CONFIG, NEW_KEY, env.deps);
  assert.equal(result.requestPayment.paymentId, PAYMENT_ID);
  assert.equal(env.preparations(), 1);
}));

test('other browser, revoked credentials, and ordinary different-key attempts do not resume a payment', async () => environment(async () => {
  const env = memory();
  await createPayment(request(), CONFIG, OLD_KEY, env.deps);
  await assert.rejects(createPayment(request(), CONFIG, NEW_KEY, env.deps), /payment_already_pending/);
  await assert.rejects(createPayment(request(OTHER_ID, OTHER_SECRET), CONFIG, NEW_KEY, env.deps), /device_auth_failed/);
  await env.recover();
  await assert.rejects(createPayment(request(), CONFIG, NEW_KEY, env.deps), /device_auth_failed/);
  assert.equal(env.lookups(), 0);
}));

test('a historical recovery does not unlock different-key reuse of a newer checkout', async () => environment(async () => {
  const env = memory();
  const recoveredRequest = await env.recover();
  env.deps.now += 1000;
  await createPayment(recoveredRequest, CONFIG, OLD_KEY, env.deps);
  await assert.rejects(createPayment(recoveredRequest, CONFIG, NEW_KEY, env.deps), /payment_already_pending/);
  assert.equal(env.lookups(), 0);
}));

for (const status of ['PAID', 'CANCELLED', 'FAILED', 'PAY_PENDING', 'PARTIAL_CANCELLED']) {
  test(`recovered ${status} is reconciled without another SDK payload or payment ID`, async () => environment(async () => {
    const env = memory();
    await createPayment(request(), CONFIG, OLD_KEY, env.deps);
    const recoveredRequest = await env.recover();
    env.setProvider(finalProvider(status));
    const result = await createPayment(recoveredRequest, CONFIG, NEW_KEY, env.deps);
    assert.equal(result.requestPayment, null);
    assert.equal(result.paymentId, PAYMENT_ID);
    assert.equal(result.reconciliation.paymentId, PAYMENT_ID);
    assert.equal(result.resumed, true);
    const expected = { PAID: 'paid', CANCELLED: 'cancelled', FAILED: 'abandoned', PAY_PENDING: 'pending', PARTIAL_CANCELLED: 'review_required' }[status];
    assert.equal(result.reconciliation.status, expected);
    assert.equal(env.preparations(), 1);
    assert.equal(env.lookups(), 1);
    if (status === 'PAID') {
      assert.equal(result.reconciliation.entitlement.active, true);
      await reconcilePayment(PAYMENT_ID, ID, CONFIG, env.deps);
      assert.equal(env.record().entitlement.grants.length, 1, 'duplicate provider reconciliation grants once');
    }
    if (status === 'PAY_PENDING' || status === 'PARTIAL_CANCELLED') {
      assert.equal(env.record().pendingPayment.paymentId, PAYMENT_ID);
    } else assert.equal(env.record().pendingPayment, null);
  }));
}

test('canonical terminal intent cannot be downgraded to prepared during recovered checkout', async () => environment(async () => {
  const env = memory();
  await createPayment(request(), CONFIG, OLD_KEY, env.deps);
  const recoveredRequest = await env.recover();
  const canonical = env.intent();
  canonical.status = 'paid';
  env.setIntent(canonical);
  env.setProvider(finalProvider());
  const result = await createPayment(recoveredRequest, CONFIG, NEW_KEY, env.deps);
  assert.equal(result.reconciliation.status, 'paid');
  assert.equal(result.requestPayment, null);
  assert.equal(env.intent().status, 'paid');
}));

test('lookup failures leave recovered pending identity intact and cannot expose SDK payload', async () => environment(async () => {
  for (const status of [401, 429, 500]) {
    const env = memory();
    await createPayment(request(), CONFIG, OLD_KEY, env.deps);
    const recoveredRequest = await env.recover();
    const before = env.record().pendingPayment;
    env.setProvider(new PortOneSafeError('portone_lookup_failed', status !== 401, status));
    await assert.rejects(createPayment(recoveredRequest, CONFIG, NEW_KEY, env.deps), /portone_lookup_failed/);
    assert.deepEqual(env.record().pendingPayment, before);
    assert.equal(env.preparations(), 1);
  }
}));

test('empty or malformed successful lookup is not treated as an authoritative 404', async () => environment(async () => {
  for (const result of [null, undefined, '', [], 0]) {
    const env = memory();
    await createPayment(request(), CONFIG, OLD_KEY, env.deps);
    const recoveredRequest = await env.recover();
    const before = env.record().pendingPayment;
    env.setProvider(result);
    await assert.rejects(createPayment(recoveredRequest, CONFIG, NEW_KEY, env.deps), /portone_invalid_response/);
    assert.deepEqual(env.record().pendingPayment, before);
    assert.equal(env.intent().status, 'prepared');
    assert.equal(env.preparations(), 1);
  }
}));

test('recovery preserves expired uncertain payment instead of silently generating another charge', async () => environment(async () => {
  for (const response of [{ paymentId: PAYMENT_ID, status: 'READY' }, new PortOneSafeError('portone_lookup_failed', false, 404)]) {
    const env = memory();
    await createPayment(request(), CONFIG, OLD_KEY, env.deps);
    env.deps.now += 25 * 60 * 60 * 1000;
    const recoveredRequest = await env.recover();
    env.deps.newPaymentId = () => NEXT_ID;
    env.setProvider(response);
    await assert.rejects(createPayment(recoveredRequest, CONFIG, NEW_KEY, env.deps), /payment_reconciliation_required/);
    assert.equal(env.record().pendingPayment.paymentId, PAYMENT_ID);
    assert.equal(env.preparations(), 1);
  }
}));

test('expired recovered payment can still settle a provider payment made inside its original window', async () => environment(async () => {
  const env = memory();
  await createPayment(request(), CONFIG, OLD_KEY, env.deps);
  env.deps.now += 25 * 60 * 60 * 1000;
  const recoveredRequest = await env.recover();
  env.setProvider(finalProvider());
  const result = await createPayment(recoveredRequest, CONFIG, NEW_KEY, env.deps);
  assert.equal(result.reconciliation.status, 'paid');
  assert.equal(result.requestPayment, null);
}));

test('ownership and contract corruption block recovered reuse before provider access', async () => environment(async () => {
  for (const change of ['owner', 'contract', 'hash']) {
    const env = memory();
    await createPayment(request(), CONFIG, OLD_KEY, env.deps);
    const recoveredRequest = await env.recover();
    const current = env.record();
    if (change === 'owner') current.pendingPayment.ownerDeviceId = OTHER_ID;
    if (change === 'contract') current.pendingPayment.contract.amount = 1;
    if (change === 'hash') current.pendingPayment.idempotencyHash = 'not-the-existing-intent-hash';
    env.setRecord(current);
    await assert.rejects(createPayment(recoveredRequest, CONFIG, NEW_KEY, env.deps), /payment_intent_conflict/);
    assert.equal(env.lookups(), 0);
  }
}));

test('credential revoked during provider check cannot obtain recovered SDK payload', async () => environment(async () => {
  const env = memory();
  await createPayment(request(), CONFIG, OLD_KEY, env.deps);
  const recoveredRequest = await env.recover();
  env.deps.getPayment = async () => {
    const current = env.record();
    current.secretHash = hashDeviceSecret(ID, OTHER_SECRET);
    env.setRecord(current);
    return { paymentId: PAYMENT_ID, status: 'READY' };
  };
  await assert.rejects(createPayment(recoveredRequest, CONFIG, NEW_KEY, env.deps), /device_auth_failed/);
  assert.equal(env.preparations(), 1);
}));
