import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const searchHandler = require('./search.js');
const {
  SEARCH_RECONCILIATION_GRACE_MS,
  buildOfficialCandidate,
  buildUpstreamCandidate,
  buildUnifiedPayload,
  buildUnavailablePayload,
  chooseRicherCandidate,
  fetchTextWithTimeout,
  getOfficialCookieHeader,
  isCacheableSearchPayload,
  mergeSearchProducts,
  parseOfficialTotalCount
} = searchHandler._test;

function products(count, prefix = 'A') {
  return Array.from({ length: count }, (_, index) => ({
    goodsNo: prefix + String(index + 1).padStart(4, '0'),
    goodsName: '상품 ' + (index + 1),
    priceToPay: 1000 + index
  }));
}

function upstreamResult(rows, totalCount, overrides = {}) {
  return {
    status: 200,
    parsed: {
      success: true,
      complete: true,
      incomplete: false,
      data: {
        totalCount,
        products: rows,
        inventory: { totalCount, products: rows },
        source: 'oliveyoung-official-cloud-run'
      },
      meta: { total: totalCount },
      ...overrides
    }
  };
}

function officialPayload(rows, totalCount) {
  return {
    Data: [
      {
        CollName: 'OLIVE_GOODS',
        TotalCount: String(totalCount),
        Result: rows.map((row) => ({
          GOODS_NO: row.goodsNo,
          GOODS_NM: row.goodsName,
          SALE_PRC: String(row.priceToPay || 1000)
        }))
      }
    ]
  };
}

async function invokeHandler(query) {
  const headers = {};
  const response = {
    statusCode: 0,
    body: '',
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = String(value);
    },
    end(value) {
      this.body = value == null ? '' : String(value);
    }
  };
  await searchHandler(
    {
      method: 'GET',
      query,
      headers: { host: 'localhost:3000', 'x-forwarded-proto': 'http' }
    },
    response
  );
  return { statusCode: response.statusCode, headers, body: JSON.parse(response.body) };
}

test('one official row cannot beat a complete 22-row upstream result', () => {
  const official = buildOfficialCandidate(
    {
      status: 200,
      products: products(1, 'O'),
      totalCount: 22,
      hasExplicitTotal: true,
      incomplete: false
    },
    '어노브',
    120
  );
  const upstream = buildUpstreamCandidate(upstreamResult(products(22, 'U'), 22), '어노브', 120);

  assert.equal(official.complete, false);
  assert.equal(upstream.complete, true);
  assert.equal(
    chooseRicherCandidate([official, upstream], (candidate) => candidate.complete),
    upstream
  );
});

test('official total count accepts only nonnegative safe integers', () => {
  assert.equal(parseOfficialTotalCount('0'), 0);
  assert.equal(parseOfficialTotalCount('22'), 22);
  assert.equal(parseOfficialTotalCount(22), 22);
  assert.equal(parseOfficialTotalCount('abc'), null);
  assert.equal(parseOfficialTotalCount('-1'), null);
  assert.equal(parseOfficialTotalCount('1.5'), null);
  assert.equal(parseOfficialTotalCount(String(Number.MAX_SAFE_INTEGER + 1)), null);
  assert.equal(
    buildOfficialCandidate(
      {
        status: 302,
        products: products(1),
        totalCount: 1,
        hasExplicitTotal: true,
        incomplete: false
      },
      '테스트',
      120
    ),
    null
  );
});

test('richer complete source wins even when the smaller source reports total 1', () => {
  const official = buildOfficialCandidate(
    {
      status: 200,
      products: products(1, 'O'),
      totalCount: 1,
      hasExplicitTotal: true,
      incomplete: false
    },
    '어노브',
    120
  );
  const upstream = buildUpstreamCandidate(upstreamResult(products(22, 'U'), 22), '어노브', 120);

  assert.equal(official.complete, true);
  assert.equal(upstream.complete, true);
  assert.equal(
    chooseRicherCandidate([official, upstream], (candidate) => candidate.complete),
    upstream
  );
});

