const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  MAX_ALERTS_PER_DEVICE,
  MAX_PENDING_NOTIFICATIONS,
  applyPricesToDeviceRecord,
  appendPendingNotification,
  alertIdFor,
  createDeviceRecord,
  evaluatePrice,
  normalizeGoodsNo,
  normalizeOptionNumber,
  normalizePriceBatchResponse,
  normalizePushSubscription,
  pendingNotifications,
  publicAlert,
  removeAlert,
  removePendingNotifications,
  upsertAlert,
  verifyDeviceSecret
} = require('../api/price-alerts/_core');
const { decodeDataKey, decryptJson, devicePathHash, encryptJson } = require('../api/price-alerts/_crypto');
const { assertSameOrigin, readJson } = require('../api/price-alerts/_http');

const DEVICE_ID = 'c07l6tBv1FLYwQdE6Rz7xA';
const DEVICE_SECRET = 'EmD86c3uP5aYH2Rj9QTn4Lz7Ks0VxBwF1GgN8MhJkPc';

function alert(overrides) {
  return {
    id: 'A000000154189',
    goodsNo: 'A000000154189',
    goodsName: '어노브 테스트 상품',
    imageUrl: '',
    targetPrice: 10000,
    enabled: true,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    lastCheckedAt: null,
    lastEvaluatedPrice: null,
    eventSequence: 0,
    eventKey: null,
    ...overrides
  };
}

test('AES-256-GCM envelope round trips without exposing device JSON', () => {
  const key = crypto.randomBytes(32);
  const value = { deviceId: DEVICE_ID, push: { endpoint: 'https://push.example/private' } };
  const encrypted = encryptJson(value, key);

  assert.equal(encrypted.includes(DEVICE_ID), false);
  assert.equal(encrypted.includes('push.example'), false);
  assert.deepEqual(decryptJson(encrypted, key), value);
  assert.equal(decodeDataKey(key.toString('hex')).length, 32);
  assert.equal(decodeDataKey(key.toString('base64url')).length, 32);
  assert.equal(devicePathHash(DEVICE_ID, key).length, 64);
});

test('AES-256-GCM rejects tampered ciphertext', () => {
  const key = crypto.randomBytes(32);
  const envelope = JSON.parse(encryptJson({ ok: true }, key));
  envelope.data = (envelope.data.startsWith('A') ? 'B' : 'A') + envelope.data.slice(1);
  assert.throws(() => decryptJson(JSON.stringify(envelope), key), /authentication failed/);
});

test('device secret is hashed and verified without storing the original', () => {
  const record = createDeviceRecord(DEVICE_ID, DEVICE_SECRET, '2026-08-26T00:00:00.000Z');
  assert.notEqual(record.secretHash, DEVICE_SECRET);
  assert.equal(verifyDeviceSecret(DEVICE_ID, DEVICE_SECRET, record.secretHash), true);
  assert.equal(verifyDeviceSecret(DEVICE_ID, DEVICE_SECRET.slice(0, -1) + 'x', record.secretHash), false);
});

test('rejects cross-origin mutations and oversized JSON bodies', async () => {
  assert.doesNotThrow(() =>
    assertSameOrigin({
      headers: {
        origin: 'https://olivestock.co.kr',
        host: 'olivestock.co.kr',
        'x-forwarded-proto': 'https',
        'sec-fetch-site': 'same-origin'
      }
    })
  );
  assert.throws(
    () =>
      assertSameOrigin({
        headers: {
          origin: 'https://attacker.example',
          host: 'olivestock.co.kr',
          'sec-fetch-site': 'cross-site'
        }
      }),
    /cross_site_request_denied/
  );
  await assert.rejects(
    () => readJson({ headers: { 'content-length': String(20 * 1024) } }),
    /request_too_large/
  );
});

