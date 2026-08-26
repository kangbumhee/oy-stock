const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DeviceWriteConflictError,
  mutateDevice
} = require('../api/price-alerts/_store');
const {
  applyPricesToDeviceRecord,
  createDeviceRecord,
  removeAlert,
  upsertAlert
} = require('../api/price-alerts/_core');
const { applyPaymentGrant } = require('../api/price-alerts/_entitlement');

const DEVICE_ID = 'c07l6tBv1FLYwQdE6Rz7xA';
const DEVICE_SECRET = 'EmD86c3uP5aYH2Rj9QTn4Lz7Ks0VxBwF1GgN8MhJkPc';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initialRecord() {
  const record = createDeviceRecord(
    DEVICE_ID,
    DEVICE_SECRET,
    '2026-08-26T00:00:00.000Z'
  );
  upsertAlert(
    record,
    {
      goodsNo: 'A000000154189',
      goodsName: '어노브 테스트 상품',
      targetPrice: 10000
    },
    '2026-08-26T00:00:00.000Z'
  );
  record.alerts[0].lastEvaluatedPrice = 11000;
  return record;
}

function controlledCasStore(initial, shouldPauseFirstWrite) {
  let state = clone(initial);
  let version = 1;
  let paused = false;
  let releasePausedWrite;
  let notifyPaused;
  const pausedWrite = new Promise((resolve) => {
    notifyPaused = resolve;
  });
  const resumeWrite = new Promise((resolve) => {
    releasePausedWrite = resolve;
  });

  return {
    async readDevice() {
      return {
        record: clone(state),
        blobs: [{ pathname: 'memory/device.enc', etag: String(version) }]
      };
    },
    async writeDevice(record, blobs) {
      if (!paused && shouldPauseFirstWrite(record)) {
        paused = true;
        notifyPaused();
        await resumeWrite;
      }
      const expectedVersion = Number(blobs[0].etag);
      if (expectedVersion !== version) throw new DeviceWriteConflictError();
      state = clone(record);
      version += 1;
      return { pathname: 'memory/device.enc', etag: String(version) };
    },
    getState() {
      return clone(state);
    },
    pausedWrite,
    releasePausedWrite
  };
}

function priceObservation(record, currentPrice, now) {
  const evaluation = applyPricesToDeviceRecord(
    record,
    { A000000154189: currentPrice },
    now
  );
  return {
    changed: evaluation.changed,
    record: evaluation.record
  };
}

test('CAS retry preserves a concurrent target edit and evaluates price against the new target', async () => {
  const store = controlledCasStore(
    initialRecord(),
    (record) => record.alerts[0] && record.alerts[0].lastEvaluatedPrice === 9500
  );
  const options = {
    readDevice: store.readDevice,
    writeDevice: store.writeDevice,
    maxAttempts: 4
  };

  const cron = mutateDevice(
    DEVICE_ID,
    (record) => priceObservation(record, 9500, '2026-08-26T01:00:00.000Z'),
    options
  );
  await store.pausedWrite;

  await mutateDevice(
    DEVICE_ID,
    (record) => {
      upsertAlert(
        record,
        {
          goodsNo: 'A000000154189',
          goodsName: '어노브 테스트 상품',
          targetPrice: 9000
        },
        '2026-08-26T01:00:01.000Z'
      );
      return { changed: true, record };
    },
    options
  );
  store.releasePausedWrite();
  const cronResult = await cron;

  const finalRecord = store.getState();
  assert.equal(cronResult.attempts, 2);
  assert.equal(finalRecord.alerts[0].targetPrice, 9000);
  assert.equal(finalRecord.alerts[0].lastEvaluatedPrice, 9500);
  assert.equal(finalRecord.pendingNotifications.length, 1);
  assert.equal(finalRecord.pendingNotifications[0].targetReached, false);
});

test('CAS retry never resurrects an alert deleted while cron price work is in flight', async () => {
  const store = controlledCasStore(
    initialRecord(),
    (record) => record.alerts[0] && record.alerts[0].lastEvaluatedPrice === 9000
  );
  const options = {
    readDevice: store.readDevice,
    writeDevice: store.writeDevice,
    maxAttempts: 4
  };

  const cron = mutateDevice(
    DEVICE_ID,
    (record) => priceObservation(record, 9000, '2026-08-26T02:00:00.000Z'),
    options
  );
  await store.pausedWrite;

  await mutateDevice(
    DEVICE_ID,
    (record) => ({
      changed: removeAlert(record, 'A000000154189', '2026-08-26T02:00:01.000Z'),
      record
    }),
    options
  );
  store.releasePausedWrite();
  const cronResult = await cron;

  const finalRecord = store.getState();
  assert.equal(cronResult.attempts, 2);
  assert.deepEqual(finalRecord.alerts, []);
  assert.deepEqual(finalRecord.pendingNotifications, []);
});

test('CAS retry merges a concurrent subscription change with an alert mutation', async () => {
  const store = controlledCasStore(
    initialRecord(),
    (record) => record.alerts[0] && record.alerts[0].targetPrice === 8000
  );
  const options = {
    readDevice: store.readDevice,
    writeDevice: store.writeDevice,
    maxAttempts: 4
  };

  const alertEdit = mutateDevice(
    DEVICE_ID,
    (record) => {
      upsertAlert(
        record,
        {
          goodsNo: 'A000000154189',
          goodsName: '어노브 테스트 상품',
          targetPrice: 8000
        },
        '2026-08-26T03:00:00.000Z'
      );
      return { changed: true, record };
    },
    options
  );
  await store.pausedWrite;

  await mutateDevice(
    DEVICE_ID,
    (record) => {
      record.push = {
        active: true,
        subscription: {
          endpoint: 'https://fcm.googleapis.com/fcm/send/device-token',
          expirationTime: null,
          keys: { p256dh: 'A'.repeat(88), auth: 'B'.repeat(22) }
        },
        updatedAt: '2026-08-26T03:00:01.000Z'
      };
      return { changed: true, record };
    },
    options
  );
  store.releasePausedWrite();
  const editResult = await alertEdit;

  const finalRecord = store.getState();
  assert.equal(editResult.attempts, 2);
  assert.equal(finalRecord.alerts[0].targetPrice, 8000);
  assert.equal(finalRecord.push.active, true);
  assert.match(finalRecord.push.subscription.endpoint, /^https:\/\/fcm\.googleapis\.com\//);
});

test('CAS retry makes concurrent payment grant application exact-once', async () => {
  const paymentId = 'oypa_1234567890abcdefghijklmnop';
  const record = initialRecord();
  record.entitlement = { version: 1, grants: [], paymentCancellations: [] };
  const store = controlledCasStore(
    record,
    (candidate) =>
      candidate.entitlement && candidate.entitlement.grants.length === 1
  );
  const options = {
    readDevice: store.readDevice,
    writeDevice: store.writeDevice,
    maxAttempts: 4
  };
  const grantMutation = () =>
    mutateDevice(
      DEVICE_ID,
      (current) => {
        const result = applyPaymentGrant(
          current,
          paymentId,
          '2026-08-26T04:00:00.000Z'
        );
        return { changed: result.changed, record: current };
      },
      options
    );

  const first = grantMutation();
  await store.pausedWrite;
  const second = await grantMutation();
  store.releasePausedWrite();
  const retried = await first;

  assert.equal(second.written, true);
  assert.equal(retried.attempts, 2);
  assert.equal(retried.written, false);
  assert.equal(store.getState().entitlement.grants.length, 1);
  assert.equal(store.getState().entitlement.grants[0].paymentId, paymentId);
});
