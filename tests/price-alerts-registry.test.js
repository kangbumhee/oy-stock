const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

// Synthetic child-process configuration; this suite never uses the remote store.
process.env.PRICE_ALERT_DATA_KEY = Buffer.alloc(32, 41).toString('base64');
process.env.PRICE_ALERT_ENTITLEMENT_ENABLED = 'true';
process.env.PRICE_ALERT_STORE_NAMESPACE = 'registry-reservation-test';

const { encryptJson } = require('../api/price-alerts/_crypto');
const { createDeviceRecord } = require('../api/price-alerts/_core');
const { applyThirtyDayPromotion } = require('../api/price-alerts/_entitlement');
const {
  deviceIndexPath,
  recordHasRetainedEntitlement,
  recordIsDisposable,
  releaseDeviceRegistrationReservation
} = require('../api/price-alerts/_registry');

const ID = 'RegistryPromotionDevice000001';
const SECRET = 'RegistryFakeDeviceSecret0000000000000001';
const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const iso = (value) => new Date(value).toISOString();

function memoryIndex() {
  const objects = new Map();
  let sequence = 0;
  const deleted = [];
  const dependencies = {
    async get(pathname, options) {
      assert.equal(options.access, 'private');
      assert.equal(options.useCache, false);
      const current = objects.get(pathname);
      return current ? {
        stream: Readable.from([current.body]),
        blob: { pathname, etag: current.etag }
      } : null;
    },
    async del(pathname, options) {
      const current = objects.get(pathname);
      assert.ok(options && options.ifMatch, 'rollback must use the read ETag');
      if (!current || current.etag !== options.ifMatch) {
        const error = new Error('test precondition conflict');
        error.status = 412;
        throw error;
      }
      deleted.push(pathname);
      objects.delete(pathname);
    }
  };
  return {
    objects, deleted, dependencies,
    seed(kind, revision, extra = {}) {
      const pathname = deviceIndexPath(ID, kind);
      objects.set(pathname, {
        body: encryptJson({ version: 1, kind, deviceId: ID, revision,
          updatedAt: iso(NOW), ...extra }),
        etag: '"fake-etag-' + (++sequence) + '"'
      });
      return pathname;
    }
  };
}

test('registration reservation rollback rejects invalid records without store calls', async () => {
  const unexpected = async () => { throw new Error('must not access the store'); };
  for (const value of [null, undefined, {}]) {
    assert.equal(await releaseDeviceRegistrationReservation(value, { get: unexpected, del: unexpected }), false);
  }
});

test('registration rollback removes only its reserved registration index and preserves active index', async () => {
  const store = memoryIndex();
  const registered = store.seed('registered', 2, { reservedAt: iso(NOW) });
  const active = store.seed('active', 2, { reservedAt: iso(NOW) });
  assert.equal(await releaseDeviceRegistrationReservation({ deviceId: ID, revision: 2 }, store.dependencies), true);
  assert.deepEqual(store.deleted, [registered]);
  assert.equal(store.objects.has(registered), false);
  assert.equal(store.objects.has(active), true);
});

test('registration rollback preserves a newer reservation revision', async () => {
  const store = memoryIndex();
  const registered = store.seed('registered', 3, { reservedAt: iso(NOW) });
  assert.equal(await releaseDeviceRegistrationReservation({ deviceId: ID, revision: 2 }, store.dependencies), false);
  assert.equal(store.objects.has(registered), true);
  assert.equal(store.deleted.length, 0);
});

test('registration rollback never deletes a committed index even at the same or older revision', async () => {
  for (const revision of [1, 2]) {
    const store = memoryIndex();
    const registered = store.seed('registered', revision);
    assert.equal(await releaseDeviceRegistrationReservation({ deviceId: ID, revision: 2 }, store.dependencies), false);
    assert.equal(store.objects.has(registered), true);
    assert.equal(store.deleted.length, 0);
  }
});

test('registration rollback retries an ETag conflict and preserves a concurrently committed index', async () => {
  const store = memoryIndex();
  const registered = store.seed('registered', 2, { reservedAt: iso(NOW) });
  let attempts = 0;
  const dependencies = { ...store.dependencies, async del(pathname, options) {
    attempts += 1;
    // A concurrent successful device write replaces the reservation before del.
    store.seed('registered', 2);
    await store.dependencies.del(pathname, options);
  } };
  assert.equal(await releaseDeviceRegistrationReservation({ deviceId: ID, revision: 2 }, dependencies), false);
  assert.equal(attempts, 1);
  assert.equal(store.objects.has(registered), true);
  assert.equal(store.deleted.length, 0);
});

test('registration rollback treats missing index and invalid reservation timestamps as not owned', async () => {
  const store = memoryIndex();
  assert.equal(await releaseDeviceRegistrationReservation({ deviceId: ID, revision: 2 }, store.dependencies), false);
  for (const reservedAt of ['', null, 'not-an-iso-date']) {
    const registered = store.seed('registered', 2, { reservedAt });
    assert.equal(await releaseDeviceRegistrationReservation({ deviceId: ID, revision: 2 }, store.dependencies), false);
    assert.equal(store.objects.has(registered), true);
  }
  assert.equal(store.deleted.length, 0);
});

test('anonymous expired or revoked promotion history is retained so cleanup cannot permit another browser claim', () => {
  for (const revoked of [false, true]) {
    const record = createDeviceRecord(ID, SECRET, iso(NOW));
    applyThirtyDayPromotion(record, iso(NOW));
    if (revoked) record.entitlement.grants[0].revokedAt = iso(NOW + 86400000);
    assert.equal(record.account, undefined);
    assert.equal(recordHasRetainedEntitlement(record, NOW + 400 * 86400000), true);
    assert.equal(recordIsDisposable(record), false);
  }
  assert.equal(recordHasRetainedEntitlement(createDeviceRecord(ID, SECRET), NOW + 400 * 86400000), false);
});