test('validates OliveYoung goods numbers and allows supported Web Push services only', () => {
  assert.equal(normalizeGoodsNo('a000000154189'), 'A000000154189');
  assert.equal(normalizeGoodsNo('../secrets'), '');
  assert.equal(normalizeOptionNumber('00123456_A'), '00123456_A');
  assert.equal(normalizeOptionNumber('../option'), '');
  const keys = { p256dh: 'A'.repeat(88), auth: 'B'.repeat(22) };
  const acceptedEndpoints = [
    'https://fcm.googleapis.com/fcm/send/chrome-token',
    'https://updates.push.services.mozilla.com/wpush/v2/firefox-token',
    'https://web.push.apple.com/QHNhZmFyaS10b2tlbg',
    'https://wns2-bl2p.notify.windows.com/w/?token=edge-token'
  ];
  acceptedEndpoints.forEach((endpoint) => {
    assert.equal(normalizePushSubscription({ endpoint, expirationTime: null, keys }).endpoint, endpoint);
  });

  const rejectedEndpoints = [
    'http://fcm.googleapis.com/fcm/send/insecure',
    'https://127.0.0.1/hook',
    'https://[::1]/hook',
    'https://localhost/hook',
    'https://push.example/subscriptions/123',
    'https://fcm.googleapis.com:8443/fcm/send/token',
    'https://attacker@fcm.googleapis.com/fcm/send/token',
    'https://fcm.googleapis.com.attacker.example/fcm/send/token'
  ];
  rejectedEndpoints.forEach((endpoint) => {
    assert.equal(normalizePushSubscription({ endpoint, expirationTime: null, keys }), null);
  });
});

test('enforces the configured alert cap per device while allowing an existing alert update', () => {
  const record = { alerts: [], updatedAt: null };
  for (let index = 0; index < MAX_ALERTS_PER_DEVICE; index += 1) {
    const goodsNo = 'A' + String(index + 1).padStart(12, '0');
    const result = upsertAlert(record, { goodsNo, goodsName: goodsNo, targetPrice: 1000 });
    assert.equal(result.error, undefined);
  }
  assert.equal(
    upsertAlert(record, {
      goodsNo: 'A999999999999',
      goodsName: '제한 초과',
      targetPrice: 1000
    }).error,
    'alert_limit_reached'
  );
  const updated = upsertAlert(record, {
    goodsNo: 'A000000000001',
    goodsName: '업데이트',
    targetPrice: 900
  });
  assert.equal(updated.alert.targetPrice, 900);
  assert.equal(record.alerts.length, MAX_ALERTS_PER_DEVICE);
});

test('two options of one goods number keep independent identities, baselines, targets, and outbox', () => {
  const record = { alerts: [], pendingNotifications: [], updatedAt: null };
  const first = upsertAlert(record, {
    goodsNo: 'A000000154189',
    goodsName: '어노브 테스트 상품',
    optionNumber: '101',
    optionName: '딥 데미지 트리트먼트',
    legacyItemNumber: '88001',
    targetPrice: 10000
  });
  const second = upsertAlert(record, {
    goodsNo: 'A000000154189',
    goodsName: '어노브 테스트 상품',
    optionNumber: '102',
    optionName: '워터 에센스',
    targetPrice: 20000
  });
  assert.equal(record.alerts.length, 2);
  assert.equal(first.alert.id, 'A000000154189::101');
  assert.equal(second.alert.id, 'A000000154189::102');
  assert.equal(publicAlert(first.alert).alertId, 'A000000154189::101');

  const baseline = applyPricesToDeviceRecord(
    record,
    {
      A000000154189: {
        priceToPay: 25000,
        options: {
          101: { optionNumber: '101', optionName: '딥 데미지 트리트먼트', priceToPay: 12000, soldOut: false },
          102: { optionNumber: '102', optionName: '워터 에센스', priceToPay: 18000, soldOut: false }
        }
      }
    },
    '2026-08-26T01:00:00.000Z'
  );
  assert.deepEqual(
    baseline.record.alerts.map((item) => item.lastEvaluatedPrice),
    [12000, 18000]
  );
  assert.equal(baseline.queuedNotifications, 0);

  const changed = applyPricesToDeviceRecord(
    baseline.record,
    {
      A000000154189: {
        priceToPay: 25000,
        options: {
          101: { optionNumber: '101', optionName: '딥 데미지 트리트먼트', priceToPay: 9000, soldOut: false },
          102: { optionNumber: '102', optionName: '워터 에센스', priceToPay: 19000, soldOut: false }
        }
      }
    },
    '2026-08-26T02:00:00.000Z'
  );
  assert.equal(changed.queuedNotifications, 2);
  assert.deepEqual(
    changed.record.pendingNotifications.map((event) => event.alertId).sort(),
    ['A000000154189::101', 'A000000154189::102']
  );
  assert.equal(
    changed.record.pendingNotifications.find(
      (event) => event.alertId === 'A000000154189::101'
    ).targetReached,
    true
  );

  assert.equal(
    removeAlert(changed.record, 'A000000154189', '101', '2026-08-26T03:00:00.000Z'),
    true
  );
  assert.deepEqual(changed.record.alerts.map((item) => item.optionNumber), ['102']);
  assert.deepEqual(
    changed.record.pendingNotifications.map((event) => event.alertId),
    ['A000000154189::102']
  );
});

