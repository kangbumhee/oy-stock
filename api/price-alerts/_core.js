const crypto = require('node:crypto');
const net = require('node:net');

const MAX_ALERTS_PER_DEVICE = 10;
const MAX_PENDING_NOTIFICATIONS = 50;
const CHECK_INTERVAL_MINUTES = 60;

function normalizeDeviceId(value) {
  const raw = String(value || '').trim();
  return /^[A-Za-z0-9_-]{16,80}$/.test(raw) ? raw : '';
}

function normalizeDeviceSecret(value) {
  const raw = String(value || '').trim();
  return /^[A-Za-z0-9_-]{32,128}$/.test(raw) ? raw : '';
}

function normalizeGoodsNo(value) {
  const raw = String(value || '').trim().toUpperCase();
  return /^[AB]\d{6,20}$/.test(raw) ? raw : '';
}

function normalizeOptionNumber(value) {
  const raw = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(raw) ? raw : '';
}

function normalizeLegacyItemNumber(value) {
  if (value == null || value === '') return '';
  return normalizeOptionNumber(value);
}

function alertIdFor(goodsNo, optionNumber) {
  const normalizedGoodsNo = normalizeGoodsNo(goodsNo);
  if (!normalizedGoodsNo) return '';
  const rawOptionNumber = String(optionNumber == null ? '' : optionNumber).trim();
  if (!rawOptionNumber) return normalizedGoodsNo;
  const normalizedOptionNumber = normalizeOptionNumber(rawOptionNumber);
  return normalizedOptionNumber
    ? `${normalizedGoodsNo}::${normalizedOptionNumber}`
    : '';
}

function alertIdFrom(value) {
  if (!value) return '';
  return alertIdFor(value.goodsNo, value.optionNumber);
}

function cleanText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cleanImageUrl(value) {
  const raw = String(value || '').trim().slice(0, 1200);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch (_) {
    return '';
  }
}

function parseMoney(value) {
  if (value == null || value === '') return 0;
  const normalized = typeof value === 'string' ? value.replace(/[^\d.-]/g, '') : value;
  const number = Number(normalized);
  if (!Number.isFinite(number) || number <= 0 || number > 100000000) return 0;
  return Math.round(number);
}

function hashDeviceSecret(deviceId, deviceSecret) {
  const id = normalizeDeviceId(deviceId);
  const secret = normalizeDeviceSecret(deviceSecret);
  if (!id || !secret) return '';
  return crypto.scryptSync(secret, `oliveyoung-price-alert:${id}`, 32).toString('base64url');
}

function verifyDeviceSecret(deviceId, deviceSecret, expectedHash) {
  const actual = hashDeviceSecret(deviceId, deviceSecret);
  const expected = String(expectedHash || '');
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function normalizePushSubscription(value) {
  const source = value && value.subscription ? value.subscription : value;
  const endpoint = String((source && source.endpoint) || '').trim();
  const expirationTime = source && source.expirationTime != null ? Number(source.expirationTime) : null;
  const keys = (source && source.keys) || {};
  const p256dh = String(keys.p256dh || '').trim();
  const auth = String(keys.auth || '').trim();

  if (!endpoint || endpoint.length > 2048) return null;
  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch (_) {
    return null;
  }
  const hostname = endpointUrl.hostname.toLowerCase();
  const allowedHost =
    hostname === 'fcm.googleapis.com' ||
    hostname === 'android.googleapis.com' ||
    hostname === 'updates.push.services.mozilla.com' ||
    hostname === 'web.push.apple.com' ||
    /^[a-z0-9-]+\.notify\.windows\.com$/.test(hostname);
  if (
    endpointUrl.protocol !== 'https:' ||
    endpointUrl.username ||
    endpointUrl.password ||
    (endpointUrl.port && endpointUrl.port !== '443') ||
    !hostname ||
    hostname === 'localhost' ||
    net.isIP(hostname) !== 0 ||
    !allowedHost
  ) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{40,160}$/.test(p256dh)) return null;
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(auth)) return null;
  if (expirationTime != null && (!Number.isFinite(expirationTime) || expirationTime < 0)) return null;

  return { endpoint: endpointUrl.toString(), expirationTime, keys: { p256dh, auth } };
}

function createDeviceRecord(deviceId, deviceSecret, now) {
  const id = normalizeDeviceId(deviceId);
  const secretHash = hashDeviceSecret(id, deviceSecret);
  if (!id || !secretHash) throw new Error('invalid device credentials');
  const timestamp = now || new Date().toISOString();
  return {
    version: 1,
    deviceId: id,
    secretHash,
    createdAt: timestamp,
    updatedAt: timestamp,
    push: { active: false, subscription: null, updatedAt: timestamp },
    entitlement: { version: 1, grants: [], paymentCancellations: [] },
    pendingPayment: null,
    alerts: [],
    pendingNotifications: []
  };
}

