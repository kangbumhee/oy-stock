const {
  BlobPreconditionFailedError,
  BlobUnknownError,
  del,
  list,
  put
} = require('@vercel/blob');
const { configuredDataKey, decryptJson, devicePathHash, encryptJson } = require('./_crypto');
const { deleteDeviceIndexes, syncDeviceIndexes } = require('./_registry');

const STORE_ROOT = 'oliveyoung/price-alerts/v1/';
const MAX_MUTATION_ATTEMPTS = 8;

class DeviceWriteConflictError extends Error {
  constructor() {
    super('price alert device write conflict');
    this.name = 'DeviceWriteConflictError';
  }
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

function configuredDeviceRoot() {
  const namespace =
    String(process.env.PRICE_ALERT_STORE_NAMESPACE || '').trim() ||
    String(process.env.VERCEL_ENV || '').trim() ||
    'production';
  return `${STORE_ROOT}${normalizeStoreNamespace(namespace)}/devices/`;
}

async function listAll(prefix) {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    blobs.push(...((page && page.blobs) || []));
    cursor = page && page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

function blobTimestamp(blob) {
  const uploaded = Date.parse(blob && blob.uploadedAt);
  if (Number.isFinite(uploaded)) return uploaded;
  const match = String((blob && blob.pathname) || '').match(/\/(\d{13})-/);
  return match ? Number(match[1]) : 0;
}

function latestBlob(blobs) {
  return (blobs || []).slice().sort((a, b) => {
    const timestampDifference = blobTimestamp(b) - blobTimestamp(a);
    if (timestampDifference) return timestampDifference;
    return String(b.pathname || '').localeCompare(String(a.pathname || ''));
  })[0];
}

function authoritativeBlob(blobs, prefix) {
  return (blobs || []).find((blob) => blob && blob.pathname === `${prefix}device.enc`) ||
    latestBlob(blobs);
}

async function fetchBlobText(blob) {
  const sourceUrl = blob && (blob.downloadUrl || blob.url);
  if (!sourceUrl) throw new Error('price alert blob URL missing');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const separator = sourceUrl.includes('?') ? '&' : '?';
    const response = await fetch(
      `${sourceUrl}${separator}version=${encodeURIComponent(String(blob.etag || blob.uploadedAt || ''))}`,
      {
        signal: controller.signal,
        cache: 'no-store',
        headers: { Accept: 'application/octet-stream' }
      }
    );
    if (!response.ok) throw new Error('price alert blob read failed');
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function devicePrefix(deviceId, key) {
  return `${configuredDeviceRoot()}${devicePathHash(deviceId, key)}/`;
}

function validDeviceRecord(record, deviceId) {
  return Boolean(
    record &&
      record.version === 1 &&
      record.deviceId &&
      (!deviceId || record.deviceId === deviceId) &&
      Array.isArray(record.alerts)
  );
}

async function readDevice(deviceId) {
  const key = configuredDataKey();
  const prefix = devicePrefix(deviceId, key);
  const blobs = await listAll(prefix);
  const blob = authoritativeBlob(blobs, prefix);
  if (!blob) return { record: null, blobs: [], prefix, blob: null };
  const record = decryptJson(await fetchBlobText(blob), key);
  if (!validDeviceRecord(record, deviceId)) {
    throw new Error('invalid price alert device record');
  }
  if (record.deletedAt) return { record: null, blobs, prefix, blob, tombstone: record };
  return { record, blobs, prefix, blob };
}

function isBlobConflict(error) {
  return (
    error instanceof BlobPreconditionFailedError ||
    /precondition|etag mismatch|already exists|overwrite/i.test(String(error && error.message))
  );
}

async function writeDevice(record, previousBlobs) {
  const key = configuredDataKey();
  const prefix = devicePrefix(record.deviceId, key);
  const pathname = `${prefix}device.enc`;
  const previous = authoritativeBlob(previousBlobs, prefix);
  const previousIsCurrent = previous && previous.pathname === pathname;
  if (previousIsCurrent && !previous.etag) {
    throw new Error('price alert blob ETag missing');
  }
  const options = {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: Boolean(previousIsCurrent),
    contentType: 'application/octet-stream',
    cacheControlMaxAge: 60
  };
  if (previousIsCurrent && previous.etag) options.ifMatch = previous.etag;

  try {
    return await put(pathname, encryptJson(record, key), options);
  } catch (error) {
    if (isBlobConflict(error) || (!previousIsCurrent && error instanceof BlobUnknownError)) {
      throw new DeviceWriteConflictError();
    }
    throw error;
  }
}

function cloneRecord(record) {
  return record == null ? null : JSON.parse(JSON.stringify(record));
}

async function mutateDevice(deviceId, mutation, options) {
  const read = (options && options.readDevice) || readDevice;
  const write = (options && options.writeDevice) || writeDevice;
  const maxAttempts = Math.max(
    1,
    Math.min(20, Number((options && options.maxAttempts) || MAX_MUTATION_ATTEMPTS))
  );
  const syncIndexes = options && options.writeDevice
    ? (options.syncDeviceIndexes || (async () => {}))
    : ((options && options.syncDeviceIndexes) || syncDeviceIndexes);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const loaded = await read(deviceId);
    const outcome = (await mutation(cloneRecord(loaded.record), {
      attempt,
      exists: Boolean(loaded.record)
    })) || { changed: false, record: loaded.record };
    const nextRecord = outcome.record === undefined ? loaded.record : outcome.record;
    if (!outcome.changed) {
      return { ...outcome, record: nextRecord, attempts: attempt, written: false };
    }
    if (!validDeviceRecord(nextRecord, deviceId)) {
      throw new Error('invalid price alert device mutation');
    }
    const previousRevision = Math.max(
      0,
      Number(
        (loaded.record && loaded.record.revision) ||
          (loaded.tombstone && loaded.tombstone.revision) ||
          0
      )
    );
    nextRecord.revision = previousRevision + 1;
    try {
      const blob = await write(nextRecord, loaded.blobs || []);
      await syncIndexes(nextRecord);
      return { ...outcome, record: nextRecord, blob, attempts: attempt, written: true };
    } catch (error) {
      if (!(error instanceof DeviceWriteConflictError) || attempt === maxAttempts) throw error;
    }
  }
  throw new DeviceWriteConflictError();
}

async function purgeTombstone(deviceId, maximumRevision, options) {
  const read = (options && options.readDevice) || readDevice;
  const remove = (options && options.del) || del;
  const removeIndexes =
    (options && options.deleteDeviceIndexes) || deleteDeviceIndexes;
  const loaded = await read(deviceId);
  const tombstone = loaded.tombstone;
  const revision = Number(tombstone && tombstone.revision) || 0;
  if (
    !tombstone ||
    !loaded.blob ||
    !loaded.blob.etag ||
    revision > Number(maximumRevision || 0)
  ) {
    return false;
  }
  await removeIndexes(deviceId, revision, options);
  try {
    await remove(loaded.blob.pathname, { ifMatch: loaded.blob.etag });
  } catch (error) {
    if (isBlobConflict(error)) return false;
    await syncDeviceIndexes(tombstone, options).catch(() => {});
    throw error;
  }
  return true;
}

function deviceHashFromPath(pathname, deviceRoot) {
  const raw = String(pathname || '');
  if (!raw.startsWith(deviceRoot)) return '';
  const suffix = raw.slice(deviceRoot.length);
  const hash = suffix.split('/')[0];
  return /^[a-f0-9]{64}$/.test(hash) ? hash : '';
}

async function listLatestDevices() {
  const key = configuredDataKey();
  const deviceRoot = configuredDeviceRoot();
  const allBlobs = await listAll(deviceRoot);
  const grouped = new Map();
  allBlobs.forEach((blob) => {
    const hash = deviceHashFromPath(blob.pathname, deviceRoot);
    if (!hash) return;
    const rows = grouped.get(hash) || [];
    rows.push(blob);
    grouped.set(hash, rows);
  });

  const devices = [];
  let unreadableCount = 0;
  const groups = Array.from(grouped.values());
  for (let index = 0; index < groups.length; index += 20) {
    const outcomes = await Promise.all(
      groups.slice(index, index + 20).map(async (blobs) => {
        try {
          const first = blobs[0];
          const prefix = String(first.pathname || '').slice(
            0,
            String(first.pathname || '').lastIndexOf('/') + 1
          );
          const blob = authoritativeBlob(blobs, prefix);
          const record = decryptJson(await fetchBlobText(blob), key);
          if (!validDeviceRecord(record) || record.deletedAt) return null;
          return { record, blobs, blob };
        } catch (_) {
          return null;
        }
      })
    );
    outcomes.forEach((outcome) => {
      if (outcome) devices.push(outcome);
      else unreadableCount += 1;
    });
  }
  return { devices, unreadableCount };
}

module.exports = {
  DeviceWriteConflictError,
  configuredDeviceRoot,
  listLatestDevices,
  mutateDevice,
  normalizeStoreNamespace,
  purgeTombstone,
  readDevice,
  writeDevice
};