test('option alert input rejects unsafe or unnamed identities', () => {
  const record = { alerts: [] };
  assert.equal(
    upsertAlert(record, {
      goodsNo: 'A000000154189',
      optionNumber: '../101',
      optionName: '옵션',
      targetPrice: 10000
    }).error,
    'invalid_alert'
  );
  assert.equal(
    upsertAlert(record, {
      goodsNo: 'A000000154189',
      optionNumber: '101',
      optionName: '',
      targetPrice: 10000
    }).error,
    'invalid_alert'
  );
  assert.equal(record.alerts.length, 0);
});

test('option alert skips missing, sold-out, malformed, and zero observations without moving baseline', () => {
  const optionAlert = alert({
    id: alertIdFor('A000000154189', '101'),
    alertId: alertIdFor('A000000154189', '101'),
    optionNumber: '101',
    optionName: '딥 데미지 트리트먼트',
    lastEvaluatedPrice: 12000,
    lastCheckedAt: '2026-08-26T00:00:00.000Z'
  });
  const base = { alerts: [optionAlert], pendingNotifications: [] };
  const observations = [
    { A000000154189: { priceToPay: 20000, options: {} } },
    {
      A000000154189: {
        priceToPay: 20000,
        options: { 101: { optionNumber: '101', optionName: '옵션', priceToPay: 9000, soldOut: true } }
      }
    },
    {
      A000000154189: {
        priceToPay: 20000,
        options: { 101: { optionNumber: '101', optionName: '옵션', priceToPay: 0, soldOut: false } }
      }
    }
  ];
  observations.forEach((prices, index) => {
    const result = applyPricesToDeviceRecord(base, prices, `2026-08-26T0${index + 1}:00:00.000Z`);
    assert.equal(result.changed, false);
    assert.equal(result.record.alerts[0].lastEvaluatedPrice, 12000);
    assert.equal(result.record.alerts[0].lastCheckedAt, '2026-08-26T00:00:00.000Z');
    assert.deepEqual(result.record.pendingNotifications, []);
  });
});

test('first observation is baseline only and unchanged price refreshes checked time without a push', () => {
  const baseline = evaluatePrice(alert(), 12000, '2026-08-26T01:00:00.000Z');
  assert.equal(baseline.changed, true);
  assert.equal(baseline.notification, null);
  assert.equal(publicAlert(baseline.alert).lastEvaluatedPrice, 12000);

  const unchanged = evaluatePrice(baseline.alert, 12000, '2026-08-26T02:00:00.000Z');
  assert.equal(unchanged.changed, true);
  assert.equal(unchanged.notification, null);
  assert.equal(unchanged.alert.lastCheckedAt, '2026-08-26T02:00:00.000Z');
});

