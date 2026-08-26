const crypto = require('node:crypto');
const webPush = require('web-push');
const {
  applyPricesToDeviceRecord,
  chunk,
  normalizePriceBatchResponse,
  normalizePushSubscription,
  pendingNotifications,
  priceForAlert,
  removePendingNotifications
} = require('./_core');
const { methodNotAllowed, sendJson } = require('./_http');
const {
  configuredRegistryPolicy,
  deleteDeviceIndexes,
  listActiveDeviceRefs,
  listStaleRegistryRefs,
  recordHasRetainedEntitlement,
  recordHasStoredAlerts,
  recordIsDisposable,
  recordNeedsHourlyWork,
  syncDeviceIndexes,
  tombstoneRecord
} = require('./_registry');
const { mutateDevice, purgeTombstone, readDevice } = require('./_store');
const { serviceEntitlementActive } = require('./_entitlement');

const PRICE_BATCH_SIZE = 50;
const PRICE_BATCH_TIMEOUT_MS = Math.max(
  10000,
  Math.min(
    210000,
    Number.parseInt(process.env.PRICE_ALERT_UPSTREAM_TIMEOUT_MS || '190000', 10) || 190000
  )
);
const DEVICE_WRITE_CONCURRENCY = 10;
const DEVICE_PUSH_CONCURRENCY = 10;

function bearerToken(req) {
  const authorization = String(
    (req.headers && (req.headers.authorization || req.headers.Authorization)) || ''
  );
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

function timingSafeStringEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function requireCronAuthorization(req) {
  const expected = String(process.env.CRON_SECRET || '').trim();
  if (!expected) return { ok: false, statusCode: 503, error: 'cron_not_configured' };
  if (!timingSafeStringEqual(bearerToken(req), expected)) {
    return { ok: false, statusCode: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

function configuredPriceService() {
  const apiUrl = String(process.env.PRICE_ALERT_PRICE_API_URL || '').trim();
  const secret = String(process.env.PRICE_ALERT_SERVICE_SECRET || '').trim();
  try {
    const url = new URL(apiUrl);
    if (url.protocol !== 'https:' || !secret) return null;
    return { apiUrl: url.toString(), secret };
  } catch (_) {
    return null;
  }
}

function configureWebPush() {
  const subject = String(process.env.PRICE_ALERT_VAPID_SUBJECT || '').trim();
  const publicKey = String(process.env.PRICE_ALERT_VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(process.env.PRICE_ALERT_VAPID_PRIVATE_KEY || '').trim();
  if (
    !/^(?:mailto:|https:\/\/)/i.test(subject) ||
    !/^[A-Za-z0-9_-]{80,120}$/.test(publicKey) ||
    !/^[A-Za-z0-9_-]{30,100}$/.test(privateKey)
  ) {
    return false;
  }
  webPush.setVapidDetails(subject, publicKey, privateKey);
  return true;
}

async function fetchPriceBatch(service, goodsNos) {
  async function request(requestedGoodsNos) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PRICE_BATCH_TIMEOUT_MS);
    try {
      const response = await fetch(service.apiUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${service.secret}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ goodsNos: requestedGoodsNos })
      });
      let body = null;
      try {
        body = await response.json();
      } catch (_) {}
      return { ok: response.ok, status: Number(response.status || 0), body };
    } catch (_) {
      return { ok: false, status: 0, body: null };
    } finally {
      clearTimeout(timeout);
    }
  }

  const first = await request(goodsNos);
  if (first.ok) return normalizePriceBatchResponse(first.body, goodsNos);

  const failedGoodsNos = Array.from(
    new Set(
      (Array.isArray(first.body && first.body.failedGoodsNos)
        ? first.body.failedGoodsNos
        : []
      )
        .map((value) => String(value || '').trim().toUpperCase())
        .filter((goodsNo) => goodsNos.includes(goodsNo))
    )
  );
  if (
    first.status !== 502 ||
    failedGoodsNos.length === 0 ||
    failedGoodsNos.length >= goodsNos.length
  ) {
    return { complete: false, prices: {} };
  }

  const remainingGoodsNos = goodsNos.filter((goodsNo) => !failedGoodsNos.includes(goodsNo));
  const retry = await request(remainingGoodsNos);
  if (!retry.ok) return { complete: false, prices: {} };
  const normalized = normalizePriceBatchResponse(retry.body, remainingGoodsNos);
  if (!normalized.complete) return { complete: false, prices: {} };
  return { ...normalized, partial: true, failedGoodsNos };
}

