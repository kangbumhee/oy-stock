const {
  BlobPreconditionFailedError,
  del,
  get,
  list,
  put
} = require('@vercel/blob');
const {
  configuredDataKey,
  decryptJson,
  devicePathHash,
  encryptJson
} = require('./_crypto');
const { pendingNotifications } = require('./_core');
const {
  entitlementFeatureEnabled,
  entitlementGrants,
  pendingPaymentActive,
  pendingPaymentClaimsActiveCapacity,
  publicEntitlement
} = require('./_entitlement');
const { HttpError } = require('./_http');

const STORE_ROOT = 'oliveyoung/price-alerts/v1/';
const INDEX_VERSION = 1;
const INDEX_SHARD_COUNT = 16;
const RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function normalizeStoreNamespace(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 48);
  return normalized || 'production';
}

function configuredStoreRoot() {
  const namespace =
    String(process.env.PRICE_ALERT_STORE_NAMESPACE || '').trim() ||
    String(process.env.VERCEL_ENV || '').trim() ||
    'production';
  return `${STORE_ROOT}${normalizeStoreNamespace(namespace)}/`;
}

function configuredRegistryPolicy() {
  return {
    maxRegisteredDevices: boundedInteger(
      process.env.PRICE_ALERT_MAX_REGISTERED_DEVICES,
      5000,
      1,
      100000
    ),
    maxActiveDevices: boundedInteger(
      process.env.PRICE_ALERT_MAX_ACTIVE_DEVICES,
      20,
      1,
      5000
    ),
    inactiveTtlDays: boundedInteger(
      process.env.PRICE_ALERT_INACTIVE_TTL_DAYS,
      30,
      7,
      365
    ),
    maintenanceMaxPerRun: boundedInteger(
      process.env.PRICE_ALERT_MAINTENANCE_MAX_PER_RUN,
      100,
      1,
      1000
    ),
    tombstoneTtlHours: boundedInteger(
      process.env.PRICE_ALERT_TOMBSTONE_TTL_HOURS,
      24,
      1,
      168
    )
  };
}

function deviceIndexPath(deviceId, kind, key) {
  const hash = devicePathHash(deviceId, key || configuredDataKey());
  return `${configuredStoreRoot()}indexes/${kind}/${hash[0]}/${hash}.idx`;
}

function recordNeedsHourlyWork(record) {
  if (!entitlementFeatureEnabled() || !publicEntitlement(record).active) return false;
  const activeAlerts = (Array.isArray(record && record.alerts) ? record.alerts : []).some(
    (alert) => alert && alert.enabled !== false && alert.goodsNo
  );
  return activeAlerts || pendingNotifications(record).length > 0;
}

function recordClaimsActiveCapacity(record, now) {
  if (!entitlementFeatureEnabled()) return false;
  const timestamp = Number(now || Date.now());
  return (
    publicEntitlement(record, timestamp).active ||
    pendingPaymentClaimsActiveCapacity(record && record.pendingPayment, timestamp)
  );
}

function recordHasStoredAlerts(record) {
  return (Array.isArray(record && record.alerts) ? record.alerts : []).some(
    (alert) => alert && alert.goodsNo
  );
}

function recordHasRetainedEntitlement(record, now) {
  return (
    publicEntitlement(record, Number(now || Date.now())).active ||
    pendingPaymentActive(record && record.pendingPayment, Number(now || Date.now()))
  );
}

function recordIsDisposable(record) {
  const hasAlerts = (Array.isArray(record && record.alerts) ? record.alerts : []).some(
    (alert) => alert && alert.enabled !== false && alert.goodsNo
  );
  const subscribed = Boolean(
    record && record.push && record.push.active && record.push.subscription
  );
  const hasEntitlementHistory = entitlementGrants(record).length > 0;
  const hasPendingPayment = Boolean(record && record.pendingPayment);
  return (
    !hasAlerts &&
    !subscribed &&
    !hasEntitlementHistory &&
    !hasPendingPayment &&
    pendingNotifications(record).length === 0
  );
}

function encryptedIndexBody(record, kind, now, extra) {
  return encryptJson(
    {
      version: INDEX_VERSION,
      kind,
      deviceId: record.deviceId,
      updatedAt: record.updatedAt || now || new Date().toISOString(),
      revision: Math.max(0, Number(record.revision || 0)),
      ...(record.deletedAt ? { deletedAt: record.deletedAt } : {}),
      ...(extra || {})
    },
    configuredDataKey()
  );
}

function isConflict(error) {
  return (
    error instanceof BlobPreconditionFailedError ||
    [409, 412].includes(Number(error && (error.status || error.statusCode)))
  );
}

async function streamText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function readIndexPath(pathname, dependencies) {
  const read = (dependencies && dependencies.get) || get;
  const result = await read(pathname, {
    access: 'public',
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
  });
  if (!result) return null;
  const entry = decryptJson(await streamText(result.stream), configuredDataKey());
  if (
    !entry ||
    entry.version !== INDEX_VERSION ||
    !['active', 'registered'].includes(entry.kind) ||
    !entry.deviceId
  ) {
    throw new Error('invalid price alert index');
  }
  const etag = String((result.blob && result.blob.etag) || '');
  if (!etag) throw new Error('price alert index ETag missing');
  return { entry, etag };
}

