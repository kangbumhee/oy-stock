import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHiddenOfficialTransport } from './hidden-official-transport.mjs';

const STOCK = 'https://www.oliveyoung.co.kr';
const REVIEW = 'https://m.oliveyoung.co.kr';
const GOODS = 'A000000255680';
const stockInput = { method: 'POST', path: '/oystore/api/stock/stock-goods-info-option', body: { goodsNo: GOODS } };
const reviewInput = { method: 'POST', path: '/review/api/v2/reviews/cursor', body: {
  goodsNumber: GOODS, page: 0, size: 10, sortType: 'USEFUL_SCORE_DESC', reviewType: 'ALL', itemNumberList: ['001']
} };

function fixture({ origin = STOCK, payload = { status: 'SUCCESS', code: 200, data: {} }, raw,
  chunks, responseOrigin, advertisedLength, status = 200, evaluate, fetchImpl, current = () => true, ...settings } = {}) {
  const calls = [];
  let cancelCount = 0;
  const page = {
    isClosed: () => false,
    url: () => origin + '/',
    evaluate: evaluate || (async (fn, args) => {
      calls.push(args);
      const fetch = fetchImpl || (async (url, options) => {
        calls.push({ url, options });
        const values = chunks || [new TextEncoder().encode(raw === undefined ? JSON.stringify(payload) : raw)];
        let position = 0;
        return {
          ok: status >= 200 && status < 300,
          url: (responseOrigin || origin) + '/verified',
          headers: new Headers(advertisedLength == null ? {} : { 'content-length': String(advertisedLength) }),
          body: { getReader: () => ({
            read: async () => position < values.length ? { done: false, value: values[position++] } : { done: true },
            cancel: async () => { cancelCount++; },
            releaseLock: () => {}
          }) }
        };
      });
      const fnInBrowser = vm.runInNewContext('(' + fn.toString() + ')', {
        location: { origin }, fetch, URL, Uint8Array, TextDecoder, AbortController, setTimeout, clearTimeout
      });
      return fnInBrowser(args);
    })
  };
  const work = { page, generation: 7 };
  const transport = createHiddenOfficialTransport({
    stockPage: async () => work,
    reviewPage: async () => work,
    isCurrent: current,
    ...settings
  });
  return { transport, calls, work, cancelled: () => cancelCount };
}

test('read-only stock requests stay on the stock origin with bounded private fetch settings', async () => {
  const { transport, calls } = fixture({ timeoutMs: 90000, maxBytes: 90000000 });
  const result = await transport(stockInput);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(calls[0].timeoutMs, 5000);
  assert.equal(calls[0].maxBytes, 2 * 1024 * 1024);
  assert.equal(calls[1].url, STOCK + stockInput.path);
  assert.equal(calls[1].options.credentials, 'include');
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[1].options.cache, 'no-store');
  assert.equal('Cookie' in calls[1].options.headers, false);
});

test('review requests use the dedicated mobile origin and preserve the verified first-page filter', async () => {
  const { transport, calls } = fixture({ origin: REVIEW });
  await transport(reviewInput);
  assert.equal(calls[1].url, REVIEW + reviewInput.path);
  assert.equal(JSON.parse(calls[1].options.body).itemNumberList[0], '001');
  await transport({ method: 'GET', path: '/review/api/v2/reviews/options/' + GOODS + '/count' });
  assert.equal(calls[3].options.body, undefined);
});

test('arbitrary paths, methods, headers, bodies and unverified continuation fail before browser acquisition', async () => {
  let acquired = 0;
  const request = createHiddenOfficialTransport({ stockPage: async () => { acquired++; }, isCurrent: () => true });
  for (const input of [
    { ...stockInput, method: 'DELETE' },
    { ...stockInput, path: 'https://attacker.example/read' },
    { ...stockInput, path: '/oystore/api/stock/stock-goods-info-option?redirect=elsewhere' },
    { ...stockInput, headers: { Cookie: 'not-allowed' } },
    { ...stockInput, body: { goodsNo: GOODS, order: true } },
    { ...stockInput, body: { goodsNo: '../secret' } },
    { ...reviewInput, body: { ...reviewInput.body, page: 1 } },
    { ...reviewInput, body: { ...reviewInput.body, cursorId: 123 } },
    { method: 'POST', path: '/purchase/api/order', body: {} }
  ]) await assert.rejects(request(input), /hidden_official_request_not_allowed/);
  assert.equal(acquired, 0);
});

test('the exact catalog and store-query read paths are allowed, with bounded paging', async () => {
  const { transport } = fixture();
  await transport({ method: 'POST', path: '/oystore/api/stock/product-search-v3', body: { includeSoldOut: true, keyword: '', page: 1, sort: '01', size: 20 } });
  const input = { method: 'POST', path: '/oystore/api/stock/stock-stores', body: {
    productId: '8800289469145', lat: 37.5665, lon: 126.978, pageIdx: 1, searchWords: '서울', mapLat: 37.5665, mapLon: 126.978
  } };
  await transport(input);
  await assert.rejects(transport({ ...input, body: { ...input.body, pageIdx: 99999 } }), /not_allowed/);
});

test('HTTP errors, invalid JSON, error statuses and cross-origin responses fail with generic messages', async () => {
  for (const scenario of [
    { status: 403, raw: 'private provider error Cookie secret' },
    { raw: '<html>private challenge</html>' },
    { payload: { status: 'ERROR', message: 'private provider contents' } },
    { payload: { status: 'SUCCESS', code: 403, data: {} } },
    { responseOrigin: REVIEW }
  ]) {
    await assert.rejects(fixture(scenario).transport(stockInput), (error) => error.message === 'hidden_official_unavailable');
  }
});