test('handler waits for both sources, returns 22 instead of partial 1, and caches only that result', async () => {
  const originalFetch = global.fetch;
  const previousRefresh = process.env.OY_REFRESH_COOKIE;
  const keyword = '회귀테스트-1대22-' + Date.now();
  const upstreamRows = products(22, 'U');
  let fetchCalls = 0;
  process.env.OY_REFRESH_COOKIE = 'test-cookie';
  global.fetch = async (url) => {
    fetchCalls += 1;
    if (String(url).includes('NewMainSearchApi.do')) {
      return new Response(
        JSON.stringify(officialPayload([{ goodsNo: 'O0001', goodsName: '부분 상품' }], 22)),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, SEARCH_RECONCILIATION_GRACE_MS + 75)
    );
    return new Response(JSON.stringify(upstreamResult(upstreamRows, 22).parsed), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const first = await invokeHandler({ keyword, size: '120' });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['x-search-source'], 'products-primary');
    assert.equal(first.headers['x-cache'], 'MISS');
    assert.equal(first.body.complete, true);
    assert.equal(first.body.data.inventory.products.length, 22);

    const callsAfterFirst = fetchCalls;
    global.fetch = async () => {
      throw new Error('cache hit should not fetch');
    };
    const second = await invokeHandler({ keyword, size: '120' });
    assert.equal(second.statusCode, 200);
    assert.equal(second.headers['x-cache'], 'HIT');
    assert.equal(second.body.data.inventory.products.length, 22);
    assert.equal(fetchCalls, callsAfterFirst);
  } finally {
    global.fetch = originalFetch;
    if (previousRefresh == null) delete process.env.OY_REFRESH_COOKIE;
    else process.env.OY_REFRESH_COOKIE = previousRefresh;
  }
});