async function putIndex(record, kind, dependencies, extra) {
  const write = (dependencies && dependencies.put) || put;
  const pathname = deviceIndexPath(record.deviceId, kind);
  const desiredRevision = Math.max(0, Number(record.revision || 0));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readIndexPath(pathname, dependencies);
    if (current && Number(current.entry.revision || 0) > desiredRevision) {
      return { skipped: true };
    }
    try {
      const body = encryptedIndexBody(record, kind, null, extra);
      return await write(pathname, body, {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: Boolean(current),
        ...(current && current.etag ? { ifMatch: current.etag } : {}),
        contentType: 'application/octet-stream',
        cacheControlMaxAge: 60
      });
    } catch (error) {
      if (isConflict(error) && attempt < 4) continue;
      throw error;
    }
  }
  throw new Error('price alert index write conflict');
}

async function deleteIndexUpTo(pathname, maximumRevision, dependencies) {
  const remove = (dependencies && dependencies.del) || del;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readIndexPath(pathname, dependencies);
    if (!current || Number(current.entry.revision || 0) > Number(maximumRevision || 0)) {
      return false;
    }
    try {
      await remove(pathname, current.etag ? { ifMatch: current.etag } : undefined);
      return true;
    } catch (error) {
      if (isConflict(error) && attempt < 4) continue;
      throw error;
    }
  }
  return false;
}

async function syncDeviceIndexes(record, dependencies) {
  if (record && record.deletedAt) {
    await putIndex(record, 'registered', dependencies);
    await deleteIndexUpTo(
      deviceIndexPath(record.deviceId, 'active'),
      record.revision,
      dependencies
    );
    return;
  }
  await putIndex(record, 'registered', dependencies);
  const activePath = deviceIndexPath(record.deviceId, 'active');
  if (recordClaimsActiveCapacity(record)) {
    await putIndex(record, 'active', dependencies);
  } else {
    await deleteIndexUpTo(activePath, record.revision, dependencies);
  }
}

async function deleteDeviceIndexes(deviceId, maximumRevision, dependencies) {
  await Promise.all([
    deleteIndexUpTo(deviceIndexPath(deviceId, 'registered'), maximumRevision, dependencies),
    deleteIndexUpTo(deviceIndexPath(deviceId, 'active'), maximumRevision, dependencies)
  ]);
}