test('notifies both price rises and later drops, with one merged target message', () => {
  const start = alert({ lastEvaluatedPrice: 10000 });
  const rise = evaluatePrice(start, 12000, '2026-08-26T01:00:00.000Z');
  assert.equal(rise.notification.direction, 'up');
  assert.equal(rise.notification.targetReached, false);

  const drop = evaluatePrice(rise.alert, 9000, '2026-08-26T02:00:00.000Z');
  assert.equal(drop.notification.direction, 'down');
  assert.equal(drop.notification.targetReached, true);
  assert.notEqual(drop.notification.eventKey, rise.notification.eventKey);
  assert.equal(drop.alert.eventSequence, 2);
  assert.equal(drop.alert.eventKey, drop.notification.eventKey);
  assert.equal(Object.hasOwn(publicAlert(drop.alert), 'eventKey'), false);

  const secondRise = evaluatePrice(drop.alert, 12000, '2026-08-26T03:00:00.000Z');
  assert.notEqual(secondRise.notification.eventKey, rise.notification.eventKey);
});

test('encrypted outbox deduplicates event keys, stays FIFO, and caps at fifty', () => {
  const record = { pendingNotifications: [] };
  for (let index = 0; index <= MAX_PENDING_NOTIFICATIONS; index += 1) {
    const event = {
      type: 'price-change',
      eventKey: String(index).padStart(24, 'A'),
      goodsNo: 'A000000154189',
      goodsName: '어노브',
      direction: index % 2 ? 'up' : 'down',
      previousPrice: 10000,
      currentPrice: 11000,
      targetPrice: 9000,
      targetReached: false,
      url: '/?q=test'
    };
    assert.equal(
      appendPendingNotification(record, event, new Date(Date.UTC(2026, 7, 26, index)).toISOString()),
      true
    );
  }
  assert.equal(record.pendingNotifications.length, MAX_PENDING_NOTIFICATIONS);
  assert.equal(record.pendingNotifications[0].eventKey, String(1).padStart(24, 'A'));

  const duplicate = record.pendingNotifications[0];
  assert.equal(appendPendingNotification(record, duplicate), false);
  assert.equal(record.pendingNotifications.length, MAX_PENDING_NOTIFICATIONS);
  assert.equal(removePendingNotifications(record, [duplicate.eventKey]), true);
  assert.equal(pendingNotifications(record).some((event) => event.eventKey === duplicate.eventKey), false);
});

test('cron rebase never resurrects deleted alerts and uses the latest target price', () => {
  const deletedLatestRecord = { alerts: [], pendingNotifications: [], updatedAt: null };
  const deletedResult = applyPricesToDeviceRecord(
    deletedLatestRecord,
    { A000000154189: 9000 },
    '2026-08-26T04:00:00.000Z'
  );
  assert.equal(deletedResult.changed, false);
  assert.deepEqual(deletedResult.record.alerts, []);

  const latestRecord = {
    alerts: [alert({ targetPrice: 9000, lastEvaluatedPrice: 11000 })],
    pendingNotifications: [],
    updatedAt: null
  };
  const latestTargetResult = applyPricesToDeviceRecord(
    latestRecord,
    { A000000154189: 9500 },
    '2026-08-26T05:00:00.000Z'
  );
  assert.equal(latestTargetResult.changed, true);
  assert.equal(latestTargetResult.queuedNotifications, 1);
  assert.equal(latestTargetResult.record.alerts[0].targetPrice, 9000);
  assert.equal(latestTargetResult.record.pendingNotifications[0].targetReached, false);
});

test('same price refreshes checked time without a new event while pending delivery remains retryable', () => {
  const queued = {
    type: 'price-change',
    eventKey: 'RetryableEventKey1234567890',
    goodsNo: 'A000000154189',
    goodsName: '어노브',
    direction: 'down',
    previousPrice: 12000,
    currentPrice: 11000,
    targetPrice: 10000,
    targetReached: false,
    url: '/?q=test',
    queuedAt: '2026-08-26T01:00:00.000Z'
  };
  const record = {
    alerts: [alert({ lastEvaluatedPrice: 11000 })],
    pendingNotifications: [queued]
  };
  const result = applyPricesToDeviceRecord(
    record,
    { A000000154189: 11000 },
    '2026-08-26T02:00:00.000Z'
  );
  assert.equal(result.changed, true);
  assert.equal(result.queuedNotifications, 0);
  assert.equal(result.record.alerts[0].lastCheckedAt, '2026-08-26T02:00:00.000Z');
  assert.deepEqual(result.record.pendingNotifications, [queued]);
});