function koreanMoney(value) {
  return Number(value || 0).toLocaleString('ko-KR') + '원';
}

function pushPayload(event) {
  const rising = event.direction === 'up';
  const titlePrefix = event.optionNumber ? '옵션 가격' : '상품 가격';
  const title = rising ? `${titlePrefix}이 올랐어요` : `${titlePrefix}이 내렸어요`;
  const transition = `${koreanMoney(event.previousPrice)} → ${koreanMoney(event.currentPrice)}`;
  const target = event.targetReached
    ? ` · 목표가 ${koreanMoney(event.targetPrice)} 도달`
    : '';
  const itemLabel = event.optionNumber && event.optionName
    ? `${event.goodsName} · ${event.optionName}`
    : event.goodsName;
  return {
    ...event,
    title,
    body: `${itemLabel}\n${transition}${target}`,
    icon: event.imageUrl || '/favicon-192x192.png',
    badge: '/favicon-48x48.png',
    actions: [{ action: 'open-product', title: '상품 보기' }]
  };
}

async function mapBounded(values, concurrency, mapper) {
  const results = [];
  for (let index = 0; index < values.length; index += concurrency) {
    const batch = values.slice(index, index + concurrency);
    results.push(...(await Promise.all(batch.map(mapper))));
  }
  return results;
}

function deviceNeedsPriceUpdate(record, validPrices) {
  return (record.alerts || []).some(
    (alert) =>
      alert &&
      alert.enabled !== false &&
      priceForAlert(alert, validPrices[alert.goodsNo]) > 0
  );
}

function collectActivePriceWork(entries) {
  const goodsSet = new Set();
  const deviceIds = [];
  let activeAlertCount = 0;
  let pendingCount = 0;
  (entries || []).forEach((entry) => {
    const record = entry && entry.record;
    if (!record) return;
    deviceIds.push(record.deviceId);
    pendingCount += pendingNotifications(record).length;
    (record.alerts || []).forEach((alert) => {
      if (!alert || alert.enabled === false || !alert.goodsNo) return;
      goodsSet.add(alert.goodsNo);
      activeAlertCount += 1;
    });
  });
  return {
    activeAlertCount,
    deviceIds,
    goodsNos: Array.from(goodsSet),
    pendingCount
  };
}

async function loadActiveDeviceEntries(dependencies) {
  const listActive =
    (dependencies && dependencies.listActiveDeviceRefs) || listActiveDeviceRefs;
  const read = (dependencies && dependencies.readDevice) || readDevice;
  const sync = (dependencies && dependencies.syncDeviceIndexes) || syncDeviceIndexes;
  const removeIndexes =
    (dependencies && dependencies.deleteDeviceIndexes) || deleteDeviceIndexes;
  const indexed = await listActive(dependencies);
  let storageErrors = 0;
  const outcomes = await mapBounded(indexed.refs || [], 20, async (ref) => {
    try {
      const loaded = await read(ref.deviceId);
      if (!loaded.record) {
        await removeIndexes(
          ref.deviceId,
          Number((loaded.tombstone && loaded.tombstone.revision) || ref.revision || 0),
          dependencies
        );
        return null;
      }
      if (!recordNeedsHourlyWork(loaded.record)) {
        let record = loaded.record;
        if (
          pendingNotifications(record).length > 0 &&
          !serviceEntitlementActive(record)
        ) {
          const cleared = await clearExpiredEntitlementOutbox(
            record.deviceId,
            dependencies
          );
          record = cleared.record || record;
        }
        await sync(record, dependencies);
        return null;
      }
      return loaded;
    } catch (_) {
      storageErrors += 1;
      return null;
    }
  });
  return {
    devices: outcomes.filter(Boolean),
    unreadableCount: Number(indexed.unreadableCount || 0),
    storageErrors
  };
}