async function listAll(prefix, options, dependencies) {
  const readList = (dependencies && dependencies.list) || list;
  const blobs = [];
  let cursor;
  const stopAfter = Number(options && options.stopAfter) || Number.POSITIVE_INFINITY;
  do {
    const page = await readList({ prefix, cursor, limit: Math.min(1000, stopAfter - blobs.length) });
    blobs.push(...((page && page.blobs) || []));
    if (blobs.length >= stopAfter) break;
    cursor = page && page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function readIndex(blob, dependencies) {
  const current = await readIndexPath(blob.pathname, dependencies);
  return current && current.entry;
}

async function listActiveDeviceRefs(dependencies) {
  const blobs = await listAll(`${configuredStoreRoot()}indexes/active/`, null, dependencies);
  const refs = [];
  let unreadableCount = 0;
  for (let index = 0; index < blobs.length; index += 20) {
    const entries = await Promise.all(
      blobs.slice(index, index + 20).map((blob) => readIndex(blob, dependencies).catch(() => null))
    );
    entries.forEach((entry) => {
      if (entry && entry.kind === 'active') refs.push(entry);
      else unreadableCount += 1;
    });
  }
  return { refs, unreadableCount };
}

async function registeredDeviceCount(stopAfter, dependencies) {
  const blobs = await listAll(
    `${configuredStoreRoot()}indexes/registered/`,
    { stopAfter: stopAfter || configuredRegistryPolicy().maxRegisteredDevices + 1 },
    dependencies
  );
  return blobs.length;
}

async function activeDeviceCount(stopAfter, dependencies) {
  const blobs = await listAll(
    `${configuredStoreRoot()}indexes/active/`,
    { stopAfter: stopAfter || configuredRegistryPolicy().maxActiveDevices + 1 },
    dependencies
  );
  return blobs.length;
}

async function activeDeviceCapacity(record, dependencies) {
  const policy = configuredRegistryPolicy();
  if (!record || !record.deviceId) {
    throw new HttpError(503, 'device_registry_unavailable', 60);
  }
  try {
    const existing = await readIndexPath(
      deviceIndexPath(record.deviceId, 'active'),
      dependencies
    );
    if (existing) {
      return { available: true, existing: true, maximum: policy.maxActiveDevices };
    }
    const count = await activeDeviceCount(policy.maxActiveDevices, dependencies);
    return {
      available: count < policy.maxActiveDevices,
      existing: false,
      count,
      maximum: policy.maxActiveDevices
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'device_registry_unavailable', 60);
  }
}

async function requireActiveDeviceCapacity(record, dependencies) {
  const capacity = await activeDeviceCapacity(record, dependencies);
  if (!capacity.available) {
    throw new HttpError(503, 'active_device_capacity_reached', 3600);
  }
  return capacity;
}

async function releaseActiveDeviceReservation(record, dependencies) {
  if (!record || !record.deviceId) return false;
  return deleteIndexUpTo(
    deviceIndexPath(record.deviceId, 'active'),
    Math.max(0, Number(record.revision || 0)),
    dependencies
  );
}

async function reserveIndexSlot(record, kind, maximum, capacityError, dependencies) {
  const pathname = deviceIndexPath(record.deviceId, kind);
  const existing = await readIndexPath(pathname, dependencies);
  if (existing) return { created: false };
  try {
    const write = (dependencies && dependencies.put) || put;
    await write(
      pathname,
      encryptJson(
        {
          version: INDEX_VERSION,
          kind,
          deviceId: record.deviceId,
          updatedAt: new Date().toISOString(),
          revision: Math.max(0, Number(record.revision || 0)),
          reservedAt: new Date().toISOString()
        },
        configuredDataKey()
      ),
      {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: 'application/octet-stream',
        cacheControlMaxAge: 60
      }
    );
  } catch (error) {
    if (isConflict(error)) return { created: false };
    throw new HttpError(503, 'device_registry_unavailable', 60);
  }

  try {
    const count = kind === 'active'
      ? await activeDeviceCount(maximum + 1, dependencies)
      : await registeredDeviceCount(maximum + 1, dependencies);
    if (count > maximum) {
      await deleteIndexUpTo(pathname, record.revision, dependencies);
      throw new HttpError(503, capacityError, 3600);
    }
    return { created: true, count };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    await deleteIndexUpTo(pathname, record.revision, dependencies).catch(() => {});
    throw new HttpError(503, 'device_registry_unavailable', 60);
  }
}

async function reserveDeviceRegistration(record, dependencies) {
  const policy = configuredRegistryPolicy();
  return reserveIndexSlot(
    record,
    'registered',
    policy.maxRegisteredDevices,
    'device_capacity_reached',
    dependencies
  );
}

async function reserveActiveDevice(record, dependencies) {
  const policy = configuredRegistryPolicy();
  return reserveIndexSlot(
    record,
    'active',
    policy.maxActiveDevices,
    'active_device_capacity_reached',
    dependencies
  );
}

function tombstoneRecord(record, now) {
  const timestamp = now || new Date().toISOString();
  return {
    version: 1,
    deviceId: record.deviceId,
    secretHash: '',
    createdAt: record.createdAt || timestamp,
    updatedAt: timestamp,
    deletedAt: timestamp,
    push: { active: false, subscription: null, updatedAt: timestamp },
    alerts: [],
    pendingNotifications: []
  };
}

function maintenanceShard(now) {
  const hours = Math.floor(Number(now || Date.now()) / (60 * 60 * 1000));
  return (hours % INDEX_SHARD_COUNT).toString(16);
}

async function listStaleRegistryRefs(now, dependencies) {
  const timestamp = Number(now || Date.now());
  const shard = maintenanceShard(timestamp);
  const blobs = await listAll(
    `${configuredStoreRoot()}indexes/registered/${shard}/`,
    null,
    dependencies
  );
  const cutoff = timestamp - configuredRegistryPolicy().inactiveTtlDays * 86400000;
  const refs = [];
  let unreadableCount = 0;
  for (let index = 0; index < blobs.length; index += 20) {
    const entries = await Promise.all(
      blobs.slice(index, index + 20).map((blob) => readIndex(blob, dependencies).catch(() => null))
    );
    entries.forEach((entry) => {
      const updatedAt = Date.parse(entry && entry.updatedAt);
      if (!entry) unreadableCount += 1;
      else {
        const reservedAt = Date.parse(entry.reservedAt);
        const deletedAt = Date.parse(entry.deletedAt);
        const tombstoneCutoff =
          timestamp - configuredRegistryPolicy().tombstoneTtlHours * 3600000;
        if (
          (Number.isFinite(reservedAt) && reservedAt <= timestamp - RESERVATION_TTL_MS) ||
          (Number.isFinite(deletedAt) && deletedAt <= tombstoneCutoff) ||
          (!Number.isFinite(updatedAt) || updatedAt <= cutoff)
        ) {
          refs.push(entry);
        }
      }
    });
  }
  return { refs, shard, unreadableCount };
}

module.exports = {
  activeDeviceCapacity,
  activeDeviceCount,
  configuredRegistryPolicy,
  configuredStoreRoot,
  deleteDeviceIndexes,
  deviceIndexPath,
  listActiveDeviceRefs,
  listStaleRegistryRefs,
  maintenanceShard,
  normalizeStoreNamespace,
  recordIsDisposable,
  recordHasStoredAlerts,
  recordHasRetainedEntitlement,
  recordNeedsHourlyWork,
  recordClaimsActiveCapacity,
  registeredDeviceCount,
  releaseActiveDeviceReservation,
  requireActiveDeviceCapacity,
  reserveActiveDevice,
  reserveDeviceRegistration,
  tombstoneRecord,
  syncDeviceIndexes
};
