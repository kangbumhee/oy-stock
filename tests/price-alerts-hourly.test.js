const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PRICE_ALERT_ENTITLEMENT_ENABLED = 'true';

const hourly = require('../api/price-alerts/hourly');

const {
  collectActivePriceWork,
  configuredPriceService,
  deliverPendingForDevice,
  fetchPriceBatch,
  mapBounded,
  pushPayload,
  requireCronAuthorization
} = hourly._test;

function queuedDeviceRecord() {
  return {
    version: 1,
    deviceId: 'c07l6tBv1FLYwQdE6Rz7xA',
    push: {
      active: true,
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
        expirationTime: null,
        keys: { p256dh: 'A'.repeat(88), auth: 'B'.repeat(22) }
      }
    },
    alerts: [],
    pendingNotifications: [
      {
        type: 'price-change',
        eventKey: 'QueuedEventKey123456789012',
        direction: 'down',
        goodsNo: 'A000000154189',
        goodsName: '어노브',
        imageUrl: '',
        previousPrice: 12000,
        currentPrice: 10000,
        targetPrice: 10000,
        targetReached: true,
        url: '/?q=test',
        queuedAt: '2026-08-26T00:00:00.000Z'
      }
    ],
    entitlement: {
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
    }
  };
}

function inMemoryDeviceDependencies(initialRecord, sendNotification) {
  let state = JSON.parse(JSON.stringify(initialRecord));
  return {
    dependencies: {
      async readDevice() {
        return { record: JSON.parse(JSON.stringify(state)), blobs: [] };
      },
      async writeDevice(record) {
        state = JSON.parse(JSON.stringify(record));
        return { pathname: 'memory.enc', url: 'https://blob.example/memory.enc' };
      },
      sendNotification
    },
    getState() {
      return state;
    }
  };
}

function withEnv(values, fn) {
  const previous = {};
  Object.keys(values).forEach((key) => {
    previous[key] = process.env[key];
    if (values[key] == null) delete process.env[key];
    else process.env[key] = values[key];
  });
  try {
    return fn();
  } finally {
    Object.keys(values).forEach((key) => {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    });
  }
}

test('cron accepts only its Bearer secret', () => {
  withEnv({ CRON_SECRET: 'cron-test-secret' }, () => {
    assert.equal(
      requireCronAuthorization({ headers: { authorization: 'Bearer cron-test-secret' } }).ok,
      true
    );
    assert.equal(
      requireCronAuthorization({ headers: { authorization: 'Bearer wrong-secret' } }).statusCode,
      401
    );
  });
});

test('price service requires only the dedicated URL and service secret', () => {
  withEnv(
    {
      PRICE_ALERT_PRICE_API_URL: 'https://price-api.example/api/prices',
      PRICE_ALERT_SERVICE_SECRET: null,
      CURATOR_LIVE_SECRET: 'legacy-must-not-be-used'
    },
    () => assert.equal(configuredPriceService(), null)
  );
  withEnv(
    {
      PRICE_ALERT_PRICE_API_URL: 'https://price-api.example/api/prices',
      PRICE_ALERT_SERVICE_SECRET: 'dedicated-secret'
    },
    () =>
      assert.deepEqual(configuredPriceService(), {
        apiUrl: 'https://price-api.example/api/prices',
        secret: 'dedicated-secret'
      })
  );
});

test('price batch uses POST Bearer contract and requires a complete response', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return {
          success: true,
          complete: true,
          count: 1,
          prices: [{ goodsNo: 'A000000154189', priceToPay: 27900, originalPrice: 32000 }]
        };
      }
    };
  };
  try {
    const result = await fetchPriceBatch(
      { apiUrl: 'https://price-api.example/api/prices', secret: 'service-secret' },
      ['A000000154189']
    );
    assert.equal(result.complete, true);
    assert.equal(result.prices.A000000154189.priceToPay, 27900);
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers.Authorization, 'Bearer service-secret');
    assert.deepEqual(JSON.parse(request.options.body), { goodsNos: ['A000000154189'] });
  } finally {
    global.fetch = originalFetch;
  }
});

