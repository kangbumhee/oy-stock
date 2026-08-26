const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PRICE_ALERT_ENTITLEMENT_ENABLED = 'true';
const { Readable } = require('node:stream');

process.env.PRICE_ALERT_DATA_KEY ||= Buffer.alloc(32, 9).toString('base64');

const { HttpError, handleHttpError } = require('../api/price-alerts/_http');
const { applyPaymentGrant } = require('../api/price-alerts/_entitlement');
const {
  configuredRatePolicy,
  consumeRateLimit,
  normalizeNetwork,
  rateSubjectHash
} = require('../api/price-alerts/_limits');
const {
  configuredRegistryPolicy,
  deviceIndexPath,
  activeDeviceCapacity,
  activeDeviceCount,
  listActiveDeviceRefs,
  listStaleRegistryRefs,
  maintenanceShard,
  recordClaimsActiveCapacity,
  recordIsDisposable,
  recordNeedsHourlyWork,
  registeredDeviceCount,
  releaseActiveDeviceReservation,
  reserveActiveDevice,
  reserveDeviceRegistration,
  syncDeviceIndexes
} = require('../api/price-alerts/_registry');
const {
  cleanupInactiveDevices,
  loadActiveDeviceEntries
} = require('../api/price-alerts/hourly')._test;

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

function memoryBlob() {
  const objects = new Map();
  let etagSequence = 0;
  return {
    objects,
    async get(pathname, options) {
      assert.equal(options.access, 'private');
      assert.equal(options.useCache, false);
      const row = objects.get(pathname);
      if (!row) return null;
      return {
        stream: Readable.from([row.body]),
        blob: { pathname, etag: row.etag }
      };
    },
    async put(pathname, body, options) {
      assert.equal(options.access, 'private');
      const existing = objects.get(pathname);
      if (!options.allowOverwrite && existing) {
        const error = new Error('conflict');
        error.status = 409;
        throw error;
      }
      if (options.ifMatch && (!existing || existing.etag !== options.ifMatch)) {
        const error = new Error('precondition');
        error.status = 412;
        throw error;
      }
      const etag = `etag-${++etagSequence}`;
      objects.set(pathname, { body: String(body), etag });
      return { pathname, etag };
    },
    async del(paths, options) {
      if (!Array.isArray(paths) && options && options.ifMatch) {
        const existing = objects.get(paths);
        if (!existing || existing.etag !== options.ifMatch) {
          const error = new Error('precondition');
          error.status = 412;
          throw error;
        }
      }
      (Array.isArray(paths) ? paths : [paths]).forEach((pathname) => objects.delete(pathname));
    },
    async list({ prefix, cursor, limit = 1000 }) {
      const paths = Array.from(objects.keys()).filter((path) => path.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const selected = paths.slice(start, start + limit);
      const next = start + selected.length;
      return {
        blobs: selected.map((pathname) => ({ pathname })),
        hasMore: next < paths.length,
        cursor: next < paths.length ? String(next) : undefined
      };
    }
  };
}

function request(ip = '203.0.113.44') {
  return { headers: { 'x-vercel-forwarded-for': ip, host: 'olivestock.co.kr' } };
}

test('rate identity stores only HMAC of normalized network and host', () => {
  assert.equal(normalizeNetwork('203.0.113.44'), '203.0.113.0/24');
  assert.equal(normalizeNetwork('2001:db8:abcd:12:1:2:3:4'), '2001:db8:abcd:12::/64');
  const hash = rateSubjectHash(request(), 'mutation');
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash.includes('203.0.113'), false);
});

test('CAS rate counter rejects above configured hard limit with Retry-After', async () => {
  const blob = memoryBlob();
  await withEnv(
    { PRICE_ALERT_MUTATION_LIMIT: '2', PRICE_ALERT_MUTATION_WINDOW_SECONDS: '60' },
    async () => {
      assert.equal(configuredRatePolicy('mutation').limit, 2);
      await consumeRateLimit(request(), 'mutation', { ...blob, now: 1000 });
      await consumeRateLimit(request(), 'mutation', { ...blob, now: 1001 });
      await assert.rejects(
        consumeRateLimit(request(), 'mutation', { ...blob, now: 1002 }),
        (error) =>
          error instanceof HttpError &&
          error.statusCode === 429 &&
          error.code === 'rate_limit_exceeded' &&
          error.retryAfter === 60
      );
    }
  );
  assert.equal(blob.objects.size, 1);
});

