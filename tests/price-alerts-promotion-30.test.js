const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createDeviceRecord, hashDeviceSecret, verifyDeviceSecret } = require('../api/price-alerts/_core');
const { mutateDevice, DeviceWriteConflictError } = require('../api/price-alerts/_store');
const { HttpError } = require('../api/price-alerts/_http');
const entitlement = require('../api/price-alerts/_entitlement');
const { recordHasRetainedEntitlement, recordIsDisposable } = require('../api/price-alerts/_registry');
const { createPromotionHandler } = require('../api/price-alerts/promotion')._test;

const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const ID = 'PromotionCanonicalDevice000001';
const SECRET = 'PromotionOriginalSecret000000000000001';
const ROTATED_SECRET = 'PromotionRotatedSecret000000000000002';
const ENTRY_CODE = 'TEST-ENTRY-INVITATION';
const ADMIN_CODE = 'TEST-CURRENT-ADMIN-INVITATION';
const clone = (value) => value == null ? null : JSON.parse(JSON.stringify(value));
const iso = (timestamp) => new Date(timestamp).toISOString();

function configuration(code, pepper = 'promotion-test-only-pepper-value') {
  return { pepper, digest: Buffer.from(entitlement.promotionDigest(code, pepper), 'base64url'), publicId: 'test-public-id' };
}

function record(verified = true) {
  const value = createDeviceRecord(ID, SECRET);
  value.createdAt = iso(NOW);
  value.updatedAt = iso(NOW);
  value.account = verified ? { email: 'member@example.com', verifiedAt: iso(NOW), indexLinked: true } : {};
  return value;
}

function req(code = ENTRY_CODE, secret = SECRET) {
  return { method: 'POST', headers: { host: 'oy-stock.vercel.app', origin: 'https://oy-stock.vercel.app',
    'x-price-alert-device-id': ID, 'x-price-alert-device-secret': secret }, body: { code } };
}

function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value; },
    end(value) { this.body = JSON.parse(value); } };
}

async function enabled(run) {
  const previous = process.env.PRICE_ALERT_ENTITLEMENT_ENABLED;
  process.env.PRICE_ALERT_ENTITLEMENT_ENABLED = 'true';
  try { return await run(); } finally {
    if (previous == null) delete process.env.PRICE_ALERT_ENTITLEMENT_ENABLED;
    else process.env.PRICE_ALERT_ENTITLEMENT_ENABLED = previous;
  }
}

function memory(initial = record(), extra = {}) {
  let current = clone(initial);
  let writes = 0;
  let capacity = false;
  let releases = 0;
  let settingsReads = 0;
  const store = {
    async readDevice(id) {
      assert.equal(id, ID);
      return { record: clone(current), blobs: current ? [{ etag: String(current.revision || 0) }] : [] };
    },
    async writeDevice(value, blobs) {
      await Promise.resolve();
      if (Number(blobs[0]?.etag || 0) !== Number(current?.revision || 0)) throw new DeviceWriteConflictError();
      current = clone(value);
      writes += 1;
      return { etag: String(current.revision) };
    }
  };
  const deps = {
    now: NOW,
    async consumeRateLimit(_request, scope) { assert.equal(scope, 'promotion'); },
    configuredPromotion: () => configuration(ENTRY_CODE),
    async resolvedPromotion() { settingsReads += 1; return configuration(ADMIN_CODE); },
    async mutateAuthenticatedDevice(request, options, mutation) {
      assert.equal(options.allowCreate, false);
      if (request.headers['x-price-alert-device-id'] !== ID || !request.headers['x-price-alert-device-secret']) {
        throw new HttpError(401, 'device_auth_required');
      }
      return mutateDevice(ID, async (value, context) => {
        if (!value || !verifyDeviceSecret(ID, request.headers['x-price-alert-device-secret'], value.secretHash)) {
          throw new HttpError(401, 'device_auth_failed');
        }
        return mutation(value, { ...context, created: false });
      }, store);
    },
    async reserveActiveDevice() {
      const created = !capacity;
      capacity = true;
      return { created };
    },
    async releaseActiveDeviceReservation() { capacity = false; releases += 1; },
    ...extra
  };
  return { deps, get current() { return clone(current); }, get writes() { return writes; },
    get settingsReads() { return settingsReads; }, get releases() { return releases; },
    setCurrent(value) { current = clone(value); }, handler: createPromotionHandler(deps) };
}

