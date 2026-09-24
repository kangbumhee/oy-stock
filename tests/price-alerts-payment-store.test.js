const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { BlobPreconditionFailedError } = require('@vercel/blob');
const { encryptJson, decryptJson } = require('../api/price-alerts/_crypto');
const { mutateIntent, readIntent } = require('../api/price-alerts/_payment-store');

const PAYMENT_ID = 'oypa_paymentStoreRegression123456789';

async function withDataKey(run) {
  const previous = process.env.PRICE_ALERT_DATA_KEY;
  process.env.PRICE_ALERT_DATA_KEY = '22'.repeat(32);
  try { await run(); } finally {
    if (previous === undefined) delete process.env.PRICE_ALERT_DATA_KEY;
    else process.env.PRICE_ALERT_DATA_KEY = previous;
  }
}

function initialIntent() {
  return {
    version: 1, revision: 1, paymentId: PAYMENT_ID,
    ownerDeviceId: 'SyntheticPaymentStoreDevice12345', status: 'created',
    contract: { amount: 30000, currency: 'KRW' },
    events: [{ type: 'created', reason: 'synthetic-large-record-'.repeat(80) }]
  };
}

test('payment CAS requests an identity representation and uses that exact GET validator', async () => {
  await withDataKey(async () => {
    let body = encryptJson(initialIntent());
    let strongEtag = '"original-body-version-1"';
    let gets = 0;
    let writes = 0;
    const saved = await mutateIntent(PAYMENT_ID, (intent) => {
      intent.status = 'prepared';
      return { changed: true, intent };
    }, {
      async get(_pathname, options) {
        gets += 1;
        assert.equal(options.useCache, false);
        const identity = options.headers['Accept-Encoding'] === 'identity';
        return { statusCode: 200, stream: Readable.from([body]),
          blob: { etag: identity ? strongEtag : `W/${strongEtag}` } };
      },
      async put(_pathname, nextBody, options) {
        writes += 1;
        assert.equal(options.allowOverwrite, true);
        if (options.ifMatch !== strongEtag) throw new BlobPreconditionFailedError();
        body = nextBody;
        strongEtag = '"original-body-version-2"';
        return { etag: strongEtag };
      }
    });
    assert.equal(gets, 1);
    assert.equal(writes, 1);
    assert.equal(saved.intent.status, 'prepared');
    assert.equal(decryptJson(body).revision, 2);
  });
});

test('weak or malformed ETags fail closed even when an identity representation was requested', async () => {
  await withDataKey(async () => {
    for (const etag of ['W/"weak-validator"', '', 'unquoted-validator', '"invalid\r\nvalidator"']) {
      let writes = 0;
      await assert.rejects(mutateIntent(PAYMENT_ID, (intent) => {
        intent.status = 'prepared';
        return { changed: true, intent };
      }, {
        async get(_pathname, options) {
          assert.equal(options.headers['Accept-Encoding'], 'identity');
          return { statusCode: 200, stream: Readable.from([encryptJson(initialIntent())]), blob: { etag } };
        },
        async put() { writes += 1; }
      }), /payment intent strong ETag required/);
      assert.equal(writes, 0);
    }
  });
});

test('a genuine concurrent payment update rereads both body and ETag before retrying', async () => {
  await withDataKey(async () => {
    let body = encryptJson(initialIntent());
    let etag = '"version-1"';
    let reads = 0;
    let writes = 0;
    const saved = await mutateIntent(PAYMENT_ID, (intent) => {
      intent.status = 'prepared';
      return { changed: true, intent };
    }, {
      async get() {
        reads += 1;
        return { statusCode: 200, stream: Readable.from([body]), blob: { etag } };
      },
      async put(_pathname, nextBody, options) {
        writes += 1;
        if (writes === 1) {
          const concurrent = decryptJson(body);
          concurrent.revision = 2;
          concurrent.concurrentMarker = 'must-survive';
          body = encryptJson(concurrent);
          etag = '"version-2"';
          throw new BlobPreconditionFailedError();
        }
        assert.equal(options.ifMatch, etag);
        assert.equal(decryptJson(nextBody).concurrentMarker, 'must-survive');
        body = nextBody;
        etag = '"version-3"';
        return { etag };
      }
    });
    assert.equal(reads, 2);
    assert.equal(writes, 2);
    assert.equal(saved.intent.revision, 3);
    assert.equal(saved.intent.concurrentMarker, 'must-survive');
  });
});
