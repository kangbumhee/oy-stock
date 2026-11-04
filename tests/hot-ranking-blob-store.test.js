const test = require('node:test');
const assert = require('node:assert/strict');
const { createConditionalBlobStore } = require('../api/oliveyoung/_conditional-blob-store');

const PATHNAME = 'oliveyoung/hot-ranking-history.json';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function data(version) {
  return { version, products: { first: { observations: [{ total: version }] } }, runs: [] };
}

function full(value, etag) {
  return { statusCode: 200, stream: { text: JSON.stringify(value) }, blob: { etag } };
}

function notModified() {
  return { statusCode: 304, stream: null, blob: {} };
}

function harness({ results = [], getImpl, putImpl, readTextImpl } = {}) {
  const calls = [];
  const puts = [];
  const bodies = [];
  const store = createConditionalBlobStore({
    pathname: PATHNAME,
    emptyStore: () => ({ version: 1, products: {}, runs: [] }),
    get: async (pathname, options) => {
      calls.push({ pathname, options: { ...options } });
      if (getImpl) return getImpl(calls.length, options);
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result;
    },
    put: async (pathname, text, options) => {
      puts.push({ pathname, text, options });
      return putImpl ? putImpl() : { pathname };
    },
    readText: async stream => {
      bodies.push(stream);
      return readTextImpl ? readTextImpl(stream) : stream.text;
    }
  });
  return { store, calls, puts, bodies };
}

test('a second collector read validates the latest version without downloading an unchanged body', async () => {
  const first = data(1);
  const h = harness({ results: [full(first, '"v1"'), notModified(), notModified()] });
  const reports = [];
  const a = await h.store.read({ onRead: info => reports.push(info) });
  a.products.first.observations[0].total = 999;
  const b = await h.store.read({ onRead: info => reports.push(info) });
  b.runs.push('collector-local-change');
  const c = await h.store.read();
  assert.deepEqual(b.products, first.products);
  assert.deepEqual(c, first);
  assert.notStrictEqual(b, c);
  assert.equal(h.bodies.length, 1);
  assert.deepEqual(h.calls.map(call => call.options), [
    { access: 'private', useCache: false },
    { access: 'private', useCache: false, ifNoneMatch: '"v1"' },
    { access: 'private', useCache: false, ifNoneMatch: '"v1"' }
  ]);
  assert.ok(h.calls.every(call => call.pathname === PATHNAME));
  assert.deepEqual(reports, [
    { statusCode: 200, bodyBytes: Buffer.byteLength(JSON.stringify(first)) },
    { statusCode: 304, bodyBytes: 0 }
  ]);
});

test('changed content and its validator replace the old pair together', async () => {
  const h = harness({ results: [full(data(1), '"v1"'), full(data(2), '"v2"'), notModified()] });
  await h.store.read();
  assert.deepEqual(await h.store.read(), data(2));
  assert.deepEqual(await h.store.read(), data(2));
  assert.equal(h.calls[2].options.ifNoneMatch, '"v2"');
});

test('a cold 304 retries unconditionally once and never invents an empty store', async () => {
  const h = harness({ results: [notModified(), full(data(2), '"v2"'), notModified()] });
  assert.deepEqual(await h.store.read(), data(2));
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => !('ifNoneMatch' in call.options)));
  assert.deepEqual(await h.store.read(), data(2));
  assert.equal(h.calls[2].options.ifNoneMatch, '"v2"');
  const invalid = harness({ results: [notModified(), notModified()] });
  await assert.rejects(invalid.store.read(), /read failed/);
  assert.equal(invalid.calls.length, 2);
});

test('missing Blob clears the prior validator and returns a fresh empty store', async t => {
  const missing = new Error('missing');
  missing.name = 'BlobNotFoundError';
  for (const [name, response] of [['SDK null', null], ['SDK exception', missing]]) {
    await t.test(name, async () => {
      const h = harness({ results: [full(data(1), '"v1"'), response, full(data(3), '"v3"')] });
      await h.store.read();
      assert.deepEqual(await h.store.read(), { version: 1, products: {}, runs: [] });
      assert.deepEqual(await h.store.read(), data(3));
      assert.equal(h.calls[2].options.ifNoneMatch, undefined);
    });
  }
});

