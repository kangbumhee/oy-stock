const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createDeviceRecord, verifyDeviceSecret } = require('../api/price-alerts/_core');
const { DeviceWriteConflictError, mutateDevice } = require('../api/price-alerts/_store');
const { decryptJson } = require('../api/price-alerts/_crypto');
const { mutateAccountIndex, readAccountIndex, accountIndexPath } = require('../api/price-alerts/_account-store');
const { configuredAccountMail, sendAccountMail } = require('../api/price-alerts/_account-mail');
const { HttpError, deviceCredentials } = require('../api/price-alerts/_http');
const { applyPaymentGrant, publicEntitlement } = require('../api/price-alerts/_entitlement');
const { recordIsDisposable, recordHasRetainedEntitlement } = require('../api/price-alerts/_registry');
const { configuredRatePolicy } = require('../api/price-alerts/_limits');
const { createAccountHandler } = require('../api/price-alerts/account')._test;
const service = require('../api/price-alerts/_account-service');

const ID = 'AccountDevice000000000001';
const SECOND_ID = 'AccountDevice000000000002';
const SECRET = 'AccountOriginalSecret000000000000000001';
const SECOND_SECRET = 'AccountOtherSecret000000000000000000002';
const EMAIL = 'owner@example.com';
const CODE = '1234567890ABCDEF12345678';
const NOW = Date.parse('2026-09-24T01:00:00Z');
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const request = (id = ID, secret = SECRET) => ({ headers: {
  'x-price-alert-device-id': id, 'x-price-alert-device-secret': secret,
  host: 'olivestock.example', origin: 'https://olivestock.example'
} });

