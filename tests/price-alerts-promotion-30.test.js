const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createDeviceRecord, hashDeviceSecret, normalizeDeviceId, normalizeDeviceSecret, verifyDeviceSecret } = require('../api/price-alerts/_core');
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

function memory(initial = record(), extra = {}, storeExtra = {}) {
  let current = clone(initial);
  let writes = 0;
  let capacity = false;
  let releases = 0;
  let registered = false;
  let registrationReservations = 0;
  let registrationReleases = 0;
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
    },
    ...storeExtra
  };
  const deps = {
    now: NOW,
    async consumeRateLimit(_request, scope) { assert.equal(scope, 'promotion'); },
    configuredPromotion: () => configuration(ENTRY_CODE),
    async resolvedPromotion() { settingsReads += 1; return configuration(ADMIN_CODE); },
    async mutateAuthenticatedDevice(request, options, mutation) {
      assert.equal(options.allowCreate, true);
      if (normalizeDeviceId(request.headers['x-price-alert-device-id']) !== ID ||
          !normalizeDeviceSecret(request.headers['x-price-alert-device-secret'])) {
        throw new HttpError(401, 'device_auth_required');
      }
      return mutateDevice(ID, async (value, context) => {
        const created = !value;
        if (!value) value = createDeviceRecord(ID, request.headers['x-price-alert-device-secret'], iso(NOW));
        else if (!verifyDeviceSecret(ID, request.headers['x-price-alert-device-secret'], value.secretHash)) {
          throw new HttpError(401, 'device_auth_failed');
        }
        return mutation(value, { ...context, created });
      }, store);
    },
    async reserveDeviceRegistration() {
      registrationReservations += 1;
      const created = !registered;
      registered = true;
      return { created };
    },
    async releaseDeviceRegistrationReservation() { registered = false; registrationReleases += 1; },
    async reserveActiveDevice() {
      const created = !capacity;
      capacity = true;
      return { created };
    },
    async releaseActiveDeviceReservation() { capacity = false; releases += 1; },
    async syncDeviceIndexes() {},
    ...extra
  };
  return { deps, get current() { return clone(current); }, get writes() { return writes; },
    get settingsReads() { return settingsReads; }, get releases() { return releases; },
    get registrationReservations() { return registrationReservations; },
    get registrationReleases() { return registrationReleases; },
    get registrationReserved() { return registered; }, get activeReserved() { return capacity; },
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

test('an existing anonymous or unverified browser redeems without requiring an email', async () => enabled(async () => {
  for (const account of [{}, null, { email: 'unverified@example.com', verifiedAt: null, indexLinked: false }]) {
    const initial = record(false);
    initial.account = account;
    const h = memory(initial);
    const res = response();
    await h.handler(req(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.entitlement.active, true);
    assert.equal(res.body.entitlement.lifetime, false);
    assert.deepEqual(h.current.account, account);
    assert.equal(h.registrationReservations, 0);
    assert.equal(h.writes, 1);
  }
}));

test('a new browser persists a thirty-day pass with no email and reserves registration once', async () => enabled(async () => {
  const h = memory(null);
  const res = response();
  await h.handler(req(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.entitlement.active, true);
  assert.equal(res.body.entitlement.lifetime, false);
  assert.equal(res.body.entitlement.expiresAt, iso(NOW + entitlement.PASS_DURATION_MS));
  assert.equal(h.current.account, undefined);
  assert.equal(h.current.deviceId, ID);
  assert.equal(verifyDeviceSecret(ID, SECRET, h.current.secretHash), true);
  assert.equal(h.registrationReservations, 1);
  const repeat = response();
  await h.handler(req(), repeat);
  assert.equal(repeat.body.idempotent, true);
  assert.equal(h.writes, 1);
  assert.equal(h.registrationReservations, 1);
}));

test('invalid credentials and a different secret for an existing browser cannot redeem', async () => enabled(async () => {
  for (const [h, request] of [[memory(), req(ENTRY_CODE, ROTATED_SECRET)],
    [memory(null), req(ENTRY_CODE, '')],
    [memory(null), { ...req(), headers: { ...req().headers, 'x-price-alert-device-id': 'short' } }]]) {
    const res = response();
    await h.handler(request, res);
    assert.equal(res.statusCode, 401);
    assert.equal(h.writes, 0);
    assert.equal(h.registrationReservations, 0);
  }
}));

test('concurrent new and existing anonymous claims use CAS and persist one invitation grant only', async () => enabled(async () => {
  for (const initial of [null, record(false)]) {
    const h = memory(initial);
    const responses = [response(), response()];
    await Promise.all(responses.map((res) => h.handler(req(), res)));
    assert.deepEqual(responses.map((res) => res.statusCode), [200, 200]);
    assert.equal(responses.filter((res) => res.body.idempotent === false).length, 1);
    assert.equal(responses.filter((res) => res.body.idempotent === true).length, 1);
    assert.equal(h.writes, 1);
    assert.equal(h.current.entitlement.grants.length, 1);
  }
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

test('invalid invitation, cross-origin and malformed payload cannot create a browser record', async () => enabled(async () => {
  for (const initial of [null, record(false)]) {
    const h = memory(initial);
    for (const request of [req('wrong-key'), { ...req(), body: { code: ENTRY_CODE, lifetime: true } },
      { ...req(), headers: { ...req().headers, origin: 'https://foreign.example' } }]) {
      const res = response();
      await h.handler(request, res);
      assert.equal(res.body.success, false);
      assert.ok([400, 403].includes(res.statusCode));
    }
    assert.equal(h.writes, 0);
    assert.equal(h.registrationReservations, 0);
    assert.deepEqual(h.current, initial);
  }
}));

test('capacity failure never persists a grant and a failed write releases its reservation', async () => enabled(async () => {
  const h = memory(record(), { async reserveActiveDevice() { throw new HttpError(503, 'active_device_capacity_reached'); } });
  const res = response();
  await h.handler(req(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(h.writes, 0);
  const failed = memory(record(), { async mutateAuthenticatedDevice(_req, _options, mutation) {
    await mutation(record(), { created: false });
    throw new Error('private write failed');
  } });
  const failedRes = response();
  await failed.handler(req(), failedRes);
  assert.equal(failedRes.statusCode, 500);
  assert.equal(failed.releases, 1);
}));

test('registration capacity failure never reserves an active slot or persists a new browser', async () => enabled(async () => {
  let activeAttempts = 0;
  const h = memory(null, {
    async reserveDeviceRegistration() { throw new HttpError(503, 'device_capacity_reached'); },
    async reserveActiveDevice() { activeAttempts += 1; return { created: true }; }
  });
  const res = response();
  await h.handler(req(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'device_capacity_reached');
  assert.equal(h.current, null);
  assert.equal(h.writes, 0);
  assert.equal(activeAttempts, 0);
  assert.equal(h.registrationReleases, 0);
}));

test('new browser active-capacity failure releases only its newly created registration reservation', async () => enabled(async () => {
  const h = memory(null, {
    async reserveActiveDevice() { throw new HttpError(503, 'active_device_capacity_reached'); }
  });
  const res = response();
  await h.handler(req(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(h.current, null);
  assert.equal(h.registrationReservations, 1);
  assert.equal(h.registrationReleases, 1);
  assert.equal(h.releases, 0);
  assert.equal(h.writes, 0);
  let releasedExisting = 0;
  const existing = memory(null, {
    async reserveDeviceRegistration() { return { created: false }; },
    async releaseDeviceRegistrationReservation() { releasedExisting += 1; },
    async reserveActiveDevice() { throw new HttpError(503, 'active_device_capacity_reached'); }
  });
  await existing.handler(req(), response());
  assert.equal(releasedExisting, 0);
}));

test('a failed new-browser write rolls back both reservations without changing existing account state', async () => enabled(async () => {
  const h = memory(null, {
    async mutateAuthenticatedDevice(_request, options, mutation) {
      assert.equal(options.allowCreate, true);
      await mutation(createDeviceRecord(ID, SECRET, iso(NOW)), { created: true });
      throw new Error('private write failed');
    }
  });
  const res = response();
  await h.handler(req(), res);
  assert.equal(res.statusCode, 500);
  assert.equal(h.current, null);
  assert.equal(h.registrationReleases, 1);
  assert.equal(h.releases, 1);
  const linked = record();
  linked.account.recovery = { pending: 'preserved-test-state' };
  const existing = memory(linked);
  await existing.handler(req(), response());
  assert.deepEqual(existing.current.account, linked.account);
  assert.equal(existing.registrationReservations, 0);
}));

test('a committed grant keeps both reservations on index failure and an idempotent replay repairs indexes', async () => enabled(async () => {
  let syncCalls = 0;
  let projected = null;
  async function synchronize(value) {
    syncCalls += 1;
    if (syncCalls === 1) throw new Error('private index sync failed');
    projected = clone(value);
  }
  const h = memory(null, { syncDeviceIndexes: synchronize }, { syncDeviceIndexes: synchronize });
  const first = response();
  await h.handler(req(), first);
  assert.equal(first.statusCode, 500);
  assert.deepEqual(first.body, { success: false, error: 'internal_error' });
  assert.equal(h.current.entitlement.grants.length, 1);
  assert.equal(h.current.revision, 1);
  assert.equal(h.writes, 1);
  assert.equal(h.activeReserved, true);
  assert.equal(h.registrationReserved, true);
  assert.equal(h.releases, 0);
  assert.equal(h.registrationReleases, 0);
  const original = clone(h.current.entitlement);
  const replay = response();
  await h.handler(req(), replay);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.idempotent, true);
  assert.equal(replay.body.entitlement.active, true);
  assert.equal(syncCalls, 2);
  assert.equal(h.writes, 1);
  assert.deepEqual(h.current.entitlement, original);
  assert.deepEqual(projected, h.current);
  assert.equal(h.current.entitlement.grants.length, 1);
}));

test('an idempotent promotion waits for index repair and fails closed if repair is still unavailable', async () => enabled(async () => {
  const initial = record(false);
  entitlement.applyThirtyDayPromotion(initial, iso(NOW));
  let syncCalls = 0;
  const h = memory(initial, { async syncDeviceIndexes() {
    syncCalls += 1;
    throw new Error('private index sync failed');
  } });
  const res = response();
  await h.handler(req(), res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, error: 'internal_error' });
  assert.equal(syncCalls, 1);
  assert.equal(h.writes, 0);
  assert.deepEqual(h.current, initial);
  assert.equal(h.releases, 0);
  assert.equal(h.registrationReleases, 0);
}));

test('anonymous expired and revoked claims stay consumed and retained without an email', async () => enabled(async () => {
  for (const revoked of [false, true]) {
    const initial = record(false);
    entitlement.applyThirtyDayPromotion(initial, iso(NOW));
    if (revoked) initial.entitlement.grants[0].revokedAt = iso(NOW + 86400000);
    const h = memory(initial, { now: NOW + 100 * 86400000 });
    const res = response();
    await h.handler(req(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.idempotent, true);
    assert.equal(res.body.entitlement.active, false);
    assert.deepEqual(h.current, initial);
    assert.equal(h.writes, 0);
    assert.equal(h.registrationReservations, 0);
    assert.equal(recordHasRetainedEntitlement(h.current, NOW + 1000 * 86400000), true);
    assert.equal(recordIsDisposable(h.current), false);
  }
}));

test('CAS retry rolls back its latest newly created reservation after a final write failure', async () => enabled(async () => {
  let current = record();
  let reservationRevision = null;
  let writeAttempts = 0;
  const releasedRevisions = [];
  const h = memory(current, {
    async mutateAuthenticatedDevice(_request, options, mutation) {
      assert.equal(options.allowCreate, true);
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