async function clearExpiredEntitlementOutbox(deviceId, dependencies) {
  const mutate = (dependencies && dependencies.mutateDevice) || mutateDevice;
  const options = dependencies && (dependencies.readDevice || dependencies.writeDevice)
    ? {
        readDevice: dependencies.readDevice,
        writeDevice: dependencies.writeDevice,
        syncDeviceIndexes: dependencies.syncDeviceIndexes
      }
    : undefined;
  return mutate(
    deviceId,
    (record) => {
      if (
        !record ||
        serviceEntitlementActive(record) ||
        pendingNotifications(record).length === 0
      ) {
        return { changed: false, record };
      }
      const now = new Date().toISOString();
      record.pendingNotifications = [];
      record.updatedAt = now;
      return { changed: true, record, value: { cleared: true } };
    },
    options
  );
}

async function cleanupInactiveDevices(now, dependencies) {
  const timestamp = Number(now || Date.now());
  const listStale =
    (dependencies && dependencies.listStaleRegistryRefs) || listStaleRegistryRefs;
  const mutate = (dependencies && dependencies.mutateDevice) || mutateDevice;
  const removeIndexes =
    (dependencies && dependencies.deleteDeviceIndexes) || deleteDeviceIndexes;
  const purge = (dependencies && dependencies.purgeTombstone) || purgeTombstone;
  const stale = await listStale(timestamp, dependencies);
  const policy = configuredRegistryPolicy();
  const cutoff = timestamp - policy.inactiveTtlDays * 86400000;
  const refs = (stale.refs || []).slice(0, policy.maintenanceMaxPerRun);
  let cleaned = 0;
  let storageErrors = 0;

  await mapBounded(refs, 10, async (ref) => {
    try {
      if (ref.deletedAt) {
        if (await purge(ref.deviceId, ref.revision, dependencies)) cleaned += 1;
        return;
      }
      const saved = await mutate(ref.deviceId, (record) => {
        if (!record) {
          return {
            changed: false,
            record: null,
            value: { missing: true, maximumRevision: Number(ref.revision || 0) }
          };
        }
        const updatedAt = Date.parse(record.updatedAt || record.createdAt);
        if (
          recordHasStoredAlerts(record) ||
          recordHasRetainedEntitlement(record, timestamp) ||
          recordNeedsHourlyWork(record) ||
          (Number.isFinite(updatedAt) && updatedAt > cutoff)
        ) {
          return { changed: false, record, value: { missing: false } };
        }
        return {
          changed: true,
          record: tombstoneRecord(record, new Date(timestamp).toISOString()),
          value: { missing: false, cleaned: true }
        };
      });
      if (saved.value && saved.value.missing) {
        await removeIndexes(ref.deviceId, saved.value.maximumRevision, dependencies);
        cleaned += 1;
      } else if (saved.value && saved.value.cleaned) {
        cleaned += 1;
      }
    } catch (_) {
      storageErrors += 1;
    }
  });

  return {
    candidates: refs.length,
    cleaned,
    shard: stale.shard,
    unreadableCount: Number(stale.unreadableCount || 0),
    storageErrors
  };
}

async function rebaseDevicePrices(deviceId, validPrices, dependencies) {
  try {
    const mutate = (dependencies && dependencies.mutateDevice) || mutateDevice;
    const options = dependencies && (dependencies.readDevice || dependencies.writeDevice)
      ? {
          readDevice: dependencies.readDevice,
          writeDevice: dependencies.writeDevice
        }
      : undefined;
    const saved = await mutate(
      deviceId,
      (record) => {
        if (!record) return { changed: false, record: null, value: { stateUpdates: 0 } };
        const evaluation = applyPricesToDeviceRecord(
          record,
          validPrices,
          new Date().toISOString()
        );
        return {
          changed: evaluation.changed,
          record: evaluation.record,
          value: {
            stateUpdates: evaluation.stateUpdates,
            queuedNotifications: evaluation.queuedNotifications
          }
        };
      },
      options
    );
    return {
      changed: saved.changed,
      storageError: false,
      stateUpdates: Number(saved.value && saved.value.stateUpdates) || 0,
      queuedNotifications: Number(saved.value && saved.value.queuedNotifications) || 0
    };
  } catch (_) {
    return { changed: false, storageError: true, stateUpdates: 0 };
  }
}