async function withEnvironment(fn) {
  const values = {
    PRICE_ALERT_DATA_KEY: '23'.repeat(32), PRICE_ALERT_ACCOUNT_RECOVERY_ENABLED: 'true',
    PRICE_ALERT_ENTITLEMENT_ENABLED: 'true', PRICE_ALERT_SMTP_HOST: 'smtp.example.com',
    PRICE_ALERT_SMTP_PORT: '465', PRICE_ALERT_SMTP_USER: 'sender@example.com',
    PRICE_ALERT_SMTP_PASSWORD: 'test-smtp-password', PRICE_ALERT_SMTP_FROM: 'sender@example.com'
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await fn(); } finally {
    for (const key of Object.keys(values)) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function memory() {
  const devices = new Map();
  const indexes = new Map();
  const sent = [];
  const writes = [];
  const deviceStore = {
    async readDevice(id) {
      const entry = devices.get(id);
      return { record: clone(entry && entry.record) || null,
        blobs: entry ? [{ etag: String(entry.revision) }] : [] };
    },
    async writeDevice(record, blobs) {
      const current = devices.get(record.deviceId);
      if (Number(blobs[0]?.etag || 0) !== Number(current?.revision || 0)) throw new DeviceWriteConflictError();
      devices.set(record.deviceId, { record: clone(record), revision: (current?.revision || 0) + 1 });
      return { etag: String((current?.revision || 0) + 1) };
    }
  };
  const accountStore = {
    async get(path, options) {
      assert.equal(options.access, 'private');
      const entry = indexes.get(path);
      return entry ? { stream: Readable.from([entry.body]), blob: { etag: String(entry.revision) } } : null;
    },
    async put(path, body, options) {
      assert.equal(options.access, 'private');
      assert.ok(!path.includes('@'));
      assert.ok(!body.includes(EMAIL));
      const entry = indexes.get(path);
      if ((entry && Number(options.ifMatch) !== entry.revision) || (!entry && options.ifMatch)) {
        throw Object.assign(new Error('conflict'), { status: 412 });
      }
      indexes.set(path, { body, revision: Number(entry?.revision || 0) + 1 });
      writes.push({ path, body, options });
      return { etag: String(Number(entry?.revision || 0) + 1) };
    }
  };
  const deps = {
    now: NOW, newCode: () => CODE, deviceStore, accountStore,
    configuredAccountMail: () => ({ configured: true }),
    sendAccountMail: async (message) => { sent.push(message); },
    reserveDeviceRegistration: async () => {},
    mutateAccountIndex: (email, mutation) => mutateAccountIndex(email, mutation, accountStore),
    readAccountIndex: (email) => readAccountIndex(email, accountStore),
    mutateDevice: (id, mutation) => mutateDevice(id, mutation, deviceStore),
    async authenticateDevice(req, options = {}) {
      const credentials = deviceCredentials(req);
      const loaded = await deviceStore.readDevice(credentials.deviceId);
      if (!loaded.record && options.allowCreate) return { record: createDeviceRecord(credentials.deviceId, credentials.deviceSecret), created: true };
      if (!loaded.record || !verifyDeviceSecret(credentials.deviceId, credentials.deviceSecret, loaded.record.secretHash)) {
        throw new HttpError(401, 'device_auth_failed');
      }
      return { record: loaded.record, created: false };
    },
    async mutateAuthenticatedDevice(req, options, mutation) {
      const credentials = deviceCredentials(req);
      return mutateDevice(credentials.deviceId, async (current, context) => {
        const created = !current;
        if (!current && options?.allowCreate) current = createDeviceRecord(credentials.deviceId, credentials.deviceSecret);
        if (!current || !verifyDeviceSecret(credentials.deviceId, credentials.deviceSecret, current.secretHash)) {
          throw new HttpError(401, 'device_auth_failed');
        }
        return mutation(current, { ...context, created });
      }, deviceStore);
    }
  };
  return { deps, devices, sent, writes, record: (id = ID) => clone(devices.get(id)?.record),
    setRecord(record) { devices.set(record.deviceId, { record: clone(record), revision: (devices.get(record.deviceId)?.revision || 0) + 1 }); } };
}

async function enroll(env, req = request(), email = EMAIL) {
  await service.requestEmailVerification(req, email, env.deps);
  return service.verifyEmail(req, email, CODE, env.deps);
}

test('email normalization rejects injection; SMTP configuration requires authenticated TLS transport', async () => {
  assert.equal(service.normalizeEmail(' Owner@Example.COM '), EMAIL);
  for (const email of ['owner\r\nBcc:x@example.com', 'a..b@example.com', '.a@example.com', 'a@localhost']) {
    assert.equal(service.normalizeEmail(email), '');
  }
  assert.equal(configuredAccountMail({}), null);
  await withEnvironment(async () => {
    assert.equal(configuredAccountMail().port, 465);
    let captured;
    let message;
    await sendAccountMail({ email: EMAIL, code: CODE, purpose: 'recovery' }, {
      createTransport: (options) => {
        captured = options;
        return { sendMail: async (value) => { message = value; }, close() {} };
      }
    });
    assert.equal(captured.requireTLS, true);
    assert.equal(captured.tls.rejectUnauthorized, true);
    assert.equal(message.disableUrlAccess, true);
    assert.match(message.text, /1234-5678-90AB-CDEF-1234-5678/);
    assert.doesNotMatch(message.text, /https?:\/\//);
    await assert.rejects(sendAccountMail({ email: EMAIL, code: CODE, purpose: 'recovery' }, {
      createTransport: () => ({ async sendMail() { throw new Error('smtp secret ' + EMAIL); } })
    }), (error) => error.code === 'account_mail_unavailable' && !error.message.includes(EMAIL));
  });
});

test('verified email is linked to encrypted HMAC index before checkout is unlocked', async () => withEnvironment(async () => {
  const env = memory();
  await service.requestEmailVerification(request(), EMAIL.toUpperCase(), env.deps);
  assert.equal(env.sent.length, 1);
  assert.equal(env.record().account.emailChallenge.codeHash.includes(CODE), false);
  assert.throws(() => service.requireVerifiedAccount(env.record()), /email_verification_required/);
  const result = await service.verifyEmail(request(), EMAIL, '1234-5678-90ab-cdef-1234-5678', env.deps);
  assert.deepEqual(result.account, { email: EMAIL, verified: true });
  assert.equal(result.credentials, undefined);
  assert.doesNotThrow(() => service.requireVerifiedAccount(env.record()));
  assert.equal((await env.deps.readAccountIndex(EMAIL)).index.deviceId, ID);
  assert.ok(env.writes.length > 0);
  assert.ok(env.writes.every((write) => write.path === accountIndexPath(EMAIL)));
  assert.equal(decryptJson(env.writes.at(-1).body).deviceId, ID);
  assert.equal(recordIsDisposable(env.record()), false);
  assert.equal(recordHasRetainedEntitlement(env.record(), NOW + 365 * 86400000), true);
  await assert.rejects(service.verifyEmail(request(), EMAIL, CODE, env.deps), /account_code_invalid/);
}));

test('verification codes bind the mailbox and purpose; wrong attempts persist and lock after five', async () => withEnvironment(async () => {
  const env = memory();
  await service.requestEmailVerification(request(), EMAIL, env.deps);
  await assert.rejects(service.verifyEmail(request(), 'other@example.com', CODE, env.deps), /account_code_invalid/);
  await assert.rejects(service.recoverAccount(request(), EMAIL, CODE, env.deps), /account_code_invalid/);
  for (let i = 0; i < 5; i += 1) await assert.rejects(service.verifyEmail(request(), EMAIL, 'BAD', env.deps), /account_code_invalid/);
  assert.equal(env.record().account.emailChallenge.attempts, 5);
  await assert.rejects(service.verifyEmail(request(), EMAIL, CODE, env.deps), /account_code_invalid/);
  assert.equal(service.publicAccount(env.record()).verified, false);
}));

test('verification expires at fifteen minutes and resend is bounded per email across devices', async () => withEnvironment(async () => {
  const env = memory();
  const first = await service.requestEmailVerification(request(), EMAIL, env.deps);
  const retry = await service.requestEmailVerification(request(SECOND_ID, SECOND_SECRET), EMAIL, env.deps);
  assert.deepEqual(first, retry);
  assert.equal(env.sent.length, 1);
  env.deps.now += service.CODE_TTL_MS;
  await assert.rejects(service.verifyEmail(request(), EMAIL, CODE, env.deps), /account_code_invalid/);
  for (let i = 0; i < 8; i += 1) {
    env.deps.now += 61000;
    await service.requestEmailVerification(request(), EMAIL, env.deps);
  }
  assert.equal(env.sent.length, 5);
}));

test('one email cannot be enrolled into two canonical devices and a verified email cannot change', async () => withEnvironment(async () => {
  const env = memory();
  await enroll(env);
  env.deps.now += 61000;
  const response = await service.requestEmailVerification(request(SECOND_ID, SECOND_SECRET), EMAIL, env.deps);
  assert.equal(response.sent, true);
  assert.equal(env.sent.at(-1).purpose, 'existing');
  assert.equal(env.record(SECOND_ID), undefined);
  assert.equal((await env.deps.readAccountIndex(EMAIL)).index.deviceId, ID);
  await assert.rejects(service.requestEmailVerification(request(), 'new@example.com', env.deps), /account_email_locked/);
}));

test('recovery atomically rotates only canonical credentials and preserves paid identity and grants', async () => withEnvironment(async () => {
  const env = memory();
  await enroll(env);
  const record = env.record();
  applyPaymentGrant(record, 'oypa_ABCDEFGHIJKLMNOPQRSTUVWX', new Date(NOW).toISOString());
  record.push = { active: true, subscription: { endpoint: 'old endpoint' } };
  record.pendingNotifications = [{ id: 'queued-on-old-browser' }];
  record.alerts = [{ goodsNo: 'A000000000001', targetPrice: 1000 }];
  env.setRecord(record);
  env.deps.now += 61000;
  await service.requestRecovery(request(SECOND_ID, SECOND_SECRET), EMAIL, env.deps);
  const result = await service.recoverAccount(request(SECOND_ID, SECOND_SECRET), EMAIL, CODE, env.deps);
  const saved = env.record();
  assert.equal(result.credentials.deviceId, ID);
  assert.notEqual(result.credentials.deviceSecret, SECRET);
  assert.equal(verifyDeviceSecret(ID, SECRET, saved.secretHash), false);
  assert.equal(verifyDeviceSecret(ID, result.credentials.deviceSecret, saved.secretHash), true);
  assert.deepEqual(saved.entitlement, record.entitlement);
  assert.deepEqual(saved.alerts, record.alerts);
  assert.equal(saved.pendingPayment, record.pendingPayment);
  assert.equal(saved.push.active, false);
  assert.equal(saved.push.subscription, null);
  assert.deepEqual(saved.pendingNotifications, []);
  assert.equal(publicEntitlement(saved, env.deps.now).active, true);
  assert.equal(env.record(SECOND_ID), undefined);
  await assert.rejects(env.deps.authenticateDevice(request()), /device_auth_failed/);
  await assert.rejects(service.recoverAccount(request(SECOND_ID, SECOND_SECRET), EMAIL, CODE, env.deps), /account_code_invalid/);
}));

test('concurrent recovery redemptions and old authenticated writes allow exactly one new credential', async () => withEnvironment(async () => {
  const env = memory();
  await enroll(env);
  env.deps.now += 61000;
  await service.requestRecovery(request(), EMAIL, env.deps);
  const outcomes = await Promise.allSettled([
    service.recoverAccount(request(SECOND_ID, SECOND_SECRET), EMAIL, CODE, env.deps),
    service.recoverAccount(request(SECOND_ID, SECOND_SECRET), EMAIL, CODE, env.deps)
  ]);
  assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((entry) => entry.status === 'rejected').length, 1);
  const success = outcomes.find((entry) => entry.status === 'fulfilled').value;
  assert.equal(env.record().account.credentialVersion, 1);
  assert.equal(verifyDeviceSecret(ID, success.credentials.deviceSecret, env.record().secretHash), true);
  await assert.rejects(env.deps.mutateAuthenticatedDevice(request(), null, (record) => {
    record.alerts = [{ goodsNo: 'A000000000001' }];
    return { changed: true, record };
  }), /device_auth_failed/);
}));

test('lost recovery response is repaired with a newly mailed code, never by replaying the old code', async () => withEnvironment(async () => {
  const env = memory();
  await enroll(env);
  env.deps.now += 61000;
  await service.requestRecovery(request(), EMAIL, env.deps);
  const first = await service.recoverAccount(request(), EMAIL, CODE, env.deps);
  env.deps.now += 61000;
  const newerCode = 'ABCDEF123456789012345678';
  env.deps.newCode = () => newerCode;
  await service.requestRecovery(request(), EMAIL, env.deps);
  await assert.rejects(service.recoverAccount(request(), EMAIL, CODE, env.deps), /account_code_invalid/);
  const second = await service.recoverAccount(request(), EMAIL, newerCode, env.deps);
  assert.equal(verifyDeviceSecret(ID, first.credentials.deviceSecret, env.record().secretHash), false);
  assert.equal(verifyDeviceSecret(ID, second.credentials.deviceSecret, env.record().secretHash), true);
}));

test('known, unknown, and delivery-failed recovery requests have identical HTTP response data', async () => withEnvironment(async () => {
  const env = memory();
  await enroll(env);
  env.deps.now += 61000;
  const known = await service.requestRecovery(request(), EMAIL, env.deps);
  const unknown = await service.requestRecovery(request(), 'unknown@example.com', env.deps);
  assert.deepEqual(known, unknown);
  assert.equal(env.sent.at(-1).purpose, 'recovery-unavailable');
  env.deps.now += 61000;
  env.deps.sendAccountMail = async () => { throw new Error('failure'); };
  assert.deepEqual(await service.requestRecovery(request(), EMAIL, env.deps), known);
  await assert.rejects(service.recoverAccount(request(), 'unknown@example.com', CODE, env.deps), /account_code_invalid/);
}));

test('recovery brute-force attempts are serialized by device CAS and cannot exceed five guesses', async () => withEnvironment(async () => {
  const env = memory();
  await enroll(env);
  env.deps.now += 61000;
  await service.requestRecovery(request(), EMAIL, env.deps);
  const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => service.recoverAccount(request(), EMAIL, 'BAD', env.deps)));
  assert.equal(attempts.every((attempt) => attempt.status === 'rejected'), true);
  assert.equal(env.record().account.recoveryChallenge.attempts, 5);
  await assert.rejects(service.recoverAccount(request(), EMAIL, CODE, env.deps), /account_code_invalid/);
  assert.equal(verifyDeviceSecret(ID, SECRET, env.record().secretHash), true);
}));