function normalizeAlertInput(value) {
  const source = value || {};
  const goodsNo = normalizeGoodsNo(source.goodsNo);
  const targetPrice = parseMoney(source.targetPrice);
  if (!goodsNo || !targetPrice) return null;
  const rawOptionNumber = String(source.optionNumber == null ? '' : source.optionNumber).trim();
  const optionNumber = rawOptionNumber ? normalizeOptionNumber(rawOptionNumber) : '';
  if (rawOptionNumber && !optionNumber) return null;
  const optionName = optionNumber ? cleanText(source.optionName, 120) : '';
  if (optionNumber && !optionName) return null;
  const rawLegacyItemNumber = String(
    source.legacyItemNumber == null ? '' : source.legacyItemNumber
  ).trim();
  const legacyItemNumber = rawLegacyItemNumber
    ? normalizeLegacyItemNumber(rawLegacyItemNumber)
    : '';
  if (rawLegacyItemNumber && !legacyItemNumber) return null;
  return {
    goodsNo,
    goodsName: cleanText(source.goodsName || goodsNo, 180) || goodsNo,
    imageUrl: cleanImageUrl(source.imageUrl),
    targetPrice,
    optionNumber,
    optionName,
    legacyItemNumber
  };
}

function publicAlert(alert) {
  const optionNumber = normalizeOptionNumber(alert.optionNumber);
  const alertId = alertIdFrom(alert);
  return {
    id: alertId,
    alertId,
    goodsNo: alert.goodsNo,
    goodsName: alert.goodsName,
    imageUrl: alert.imageUrl || '',
    optionNumber: optionNumber || null,
    optionName: optionNumber ? cleanText(alert.optionName, 120) : '',
    legacyItemNumber: optionNumber
      ? normalizeLegacyItemNumber(alert.legacyItemNumber) || null
      : null,
    targetPrice: alert.targetPrice,
    lastEvaluatedPrice: parseMoney(alert.lastEvaluatedPrice) || null,
    lastCheckedAt: alert.lastCheckedAt || null,
    createdAt: alert.createdAt,
    updatedAt: alert.updatedAt,
    enabled: alert.enabled !== false
  };
}

function upsertAlert(record, input, now) {
  const normalized = normalizeAlertInput(input);
  if (!normalized) return { error: 'invalid_alert' };
  const timestamp = now || new Date().toISOString();
  const alerts = Array.isArray(record.alerts) ? record.alerts.slice() : [];
  const alertId = alertIdFor(normalized.goodsNo, normalized.optionNumber);
  const index = alerts.findIndex((item) => alertIdFrom(item) === alertId);

  if (index < 0 && alerts.length >= MAX_ALERTS_PER_DEVICE) {
    return { error: 'alert_limit_reached' };
  }

  const existing = index >= 0 ? alerts[index] : null;
  const alert = {
    id: alertId,
    alertId,
    goodsNo: normalized.goodsNo,
    goodsName: normalized.goodsName,
    imageUrl: normalized.imageUrl,
    optionNumber: normalized.optionNumber || null,
    optionName: normalized.optionName,
    legacyItemNumber: normalized.legacyItemNumber || null,
    targetPrice: normalized.targetPrice,
    enabled: true,
    createdAt: (existing && existing.createdAt) || timestamp,
    updatedAt: timestamp,
    lastCheckedAt: (existing && existing.lastCheckedAt) || null,
    lastEvaluatedPrice: (existing && parseMoney(existing.lastEvaluatedPrice)) || null,
    eventSequence: Number((existing && existing.eventSequence) || 0),
    eventKey: (existing && (existing.eventKey || existing.lastEventKey)) || null
  };

  if (index >= 0) alerts[index] = alert;
  else alerts.push(alert);
  record.alerts = alerts;
  record.updatedAt = timestamp;
  return { alert };
}

function removeAlert(record, goodsNo, optionNumber, now) {
  let resolvedOptionNumber = optionNumber;
  let resolvedNow = now;
  if (
    now === undefined &&
    typeof optionNumber === 'string' &&
    /^\d{4}-\d{2}-\d{2}T/.test(optionNumber)
  ) {
    resolvedNow = optionNumber;
    resolvedOptionNumber = '';
  }
  const alertId = alertIdFor(goodsNo, resolvedOptionNumber);
  if (!alertId) return false;
  const alerts = Array.isArray(record.alerts) ? record.alerts : [];
  const next = alerts.filter((item) => alertIdFrom(item) !== alertId);
  if (next.length === alerts.length) return false;
  record.alerts = next;
  record.pendingNotifications = pendingNotifications(record).filter(
    (event) => alertIdFrom(event) !== alertId
  );
  record.updatedAt = resolvedNow || new Date().toISOString();
  return true;
}