test('deleting an alert also cancels its queued notifications', () => {
  const queued = {
    type: 'price-change',
    eventKey: 'DeleteMeEventKey1234567890',
    goodsNo: 'A000000154189',
    queuedAt: '2026-08-26T01:00:00.000Z'
  };
  const record = {
    alerts: [alert()],
    pendingNotifications: [queued]
  };
  assert.equal(removeAlert(record, 'A000000154189'), true);
  assert.deepEqual(record.alerts, []);
  assert.deepEqual(record.pendingNotifications, []);
});

test('rejects zero, incomplete, count mismatch, or missing upstream price batches', () => {
  const requested = ['A000000154189', 'A000000154190'];
  const valid = normalizePriceBatchResponse(
    {
      success: true,
      complete: true,
      count: 2,
      prices: [
        { goodsNo: requested[0], priceToPay: 12000 },
        { goodsNo: requested[1], priceToPay: 13000 }
      ]
    },
    requested
  );
  assert.equal(valid.complete, true);
  assert.equal(valid.prices[requested[0]].priceToPay, 12000);

  const enhanced = normalizePriceBatchResponse(
    {
      success: true,
      complete: true,
      count: 1,
      prices: [
        {
          goodsNo: requested[0],
          priceToPay: 12000,
          originalPrice: 15000,
          options: [
            {
              optionNumber: '101',
              optionName: '딥 데미지 트리트먼트',
              priceToPay: 9000,
              originalPrice: 12000,
              soldOut: false
            },
            {
              optionNumber: '102',
              optionName: '품절 옵션',
              priceToPay: 0,
              originalPrice: 10000,
              soldOut: true
            },
            {
              optionNumber: '../unsafe',
              optionName: '잘못된 옵션',
              priceToPay: 1,
              soldOut: false
            }
          ]
        }
      ]
    },
    [requested[0]]
  );
  assert.equal(enhanced.complete, true);
  assert.equal(enhanced.prices[requested[0]].options['101'].priceToPay, 9000);
  assert.equal(enhanced.prices[requested[0]].options['102'].soldOut, true);
  assert.equal(enhanced.prices[requested[0]].options['../unsafe'], undefined);

  assert.equal(
    normalizePriceBatchResponse(
      { success: true, complete: false, count: 2, prices: [] },
      requested
    ).complete,
    false
  );
  assert.equal(
    normalizePriceBatchResponse(
      {
        success: true,
        complete: true,
        count: 1,
        prices: [{ goodsNo: requested[0], priceToPay: 12000 }]
      },
      requested
    ).complete,
    false
  );
  assert.equal(
    normalizePriceBatchResponse(
      {
        success: true,
        complete: true,
        count: 2,
        prices: [
          { goodsNo: requested[0], priceToPay: 12000 },
          { goodsNo: requested[1], priceToPay: 0 }
        ]
      },
      requested
    ).complete,
    false
  );

  const untouched = {
    alerts: [alert()],
    pendingNotifications: []
  };
  const incomplete = normalizePriceBatchResponse(
    { success: true, complete: false, count: 1, prices: [] },
    ['A000000154189']
  );
  const notApplied = applyPricesToDeviceRecord(
    untouched,
    incomplete.prices,
    '2026-08-26T06:00:00.000Z'
  );
  assert.equal(notApplied.changed, false);
  assert.equal(notApplied.record.alerts[0].lastEvaluatedPrice, null);
  assert.deepEqual(notApplied.record.pendingNotifications, []);
});