test('rate counter resets in place after window and Blob failures fail closed', async () => {
  const blob = memoryBlob();
  await withEnv(
    { PRICE_ALERT_CREATE_LIMIT: '1', PRICE_ALERT_CREATE_WINDOW_SECONDS: '60' },
    async () => {
      await consumeRateLimit(request(), 'create', { ...blob, now: 1000 });
      await consumeRateLimit(request(), 'create', { ...blob, now: 61001 });
      assert.equal(blob.objects.size, 1);
      await assert.rejects(
        consumeRateLimit(request('198.51.100.20'), 'create', {
          now: 61001,
          async get() {
            throw new Error('blob offline');
          },
          put: blob.put
        }),
        (error) =>
          error instanceof HttpError &&
          error.statusCode === 503 &&
          error.code === 'rate_limit_unavailable'
      );
    }
  );
});

test('HTTP error includes Retry-After for 429 and 503 capacity controls', () => {
  const headers = {};
  let body = '';
  const res = {
    setHeader(name, value) {
      headers[name] = value;
    },
    end(value) {
      body = value;
    }
  };
  handleHttpError(res, new HttpError(429, 'rate_limit_exceeded', 37));
  assert.equal(res.statusCode, 429);
  assert.equal(headers['Retry-After'], '37');
  assert.equal(JSON.parse(body).error, 'rate_limit_exceeded');
});

function device(overrides = {}) {
  const record = {
    version: 1,
    deviceId: 'ScaleDeviceIdentifier12345',
    updatedAt: '2026-08-26T00:00:00.000Z',
    alerts: [],
    pendingNotifications: [],
    push: { active: false, subscription: null },
    ...overrides
  };
  if (
    record.alerts.length > 0 &&
    !Object.prototype.hasOwnProperty.call(overrides, 'entitlement')
  ) {
    record.entitlement = {
      version: 1,
      grants: [
        {
          source: 'promotion',
          promotionId: 'test-lifetime',
          grantedAt: '2026-08-26T00:00:00.000Z',
          lifetime: true,
          revokedAt: null
        }
      ]
    };
  }
  return record;
}

test('record activity distinguishes hourly work from disposable empty records', () => {
  assert.equal(recordNeedsHourlyWork(device()), false);
  assert.equal(recordIsDisposable(device()), true);
  const subscribed = device({ push: { active: true, subscription: { endpoint: 'x' } } });
  assert.equal(recordNeedsHourlyWork(subscribed), false);
  assert.equal(recordIsDisposable(subscribed), false);
  const alerting = device({ alerts: [{ goodsNo: 'A000000154189', enabled: true }] });
  assert.equal(recordNeedsHourlyWork(alerting), true);
  assert.equal(recordIsDisposable(alerting), false);
});

test('active index lists only active device refs without scanning device records', async () => {
  const blob = memoryBlob();
  await syncDeviceIndexes(
    device({ alerts: [{ goodsNo: 'A000000154189', enabled: true }] }),
    blob
  );
  await syncDeviceIndexes(
    device({
      deviceId: 'SecondScaleDeviceIdentifier',
      alerts: [],
      push: { active: true, subscription: { endpoint: 'x' } }
    }),
    blob
  );
  const active = await listActiveDeviceRefs(blob);
  assert.deepEqual(active.refs.map((ref) => ref.deviceId), ['ScaleDeviceIdentifier12345']);
  assert.equal(active.unreadableCount, 0);
  assert.equal(await registeredDeviceCount(10, blob), 2);
});

test('registration reservation enforces global capacity and removes rejected slot', async () => {
  const blob = memoryBlob();
  await withEnv({ PRICE_ALERT_MAX_REGISTERED_DEVICES: '1' }, async () => {
    assert.equal((await reserveDeviceRegistration(device(), blob)).created, true);
    await assert.rejects(
      reserveDeviceRegistration(
        device({ deviceId: 'SecondScaleDeviceIdentifier' }),
        blob
      ),
      (error) =>
        error instanceof HttpError &&
        error.statusCode === 503 &&
        error.code === 'device_capacity_reached' &&
        error.retryAfter === 3600
    );
    assert.equal(await registeredDeviceCount(10, blob), 1);
  });
});