test('new invitation grants exactly thirty days, not lifetime, and expires at the boundary', () => {
  const value = record();
  assert.equal(entitlement.applyThirtyDayPromotion(value, iso(NOW)).changed, true);
  const grant = value.entitlement.grants[0];
  assert.equal(grant.source, 'promotion');
  assert.equal(grant.lifetime, false);
  assert.equal(grant.durationDays, 30);
  assert.equal(Date.parse(grant.endsAt) - Date.parse(grant.startsAt), entitlement.PASS_DURATION_MS);
  assert.deepEqual(entitlement.publicEntitlement(value, NOW), {
    active: true, lifetime: false, expiresAt: iso(NOW + entitlement.PASS_DURATION_MS),
    plan: { amount: 30000, currency: 'KRW', durationDays: 30, autoRenew: false }
  });
  assert.equal(entitlement.publicEntitlement(value, NOW + entitlement.PASS_DURATION_MS).active, false);
});

test('repeated claims, expiry and revoked invitations never create another thirty days', () => {
  const value = record();
  entitlement.applyThirtyDayPromotion(value, iso(NOW));
  const original = clone(value.entitlement);
  for (const time of [NOW, NOW + 86400000, NOW + 100 * 86400000]) {
    assert.equal(entitlement.applyThirtyDayPromotion(value, iso(time)).changed, false);
    assert.deepEqual(value.entitlement, original);
  }
  value.entitlement.grants[0].revokedAt = iso(NOW + 86400000);
  assert.equal(entitlement.applyThirtyDayPromotion(value, iso(NOW + 2 * 86400000)).changed, false);
  assert.equal(entitlement.publicEntitlement(value, NOW).active, false);
});

test('legacy lifetime entitlements are not replaced, downgraded or resurrected when revoked', () => {
  const value = record(false);
  entitlement.applyLifetimePromotion(value, 'legacy-public-id', iso(NOW));
  const original = clone(value.entitlement);
  assert.equal(entitlement.applyThirtyDayPromotion(value, iso(NOW)).changed, false);
  assert.deepEqual(value.entitlement, original);
  assert.equal(entitlement.publicEntitlement(value, NOW).lifetime, true);
  value.entitlement.grants[0].revokedAt = iso(NOW);
  assert.equal(entitlement.applyThirtyDayPromotion(value, iso(NOW)).changed, false);
  assert.equal(entitlement.publicEntitlement(value, NOW).active, false);
});

test('thirty-day invitation appends to paid and administrator periods and payment cancellation preserves it', () => {
  const value = record();
  const paymentId = 'oypa_testpayment00000000000000001';
  entitlement.applyPaymentGrant(value, paymentId, iso(NOW));
  entitlement.applyAdminExtension(value, { actionId: 'admin-action-00000001', durationDays: 5,
    reason: 'Test extension', actorEmail: 'kbhjjan@gmail.com' }, iso(NOW + 1000));
  const prior = clone(value.entitlement.grants);
  entitlement.applyThirtyDayPromotion(value, iso(NOW + 2000));
  assert.deepEqual(value.entitlement.grants.slice(0, 2), prior);
  assert.equal(Date.parse(entitlement.publicEntitlement(value, NOW).expiresAt), NOW + 65 * 86400000);
  entitlement.revokePaymentGrant(value, paymentId, iso(NOW + 3000));
  const invitation = value.entitlement.grants.find((grant) => grant.claimId);
  assert.equal(invitation.revokedAt, null);
  assert.equal(Date.parse(invitation.endsAt) - Date.parse(invitation.startsAt), entitlement.PASS_DURATION_MS);
  assert.equal(entitlement.publicEntitlement(value, NOW + 4000).active, true);
});

