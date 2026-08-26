const test = require('node:test');
const assert = require('node:assert/strict');

const {
  configuredDeviceRoot,
  normalizeStoreNamespace
} = require('../api/price-alerts/_store');

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

test('Blob device roots isolate production and preview automatically', () => {
  withEnv({ PRICE_ALERT_STORE_NAMESPACE: null, VERCEL_ENV: 'production' }, () => {
    assert.equal(
      configuredDeviceRoot(),
      'oliveyoung/price-alerts/v1/production/devices/'
    );
  });
  withEnv({ PRICE_ALERT_STORE_NAMESPACE: null, VERCEL_ENV: 'preview' }, () => {
    assert.equal(configuredDeviceRoot(), 'oliveyoung/price-alerts/v1/preview/devices/');
  });
});

test('explicit Blob namespace wins and path characters are normalized safely', () => {
  withEnv(
    { PRICE_ALERT_STORE_NAMESPACE: 'Tenant / Korea .. Production', VERCEL_ENV: 'preview' },
    () => {
      assert.equal(
        configuredDeviceRoot(),
        'oliveyoung/price-alerts/v1/tenant-korea-production/devices/'
      );
    }
  );
  assert.equal(normalizeStoreNamespace('../../'), 'production');
});
