import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const apiSource = readFileSync(new URL('../public/js/api.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

function product(index) {
  return {
    goodsNo: 'A' + String(index + 1).padStart(12, '0'),
    goodsName: '상품 ' + (index + 1)
  };
}

function payload({ count, total, source = 'official-search', ...flags }) {
  const products = Array.from({ length: count }, (_, index) => product(index));
  return {
    success: true,
    ...flags,
    data: {
      totalCount: total,
      count,
      nextPage: count < total,
      products,
      inventory: { totalCount: total, products },
      source
    }
  };
}

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data)
  };
}

function loadApi(fetchImpl = async () => {
  throw new Error('unexpected fetch');
}) {
  const values = new Map();
  const context = {
    CONFIG: {
      DEFAULT_LAT: 37.6152,
      DEFAULT_LNG: 126.7156,
      DEFAULT_LOCATION: '김포 사우',
      SEARCH_SIZE: 120,
      SEARCH_PREVIEW_SIZE: 48,
      SEARCH_DIRECT_FETCH_TIMEOUT_MS: 48000
    },
    sessionStorage: {
      getItem(key) {
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        values.set(key, value);
      },
      removeItem(key) {
        values.delete(key);
      }
    },
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout,
    console: {
      log() {},
      warn() {},
      error() {}
    }
  };
  vm.createContext(context);
  vm.runInContext(apiSource, context, { filename: 'public/js/api.js' });
  return { API: context.API, values, context };
}

test('rejects and evicts a one-product bare search supplement cache entry', () => {
  const { API, values } = loadApi();
  const data = payload({ count: 1, total: 1, source: 'search-supplement' });
  const key = API._searchCacheKey('어노브', 37.6152, 126.7156, 48);

  API.setCachedSearch('어노브', 37.6152, 126.7156, 48, data);
  assert.equal(values.has(key), false);

  values.set(key, JSON.stringify({ ts: Date.now(), data }));
  assert.equal(API.getCachedSearch('어노브', 37.6152, 126.7156, 48), null);
  assert.equal(values.has(key), false);
});

test('rejects a 16-of-348 response for a requested size of 120', () => {
  const { API, values } = loadApi();
  const data = payload({ count: 16, total: 348, source: 'products-primary' });

  assert.equal(API._isIncompleteSearch(data, 120), true);
  API.setCachedSearch('바디로션', 37.6152, 126.7156, 120, data);
  assert.equal(values.size, 0);
});

test('accepts a complete 48-product preview from a 624-product result', () => {
  const { API, values } = loadApi();
  const data = payload({ count: 48, total: 624, source: 'official-search' });

  assert.equal(API._isIncompleteSearch(data, 48), false);
  API.setCachedSearch('선크림', 37.6152, 126.7156, 48, data);
  assert.equal(values.size, 1);
  assert.equal(
    API._productCountFromSearchData(
      API.getCachedSearch('선크림', 37.6152, 126.7156, 48)
    ),
    48
  );
});

test('recognizes fallback and explicit incomplete markers without rejecting an augmented primary', () => {
  const { API } = loadApi();

  assert.equal(
    API._isIncompleteSearch(
      payload({ count: 1, total: 1, source: 'local-stock-detail-cache', fallback: true }),
      48
    ),
    true
  );
  assert.equal(API._isIncompleteSearch(payload({ count: 48, total: 48, partial: true }), 48), true);
  assert.equal(
    API._isIncompleteSearch(payload({ count: 48, total: 48, incomplete: true }), 48),
    true
  );
  assert.equal(
    API._isIncompleteSearch(payload({ count: 48, total: 48, complete: false }), 48),
    true
  );
  assert.equal(
    API._isIncompleteSearch(
      payload({ count: 48, total: 48, source: 'official-search+search-supplement' }),
      48
    ),
    false
  );
});

test('does not return a proxy partial when the direct search fails', async () => {
  const calls = [];
  const partial = payload({ count: 16, total: 348, source: 'products-primary' });
  const { API, values } = loadApi(async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return response(partial);
    throw new Error('direct unavailable');
  });

  await assert.rejects(
    API.search('바디로션', 37.6152, 126.7156, 120),
    (error) => error.name === 'SearchUnavailableError' && error.searchIncomplete === true
  );
  assert.equal(calls.length, 2);
  assert.equal(values.size, 0);
});

test('replaces a bare proxy supplement with the complete direct result', async () => {
  const calls = [];
  const supplement = payload({ count: 1, total: 1, source: 'search-supplement' });
  const complete = payload({ count: 22, total: 22, source: 'oliveyoung-official-cloud-run' });
  const { API, values } = loadApi(async (url) => {
    calls.push(String(url));
    return response(calls.length === 1 ? supplement : complete);
  });

  const result = await API.search('어노브', 37.6152, 126.7156, 48);

  assert.equal(API._productCountFromSearchData(result), 22);
  assert.equal(calls.length, 2);
  assert.equal(values.size, 1);
});