test('active reservation hard-bounds hourly devices before the first alert write', async () => {
  const blob = memoryBlob();
  await withEnv({ PRICE_ALERT_MAX_ACTIVE_DEVICES: '1' }, async () => {
    assert.equal((await reserveActiveDevice(device(), blob)).created, true);
    assert.equal((await activeDeviceCapacity(device(), blob)).available, true);
    assert.equal(
      (
        await activeDeviceCapacity(
          device({ deviceId: 'SecondScaleDeviceIdentifier' }),
          blob
        )
      ).available,
      false
    );
    await assert.rejects(
      reserveActiveDevice(device({ deviceId: 'SecondScaleDeviceIdentifier' }), blob),
      (error) =>
        error instanceof HttpError &&
        error.statusCode === 503 &&
        error.code === 'active_device_capacity_reached'
    );
    assert.equal(await activeDeviceCount(10, blob), 1);
  });
});

test('pending payment keeps its reserved active slot, expiry releases it, and PAID keeps it', async () => {
  const blob = memoryBlob();
  const pending = device({
    revision: 1,
    pendingPayment: {
      paymentId: 'oypa_1234567890abcdefghijklmnop',
      status: 'prepared',
      expiresAt: '2099-01-01T00:00:00.000Z'
    }
  });
  await withEnv({ PRICE_ALERT_MAX_ACTIVE_DEVICES: '1' }, async () => {
    await reserveActiveDevice(device({ revision: 0 }), blob);
    await syncDeviceIndexes(pending, blob);
    assert.equal(recordClaimsActiveCapacity(pending), true);
    assert.equal(await activeDeviceCount(10, blob), 1);
    assert.equal(
      await releaseActiveDeviceReservation(
        { deviceId: pending.deviceId, revision: 0 },
        blob
      ),
      false
    );
    assert.equal(await activeDeviceCount(10, blob), 1);

    const expired = device({
      revision: 1,
      pendingPayment: {
        paymentId: 'oypa_1234567890abcdefghijklmnop',
        status: 'prepared',
        expiresAt: '2020-01-01T00:00:00.000Z'
      }
    });
    await syncDeviceIndexes(expired, blob);
    assert.equal(recordClaimsActiveCapacity(expired), false);
    assert.equal(await activeDeviceCount(10, blob), 0);

    const paid = device({ revision: 2 });
    applyPaymentGrant(
      paid,
      'oypa_1234567890abcdefghijklmnop',
      '2026-08-26T00:00:00.000Z'
    );
    await reserveActiveDevice(paid, blob);
    await syncDeviceIndexes(paid, blob);
    assert.equal(recordClaimsActiveCapacity(paid), true);
    assert.equal(await activeDeviceCount(10, blob), 1);
  });
});

test('stale inactive sync cannot delete a newer active index under forced interleaving', async () => {
  const blob = memoryBlob();
  const base = device({
    revision: 0,
    alerts: [{ goodsNo: 'A000000154189', enabled: true }]
  });
  await syncDeviceIndexes(base, blob);

  const staleInactive = device({ revision: 1, alerts: [] });
  const newerActive = device({
    revision: 2,
    alerts: [{ goodsNo: 'A000000154189', enabled: true }]
  });
  const activePath = deviceIndexPath(base.deviceId, 'active');
  let interleaved = false;
  await syncDeviceIndexes(staleInactive, {
    ...blob,
    async get(pathname, options) {
      const snapshot = await blob.get(pathname, options);
      if (pathname === activePath && !interleaved) {
        interleaved = true;
        await syncDeviceIndexes(newerActive, blob);
      }
      return snapshot;
    }
  });

  const active = await listActiveDeviceRefs(blob);
  assert.equal(interleaved, true);
  assert.equal(active.refs.length, 1);
  assert.equal(active.refs[0].revision, 2);
});

test('hourly loader reads only active index refs and self-heals stale refs', async () => {
  const activeRecord = device({ alerts: [{ goodsNo: 'A000000154189', enabled: true }] });
  const inactiveRecord = device({ deviceId: 'InactiveScaleDeviceIdentifier' });
  const synced = [];
  const deleted = [];
  const reads = [];
  const result = await loadActiveDeviceEntries({
    async listActiveDeviceRefs() {
      return {
        refs: [
          { deviceId: activeRecord.deviceId },
          { deviceId: inactiveRecord.deviceId },
          { deviceId: 'MissingScaleDeviceIdentifier' }
        ],
        unreadableCount: 1
      };
    },
    async readDevice(deviceId) {
      reads.push(deviceId);
      if (deviceId === activeRecord.deviceId) return { record: activeRecord, blobs: [] };
      if (deviceId === inactiveRecord.deviceId) return { record: inactiveRecord, blobs: [] };
      return { record: null, blobs: [] };
    },
    async syncDeviceIndexes(record) {
      synced.push(record.deviceId);
    },
    async deleteDeviceIndexes(deviceId) {
      deleted.push(deviceId);
    }
  });
  assert.deepEqual(reads, [
    activeRecord.deviceId,
    inactiveRecord.deviceId,
    'MissingScaleDeviceIdentifier'
  ]);
  assert.deepEqual(result.devices.map((entry) => entry.record.deviceId), [activeRecord.deviceId]);
  assert.deepEqual(synced, [inactiveRecord.deviceId]);
  assert.deepEqual(deleted, ['MissingScaleDeviceIdentifier']);
  assert.equal(result.unreadableCount, 1);
  assert.equal(result.storageErrors, 0);
});

