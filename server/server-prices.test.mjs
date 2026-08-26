import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OY_SERVER_DISABLE_START = '1';
process.env.PRICE_ALERT_SERVICE_SECRET = 'price-test-secret';
process.env.CRON_SECRET = 'cron-test-secret';

const {
  calculatePriceStartAt,
  priceFromOfficialDetail,
  publicFieldsFromStockOption,
  server,
  shouldRetryPriceDetailResult
} = await import('./server.mjs');

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function priceRequest({ method = 'POST', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(origin + '/api/prices', {
    method,
    headers,
    body: body === undefined ? undefined : body
  });
}

test('price endpoint is POST only and requires its dedicated service secret', async () => {
  const wrongMethod = await priceRequest({ method: 'GET' });
  assert.equal(wrongMethod.status, 405);

  const missing = await priceRequest({ body: JSON.stringify({ goodsNos: ['A1'] }) });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error, 'unauthorized');

  const cronSecret = await priceRequest({
    token: 'cron-test-secret',
    body: JSON.stringify({ goodsNos: ['A1'] })
  });
  assert.equal(cronSecret.status, 401);
  assert.equal((await cronSecret.json()).error, 'unauthorized');
});

test('price endpoint validates JSON and the atomic batch boundary before lookup', async () => {
  const invalidJson = await priceRequest({ token: 'price-test-secret', body: '{' });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).error, 'invalid_json');

  const empty = await priceRequest({
    token: 'price-test-secret',
    body: JSON.stringify({ goodsNos: [] })
  });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, 'goodsNos_required');

  const tooShort = await priceRequest({
    token: 'price-test-secret',
    body: JSON.stringify({ goodsNos: ['A1'] })
  });
  assert.equal(tooShort.status, 400);
  assert.equal((await tooShort.json()).error, 'goodsNos_invalid');

  const tooMany = await priceRequest({
    token: 'price-test-secret',
    body: JSON.stringify({
      goodsNos: Array.from({ length: 51 }, (_, index) => `A${index + 1}`)
    })
  });
  assert.equal(tooMany.status, 400);
  assert.equal((await tooMany.json()).error, 'goodsNos_limit_exceeded');
});

test('maps only finalPrice and salePrice from the official detail response', () => {
  assert.deepEqual(
    priceFromOfficialDetail('A000000253724', {
      data: {
        finalPrice: 37200,
        salePrice: 64000,
        maxBenefitPrice: 29900
      }
    }),
    {
      goodsNo: 'A000000253724',
      priceToPay: 37200,
      originalPrice: 64000,
      options: []
    }
  );
  assert.equal(
    priceFromOfficialDetail('A000000253724', {
      data: { finalPrice: 0, salePrice: 64000, maxBenefitPrice: 29900 }
    }),
    null
  );
  assert.equal(
    priceFromOfficialDetail('A000000253724', {
      data: { finalPrice: 37200, maxBenefitPrice: 29900 }
    }),
    null
  );
});

test('normalizes complete official option prices without conditional benefit prices', () => {
  assert.deepEqual(
    priceFromOfficialDetail('A000000253724', {
      data: {
        finalPrice: 37200,
        salePrice: 64000,
        options: [
          {
            optionNumber: 100123,
            optionName: ' 01호 ',
            finalPrice: 12900,
            salePrice: 15900,
            maxBenefitPrice: 9900,
            soldOut: false
          },
          {
            optionNumber: '100124',
            optionName: '02호',
            finalPrice: '13,900',
            salePrice: '15,900',
            soldOut: true
          }
        ]
      }
    }),
    {
      goodsNo: 'A000000253724',
      priceToPay: 37200,
      originalPrice: 64000,
      options: [
        {
          optionNumber: '100123',
          optionName: '01호',
          priceToPay: 12900,
          originalPrice: 15900,
          soldOut: false
        },
        {
          optionNumber: '100124',
          optionName: '02호',
          priceToPay: 13900,
          originalPrice: 15900,
          soldOut: true
        }
      ]
    }
  );
  assert.deepEqual(
    priceFromOfficialDetail('A000000253724', {
      data: { finalPrice: 37200, salePrice: 64000, options: null }
    }),
    {
      goodsNo: 'A000000253724',
      priceToPay: 37200,
      originalPrice: 64000,
      options: []
    }
  );
});

test('rejects malformed or ambiguous present official option data atomically', () => {
  const validBase = { finalPrice: 12000, salePrice: 15000 };
  const validOption = {
    optionNumber: '100123',
    optionName: '01호',
    finalPrice: 12000,
    salePrice: 15000,
    soldOut: false
  };

  assert.equal(
    priceFromOfficialDetail('A000000253724', {
      data: { ...validBase, options: { 0: validOption } }
    }),
    null
  );
  for (const invalidOption of [
    { ...validOption, optionNumber: '' },
    { ...validOption, optionName: '' },
    { ...validOption, finalPrice: 0 },
    { ...validOption, salePrice: null },
    { ...validOption, soldOut: 'N' }
  ]) {
    assert.equal(
      priceFromOfficialDetail('A000000253724', {
        data: { ...validBase, options: [validOption, invalidOption] }
      }),
      null
    );
  }
  assert.equal(
    priceFromOfficialDetail('A000000253724', {
      data: { ...validBase, options: [validOption, { ...validOption }] }
    }),
    null
  );
});

test('maps only available public option fields from stock option rows', () => {
  assert.deepEqual(
    publicFieldsFromStockOption({
      itemNumber: 100123,
      legacyItemNumber: 'legacy-1',
      priceToPay: '12,900',
      originalPrice: 15900,
      soldOutYn: 'N'
    }),
    {
      optionNumber: '100123',
      priceToPay: 12900,
      originalPrice: 15900,
      soldOut: false
    }
  );
  assert.deepEqual(
    publicFieldsFromStockOption({
      legacyItemNumber: 'legacy-only',
      finalPrice: 0,
      salePrice: 15900,
      soldOutYn: 'unknown'
    }),
    { originalPrice: 15900 }
  );
});

test('never retries 429 and retries only network or 5xx once', () => {
  assert.equal(shouldRetryPriceDetailResult({ status: 429 }, 0), false);
  assert.equal(shouldRetryPriceDetailResult({ status: 400 }, 0), false);
  assert.equal(shouldRetryPriceDetailResult({ status: 0 }, 0), true);
  assert.equal(shouldRetryPriceDetailResult({ status: 503 }, 0), true);
  assert.equal(shouldRetryPriceDetailResult({ status: 0 }, 1), false);
  assert.equal(shouldRetryPriceDetailResult({ status: 503 }, 1), false);
});

test('paces fifty detail requests under the observed upstream minute limit', () => {
  const starts = [];
  for (let index = 0; index < 50; index += 1) {
    starts.push(calculatePriceStartAt(0, starts, 1000, 20, 60000));
  }

  assert.equal(starts[0], 0);
  assert.equal(starts[19], 19000);
  assert.equal(starts[20], 60000);
  assert.equal(starts[40], 120000);
  assert.equal(starts[49], 129000);
  assert.ok(starts[49] < 180000);
});