async function persistPushOutcome(
  deviceId,
  attemptedEndpoint,
  deliveredEventKeys,
  deactivate,
  dependencies
) {
  if (!deliveredEventKeys.length && !deactivate) return { changed: false, storageError: false };
  try {
    const mutate = (dependencies && dependencies.mutateDevice) || mutateDevice;
    const options = dependencies && (dependencies.readDevice || dependencies.writeDevice)
      ? {
          readDevice: dependencies.readDevice,
          writeDevice: dependencies.writeDevice
        }
      : undefined;
    const saved = await mutate(
      deviceId,
      (record) => {
        if (!record) return { changed: false, record: null };
        const now = new Date().toISOString();
        let changed = removePendingNotifications(record, deliveredEventKeys);
        const currentSubscription = normalizePushSubscription(
          record.push && record.push.subscription
        );
        if (
          deactivate &&
          currentSubscription &&
          currentSubscription.endpoint === attemptedEndpoint
        ) {
          record.push = { active: false, subscription: null, updatedAt: now };
          changed = true;
        }
        if (changed) record.updatedAt = now;
        return {
          changed,
          record: changed && recordIsDisposable(record) ? tombstoneRecord(record, now) : record
        };
      },
      options
    );
    return { changed: saved.changed, storageError: false };
  } catch (_) {
    return { changed: false, storageError: true };
  }
}

