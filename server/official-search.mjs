const DEFAULT_PAGE_SIZE = 48;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CACHE_MAX = 200;

const searchCache = new Map();

function numberValue(value) {
  if (value == null) return 0;
  const parsed = Number.parseInt(String(value).replace(/[^\d.-]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function officialTotalCount(value) {
  if (value == null) return null;
  const normalized = String(value).trim().replace(/,/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function imageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return 'https://image.oliveyoung.co.kr/uploads/images/goods/' + raw.replace(/^\/+/, '');
}

export function parseSearchSize(value) {
  const parsed = Number.parseInt(String(value || '50'), 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(200, parsed));
}

export function normalizeSearchKeyword(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeOfficialProduct(row) {
  if (!row || typeof row !== 'object') return null;

  const goodsNo = String(row.GOODS_NO || row.goodsNo || row.goodsNumber || '').trim();
  if (!goodsNo || goodsNo === 'A000000000000') return null;

  const salePrice = numberValue(row.SALE_PRC || row.salePrice || row.priceToPay);
  const normalPrice = numberValue(row.NORM_PRC || row.SUP_PRC || row.originalPrice);
  const originalPrice = normalPrice || salePrice;
  const priceToPay = salePrice || originalPrice;

  return {
    goodsNo,
    goodsNumber: goodsNo,
    goodsName: String(row.GOODS_NM || row.goodsName || goodsNo).trim(),
    brandName: String(row.ONL_BRND_NM || row.BRND_NM || row.brandName || '').trim(),
    imageUrl: imageUrl(row.IMG_PATH_NM || row.imageUrl || row.thumbnail),
    priceToPay,
    originalPrice,
    discountRate:
      originalPrice > priceToPay && priceToPay > 0
        ? Math.round((1 - priceToPay / originalPrice) * 100)
        : 0,
    categoryNumber: String(row.DISP_CAT_NO || row.categoryNumber || '').trim(),
    goodsOut: row.GOODS_SOUT_INFO === 'Y' || row.SOLD_OUT_YN === 'Y',
    todayDelivery: row.QUICK_YN === 'Y',
    source: 'oliveyoung-official-cloud-run'
  };
}

export function normalizeOfficialPrice(goodsNoValue, row) {
  const goodsNo = String(goodsNoValue || '').trim().toUpperCase();
  if (!/^[AB]\d{6,20}$/i.test(goodsNo) || !row || typeof row !== 'object') return null;

  const saleValue = row.priceToPay ?? row.SALE_PRC ?? row.salePrice;
  const originalValue =
    row.originalPrice ?? row.NORM_PRC ?? row.SUP_PRC ?? row.normalPrice ?? saleValue;
  const priceToPay = numberValue(saleValue);
  const originalPrice = numberValue(originalValue);
  if (priceToPay <= 0 || originalPrice <= 0) return null;

  return { goodsNo, priceToPay, originalPrice };
}

export function parsePriceGoodsNos(value, max = 50) {
  if (!Array.isArray(value) || value.length < 1) {
    const error = new Error('goodsNos_required');
    error.code = 'INVALID_GOODS_NOS';
    throw error;
  }

  const normalizedMax = Math.max(1, Math.min(50, Number.parseInt(String(max), 10) || 50));
  if (value.length > normalizedMax) {
    const error = new Error('goodsNos_limit_exceeded');
    error.code = 'GOODS_NOS_LIMIT_EXCEEDED';
    throw error;
  }

  const goodsNos = [];
  const seen = new Set();
  for (const raw of value) {
    const goodsNo = String(raw || '').trim().toUpperCase();
    if (!/^[AB]\d{6,20}$/i.test(goodsNo)) {
      const error = new Error('goodsNos_invalid');
      error.code = 'INVALID_GOODS_NOS';
      throw error;
    }
    if (seen.has(goodsNo)) continue;
    seen.add(goodsNo);
    goodsNos.push(goodsNo);
  }
  return goodsNos;
}

function goodsCollection(payload) {
  const data = payload && Array.isArray(payload.Data) ? payload.Data : [];
  return data.find((item) => item && item.CollName === 'OLIVE_GOODS') || null;
}

function pruneCache(cacheMax, cacheTtlMs) {
  const now = Date.now();
  for (const [key, value] of searchCache) {
    if (now - value.ts > cacheTtlMs) searchCache.delete(key);
  }
  while (searchCache.size > cacheMax) {
    const first = searchCache.keys().next().value;
    if (first == null) break;
    searchCache.delete(first);
  }
}

function buildPayload(query, totalCount, products) {
  const updatedAt = new Date().toISOString();
  const source = 'oliveyoung-official-cloud-run';
  const normalizedTotal = Math.max(totalCount || 0, products.length);
  return {
    success: true,
    complete: true,
    incomplete: false,
    data: {
      keyword: query,
      totalCount: normalizedTotal,
      count: products.length,
      nextPage: normalizedTotal > products.length,
      products,
      inventory: {
        totalCount: normalizedTotal,
        products
      },
      source,
      updatedAt
    },
    meta: {
      keyword: query,
      total: normalizedTotal,
      count: products.length,
      source
    },
    source,
    updatedAt
  };
}

export function clearOfficialSearchCache() {
  searchCache.clear();
}

function searchOverloadedError(reason) {
  const error = new Error(reason || 'official_search_overloaded');
  error.code = 'OFFICIAL_SEARCH_OVERLOADED';
  error.httpStatus = 429;
  error.retryAfterSeconds = 5;
  return error;
}

/**
 * Limits unique searches while coalescing requests for the same keyword and size.
 * The queue is bounded so Cloud Run does not retain an unbounded number of requests.
 */
export function createBoundedSearchRunner(
  search,
  { maxConcurrent = 2, maxQueue = 12, maxWaitMs = 5000 } = {}
) {
  if (typeof search !== 'function') throw new Error('search_required');

  const concurrentLimit = Math.max(1, Number.parseInt(String(maxConcurrent), 10) || 2);
  const queueLimit = Math.max(0, Number.parseInt(String(maxQueue), 10) || 0);
  const waitLimitMs = Math.max(1, Number.parseInt(String(maxWaitMs), 10) || 5000);
  const flights = new Map();
  const queue = [];
  let active = 0;

  function finishFlight(key, promise) {
    if (flights.get(key) === promise) flights.delete(key);
  }

  function start(item) {
    if (item.settled) return;
    item.started = true;
    if (item.timer) clearTimeout(item.timer);
    active += 1;

    Promise.resolve()
      .then(() => search(item.keyword, item.size))
      .then(item.resolve, item.reject)
      .finally(() => {
        item.settled = true;
        active = Math.max(0, active - 1);
        finishFlight(item.key, item.promise);
        pump();
      });
  }

  function pump() {
    while (active < concurrentLimit && queue.length) {
      const item = queue.shift();
      if (!item || item.settled) continue;
      start(item);
    }
  }

  function run(keyword, size) {
    const query = normalizeSearchKeyword(keyword);
    const limit = parseSearchSize(size);
    const key = query.toLowerCase() + '|' + limit;
    const existing = flights.get(key);
    if (existing) return existing;

    if (active >= concurrentLimit && queue.length >= queueLimit) {
      return Promise.reject(searchOverloadedError('official_search_queue_full'));
    }

    let resolveTask;
    let rejectTask;
    const promise = new Promise((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const item = {
      key,
      keyword: query,
      size: limit,
      promise,
      resolve: resolveTask,
      reject: rejectTask,
      timer: null,
      started: false,
      settled: false
    };

    flights.set(key, promise);
    if (active < concurrentLimit) {
      start(item);
    } else {
      queue.push(item);
      item.timer = setTimeout(() => {
        if (item.started || item.settled) return;
        item.settled = true;
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        finishFlight(key, promise);
        rejectTask(searchOverloadedError('official_search_queue_timeout'));
      }, waitLimitMs);
      if (item.timer.unref) item.timer.unref();
    }

    return promise;
  }

  run.stats = () => ({
    active,
    queued: queue.filter((item) => item && !item.settled).length,
    flights: flights.size,
    maxConcurrent: concurrentLimit,
    maxQueue: queueLimit
  });
  return run;
}

export async function searchOfficialProducts(
  keyword,
  size,
  {
    fetchPage,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    cacheMax = DEFAULT_CACHE_MAX,
    pageSize = DEFAULT_PAGE_SIZE
  } = {}
) {
  const query = normalizeSearchKeyword(keyword);
  if (!query) throw new Error('keyword_required');
  if (typeof fetchPage !== 'function') throw new Error('fetchPage_required');

  const limit = parseSearchSize(size);
  const normalizedPageSize = Math.max(1, Math.min(DEFAULT_PAGE_SIZE, Number(pageSize) || DEFAULT_PAGE_SIZE));
  const cacheKey = query.toLowerCase() + '|' + limit;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < cacheTtlMs) {
    return { ...cached.payload, cache: 'HIT' };
  }

  const firstListSize = Math.min(normalizedPageSize, limit);
  const first = await fetchPage({ keyword: query, startCount: 0, listnum: firstListSize });
  const firstCollection = goodsCollection(first && first.data);
  const firstRows =
    firstCollection && Array.isArray(firstCollection.Result) ? firstCollection.Result : [];

  const firstStatus = Number(first && first.status);
  if (
    !first ||
    !Number.isFinite(firstStatus) ||
    firstStatus < 200 ||
    firstStatus >= 400 ||
    !firstCollection
  ) {
    const status = first && first.status ? first.status : 502;
    throw new Error('official_search_failed_' + status);
  }

  const totalCount = officialTotalCount(firstCollection.TotalCount);
  if (totalCount == null) {
    throw new Error('official_search_total_missing_or_invalid');
  }
  if (!firstRows.length) {
    if (totalCount > 0) {
      throw new Error(`official_search_incomplete_0_of_${Math.min(limit, totalCount)}`);
    }
    const emptyPayload = buildPayload(query, totalCount, []);
    pruneCache(cacheMax, cacheTtlMs);
    searchCache.set(cacheKey, { ts: Date.now(), payload: emptyPayload });
    return { ...emptyPayload, cache: 'MISS' };
  }

  const wanted = Math.min(limit, totalCount);
  const rows = firstRows.slice();
  const starts = [];
  for (let start = firstListSize; start < wanted; start += normalizedPageSize) {
    starts.push(start);
  }

  if (starts.length) {
    const pages = await Promise.allSettled(
      starts.map((startCount) =>
        fetchPage({
          keyword: query,
          startCount,
          listnum: Math.min(normalizedPageSize, wanted - startCount)
        })
      )
    );
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const startCount = starts[index];
      if (
        page.status !== 'fulfilled' ||
        !page.value ||
        !Number.isFinite(Number(page.value.status)) ||
        Number(page.value.status) < 200 ||
        page.value.status >= 400 ||
        !goodsCollection(page.value.data)
      ) {
        const status =
          page.status === 'fulfilled' && page.value && page.value.status
            ? page.value.status
            : 502;
        throw new Error(`official_search_page_failed_${startCount}_${status}`);
      }
      const collection = goodsCollection(page.value.data);
      const pageRows = collection && Array.isArray(collection.Result) ? collection.Result : [];
      rows.push(...pageRows);
    }
  }

  const products = [];
  const seen = new Set();
  for (const row of rows) {
    const product = normalizeOfficialProduct(row);
    if (!product || seen.has(product.goodsNo)) continue;
    seen.add(product.goodsNo);
    products.push(product);
    if (products.length >= wanted) break;
  }

  if (!products.length) throw new Error('official_search_empty');
  if (products.length !== wanted) {
    throw new Error(`official_search_incomplete_${products.length}_of_${wanted}`);
  }

  const payload = buildPayload(query, totalCount, products);

  pruneCache(cacheMax, cacheTtlMs);
  searchCache.set(cacheKey, { ts: Date.now(), payload });
  return { ...payload, cache: 'MISS' };
}