test('does not return an incomplete direct response after a proxy partial', async () => {
  const calls = [];
  const partial = payload({ count: 16, total: 348, source: 'products-primary' });
  const { API } = loadApi(async (url) => {
    calls.push(String(url));
    return response(partial);
  });

  await assert.rejects(
    API.search('바디로션', 37.6152, 126.7156, 120),
    (error) => error.name === 'SearchUnavailableError' && error.searchIncomplete === true
  );
  assert.equal(calls.length, 2);
});

test('times out while consuming a stalled direct response body', { timeout: 1000 }, async () => {
  const calls = [];
  const supplement = payload({ count: 1, total: 1, source: 'search-supplement' });
  const { API, context, values } = loadApi(async (url, init) => {
    calls.push(String(url));
    if (calls.length === 1) return response(supplement);

    const signal = init && init.signal;
    return {
      ok: true,
      status: 200,
      json() {
        return new Promise((resolve, reject) => {
          function rejectAbort() {
            const error = new Error('body aborted');
            error.name = 'AbortError';
            reject(error);
          }
          if (!signal || signal.aborted) {
            rejectAbort();
            return;
          }
          signal.addEventListener('abort', rejectAbort, { once: true });
        });
      }
    };
  });
  context.CONFIG.SEARCH_DIRECT_FETCH_TIMEOUT_MS = 15;
  let caught;

  await assert.rejects(API.search('어노브', 37.6152, 126.7156, 48), (error) => {
    caught = error;
    return error.name === 'SearchUnavailableError';
  });

  assert.equal(calls.length, 2);
  assert.equal(values.size, 0);
  assert.equal(caught.cause.name, 'AbortError');
  assert.equal(caught.cause.searchTimedOut, true);
});

test('keeps a valid preview and reports when the full search fails', async () => {
  const preview = payload({ count: 48, total: 624, source: 'official-search' });
  const { API, context } = loadApi();
  const renderedCounts = [];
  const errors = [];
  let resolveNotice;
  const notice = new Promise((resolve) => {
    resolveNotice = resolve;
  });

  context.Storage = {
    setHistory() {}
  };
  context.UI = {
    renderHistory() {},
    clearResults() {},
    renderVelocityRanking() {},
    showSearchLoading() {},
    renderProducts(products) {
      renderedCounts.push(products.length);
    },
    productsFromSearchApiResponse(data) {
      return data.data.inventory.products;
    },
    showSyncStatus(message, isError) {
      errors.push({ message, isError });
      resolveNotice();
    },
    showSearchError(message) {
      errors.push({ message, blocking: true });
      resolveNotice();
    }
  };
  context.document = {
    readyState: 'loading',
    addEventListener() {},
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    }
  };
  context.window = { setTimeout };
  context.sessionStorage = { getItem: () => null, removeItem() {} };

  API.getCachedSearch = () => null;
  API.loadDetailCache = () => Promise.resolve(null);
  API.search = (_keyword, _lat, _lng, size) => {
    if (size === 48) return Promise.resolve(preview);
    return Promise.reject(API._searchUnavailableError(payload({ count: 16, total: 624 })));
  };

  vm.runInContext(appSource, context, { filename: 'public/js/app.js' });
  context.App._renderVelocityRanking = () => {};
  context.App._stopVelocityAutoRefresh = () => {};
  context.App._startVelocityAutoRefresh = () => {};
  context.App._enrichSearchOnline = () => {};
  context.App._queueCuratorLinks = () => {};
  context.App._tryAutoBuyFromUrl = () => {};
  context.App._detailDataForSearchList = () => null;

  context.App.doSearch('선크림');
  await Promise.race([
    notice,
    new Promise((_, reject) => setTimeout(() => reject(new Error('notice timeout')), 250))
  ]);

  assert.equal(context.App.products.length, 48);
  assert.equal(renderedCounts.at(-1), 48);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].isError, true);
  assert.match(errors[0].message, /48개를 유지/);
  assert.equal(errors[0].blocking, undefined);
});

test('shows the retry error state when no valid search result exists', async () => {
  const { API, context } = loadApi();
  let resolveError;
  const errorShown = new Promise((resolve) => {
    resolveError = resolve;
  });
  const errors = [];

  context.Storage = { setHistory() {} };
  context.UI = {
    renderHistory() {},
    clearResults() {},
    renderVelocityRanking() {},
    showSearchLoading() {},
    showSyncStatus() {},
    showSearchError(message, keyword) {
      errors.push({ message, keyword });
      resolveError();
    }
  };
  context.document = {
    readyState: 'loading',
    addEventListener() {},
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    }
  };
  context.window = { setTimeout };
  context.sessionStorage = { getItem: () => null, removeItem() {} };

  API.getCachedSearch = () => null;
  API.loadDetailCache = () => Promise.resolve(null);
  API.search = () => Promise.reject(API._searchUnavailableError(null));

  vm.runInContext(appSource, context, { filename: 'public/js/app.js' });
  context.App._renderVelocityRanking = () => {};
  context.App._stopVelocityAutoRefresh = () => {};

  context.App.doSearch('바디로션');
  await Promise.race([
    errorShown,
    new Promise((_, reject) => setTimeout(() => reject(new Error('error timeout')), 250))
  ]);

  assert.equal(context.App.products.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].keyword, '바디로션');
  assert.match(errors[0].message, /다시 시도/);
});