function eventKeyFor(alert, sequence, previousPrice, currentPrice) {
  return crypto
    .createHash('sha256')
    .update(`${alertIdFrom(alert)}:${sequence}:${previousPrice}:${currentPrice}`)
    .digest('base64url')
    .slice(0, 32);
}

function evaluatePrice(alert, value, now) {
  const currentPrice = parseMoney(value);
  if (!currentPrice) return { changed: false, alert, notification: null };
  const timestamp = now || new Date().toISOString();
  const previousPrice = parseMoney(alert.lastEvaluatedPrice);

  if (!previousPrice) {
    return {
      changed: true,
      notification: null,
      alert: { ...alert, lastEvaluatedPrice: currentPrice, lastCheckedAt: timestamp }
    };
  }
  if (previousPrice === currentPrice) {
    return {
      changed: true,
      notification: null,
      alert: { ...alert, lastCheckedAt: timestamp }
    };
  }

  const direction = currentPrice > previousPrice ? 'up' : 'down';
  const sequence = Number(alert.eventSequence || 0) + 1;
  const eventKey = eventKeyFor(alert, sequence, previousPrice, currentPrice);
  const targetPrice = parseMoney(alert.targetPrice);
  const targetReached = direction === 'down' && previousPrice > targetPrice && currentPrice <= targetPrice;
  const updatedAlert = {
    ...alert,
    lastEvaluatedPrice: currentPrice,
    lastCheckedAt: timestamp,
    eventSequence: sequence,
    eventKey
  };

  return {
    changed: true,
    alert: updatedAlert,
    notification: {
      type: 'price-change',
      eventKey,
      direction,
      alertId: alertIdFrom(alert),
      goodsNo: alert.goodsNo,
      goodsName: alert.goodsName || alert.goodsNo,
      imageUrl: alert.imageUrl || '',
      optionNumber: normalizeOptionNumber(alert.optionNumber) || null,
      optionName: normalizeOptionNumber(alert.optionNumber)
        ? cleanText(alert.optionName, 120)
        : '',
      legacyItemNumber: normalizeOptionNumber(alert.optionNumber)
        ? normalizeLegacyItemNumber(alert.legacyItemNumber) || null
        : null,
      previousPrice,
      currentPrice,
      targetPrice,
      targetReached,
      url: '/?q=' + encodeURIComponent(alert.goodsName || alert.goodsNo)
    }
  };
}

function normalizePriceBatchResponse(value, requestedGoodsNos) {
  const requested = Array.from(new Set((requestedGoodsNos || []).map(normalizeGoodsNo).filter(Boolean)));
  if (
    !value ||
    value.success !== true ||
    value.complete !== true ||
    Number(value.count) !== requested.length ||
    !Array.isArray(value.prices)
  ) {
    return { complete: false, prices: {} };
  }

  const prices = {};
  for (const item of value.prices) {
    const goodsNo = normalizeGoodsNo(item && item.goodsNo);
    const priceToPay = parseMoney(item && item.priceToPay);
    if (!goodsNo || !requested.includes(goodsNo) || !priceToPay || prices[goodsNo]) {
      return { complete: false, prices: {} };
    }
    const options = Object.create(null);
    const duplicateOptions = new Set();
    if (item.options != null && !Array.isArray(item.options)) {
      return { complete: false, prices: {} };
    }
    for (const option of item.options || []) {
      const optionNumber = normalizeOptionNumber(option && option.optionNumber);
      const optionName = cleanText(option && option.optionName, 120);
      const soldOut = option && option.soldOut;
      const optionPrice = parseMoney(option && option.priceToPay);
      if (
        !optionNumber ||
        !optionName ||
        typeof soldOut !== 'boolean' ||
        (!soldOut && !optionPrice)
      ) {
        continue;
      }
      if (options[optionNumber]) {
        duplicateOptions.add(optionNumber);
        delete options[optionNumber];
        continue;
      }
      if (duplicateOptions.has(optionNumber)) continue;
      options[optionNumber] = {
        optionNumber,
        optionName,
        priceToPay: optionPrice || null,
        originalPrice: parseMoney(option.originalPrice) || null,
        soldOut
      };
    }
    prices[goodsNo] = {
      goodsNo,
      priceToPay,
      originalPrice: parseMoney(item.originalPrice) || null,
      options
    };
  }
  const complete = requested.length > 0 && requested.every((goodsNo) => prices[goodsNo]);
  return { complete, prices: complete ? prices : {} };
}