test('failed or invalid responses do not return stale data or keep its validator', async t => {
  const cases = [
    ['network error', new Error('connection reset')],
    ['unexpected status', { statusCode: 503, stream: null }],
    ['missing stream', { statusCode: 200, stream: null }],
    ['empty body', { statusCode: 200, stream: { text: '' }, blob: {} }],
    ['malformed JSON', { statusCode: 200, stream: { text: '{' }, blob: {} }],
    ['null JSON', full(null, '"bad"')],
    ['array JSON', full([], '"bad"')],
    ['primitive JSON', full(3, '"bad"')]
  ];
  for (const [name, response] of cases) {
    await t.test(name, async () => {
      const h = harness({ results: [full(data(1), '"v1"'), response, full(data(3), '"v3"')] });
      await h.store.read();
      await assert.rejects(h.store.read());
      assert.deepEqual(await h.store.read(), data(3));
      assert.equal(h.calls[2].options.ifNoneMatch, undefined);
    });
  }
});

test('a body stream failure is propagated and cannot fall back to old content', async () => {
  const h = harness({
    results: [full(data(1), '"v1"'), { statusCode: 200, stream: { fail: true } }, full(data(3), '"v3"')],
    readTextImpl: stream => {
      if (stream.fail) throw new Error('stream failed');
      return stream.text;
    }
  });
  await h.store.read();
  await assert.rejects(h.store.read(), /stream failed/);
  assert.deepEqual(await h.store.read(), data(3));
  assert.equal(h.calls[2].options.ifNoneMatch, undefined);
});

test('responses without a validator are usable but never become conditional cache entries', async () => {
  const h = harness({ results: [full(data(1)), full(data(2))] });
  assert.deepEqual(await h.store.read(), data(1));
  assert.deepEqual(await h.store.read(), data(2));
  assert.ok(h.calls.every(call => !('ifNoneMatch' in call.options)));
});

test('an old 304 returns its own snapshot without overwriting a concurrent new 200', async () => {
  const slow = deferred();
  const h = harness({ results: [full(data(1), '"v1"'), slow.promise, full(data(2), '"v2"'), notModified()] });
  await h.store.read();
  const old = h.store.read();
  assert.deepEqual(await h.store.read(), data(2));
  slow.resolve(notModified());
  assert.deepEqual(await old, data(1));
  assert.deepEqual(await h.store.read(), data(2));
  assert.equal(h.calls[3].options.ifNoneMatch, '"v2"');
});

test('a slow older 200 cannot replace the validator from a later completed read', async () => {
  const slow = deferred();
  const h = harness({ results: [full(data(1), '"v1"'), slow.promise, full(data(3), '"v3"'), notModified()] });
  await h.store.read();
  const old = h.store.read();
  assert.deepEqual(await h.store.read(), data(3));
  slow.resolve(full(data(2), '"v2"'));
  assert.deepEqual(await old, data(2));
  assert.deepEqual(await h.store.read(), data(3));
  assert.equal(h.calls[3].options.ifNoneMatch, '"v3"');
});

test('a later 304 prevents an earlier 200 response from installing a superseded cache snapshot', async () => {
  const slow = deferred();
  const h = harness({ results: [full(data(1), '"v1"'), slow.promise, notModified(), notModified()] });
  await h.store.read();
  const old = h.store.read();
  assert.deepEqual(await h.store.read(), data(1));
  slow.resolve(full(data(2), '"v2"'));
  await old;
  assert.deepEqual(await h.store.read(), data(1));
  assert.equal(h.calls[3].options.ifNoneMatch, '"v1"');
});