test('one 502 failed goods number is isolated with one bounded retry', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    const goodsNos = JSON.parse(options.body).goodsNos;
    requests.push(goodsNos);
    if (requests.length === 1) {
      return {
        ok: false,
        status: 502,
        async json() {
          return { success: false, failedGoodsNos: ['A000000154190'] };
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          complete: true,
          count: 1,
          prices: [{ goodsNo: 'A000000154189', priceToPay: 27900 }]
        };
      }
    };
  };
  try {
    const result = await fetchPriceBatch(
      { apiUrl: 'https://price-api.example/api/prices', secret: 'service-secret' },
      ['A000000154189', 'A000000154190']
    );
    assert.equal(result.complete, true);
    assert.equal(result.partial, true);
    assert.deepEqual(result.failedGoodsNos, ['A000000154190']);
    assert.deepEqual(requests, [
      ['A000000154189', 'A000000154190'],
      ['A000000154189']
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('503 never fans out retries even if its body names failed goods', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {
      ok: false,
      status: 503,
      async json() {
        return { failedGoodsNos: ['A000000154190'] };
      }
    };
  };
  try {
    const result = await fetchPriceBatch(
      { apiUrl: 'https://price-api.example/api/prices', secret: 'service-secret' },
      ['A000000154189', 'A000000154190']
    );
    assert.equal(result.complete, false);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('push target crossing is represented by one notification payload', () => {
  const payload = pushPayload({
    type: 'price-change',
    eventKey: 'TargetReachedEventKey12345',
    direction: 'down',
    goodsNo: 'A000000154189',
    goodsName: '어노브',
    imageUrl: '',
    previousPrice: 12000,
    currentPrice: 9000,
    targetPrice: 10000,
    targetReached: true,
    url: '/?q=test'
  });
  assert.equal(payload.type, 'price-change');
  assert.equal(payload.actions.length, 1);
  assert.equal(payload.actions[0].action, 'open-product');
  assert.match(payload.body, /목표가 10,000원 도달/);
});

test('option push identifies the option in title and body', () => {
  const payload = pushPayload({
    type: 'price-change',
    eventKey: 'OptionPriceEventKey123456',
    direction: 'up',
    alertId: 'A000000154189::101',
    goodsNo: 'A000000154189',
    goodsName: '어노브',
    optionNumber: '101',
    optionName: '딥 데미지 트리트먼트',
    previousPrice: 9000,
    currentPrice: 12000,
    targetPrice: 10000,
    targetReached: false,
    url: '/?q=test'
  });
  assert.equal(payload.title, '옵션 가격이 올랐어요');
  assert.match(payload.body, /어노브 · 딥 데미지 트리트먼트/);
});

test('hourly work counts option alerts separately but fetches one upstream goods row', () => {
  const work = collectActivePriceWork([
    {
      record: {
        deviceId: 'OptionDeviceIdentifier123',
        alerts: [
          { goodsNo: 'A000000154189', optionNumber: '101', enabled: true },
          { goodsNo: 'A000000154189', optionNumber: '102', enabled: true },
          { goodsNo: 'A000000154189', enabled: true }
        ],
        pendingNotifications: []
      }
    }
  ]);
  assert.equal(work.activeAlertCount, 3);
  assert.deepEqual(work.goodsNos, ['A000000154189']);
});

test('bounded mapper limits concurrent Blob or Push work', async () => {
  let active = 0;
  let maximum = 0;
  const result = await mapBounded([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(maximum, 3);
});

test('transient Push failure keeps outbox and the next cron retry removes it on success', async () => {
  let transient = true;
  const memory = inMemoryDeviceDependencies(queuedDeviceRecord(), async () => {
    if (transient) {
      const error = new Error('temporary');
      error.statusCode = 503;
      throw error;
    }
  });

  const first = await deliverPendingForDevice(
    'c07l6tBv1FLYwQdE6Rz7xA',
    memory.dependencies
  );
  assert.equal(first.errors, 1);
  assert.equal(memory.getState().pendingNotifications.length, 1);

  transient = false;
  const retry = await deliverPendingForDevice(
    'c07l6tBv1FLYwQdE6Rz7xA',
    memory.dependencies
  );
  assert.equal(retry.sent, 1);
  assert.equal(memory.getState().pendingNotifications.length, 0);
});

test('HTTP 410 removes attempted event and disables only the expired subscription', async () => {
  const memory = inMemoryDeviceDependencies(queuedDeviceRecord(), async () => {
    const error = new Error('gone');
    error.statusCode = 410;
    throw error;
  });
  const result = await deliverPendingForDevice(
    'c07l6tBv1FLYwQdE6Rz7xA',
    memory.dependencies
  );
  assert.equal(result.deactivated, 1);
  assert.equal(memory.getState().push.active, false);
  assert.equal(memory.getState().push.subscription, null);
  assert.equal(memory.getState().pendingNotifications.length, 0);
});