test('entry invitation works independently of admin override availability without revealing its code', async () => enabled(async () => {
  const h = memory(record(), { async resolvedPromotion() { throw new Error('must not read admin override'); } });
  const res = response();
  await h.handler(req(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.entitlement.active, true);
  assert.equal(res.body.entitlement.lifetime, false);
  assert.equal(res.body.entitlement.expiresAt, iso(NOW + entitlement.PASS_DURATION_MS));
  assert.equal(h.writes, 1);
  assert.ok(!JSON.stringify(res.body).includes(ENTRY_CODE));
  assert.ok(!JSON.stringify(h.current).includes(ENTRY_CODE));
}));

test('admin-managed invitation is thirty days too and a later different valid key cannot add time', async () => enabled(async () => {
  const h = memory();
  const first = response();
  await h.handler(req(ADMIN_CODE), first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.entitlement.lifetime, false);
  const original = clone(h.current.entitlement);
  const replay = response();
  await h.handler(req(), replay);
  assert.equal(replay.body.idempotent, true);
  assert.deepEqual(h.current.entitlement, original);
  assert.equal(h.writes, 1);
  assert.equal(h.settingsReads, 1);
}));

test('non-entry code settings failure is fail-closed and never mutates entitlement', async () => enabled(async () => {
  const h = memory(record(), { async resolvedPromotion() { throw new HttpError(503, 'promotion_settings_unavailable'); } });
  const res = response();
  await h.handler(req(ADMIN_CODE), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'promotion_settings_unavailable');
  assert.equal(h.writes, 0);
}));

test('new invitation requires a verified canonical email before reserving capacity even when recovery is disabled', async () => enabled(async () => {
  let reservations = 0;
  const h = memory(record(false), { async reserveActiveDevice() { reservations += 1; return { created: true }; } });
  const previous = process.env.PRICE_ALERT_ACCOUNT_RECOVERY_ENABLED;
  process.env.PRICE_ALERT_ACCOUNT_RECOVERY_ENABLED = 'false';
  try {
    const res = response();
    await h.handler(req(), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'email_verification_required');
    assert.equal(reservations, 0);
    assert.equal(h.writes, 0);
  } finally {
    if (previous == null) delete process.env.PRICE_ALERT_ACCOUNT_RECOVERY_ENABLED;
    else process.env.PRICE_ALERT_ACCOUNT_RECOVERY_ENABLED = previous;
  }
}));

test('unregistered or invalid browser credentials cannot redeem a promotion', async () => enabled(async () => {
  for (const h of [memory(null), memory()]) {
    const res = response();
    await h.handler(req(ENTRY_CODE, ROTATED_SECRET), res);
    assert.equal(res.statusCode, 401);
    assert.equal(h.writes, 0);
  }
}));

test('concurrent authenticated claims use CAS and persist one invitation grant only', async () => enabled(async () => {
  const h = memory();
  const responses = [response(), response()];
  await Promise.all(responses.map((res) => h.handler(req(), res)));
  assert.deepEqual(responses.map((res) => res.statusCode), [200, 200]);
  assert.equal(responses.filter((res) => res.body.idempotent === false).length, 1);
  assert.equal(responses.filter((res) => res.body.idempotent === true).length, 1);
  assert.equal(h.writes, 1);
  assert.equal(h.current.entitlement.grants.length, 1);
}));

test('recovered browser retains the canonical invitation and expired history survives cleanup classification', async () => enabled(async () => {
  const value = record();
  entitlement.applyThirtyDayPromotion(value, iso(NOW));
  value.secretHash = hashDeviceSecret(ID, ROTATED_SECRET);
  const h = memory(value, { now: NOW + 100 * 86400000 });
  const oldBrowser = response();
  await h.handler(req(), oldBrowser);
  assert.equal(oldBrowser.statusCode, 401);
  const recovered = response();
  await h.handler(req(ENTRY_CODE, ROTATED_SECRET), recovered);
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.body.idempotent, true);
  assert.equal(recovered.body.entitlement.active, false);
  assert.equal(recovered.body.entitlement.expiresAt, iso(NOW + entitlement.PASS_DURATION_MS));
  assert.equal(h.writes, 0);
  assert.equal(recordHasRetainedEntitlement(h.current, NOW + 100 * 86400000), true);
  assert.equal(recordIsDisposable(h.current), false);
}));