function chunk(values, size) {
  const rows = [];
  for (let index = 0; index < values.length; index += size) {
    rows.push(values.slice(index, index + size));
  }
  return rows;
}

function pendingNotifications(record) {
  return (Array.isArray(record && record.pendingNotifications)
    ? record.pendingNotifications
    : []
  ).filter(
    (event) =>
      event &&
      event.type === 'price-change' &&
      /^[A-Za-z0-9_-]{20,40}$/.test(String(event.eventKey || '')) &&
      normalizeGoodsNo(event.goodsNo)
  );
}

function priceForAlert(alert, priceRow) {
  if (!alert || !priceRow) return 0;
  const rawOptionNumber = String(
    alert.optionNumber == null ? '' : alert.optionNumber
  ).trim();
  const optionNumber = normalizeOptionNumber(alert.optionNumber);
  if (rawOptionNumber && !optionNumber) return 0;
  if (!optionNumber) {
    return parseMoney(
      typeof priceRow === 'number' || typeof priceRow === 'string'
        ? priceRow
        : priceRow.priceToPay
    );
  }
  if (typeof priceRow !== 'object' || !priceRow.options) return 0;
  const option = Array.isArray(priceRow.options)
    ? priceRow.options.find(
        (item) => normalizeOptionNumber(item && item.optionNumber) === optionNumber
      )
    : priceRow.options[optionNumber];
  if (!option || option.soldOut !== false) return 0;
  return parseMoney(option.priceToPay);
}

function appendPendingNotification(record, notification, now) {
  if (
    !notification ||
    notification.type !== 'price-change' ||
    !/^[A-Za-z0-9_-]{20,40}$/.test(String(notification.eventKey || '')) ||
    !normalizeGoodsNo(notification.goodsNo)
  ) {
    return false;
  }
  const current = pendingNotifications(record);
  if (current.some((event) => event.eventKey === notification.eventKey)) {
    record.pendingNotifications = current;
    return false;
  }
  current.push({ ...notification, queuedAt: now || new Date().toISOString() });
  current.sort((left, right) => {
    const timeDifference = Date.parse(left.queuedAt || 0) - Date.parse(right.queuedAt || 0);
    if (Number.isFinite(timeDifference) && timeDifference) return timeDifference;
    return String(left.eventKey).localeCompare(String(right.eventKey));
  });
  record.pendingNotifications = current.slice(-MAX_PENDING_NOTIFICATIONS);
  return true;
}

function removePendingNotifications(record, eventKeys) {
  const keys = new Set((eventKeys || []).map(String));
  if (!keys.size) return false;
  const current = pendingNotifications(record);
  const next = current.filter((event) => !keys.has(event.eventKey));
  record.pendingNotifications = next;
  return next.length !== current.length;
}

function applyPricesToDeviceRecord(record, validPrices, now) {
  const timestamp = now || new Date().toISOString();
  const next = {
    ...record,
    alerts: Array.isArray(record && record.alerts) ? record.alerts.slice() : [],
    pendingNotifications: pendingNotifications(record).slice()
  };
  let stateUpdates = 0;
  let queuedNotifications = 0;

  next.alerts = next.alerts.map((alert) => {
    const price = priceForAlert(
      alert,
      validPrices && validPrices[alert && alert.goodsNo]
    );
    if (!alert || alert.enabled === false || !price) return alert;
    const evaluation = evaluatePrice(alert, price, timestamp);
    if (!evaluation.changed) return alert;
    stateUpdates += 1;
    if (
      evaluation.notification &&
      appendPendingNotification(next, evaluation.notification, timestamp)
    ) {
      queuedNotifications += 1;
    }
    return evaluation.alert;
  });
  if (stateUpdates) next.updatedAt = timestamp;
  return {
    record: next,
    changed: stateUpdates > 0,
    stateUpdates,
    queuedNotifications
  };
}

module.exports = {
  CHECK_INTERVAL_MINUTES,
  MAX_ALERTS_PER_DEVICE,
  MAX_PENDING_NOTIFICATIONS,
  alertIdFor,
  applyPricesToDeviceRecord,
  appendPendingNotification,
  chunk,
  cleanImageUrl,
  createDeviceRecord,
  evaluatePrice,
  hashDeviceSecret,
  normalizeAlertInput,
  normalizeDeviceId,
  normalizeDeviceSecret,
  normalizeGoodsNo,
  normalizeLegacyItemNumber,
  normalizeOptionNumber,
  normalizePriceBatchResponse,
  normalizePushSubscription,
  parseMoney,
  pendingNotifications,
  priceForAlert,
  publicAlert,
  removeAlert,
  removePendingNotifications,
  upsertAlert,
  verifyDeviceSecret
};