test('oversized content-length and streaming responses are rejected without exposing response text', async () => {
  const advertised = fixture({ advertisedLength: 500, maxBytes: 64 });
  await assert.rejects(advertised.transport(stockInput), /hidden_official_unavailable/);
  const streaming = fixture({ chunks: [new Uint8Array(40), new Uint8Array(40)], maxBytes: 64 });
  await assert.rejects(streaming.transport(stockInput), /hidden_official_unavailable/);
  assert.equal(streaming.cancelled(), 1);
});

test('wrong page origin and a replaced session cannot return apparently successful data', async () => {
  await assert.rejects(fixture({ origin: REVIEW }).transport(stockInput), /hidden_official_unavailable/);
  let currentChecks = 0;
  const stale = fixture({ current: () => ++currentChecks === 1 });
  await assert.rejects(stale.transport(stockInput), /hidden_official_unavailable/);
  assert.equal(currentChecks, 2);
});

test('page acquisition and evaluation are bounded and sanitize exceptions', async () => {
  const request = createHiddenOfficialTransport({ stockPage: () => new Promise(() => {}), isCurrent: () => true, pageAcquireTimeoutMs: 5 });
  await assert.rejects(request(stockInput), /hidden_official_unavailable/);
  await assert.rejects(fixture({ evaluate: () => new Promise(() => {}), timeoutMs: 5 }).transport(stockInput), /hidden_official_unavailable/);
  await assert.rejects(fixture({ evaluate: async () => { throw new Error('Cookie=private'); } }).transport(stockInput), (error) => error.message === 'hidden_official_unavailable');
});

test('private hidden route bypasses wildcard CORS even on unauthorized requests and preflight', async () => {
  process.env.OY_SERVER_DISABLE_START = '1';
  const { server } = await import('./server.mjs');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    for (const method of ['GET', 'OPTIONS']) {
      const response = await fetch(origin + '/api/hidden-stock?action=options&goodsNo=' + GOODS, { method });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal((await response.json()).error, 'service_auth_required');
    }
    const publicHealth = await fetch(origin + '/health');
    assert.equal(publicHealth.status, 200);
    assert.equal(publicHealth.headers.get('access-control-allow-origin'), '*');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('review bootstrap uses an isolated unsigned mobile context without changing the desktop stock session', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function ensureHiddenReviewPage()');
  const end = source.indexOf('\nfunction getHiddenStockHandler()', start);
  assert.ok(start >= 0 && end > start);
  let contexts = 0;
  let contextOptions;
  let currentUrl = 'about:blank';
  const publicPage = { isClosed: () => false, url: () => currentUrl, route: async () => {},
    goto: async url => { assert.equal(url, REVIEW + '/'); currentUrl = url; } };
  const publicContext = { newPage: async () => publicPage, close: async () => {},
    addCookies: () => { throw new Error('public reviews must not receive account cookies'); } };
  const sandbox = vm.createContext({ URL, OY_M: REVIEW, ensureSession: async () => {}, sessionGeneration: 7,
    hiddenReviewPage: null, hiddenReviewContext: null, hiddenReviewPageInitPromise: null,
    browser: { newContext: async options => { contexts++; contextOptions = options; return publicContext; } },
    browserContext: { newPage: () => { throw new Error('desktop stock context must remain separate'); } }
  });
  const bootstrap = vm.runInContext(source.slice(start, end) + '\nensureHiddenReviewPage;', sandbox);
  const [first, concurrent] = await Promise.all([bootstrap(), bootstrap()]);
  assert.equal(contexts, 1);
  assert.equal(contextOptions.isMobile, true);
  assert.match(contextOptions.userAgent, /Mobile/);
  assert.equal(contextOptions.viewport.width, 390);
  assert.equal('storageState' in contextOptions, false);
  assert.equal('extraHTTPHeaders' in contextOptions, false);
  assert.equal(first.page, publicPage);
  assert.equal(concurrent.page, publicPage);
  assert.equal(first.generation, 7);
  await bootstrap();
  assert.equal(contexts, 1);
});

test('review bootstrap still rejects redirects and replaced generations and closes its public context', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function ensureHiddenReviewPage()');
  const end = source.indexOf('\nfunction getHiddenStockHandler()', start);
  for (const mode of ['desktop-redirect', 'session-replaced']) {
    let closed = 0;
    let currentUrl = 'about:blank';
    let sandbox;
    const publicPage = { isClosed: () => false, url: () => currentUrl, route: async () => {}, goto: async () => {
      currentUrl = mode === 'desktop-redirect' ? STOCK + '/store/main/main.do?oy=0' : REVIEW + '/';
      if (mode === 'session-replaced') sandbox.sessionGeneration++;
    } };
    const publicContext = { newPage: async () => publicPage, close: async () => { closed++; } };
    sandbox = vm.createContext({ URL, OY_M: REVIEW, ensureSession: async () => {}, sessionGeneration: 7,
      hiddenReviewPage: null, hiddenReviewContext: null, hiddenReviewPageInitPromise: null,
      browser: { newContext: async () => publicContext } });
    const bootstrap = vm.runInContext(source.slice(start, end) + '\nensureHiddenReviewPage;', sandbox);
    await assert.rejects(bootstrap(), /hidden_review_page_unavailable/);
    assert.equal(closed, 1);
    assert.equal(sandbox.hiddenReviewPage, null);
  }
});
