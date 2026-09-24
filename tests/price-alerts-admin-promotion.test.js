const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { decryptJson } = require('../api/price-alerts/_crypto');
const { applyLifetimePromotion, promotionDigest, promotionMatches, publicEntitlement } = require('../api/price-alerts/_entitlement');
const { readPromotionSettings, resolvedPromotion, setPromotionCode } = require('../api/price-alerts/_promotion-settings');
const { createHandler } = require('../api/price-alerts/admin')._test;

const ADMIN = { email: 'kbhjjan@gmail.com' };
const CLIENT_ID = 'test-admin-client.apps.googleusercontent.com';
const OLD_CODE = 'old-test-free-code';
const NEW_CODE = 'new-test-free-code';
const PEPPER = 'test-env-pepper-with-enough-length';
async function environment(fn) {
  const values = { PRICE_ALERT_GOOGLE_CLIENT_ID: CLIENT_ID, PRICE_ALERT_DATA_KEY: '66'.repeat(32), PRICE_ALERT_STORE_NAMESPACE: 'promotion-admin-tests', PRICE_ALERT_PROMO_CODE_PEPPER: PEPPER, PRICE_ALERT_PROMO_CODE_DIGEST: promotionDigest(OLD_CODE, PEPPER) };
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { await fn(); } finally { Object.keys(values).forEach((key) => { if (before[key] == null) delete process.env[key]; else process.env[key] = before[key]; }); }
}

function memory() {
  let ciphertext = null;
  let revision = 0;
  const dependencies = {
    async get(_path, options) {
      assert.equal(options.access, 'private'); assert.equal(options.useCache, false);
      return ciphertext ? { statusCode: 200, stream: Readable.from([ciphertext]), blob: { etag: String(revision) } } : null;
    },
    async put(_path, body, options) {
      assert.equal(options.access, 'private'); assert.equal(options.addRandomSuffix, false);
      if (ciphertext ? options.ifMatch !== String(revision) : options.allowOverwrite !== false) {
        const error = new Error('etag mismatch'); error.statusCode = 412; throw error;
      }
      ciphertext = body; revision += 1;
      return { etag: String(revision) };
    }
  };
  return { dependencies, encrypted: () => ciphertext, revision: () => revision };
}

test('free key rotation replaces the environment key, stores encrypted HMAC settings and preserves existing lifetime grants', () => environment(async () => {
  const store = memory();
  const before = await resolvedPromotion(store.dependencies);
  assert.equal(promotionMatches(OLD_CODE, before), true);
  const device = { entitlement: { grants: [], paymentCancellations: [] } };
  applyLifetimePromotion(device, before.publicId, '2026-09-01T00:00:00.000Z');
  const command = { code: NEW_CODE, actionId: 'promotion_action_123456789', reason: '초대 키 정기 변경' };
  const result = await setPromotionCode(command, ADMIN, store.dependencies);
  assert.equal(result.idempotent, false);
  const after = await resolvedPromotion(store.dependencies);
  assert.equal(promotionMatches(OLD_CODE, after), false);
  assert.equal(promotionMatches(NEW_CODE, after), true);
  assert.equal(publicEntitlement(device).lifetime, true);
  assert.equal(store.encrypted().includes(NEW_CODE), false);
  assert.equal(store.encrypted().includes(after.pepper), false);
  assert.equal(JSON.stringify(decryptJson(store.encrypted())).includes(NEW_CODE), false);
  assert.equal(JSON.stringify(decryptJson(store.encrypted())).includes(command.reason), false);
  assert.deepEqual(Object.keys(result.settings).sort(), ['audit', 'configured', 'updatedAt', 'updatedBy']);
  assert.deepEqual(Object.keys(result.settings.audit[0]).sort(), ['actorEmail', 'changedAt']);
  assert.equal((await setPromotionCode(command, ADMIN, store.dependencies)).idempotent, true);
  assert.equal(store.revision(), 1);
  await assert.rejects(setPromotionCode({ ...command, code: 'other-test-key' }, ADMIN, store.dependencies), { code: 'admin_action_conflict' });
}));

test('concurrent key rotations preserve CAS audit and old request replay never rolls back the newer key', () => environment(async () => {
  const store = memory();
  const one = { code: 'first-new-test-code', actionId: 'promotion_first_123456789', reason: '첫 초대 키 변경' };
  const two = { code: 'second-new-test-code', actionId: 'promotion_second_123456789', reason: '두 번째 초대 키 변경' };
  await Promise.all([setPromotionCode(one, ADMIN, store.dependencies), setPromotionCode(two, ADMIN, store.dependencies)]);
  const loaded = await readPromotionSettings(store.dependencies);
  assert.equal(loaded.settings.actions.length, 2);
  assert.equal(promotionMatches(two.code, await resolvedPromotion(store.dependencies)), true);
  assert.equal((await setPromotionCode(one, ADMIN, store.dependencies)).idempotent, true);
  assert.equal(promotionMatches(two.code, await resolvedPromotion(store.dependencies)), true);
  assert.equal(store.revision(), 2);
}));

test('settings outage fails closed and never restores the replaced environment key', () => environment(async () => {
  await assert.rejects(resolvedPromotion({ get: async () => { throw new Error('unavailable'); } }), { code: 'promotion_settings_unavailable' });
  for (const code of ['short', 'bad\nkey', 'a'.repeat(161)]) {
    await assert.rejects(setPromotionCode({ code, actionId: 'promotion_action_123456789', reason: '테스트 변경 사유' }, ADMIN), { code: 'invalid_promotion_update' });
  }
}));

test('promotion admin reads and writes require allowlisted Google authorization and never return key material', () => environment(async () => {
  const store = memory();
  const tokenPayload = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'admin-sub', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, email: ADMIN.email, email_verified: true };
  const handler = createHandler({ ...store.dependencies, googleClient: { verifyIdToken: async () => ({ getPayload: () => tokenPayload }) } });
  const response = () => ({ statusCode: 200, setHeader() {}, end(body) { this.body = JSON.parse(body); } });
  const noToken = response();
  await handler({ method: 'GET', headers: {}, query: { action: 'promotion-settings' } }, noToken);
  assert.equal(noToken.statusCode, 401);
  const headers = { authorization: 'Bearer simulated.test.signature', origin: 'https://olivestock.example', host: 'olivestock.example' };
  const command = { action: 'set-promotion', code: NEW_CODE, actionId: 'promotion_action_123456789', reason: '초대 키 변경' };
  tokenPayload.email = 'wrong@gmail.com';
  const rejected = response();
  await handler({ method: 'POST', headers, body: command }, rejected);
  assert.equal(rejected.statusCode, 403); assert.equal(store.revision(), 0);
  tokenPayload.email = ADMIN.email;
  const accepted = response();
  await handler({ method: 'POST', headers, body: command }, accepted);
  assert.equal(accepted.statusCode, 200);
  const settings = response();
  await handler({ method: 'GET', headers, query: { action: 'promotion-settings' } }, settings);
  assert.equal(settings.statusCode, 200);
  assert.equal(JSON.stringify(settings.body).includes(NEW_CODE), false);
  assert.equal(JSON.stringify(settings.body).includes('digest'), false);
  assert.equal(JSON.stringify(settings.body).includes('pepper'), false);
}));