test('handler retries Cloud Run after a 429 and uses the following complete 200 response', async () => {
  const originalFetch = global.fetch;
  const previousRefresh = process.env.OY_REFRESH_COOKIE;
  const keyword = '회귀테스트-429재시도-' + Date.now();
  const upstreamRows = products(22, 'R');
  let upstreamCalls = 0;
  process.env.OY_REFRESH_COOKIE = 'test-cookie';
  global.fetch = async (url) => {
    if (String(url).includes('NewMainSearchApi.do')) {
      return new Response(JSON.stringify({ error: 'official unavailable' }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      });
    }
    upstreamCalls += 1;
    if (upstreamCalls === 1) {
      return new Response(JSON.stringify(upstreamResult(products(1, 'X'), 1).parsed), {
        status: 429,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify(upstreamResult(upstreamRows, 22).parsed), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const result = await invokeHandler({ keyword, size: '120' });
    assert.equal(upstreamCalls, 2);
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['x-search-source'], 'products-primary');
    assert.equal(result.body.data.inventory.products.length, 22);
  } finally {
    global.fetch = originalFetch;
    if (previousRefresh == null) delete process.env.OY_REFRESH_COOKIE;
    else process.env.OY_REFRESH_COOKIE = previousRefresh;
  }
});

test('malformed official TotalCount is never cached or returned as a normal 200', async () => {
  const originalFetch = global.fetch;
  const previousRefresh = process.env.OY_REFRESH_COOKIE;
  const keyword = '회귀테스트-잘못된합계-' + Date.now();
  let fetchCalls = 0;
  process.env.OY_REFRESH_COOKIE = 'test-cookie';
  global.fetch = async (url) => {
    fetchCalls += 1;
    if (String(url).includes('NewMainSearchApi.do')) {
      return new Response(
        JSON.stringify(
          officialPayload([{ goodsNo: 'OBAD1', goodsName: '합계 오류 상품' }], 'abc')
        ),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ success: false, error: 'unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const first = await invokeHandler({ keyword, size: '120' });
    assert.equal(first.statusCode, 503);
    assert.equal(first.headers['x-cache'], 'BYPASS');
    assert.equal(first.body.success, false);
    assert.equal(first.body.error, 'search_temporarily_unavailable');
    assert.equal(first.body.incomplete, true);

    const callsAfterFirst = fetchCalls;
    const second = await invokeHandler({ keyword, size: '120' });
    assert.equal(second.statusCode, 503);
    assert.equal(second.headers['x-cache'], 'BYPASS');
    assert.ok(fetchCalls > callsAfterFirst);
  } finally {
    global.fetch = originalFetch;
    if (previousRefresh == null) delete process.env.OY_REFRESH_COOKIE;
    else process.env.OY_REFRESH_COOKIE = previousRefresh;
  }
});

test('a non-2xx follow-up official page cannot make a result complete', async () => {
  const originalFetch = global.fetch;
  const previousRefresh = process.env.OY_REFRESH_COOKIE;
  const keyword = '회귀테스트-후속302-' + Date.now();
  const firstRows = products(48, 'F');
  const laterRows = products(7, 'L');
  process.env.OY_REFRESH_COOKIE = 'test-cookie';
  global.fetch = async (url, init) => {
    if (String(url).includes('NewMainSearchApi.do')) {
      const startCount = Number(init.body.get('startCount'));
      return new Response(
        JSON.stringify(officialPayload(startCount === 0 ? firstRows : laterRows, 55)),
        {
          status: startCount === 0 ? 200 : 302,
          headers: { 'content-type': 'application/json' }
        }
      );
    }
    return new Response(JSON.stringify({ success: false, error: 'unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const result = await invokeHandler({ keyword, size: '55' });
    assert.equal(result.statusCode, 503);
    assert.equal(result.headers['x-cache'], 'BYPASS');
    assert.equal(result.body.incomplete, true);
    assert.equal(result.body.data.inventory.products.length, 48);
  } finally {
    global.fetch = originalFetch;
    if (previousRefresh == null) delete process.env.OY_REFRESH_COOKIE;
    else process.env.OY_REFRESH_COOKIE = previousRefresh;
  }
});

test('fast complete official result aborts a hanging upstream after the reconciliation grace', async () => {
  const originalFetch = global.fetch;
  const previousRefresh = process.env.OY_REFRESH_COOKIE;
  const keyword = '회귀테스트-빠른공식-' + Date.now();
  let upstreamAborted = false;
  process.env.OY_REFRESH_COOKIE = 'test-cookie';
  global.fetch = async (url, init) => {
    if (String(url).includes('NewMainSearchApi.do')) {
      return new Response(
        JSON.stringify(officialPayload([{ goodsNo: 'OFAST1', goodsName: '빠른 공식 상품' }], 1)),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        upstreamAborted = true;
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (init && init.signal && init.signal.aborted) abort();
      else if (init && init.signal) init.signal.addEventListener('abort', abort, { once: true });
    });
  };

  const startedAt = Date.now();
  try {
    const result = await invokeHandler({ keyword, size: '120' });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['x-search-source'], 'official-search');
    assert.equal(result.body.data.inventory.products.length, 1);
    assert.equal(upstreamAborted, true);
    assert.ok(
      elapsedMs < SEARCH_RECONCILIATION_GRACE_MS + 1000,
      'response took ' + elapsedMs + 'ms'
    );
  } finally {
    global.fetch = originalFetch;
    if (previousRefresh == null) delete process.env.OY_REFRESH_COOKIE;
    else process.env.OY_REFRESH_COOKIE = previousRefresh;
  }
});

test('fetch timeout remains active while response.text() is stalled', async () => {
  const originalFetch = global.fetch;
  let bodyAborted = false;
  global.fetch = async (_url, init) => ({
    status: 200,
    text() {
      return new Promise((resolve, reject) => {
        const abort = () => {
          bodyAborted = true;
          const error = new Error('body aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort, { once: true });
      });
    }
  });

  const startedAt = Date.now();
  try {
    await assert.rejects(
      fetchTextWithTimeout('https://example.test/body-stall', {}, 30),
      (error) => error && error.name === 'AbortError'
    );
    assert.equal(bodyAborted, true);
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    global.fetch = originalFetch;
  }
});

test('partial and supplement-only payloads are never cacheable', () => {
  const partialRows = products(16);
  const partial = {
    success: true,
    complete: false,
    incomplete: true,
    data: {
      totalCount: 348,
      products: partialRows,
      inventory: { totalCount: 348, products: partialRows },
      source: 'products-primary'
    }
  };
  const supplementOnly = buildUnifiedPayload(
    products(1, 'S'),
    '테스트',
    'search-supplement',
    null,
    null,
    { totalCount: 1 }
  );
  const complete = buildUnifiedPayload(
    products(22),
    '어노브',
    'products-primary',
    null,
    null,
    { totalCount: 22 }
  );

  assert.equal(isCacheableSearchPayload(partial, 120), false);
  assert.equal(isCacheableSearchPayload(supplementOnly, 120), false);
  assert.equal(isCacheableSearchPayload(complete, 120), true);
});

test('handler returns 503 and re-fetches when every source is partial', async () => {
  const originalFetch = global.fetch;
  const previousRefresh = process.env.OY_REFRESH_COOKIE;
  const keyword = '회귀테스트-부분응답-' + Date.now();
  const partialRows = products(16, 'P');
  let fetchCalls = 0;
  process.env.OY_REFRESH_COOKIE = 'test-cookie';
  global.fetch = async (url) => {
    fetchCalls += 1;
    if (String(url).includes('NewMainSearchApi.do')) {
      return new Response(
        JSON.stringify(officialPayload([{ goodsNo: 'O0001', goodsName: '부분 상품' }], 22)),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify(upstreamResult(partialRows, 22).parsed), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const first = await invokeHandler({ keyword, size: '120' });
    assert.equal(first.statusCode, 503);
    assert.equal(first.headers['x-cache'], 'BYPASS');
    assert.equal(first.body.success, false);
    assert.equal(first.body.error, 'search_temporarily_unavailable');
    assert.equal(first.body.incomplete, true);
    assert.equal(first.body.data.inventory.products.length, 16);

    const callsAfterFirst = fetchCalls;
    const second = await invokeHandler({ keyword, size: '120' });
    assert.equal(second.statusCode, 503);
    assert.equal(second.headers['x-cache'], 'BYPASS');
    assert.ok(fetchCalls > callsAfterFirst);
  } finally {
    global.fetch = originalFetch;
    if (previousRefresh == null) delete process.env.OY_REFRESH_COOKIE;
    else process.env.OY_REFRESH_COOKIE = previousRefresh;
  }
});

test('merge preserves primary order and appends supplements without keyword filtering', () => {
  const primary = [
    { goodsNo: 'A2', goodsName: '검색어와 무관해 보여도 유지' },
    { goodsNo: 'A1', goodsName: '두 번째 기본 상품' }
  ];
  const supplements = [
    { goodsNo: 'A1', goodsName: '중복 보조 상품' },
    { goodsNo: 'B1', goodsName: '추가 보조 상품', vendorDelivery: true }
  ];

  const merged = mergeSearchProducts(primary, supplements, '일치하지않는검색어', 120);

  assert.deepEqual(
    merged.map((product) => product.goodsNo),
    ['A2', 'A1', 'B1']
  );
  assert.equal(merged[1].goodsName, '두 번째 기본 상품');
});

test('unavailable payload is explicit and refresh cookie has priority', () => {
  const previousRefresh = process.env.OY_REFRESH_COOKIE;
  const previousSearch = process.env.OLIVEYOUNG_SEARCH_COOKIE;
  process.env.OY_REFRESH_COOKIE = 'fresh-cookie';
  process.env.OLIVEYOUNG_SEARCH_COOKIE = 'stale-cookie';
  try {
    assert.equal(getOfficialCookieHeader(), 'fresh-cookie');
  } finally {
    if (previousRefresh == null) delete process.env.OY_REFRESH_COOKIE;
    else process.env.OY_REFRESH_COOKIE = previousRefresh;
    if (previousSearch == null) delete process.env.OLIVEYOUNG_SEARCH_COOKIE;
    else process.env.OLIVEYOUNG_SEARCH_COOKIE = previousSearch;
  }

  const unavailable = buildUnavailablePayload([], '어노브', 'fallback-local', null, null, 0);
  assert.equal(unavailable.success, false);
  assert.equal(unavailable.error, 'search_temporarily_unavailable');
  assert.equal(unavailable.complete, false);
  assert.equal(unavailable.incomplete, true);
});