test('hourly TTL cleanup tombstones stale inactive devices but preserves active alerts', async () => {
  const oldEmpty = device({ updatedAt: '2026-06-01T00:00:00.000Z' });
  const oldActive = device({
    deviceId: 'ActiveScaleDeviceIdentifier',
    updatedAt: '2026-06-01T00:00:00.000Z',
    alerts: [{ goodsNo: 'A000000154189', enabled: true }]
  });
  const states = new Map([
    [oldEmpty.deviceId, oldEmpty],
    [oldActive.deviceId, oldActive]
  ]);
  const now = Date.UTC(2026, 7, 26, 10, 0, 0);
  const result = await withEnv(
    {
      PRICE_ALERT_INACTIVE_TTL_DAYS: '30',
      PRICE_ALERT_MAINTENANCE_MAX_PER_RUN: '100'
    },
    () => cleanupInactiveDevices(now, {
      async listStaleRegistryRefs() {
        return {
          refs: [{ deviceId: oldEmpty.deviceId }, { deviceId: oldActive.deviceId }],
          shard: 'a',
          unreadableCount: 0
        };
      },
      async mutateDevice(deviceId, mutation) {
        const outcome = await mutation(states.get(deviceId));
        if (outcome.changed) states.set(deviceId, outcome.record);
        return { ...outcome, value: outcome.value || {}, changed: outcome.changed };
      },
      async deleteDeviceIndexes() {}
    })
  );
  assert.equal(result.cleaned, 1);
  assert.ok(states.get(oldEmpty.deviceId).deletedAt);
  assert.equal(states.get(oldActive.deviceId).deletedAt, undefined);
});

test('failed-create registered reservation becomes maintenance-cleanable', async () => {
  const blob = memoryBlob();
  const future = Date.now() + 3 * 60 * 60 * 1000;
  const shard = maintenanceShard(future);
  let orphan;
  for (let index = 0; index < 1000; index += 1) {
    const candidate = device({ deviceId: `OrphanScaleDevice${String(index).padStart(4, '0')}` });
    if (deviceIndexPath(candidate.deviceId, 'registered').includes(`/registered/${shard}/`)) {
      orphan = candidate;
      break;
    }
  }
  assert.ok(orphan);
  await reserveDeviceRegistration(orphan, blob);
  assert.equal(await registeredDeviceCount(10, blob), 1);

  const result = await cleanupInactiveDevices(future, {
    ...blob,
    async mutateDevice(_deviceId, mutation) {
      const outcome = await mutation(null);
      return { ...outcome, value: outcome.value || {}, changed: outcome.changed };
    }
  });
  assert.equal(result.cleaned, 1);
  assert.equal(await registeredDeviceCount(10, blob), 0);
});

test('stale cleanup examines one deterministic registry shard per hourly run', async () => {
  const blob = memoryBlob();
  const now = Date.UTC(2026, 7, 26, 10, 0, 0);
  const shard = maintenanceShard(now);
  let selectedDevice = '';
  for (let index = 0; index < 1000; index += 1) {
    const candidate = `ScaleCandidateDevice${String(index).padStart(4, '0')}`;
    const probe = device({
      deviceId: candidate,
      updatedAt: '2026-06-01T00:00:00.000Z'
    });
    if (deviceIndexPath(candidate, 'registered').includes(`/registered/${shard}/`)) {
      await syncDeviceIndexes(probe, blob);
      selectedDevice = candidate;
      break;
    }
  }
  assert.ok(selectedDevice);
  const stale = await withEnv(
    { PRICE_ALERT_INACTIVE_TTL_DAYS: '30' },
    () => listStaleRegistryRefs(now, blob)
  );
  assert.equal(stale.shard, shard);
  assert.ok(stale.refs.some((ref) => ref.deviceId === selectedDevice));
  assert.equal(configuredRegistryPolicy().maxRegisteredDevices, 5000);
  assert.equal(configuredRegistryPolicy().maxActiveDevices, 20);
});
