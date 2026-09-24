const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { OAuth2Client } = require('google-auth-library');
const { authenticateAdmin } = require('../api/price-alerts/_admin-auth');
const { encryptJson } = require('../api/price-alerts/_crypto');
const { applyAdminExtension, applyPaymentGrant, publicEntitlement, revokePaymentGrant } = require('../api/price-alerts/_entitlement');
const { adminRecord, createHandler, extendAdminRecord, listAdminRecords } = require('../api/price-alerts/admin')._test;

const CLIENT_ID = 'test-admin-client.apps.googleusercontent.com';
const DEVICE_ID = 'AdminManagedDevice123456';
const ADMIN_EMAIL = 'kbhjjan@gmail.com';
const NOW = Date.now();
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const googleClient = new OAuth2Client();
googleClient.getFederatedSignonCertsAsync = async () => ({ certs: { 'test-key': publicKey } });

function token(changes = {}, signingKey = keys.privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'google-admin-subject',
    email: ADMIN_EMAIL, email_verified: true,
    iat: Math.floor(NOW / 1000) - 10, exp: Math.floor(NOW / 1000) + 3600, ...changes
  })).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${crypto.sign('RSA-SHA256', Buffer.from(signed), signingKey).toString('base64url')}`;
}

function request(changes = {}) {
  return { method: 'GET', url: '/api/price-alerts/admin', headers: { authorization: `Bearer ${token()}`, origin: 'https://olivestock.example', host: 'olivestock.example' }, ...changes };
}

function response() {
  return { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = JSON.parse(body); } };
}

function record() {
  return { version: 1, deviceId: DEVICE_ID, secretHash: 'must-not-expose', alerts: [],
    account: { email: 'member@example.com', verifiedAt: '2026-09-24T00:00:00.000Z', indexLinked: true,
      emailChallenge: { secret: 'never-return' }, recoveryChallenge: { code: 'never-return-code' } },
    entitlement: { grants: [], paymentCancellations: [] }, push: { active: true, subscription: { endpoint: 'private-endpoint' } } };
}

async function environment(fn) {
  const values = { PRICE_ALERT_GOOGLE_CLIENT_ID: CLIENT_ID, PRICE_ALERT_ENTITLEMENT_ENABLED: 'true', PRICE_ALERT_DATA_KEY: '55'.repeat(32), PRICE_ALERT_STORE_NAMESPACE: 'admin-tests' };
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await fn(); }
  finally { Object.keys(values).forEach((key) => { if (before[key] == null) delete process.env[key]; else process.env[key] = before[key]; }); }
}

test('admin verifies RSA signature with Google client and exact audience, issuer, expiry and verified allowlisted email', () => environment(async () => {
  assert.equal((await authenticateAdmin(request(), { googleClient, now: NOW })).email, ADMIN_EMAIL);
  for (const changes of [
    { email: 'another@gmail.com' }, { email_verified: false }, { email: 'kbhjjan@gmail.com.attacker.example' },
    { aud: 'different.apps.googleusercontent.com' }, { iss: 'https://attacker.example' },
    { exp: Math.floor(NOW / 1000) - 5 }, { azp: 'wrong-client' }, { sub: '' }
  ]) {
    await assert.rejects(authenticateAdmin(request({ headers: { authorization: `Bearer ${token(changes)}` } }), { googleClient, now: NOW }), (error) => [401, 403].includes(error.statusCode));
  }
  const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(authenticateAdmin(request({ headers: { authorization: `Bearer ${token({}, otherKey.privateKey)}` } }), { googleClient, now: NOW }), { code: 'admin_auth_failed' });
}));

test('private admin reads deny missing tokens and posted email cannot authorize requests', () => environment(async () => {
  let reads = 0;
  const handler = createHandler({ googleClient, readDevice: async () => { reads += 1; return { record: record() }; } });
  for (const req of [
    request({ headers: {}, query: { deviceId: DEVICE_ID, email: ADMIN_EMAIL } }),
    request({ headers: { authorization: `Bearer ${token({ email: 'other@gmail.com' })}` }, query: { deviceId: DEVICE_ID } })
  ]) {
    const res = response(); await handler(req, res);
    assert.ok([401, 403].includes(res.statusCode));
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
  assert.equal(reads, 0);
  const res = response(); await handler(request({ query: { deviceId: DEVICE_ID } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.record.email, 'member@example.com');
  assert.equal(JSON.stringify(res.body).includes('must-not-expose'), false);
  assert.equal(JSON.stringify(res.body).includes('never-return'), false);
  assert.equal(JSON.stringify(res.body).includes('private-endpoint'), false);
}));

test('manual extension is audited exactly once, payment changes preserve it, and action conflicts reject', () => {
  const device = record();
  const command = { actionId: 'admin_extension_123456789', durationDays: 7, reason: '장애 보상 기간 연장', actorEmail: ADMIN_EMAIL };
  const paymentId = 'oypa_1234567890abcdefghijklmnop';
  const secondId = 'oypa_abcdefghijklmnopqrstuvwx';
  applyPaymentGrant(device, paymentId, '2026-01-01T00:00:00.000Z');
  assert.equal(applyAdminExtension(device, command, '2026-01-10T00:00:00.000Z').changed, true);
  assert.equal(publicEntitlement(device).expiresAt, '2026-02-07T00:00:00.000Z');
  assert.equal(applyAdminExtension(device, command, '2026-01-11T00:00:00.000Z').changed, false);
  applyPaymentGrant(device, secondId, '2026-01-11T00:00:00.000Z');
  assert.equal(publicEntitlement(device).expiresAt, '2026-03-09T00:00:00.000Z');
  revokePaymentGrant(device, secondId, '2026-01-12T00:00:00.000Z');
  assert.equal(publicEntitlement(device).expiresAt, '2026-02-07T00:00:00.000Z');
  revokePaymentGrant(device, paymentId, '2026-01-12T00:00:00.000Z');
  assert.equal(publicEntitlement(device).expiresAt, '2026-01-17T00:00:00.000Z');
  assert.equal(device.entitlement.grants.filter((grant) => grant.source === 'admin').length, 1);
  assert.equal(device.entitlement.grants.find((grant) => grant.source === 'admin').revokedAt, null);
  assert.throws(() => applyAdminExtension(device, { ...command, durationDays: 8 }), { code: 'admin_action_conflict' });
  for (const durationDays of [0, 366, 1.5, '30']) assert.throws(() => applyAdminExtension(device, { ...command, durationDays }), { code: 'invalid_admin_extension' });
});

test('admin write uses existing account, reserves capacity and retries without duplicate grants', () => environment(async () => {
  let device = record();
  let reservations = 0;
  const dependencies = {
    now: Date.parse('2026-09-24T00:00:00.000Z'),
    async mutateDevice(id, mutation) {
      assert.equal(id, DEVICE_ID);
      const outcome = await mutation(structuredClone(device));
      if (outcome.changed) device = outcome.record;
      return { ...outcome, record: device };
    },
    async reserveActiveDevice() { reservations += 1; return { created: true }; }
  };
  const body = { deviceId: DEVICE_ID, actionId: 'extension_action_123456789', durationDays: 30, reason: '고객 서비스 보상' };
  const first = await extendAdminRecord(body, { email: ADMIN_EMAIL }, dependencies);
  const second = await extendAdminRecord(body, { email: ADMIN_EMAIL }, dependencies);
  assert.equal(first.idempotent, false); assert.equal(second.idempotent, true);
  assert.equal(reservations, 1); assert.equal(device.entitlement.grants.length, 1);
  device = null;
  await assert.rejects(extendAdminRecord(body, { email: ADMIN_EMAIL }, dependencies), { code: 'device_not_found' });
}));

test('admin extension enforces same origin and capacity rejection cannot persist a grant', () => environment(async () => {
  let mutationCalled = false;
  const handler = createHandler({ googleClient, mutateDevice: async () => { mutationCalled = true; } });
  const res = response();
  await handler(request({ method: 'POST', headers: { authorization: `Bearer ${token()}`, origin: 'https://other.example', host: 'olivestock.example' }, body: { action: 'extend' } }), res);
  assert.equal(res.statusCode, 403); assert.equal(mutationCalled, false);
  let written = false;
  const device = record();
  await assert.rejects(extendAdminRecord({ deviceId: DEVICE_ID, actionId: 'extension_action_123456789', durationDays: 2, reason: '보상 연장' }, { email: ADMIN_EMAIL }, {
    async mutateDevice(_id, mutation) { const value = await mutation(structuredClone(device)); written = value.changed; },
    async reserveActiveDevice() { throw new Error('capacity blocked'); }
  }), /capacity blocked/);
  assert.equal(written, false); assert.equal(device.entitlement.grants.length, 0);
}));

test('admin listing uses one bounded private index page, preserves cursor and redacts records', () => environment(async () => {
  let listCalls = 0;
  const body = encryptJson({ version: 1, kind: 'registered', deviceId: DEVICE_ID });
  const result = await listAdminRecords({ limit: 1, cursor: 'safe-cursor' }, {
    async list(options) {
      listCalls += 1; assert.equal(options.limit, 1); assert.equal(options.cursor, 'safe-cursor');
      return { hasMore: true, cursor: 'next-page', blobs: [{ pathname: `${options.prefix}a/${'a'.repeat(64)}.idx` }] };
    },
    async get(_pathname, options) { assert.equal(options.access, 'private'); assert.equal(options.useCache, false); return { statusCode: 200, stream: Readable.from([body]) }; },
    async readDevice() { return { record: record() }; }
  });
  assert.equal(listCalls, 1); assert.equal(result.records.length, 1); assert.equal(result.nextCursor, 'next-page');
  assert.deepEqual(Object.keys(result.records[0]).sort(), ['activeAlertCount', 'alertCount', 'audit', 'createdAt', 'deviceId', 'email', 'entitlement', 'lastSeenAt', 'pushActive', 'sources', 'updatedAt', 'visitCount'].sort());
  await assert.rejects(listAdminRecords({ limit: 51 }), { code: 'invalid_admin_page' });
  assert.equal(adminRecord({ ...record(), account: { email: 'unverified@example.com' } }).email, null);
}));

test('admin lists free-key legacy devices and activity without exposing promotion ids or secret fields', () => {
  const device = record();
  device.account = null;
  device.activity = { lastSeenAt: '2026-09-24T01:00:00.000Z', visitCount: 12, recentVisits: ['private-request-id'] };
  device.entitlement.grants.push({ source: 'promotion', lifetime: true, promotionId: 'private-promotion-id', grantedAt: '2026-01-01T00:00:00.000Z' });
  const summary = adminRecord(device);
  assert.equal(summary.email, null);
  assert.equal(summary.entitlement.lifetime, true);
  assert.deepEqual(summary.sources, ['promotion']);
  assert.equal(summary.visitCount, 12);
  assert.equal(summary.lastSeenAt, device.activity.lastSeenAt);
  assert.equal(JSON.stringify(summary).includes('private-'), false);
});