test('overlapping cold reads remain distinct latest-version checks', async () => {
  const slow = deferred();
  const h = harness({ results: [slow.promise, full(data(2), '"v2"'), notModified()] });
  const a = h.store.read();
  const b = h.store.read();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(await b, data(2));
  slow.resolve(full(data(1), '"v1"'));
  assert.deepEqual(await a, data(1));
  assert.deepEqual(await h.store.read(), data(2));
  assert.equal(h.calls[2].options.ifNoneMatch, '"v2"');
});

test('an older failing read cannot clear a more recent successful cache entry', async () => {
  const slow = deferred();
  const h = harness({ results: [full(data(1), '"v1"'), slow.promise, full(data(3), '"v3"'), notModified()] });
  await h.store.read();
  const old = h.store.read();
  const rejected = assert.rejects(old, /connection reset/);
  await h.store.read();
  slow.reject(new Error('connection reset'));
  await rejected;
  assert.deepEqual(await h.store.read(), data(3));
  assert.equal(h.calls[3].options.ifNoneMatch, '"v3"');
});

for (const outcome of ['success', 'failure']) {
  test(`write ${outcome} invalidates both before put and after settlement`, async () => {
    const pendingPut = deferred();
    const h = harness({
      results: [full(data(1), '"v1"'), full(data(2), '"during"'), full(data(3), '"after"')],
      putImpl: () => pendingPut.promise
    });
    await h.store.read();
    const written = data(9);
    const write = h.store.write(written);
    const settled = outcome === 'failure' ? assert.rejects(write, /write failed/) : write;
    assert.deepEqual(await h.store.read(), data(2));
    assert.equal(h.calls[1].options.ifNoneMatch, undefined);
    if (outcome === 'failure') pendingPut.reject(new Error('write failed'));
    else pendingPut.resolve({ pathname: PATHNAME });
    await settled;
    assert.deepEqual(await h.store.read(), data(3));
    assert.equal(h.calls[2].options.ifNoneMatch, undefined);
    assert.deepEqual(h.puts, [{
      pathname: PATHNAME,
      text: JSON.stringify(written),
      options: { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 }
    }]);
  });

  test(`a read begun before write ${outcome} cannot repopulate cache after that write`, async () => {
    const slow = deferred();
    const pendingPut = deferred();
    const h = harness({
      results: [full(data(1), '"v1"'), slow.promise, full(data(3), '"after"'), notModified()],
      putImpl: () => pendingPut.promise
    });
    await h.store.read();
    const old = h.store.read();
    const write = h.store.write(data(2));
    const settled = outcome === 'failure' ? assert.rejects(write, /write failed/) : write;
    if (outcome === 'failure') pendingPut.reject(new Error('write failed'));
    else pendingPut.resolve({ pathname: PATHNAME });
    await settled;
    slow.resolve(full(data(1), '"old"'));
    await old;
    assert.deepEqual(await h.store.read(), data(3));
    assert.equal(h.calls[2].options.ifNoneMatch, undefined);
    assert.deepEqual(await h.store.read(), data(3));
    assert.equal(h.calls[3].options.ifNoneMatch, '"after"');
  });

  test(`a read begun while write ${outcome} is in flight cannot repopulate cache after settlement`, async () => {
    const slow = deferred();
    const pendingPut = deferred();
    const h = harness({
      results: [full(data(1), '"v1"'), slow.promise, full(data(3), '"after"')],
      putImpl: () => pendingPut.promise
    });
    await h.store.read();
    const write = h.store.write(data(2));
    const settled = outcome === 'failure' ? assert.rejects(write, /write failed/) : write;
    const during = h.store.read();
    assert.equal(h.calls[1].options.ifNoneMatch, undefined);
    if (outcome === 'failure') pendingPut.reject(new Error('write failed'));
    else pendingPut.resolve({ pathname: PATHNAME });
    await settled;
    slow.resolve(full(data(1), '"during"'));
    await during;
    assert.deepEqual(await h.store.read(), data(3));
    assert.equal(h.calls[2].options.ifNoneMatch, undefined);
  });
}