test('recovery feature fails closed without SMTP; disabled deployments preserve existing checkout behavior', async () => withEnvironment(async () => {
  const env = memory();
  env.deps.configuredAccountMail = () => null;
  await assert.rejects(service.requestEmailVerification(request(), EMAIL, env.deps), /account_mail_not_configured/);
  assert.equal(env.sent.length, 0);
  delete process.env.PRICE_ALERT_SMTP_PASSWORD;
  assert.throws(() => service.requireVerifiedAccount({}), /account_mail_not_configured/);
  assert.equal((await service.accountStatus(request(), env.deps)).available, false);
  process.env.PRICE_ALERT_ACCOUNT_RECOVERY_ENABLED = 'false';
  assert.doesNotThrow(() => service.requireVerifiedAccount({}));
  await assert.rejects(service.requestRecovery(request(), EMAIL, env.deps), /account_recovery_disabled/);
}));

test('account handler rejects cross-site requests and uses bounded separate send/verify/read scopes', async () => withEnvironment(async () => {
  const calls = [];
  const handler = createAccountHandler({
    consumeRateLimit: async (_req, scope) => { calls.push(scope); },
    requestRecovery: async () => ({ success: true, sent: true }),
    recoverAccount: async () => ({ success: true }),
    accountStatus: async () => ({ success: true }),
    recordVisit: async () => ({ success: true })
  });
  async function invoke(method, body, origin = 'https://olivestock.example') {
    const req = { ...request(), method, body };
    req.headers.origin = origin;
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(text) { this.body = JSON.parse(text); } };
    await handler(req, res);
    return res;
  }
  assert.equal((await invoke('POST', { action: 'request-recovery', email: EMAIL }, 'https://evil.example')).statusCode, 403);
  assert.equal(calls.length, 0);
  await invoke('GET');
  await invoke('POST', { action: 'request-recovery', email: EMAIL });
  await invoke('POST', { action: 'recover', email: EMAIL, code: CODE });
  await invoke('POST', { action: 'record-visit', visitId: 'VisitSession00000000000001' });
  assert.deepEqual(calls, ['account_read', 'account_send', 'account_verify', 'account_visit']);
  assert.equal(configuredRatePolicy('account_send').limit, 5);
  assert.equal(configuredRatePolicy('account_verify').limit, 20);
  const invalid = await invoke('POST', { action: 'recover', email: EMAIL, code: CODE, deviceId: 'injected' });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.headers['Cache-Control'], 'no-store');
  for (const body of [
    { action: 'record-visit', visitId: 'VisitSession00000000000001', email: EMAIL },
    { action: 'request-recovery', email: EMAIL, code: CODE },
    { action: 'recover', email: EMAIL },
    { action: 'record-visit', visitId: '../unsafe' }
  ]) assert.equal((await invoke('POST', body)).statusCode, 400);
}));