test('legacy lifetime replay does not force new email verification or capacity reservation', async () => enabled(async () => {
  const value = record(false);
  entitlement.applyLifetimePromotion(value, 'legacy-key-id', iso(NOW));
  const h = memory(value, { async reserveActiveDevice() { throw new Error('must not reserve again'); } });
  const res = response();
  await h.handler(req(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.idempotent, true);
  assert.equal(res.body.entitlement.lifetime, true);
  assert.equal(h.writes, 0);
}));

test('invalid invitation, cross-origin and malformed payload cannot modify the account', async () => enabled(async () => {
  const h = memory();
  for (const request of [req('wrong-key'), { ...req(), body: { code: ENTRY_CODE, lifetime: true } },
    { ...req(), headers: { ...req().headers, origin: 'https://foreign.example' } }]) {
    const res = response();
    await h.handler(request, res);
    assert.equal(res.body.success, false);
    assert.ok([400, 403].includes(res.statusCode));
  }
  assert.equal(h.writes, 0);
}));

test('capacity failure never persists a grant and a failed write releases its reservation', async () => enabled(async () => {
  const h = memory(record(), { async reserveActiveDevice() { throw new HttpError(503, 'active_device_capacity_reached'); } });
  const res = response();
  await h.handler(req(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(h.writes, 0);
  const failed = memory(record(), { async mutateAuthenticatedDevice(_req, _options, mutation) {
    await mutation(record());
    throw new Error('private write failed');
  } });
  const failedRes = response();
  await failed.handler(req(), failedRes);
  assert.equal(failedRes.statusCode, 500);
  assert.equal(failed.releases, 1);
}));

test('CAS retry rolls back its latest newly created reservation after a final write failure', async () => enabled(async () => {
  let current = record();
  let reservationRevision = null;
  let writeAttempts = 0;
  const releasedRevisions = [];
  const h = memory(current, {
    async mutateAuthenticatedDevice(_request, options, mutation) {
      assert.equal(options.allowCreate, false);
      return mutateDevice(ID, mutation, {
        async readDevice() { return { record: clone(current), blobs: [] }; },
        async writeDevice() {
          writeAttempts += 1;
          if (writeAttempts === 1) {
            // A different authenticated writer commits an inactive account and
            // its index sync removes the reservation from our first attempt.
            current.revision = 1;
            reservationRevision = null;
            throw new DeviceWriteConflictError();
          }
          throw new Error('private write failed');
        }
      });
    },
    async reserveActiveDevice(value) {
      const created = reservationRevision == null;
      if (created) reservationRevision = value.revision;
      return { created };
    },
    async releaseActiveDeviceReservation(value) {
      releasedRevisions.push(value.revision);
      // Match the real registry guard: an old rollback cannot delete a newer
      // reservation (nor a successfully committed active index).
      if (reservationRevision != null && reservationRevision <= value.revision) {
        reservationRevision = null;
      }
    }
  });
  const res = response();
  await h.handler(req(), res);
  assert.equal(res.statusCode, 500);
  assert.equal(writeAttempts, 2);
  assert.deepEqual(releasedRevisions, [1]);
  assert.equal(reservationRevision, null);
  assert.equal(current.entitlement.grants.length, 0);
}));

test('promotion readiness accepts configured entry invitation without reading admin override', async () => enabled(async () => {
  const filename = path.join(__dirname, '../api/price-alerts/entitlement.js');
  const module = { exports: {} };
  const dependencies = {
    './_auth': { async authenticateDevice() { return { record: record() }; } },
    './_entitlement': { ...entitlement, configuredPromotion: () => configuration(ENTRY_CODE) },
    './_http': require('../api/price-alerts/_http'),
    './_portone': { configuredPortOne: () => null },
    './_registry': { async activeDeviceCapacity() { throw new Error('not needed'); } },
    './_promotion-settings': { async resolvedPromotion() { throw new Error('not needed'); } }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require(name) {
    assert.ok(dependencies[name], `Unexpected dependency ${name}`);
    return dependencies[name];
  } });
  const res = response();
  await module.exports({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.promotionAvailable, true);
}));
