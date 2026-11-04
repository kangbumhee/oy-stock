const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function json(value) { return JSON.parse(JSON.stringify(value)); }
function payload(label) { return { success: true, data: { products: [{ goodsNo: label }], estimates: {} } }; }
function response(status, data, etag) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => name.toLowerCase() === 'etag' ? etag || null : null },
    json: async () => {
      assert.notEqual(status, 304, '304 must not be parsed as a new JSON document');
      return json(data);
    }
  };
}
function loadClient(fetcher) {
  const context = vm.createContext({ fetch: fetcher, CONFIG: { HOT_RANK_SIZE: 128 }, Map, setTimeout, clearTimeout, AbortController });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/js/api.js'), 'utf8'), context);
  return context.API;
}

test('A to B to A validates the matching URL and reuses an isolated JSON body on 304', async () => {
  const requests = [];
  const replies = [response(200, payload('A'), 'W/"A"'), response(200, payload('B'), 'W/"B"'), response(304)];
  const api = loadClient(async (url, init) => { requests.push({ url, init }); return replies.shift(); });
  const original = await api.hotRanking(128, { range: '1d', category: '10000010001' });
  original.data.products[0].goodsNo = 'modified by renderer';
  await api.hotRanking(128, { range: '7d', category: '10000010002' });
  const again = await api.hotRanking(128, { range: '1d', category: '10000010001' });
  assert.deepEqual(json(again), payload('A'));
  assert.equal(requests.length, 3, 'no added local freshness interval may suppress revalidation');
  assert.equal(requests[2].url, requests[0].url);
  assert.equal(requests[2].init.headers['If-None-Match'], 'W/"A"');
});

test('changed content replaces the validator; signal and custom-window URL are preserved', async () => {
  const requests = [];
  const replies = [response(200, payload('A'), '"one"'), response(200, payload('B'), '"two"'), response(304)];
  const api = loadClient(async (url, init) => { requests.push({ url, init }); return replies.shift(); });
  const signal = new AbortController().signal;
  const opts = { hours: 5, categoryId: '10000010001', signal };
  await api.hotRanking(7, opts);
  await api.hotRanking(7, opts);
  const third = await api.hotRanking(7, opts);
  assert.deepEqual(json(third), payload('B'));
  assert.match(requests[0].url, /size=7&hours=5&category=10000010001$/);
  assert.equal(requests[2].init.headers['If-None-Match'], '"two"');
  assert.equal(requests[2].init.signal, signal);
});

test('authentication or network failure never returns an old ranking snapshot', async () => {
  const requests = [];
  const replies = [response(200, payload('old'), '"old"'), response(401, { success: false, error: 'auth required' }), response(200, payload('new'), '"new"')];
  const api = loadClient(async (url, init) => { requests.push({ url, init }); return replies.shift(); });
  api.viewRanking = async () => ({ success: true, fallback: true });
  await api.hotRanking(1, { range: '1d' });
  assert.deepEqual(await api.hotRanking(1, { range: '1d' }), { success: true, fallback: true });
  await api.hotRanking(1, { range: '1d' });
  assert.equal(requests[2].init, undefined, 'failed snapshot must be removed');
});

test('unexpected cacheless 304 retries once without a validator', async () => {
  const requests = [];
  const replies = [response(304), response(200, payload('fresh'), '"fresh"')];
  const api = loadClient(async (url, init) => { requests.push({ url, init }); return replies.shift(); });
  assert.deepEqual(json(await api.hotRanking(1, {})), payload('fresh'));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init, undefined);
  assert.equal(requests[1].init, undefined);
});

test('a repeated cacheless 304 uses the existing live-ranking fallback', async () => {
  let calls = 0;
  const api = loadClient(async () => { calls += 1; return response(304); });
  api.viewRanking = async () => ({ success: true, fallback: true });
  assert.deepEqual(await api.hotRanking(1, {}), { success: true, fallback: true });
  assert.equal(calls, 2);
});

test('entry count and total serialized characters bound the cache', async () => {
  const requests = [];
  const api = loadClient(async (url, init) => { requests.push({ url, init }); return response(200, payload(url), '"etag"'); });
  api.HOT_RANK_RESPONSE_CACHE_LIMIT = 2;
  await api.hotRanking(1, { range: '1d' });
  await api.hotRanking(1, { range: '7d' });
  await api.hotRanking(1, { range: '30d' });
  assert.equal(api._hotRankResponses.size, 2);
  await api.hotRanking(1, { range: '1d' });
  assert.equal(requests[3].init, undefined);
  api.HOT_RANK_RESPONSE_CACHE_CHARS = 1;
  await api.hotRanking(1, { range: '1d' });
  assert.equal(api._hotRankResponses.has(requests[3].url), false);
  assert.equal(api._hotRankResponseChars >= 0, true);
});

test('200 without ETag removes an obsolete validator instead of reusing it', async () => {
  const requests = [];
  const replies = [response(200, payload('A'), '"A"'), response(200, payload('B')), response(200, payload('C'), '"C"')];
  const api = loadClient(async (url, init) => { requests.push({ url, init }); return replies.shift(); });
  await api.hotRanking(1, {});
  await api.hotRanking(1, {});
  await api.hotRanking(1, {});
  assert.equal(requests[2].init, undefined);
});