test('visits require an existing authenticated device and deduplicate refreshes and retries', async () => withEnvironment(async () => {
  const env = memory();
  const visitId = 'VisitSession00000000000001';
  await assert.rejects(service.recordVisit(request(), visitId, env.deps), /device_auth_failed/);
  assert.equal(env.devices.size, 0);
  await enroll(env);
  assert.deepEqual(await service.recordVisit(request(), visitId, env.deps), { success: true });
  await service.recordVisit(request(), visitId, env.deps);
  env.deps.now += 1000;
  await service.recordVisit(request(), visitId, env.deps);
  assert.equal(env.record().activity.visitCount, 1);
  assert.equal(env.record().activity.lastSeenAt, new Date(env.deps.now).toISOString());
  assert.deepEqual(env.record().activity.recentVisits, [visitId]);
  env.deps.now += 30 * 60000;
  await service.recordVisit(request(), 'VisitSession00000000000002', env.deps);
  assert.equal(env.record().activity.visitCount, 2);
}));

test('stale concurrent visits cannot lower lastSeenAt or lose/double-count sessions', async () => withEnvironment(async () => {
  const env = memory();
  await enroll(env);
  const first = 'VisitSession00000000000001';
  const second = 'VisitSession00000000000002';
  const recentTime = NOW + 5000;
  await Promise.all([
    service.recordVisit(request(), first, { ...env.deps, now: recentTime }),
    service.recordVisit(request(), first, { ...env.deps, now: NOW }),
    service.recordVisit(request(), second, { ...env.deps, now: NOW + 1000 })
  ]);
  assert.equal(env.record().activity.visitCount, 2);
  assert.equal(env.record().activity.lastSeenAt, new Date(recentTime).toISOString());
  const record = env.record();
  record.updatedAt = new Date(recentTime + 5000).toISOString();
  record.activity.visitCount = 100;
  record.activity.recentVisits = Array.from({ length: 64 }, (_, i) => 'VisitSession' + String(i).padStart(16, '0'));
  env.setRecord(record);
  await service.recordVisit(request(), 'VisitSession_new_000000001', env.deps);
  assert.equal(env.record().activity.recentVisits.length, 64);
  assert.equal(env.record().activity.visitCount, 101);
  assert.equal(env.record().activity.lastSeenAt, new Date(recentTime).toISOString());
  assert.equal(env.record().updatedAt, record.updatedAt);
}));

test('recovery preserves activity while revoked browser cannot record another visit', async () => withEnvironment(async () => {
  const env = memory();
  await enroll(env);
  await service.recordVisit(request(), 'VisitSession00000000000001', env.deps);
  env.deps.now += 61000;
  await service.requestRecovery(request(), EMAIL, env.deps);
  const recovered = await service.recoverAccount(request(), EMAIL, CODE, env.deps);
  await assert.rejects(service.recordVisit(request(), 'VisitSession00000000000002', env.deps), /device_auth_failed/);
  assert.equal(env.record().activity.visitCount, 1);
  await service.recordVisit(request(ID, recovered.credentials.deviceSecret), 'VisitSession00000000000002', env.deps);
  assert.equal(env.record().activity.visitCount, 2);
}));