async function deliverPendingForDevice(deviceId, dependencies) {
  let loaded;
  try {
    const read = (dependencies && dependencies.readDevice) || readDevice;
    loaded = await read(deviceId);
  } catch (_) {
    return { sent: 0, deactivated: 0, errors: 0, storageErrors: 1 };
  }
  if (!loaded.record) return { sent: 0, deactivated: 0, errors: 0, storageErrors: 0 };
  if (!recordNeedsHourlyWork(loaded.record)) {
    return { sent: 0, deactivated: 0, errors: 0, storageErrors: 0 };
  }
  const subscription = normalizePushSubscription(
    loaded.record.push && loaded.record.push.subscription
  );
  const events = pendingNotifications(loaded.record);
  if (!events.length || !loaded.record.push || !loaded.record.push.active || !subscription) {
    return { sent: 0, deactivated: 0, errors: 0, storageErrors: 0 };
  }

  const deliveredEventKeys = [];
  let sent = 0;
  let errors = 0;
  let deactivate = false;
  const sendNotification =
    (dependencies && dependencies.sendNotification) || webPush.sendNotification.bind(webPush);
  for (const event of events) {
    try {
      await sendNotification(subscription, JSON.stringify(pushPayload(event)), {
        TTL: 60 * 60,
        urgency: 'normal',
        topic: event.eventKey
      });
      deliveredEventKeys.push(event.eventKey);
      sent += 1;
    } catch (error) {
      const statusCode = Number(error && error.statusCode);
      if (statusCode === 404 || statusCode === 410) {
        deliveredEventKeys.push(event.eventKey);
        deactivate = true;
      } else {
        errors += 1;
      }
      break;
    }
  }

  const persisted = await persistPushOutcome(
    deviceId,
    subscription.endpoint,
    deliveredEventKeys,
    deactivate,
    dependencies
  );
  return {
    sent,
    deactivated: deactivate && !persisted.storageError ? 1 : 0,
    errors,
    storageErrors: persisted.storageError ? 1 : 0
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(res, ['GET', 'POST']);
  }
  const auth = requireCronAuthorization(req);
  if (!auth.ok) return sendJson(res, auth.statusCode, { success: false, error: auth.error });

  try {
    const loaded = await loadActiveDeviceEntries();
    const entries = loaded.devices;
    const work = collectActivePriceWork(entries);
    const { activeAlertCount, deviceIds, goodsNos, pendingCount } = work;

    if (!activeAlertCount && !pendingCount) {
      const maintenance = await cleanupInactiveDevices(Date.now());
      return sendJson(res, 200, {
        success: true,
        devices: entries.length,
        alerts: 0,
        pending: 0,
        uniqueGoods: 0,
        unreadableDevices: loaded.unreadableCount,
        indexStorageErrors: loaded.storageErrors,
        cleanupCandidates: maintenance.candidates,
        cleanedDevices: maintenance.cleaned,
        cleanupStorageErrors: maintenance.storageErrors
      });
    }
    if (!configureWebPush()) {
      return sendJson(res, 503, { success: false, error: 'push_not_configured' });
    }

    const service = activeAlertCount ? configuredPriceService() : null;
    const batches = chunk(goodsNos, PRICE_BATCH_SIZE);
    const validPrices = {};
    let validBatches = 0;
    let invalidBatches = 0;
    let partialBatches = 0;

    if (activeAlertCount && service) {
      for (const goodsBatch of batches) {
        const result = await fetchPriceBatch(service, goodsBatch);
        if (!result.complete) {
          invalidBatches += 1;
          continue;
        }
        validBatches += 1;
        if (result.partial) partialBatches += 1;
        Object.assign(validPrices, result.prices);
      }
    } else if (activeAlertCount) {
      invalidBatches = batches.length;
    }

    const devicesToRebase = entries
      .filter((entry) => deviceNeedsPriceUpdate(entry.record, validPrices))
      .map((entry) => entry.record.deviceId);
    const rebaseResults = await mapBounded(
      devicesToRebase,
      DEVICE_WRITE_CONCURRENCY,
      (deviceId) => rebaseDevicePrices(deviceId, validPrices)
    );
    const updatedDevices = rebaseResults.filter((result) => result.changed).length;
    const stateUpdates = rebaseResults.reduce(
      (sum, result) => sum + Number(result.stateUpdates || 0),
      0
    );
    let storageErrors =
      rebaseResults.filter((result) => result.storageError).length + loaded.storageErrors;

    const pushResults = await mapBounded(
      deviceIds,
      DEVICE_PUSH_CONCURRENCY,
      deliverPendingForDevice
    );
    const notificationsSent = pushResults.reduce((sum, result) => sum + result.sent, 0);
    const pushDeactivated = pushResults.reduce((sum, result) => sum + result.deactivated, 0);
    const pushErrors = pushResults.reduce((sum, result) => sum + result.errors, 0);
    storageErrors += pushResults.reduce((sum, result) => sum + result.storageErrors, 0);
    const maintenance = await cleanupInactiveDevices(Date.now());
    storageErrors += maintenance.storageErrors;

    const stats = {
      devices: entries.length,
      alerts: activeAlertCount,
      pendingAtStart: pendingCount,
      uniqueGoods: goodsNos.length,
      batches: batches.length,
      validBatches,
      invalidBatches,
      partialBatches,
      updatedDevices,
      stateUpdates,
      notificationsSent,
      pushDeactivated,
      pushErrors,
      storageErrors,
      unreadableDevices: loaded.unreadableCount + maintenance.unreadableCount,
      cleanupCandidates: maintenance.candidates,
      cleanedDevices: maintenance.cleaned,
      cleanupShard: maintenance.shard,
      cleanupStorageErrors: maintenance.storageErrors
    };

    if (activeAlertCount && (!service || !validBatches)) {
      return sendJson(res, 503, {
        success: false,
        error: service ? 'price_upstream_unavailable' : 'price_service_not_configured',
        ...stats
      });
    }
    return sendJson(res, 200, {
      success: true,
      partial:
        partialBatches > 0 || invalidBatches > 0 || storageErrors > 0 || pushErrors > 0,
      ...stats
    });
  } catch (_) {
    return sendJson(res, 500, { success: false, error: 'price_alert_cron_failed' });
  }
};

module.exports._test = {
  clearExpiredEntitlementOutbox,
  cleanupInactiveDevices,
  collectActivePriceWork,
  configuredPriceService,
  deliverPendingForDevice,
  fetchPriceBatch,
  mapBounded,
  loadActiveDeviceEntries,
  persistPushOutcome,
  pushPayload,
  requireCronAuthorization
};
