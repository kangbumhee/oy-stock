const fs = require('fs/promises');
const path = require('path');

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 200;
const searchCache = new Map();

// The Cloud Run search has been observed taking a little over 34 seconds while
// waking up. Keep the first attempt above that threshold, while leaving enough
// of Vercel's 60 second budget for one short retry and response handling.
const PRODUCTS_TIMEOUT_MS = 38000;
const PRODUCTS_RETRY_TIMEOUT_MS = 8000;
const PRODUCTS_RETRY_DELAY_MS = 350;
const OFFICIAL_SEARCH_TIMEOUT_MS = 3500;
const OFFICIAL_SEARCH_PAGE_SIZE = 48;
const SEARCH_RECONCILIATION_GRACE_MS = 750;
const SEARCH_SOURCE_BUDGET_MS = 50000;
const SEARCH_ABORT_SETTLE_MS = 150;
const PRODUCTS_API_URL =
  process.env.OLIVEYOUNG_PRODUCTS_API ||
  'https://oy-stock-api-3596046881.asia-northeast3.run.app/api/search';
const LOCAL_DETAIL_CACHE_TTL_MS = 60 * 1000;
const localDetailCache = { ts: 0, data: null };
const localVendorCache = { ts: 0, data: null };
const COMMON_KEYWORD_CORRECTIONS = {
  '여뮤즈': '어뮤즈',
  '케일플러스': '케일',
  '문치치': '몬치치'
};

function cacheKey(keyword, lat, lng, size) {
  return (
    String(keyword || '')
      .trim()
      .toLowerCase() +
    '|' +
    String(lat) +
    '|' +
    String(lng) +
    '|' +
    String(size)
  );
}

function pruneSearchCache() {
  const now = Date.now();
  for (const [k, v] of searchCache) {
    if (now - v.ts > SEARCH_CACHE_TTL_MS) searchCache.delete(k);
  }
  while (searchCache.size > SEARCH_CACHE_MAX) {
    const first = searchCache.keys().next().value;
    if (first == null) break;
    searchCache.delete(first);
  }
}

function tryParseJson(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function normalizeText(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

function isVendorDeliveryProduct(product) {
  const goodsNo = String(
    (product && (product.goodsNo || product.goodsNumber)) || ''
  ).trim();
  return (
    !!(product && product.vendorDelivery) ||
    product && product.inventoryScope === 'vendor' ||
    product && product.stockStatus === 'vendor_delivery' ||
    /^B\d+/i.test(goodsNo)
  );
}

function parseSize(size) {
  const n = Number.parseInt(String(size || '50'), 10);
  if (!Number.isFinite(n)) return 50;
  if (n < 1) return 1;
  if (n > 200) return 200;
  return n;
}

function getInventoryCount(payload) {
  const inv = payload && payload.data && payload.data.inventory;
  if (!inv || typeof inv !== 'object') return 0;
  if (typeof inv.totalCount === 'number') return inv.totalCount;
  if (Array.isArray(inv.products)) return inv.products.length;
  return 0;
}

function getKeywordCorrection(keyword) {
  const raw = String(keyword || '').trim();
  if (!raw) return '';
  const canonical = raw
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = canonical.toLowerCase().replace(/\s+/g, '');
  if (COMMON_KEYWORD_CORRECTIONS[normalized]) return COMMON_KEYWORD_CORRECTIONS[normalized];
  if (normalized.includes('여뮤즈')) return '어뮤즈';
  return canonical;
}

async function fetchUpstreamProducts(keyword, size, outerSignal) {
  const url =
    PRODUCTS_API_URL +
    '?keyword=' +
    encodeURIComponent(String(keyword || '')) +
    '&size=' +
    encodeURIComponent(String(parseSize(size)));

  async function attempt(timeoutMs) {
    try {
      const result = await fetchUpstreamInventory(url, timeoutMs, outerSignal);
      return {
        status: result ? result.r.status : 500,
        text: result ? result.text : '',
        parsed: result ? tryParseJson(result.text) : null
      };
    } catch (error) {
      return {
        status: 0,
        text: '',
        parsed: null,
        error
      };
    }
  }

  function usable(result) {
    return !!(
      result &&
      result.status >= 200 &&
      result.status < 300 &&
      result.parsed &&
      result.parsed.success !== false
    );
  }

  const first = await attempt(PRODUCTS_TIMEOUT_MS);
  if (usable(first)) return first;
  if (outerSignal && outerSignal.aborted) return first;

  // Cloud Run scale-to-zero can finish warming just after the first request times out.
  // Retry here so a one-item local cache is never mistaken for the full search result.
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, PRODUCTS_RETRY_DELAY_MS);
    if (outerSignal) outerSignal.addEventListener('abort', finish, { once: true });
  });
  if (outerSignal && outerSignal.aborted) return first;
  const retried = await attempt(PRODUCTS_RETRY_TIMEOUT_MS);
  retried.retried = true;
  return usable(retried) ? retried : first.parsed ? first : retried;
}

function getOfficialCookieHeader() {
  return String(
    process.env.OY_REFRESH_COOKIE ||
      process.env.OLIVEYOUNG_SEARCH_COOKIE ||
      process.env.OY_CURATOR_COOKIE ||
      ''
  ).trim();
}

function numberFromOfficial(value) {
  if (value == null) return 0;
  const n = Number.parseInt(String(value).replace(/[^\d.-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function parseOfficialTotalCount(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function officialImageUrl(pathName) {
  const raw = String(pathName || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return 'https://image.oliveyoung.co.kr/uploads/images/goods/' + raw.replace(/^\/+/, '');
}

function normalizeOfficialProduct(row) {
  if (!row || typeof row !== 'object') return null;
  const goodsNo = String(row.GOODS_NO || row.goodsNo || row.goodsNumber || '').trim();
  if (!goodsNo || goodsNo === 'A000000000000') return null;

  const salePrice = numberFromOfficial(row.SALE_PRC || row.salePrice || row.priceToPay);
  const normalPrice = numberFromOfficial(row.NORM_PRC || row.SUP_PRC || row.originalPrice);
  const originalPrice = normalPrice || salePrice;
  const priceToPay = salePrice || originalPrice;

  return {
    goodsNo,
    goodsNumber: goodsNo,
    goodsName: String(row.GOODS_NM || row.goodsName || goodsNo).trim(),
    brandName: String(row.ONL_BRND_NM || row.BRND_NM || row.brandName || '').trim(),
    imageUrl: officialImageUrl(row.IMG_PATH_NM || row.imageUrl || row.thumbnail),
    priceToPay,
    originalPrice,
    discountRate:
      originalPrice > priceToPay && priceToPay > 0
        ? Math.round((1 - priceToPay / originalPrice) * 100)
        : 0,
    categoryNumber: String(row.DISP_CAT_NO || row.categoryNumber || '').trim(),
    goodsOut: row.GOODS_SOUT_INFO === 'Y',
    todayDelivery: row.QUICK_YN === 'Y',
    source: 'oliveyoung-official-search'
  };
}

async function fetchTextWithTimeout(url, init, timeoutMs, outerSignal) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    const response = await fetch(
      url,
      Object.assign({}, init || {}, { signal: controller.signal })
    );
    // Keep the timeout active until the body is fully consumed. A response can
    // deliver headers and then stall indefinitely while reading text().
    const text = await response.text();
    return { r: response, text };
  } finally {
    clearTimeout(t);
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

async function fetchOfficialSearchPage(keyword, startCount, listnum, outerSignal) {
  const cookieHeader = getOfficialCookieHeader();
  if (!cookieHeader) {
    return { status: 0, parsed: null, text: '', skipped: true };
  }

  const body = new URLSearchParams({
    query: String(keyword || ''),
    reQuery: '',
    rt: '',
    collection: 'OLIVE_GOODS,OLIVE_PLAN,OLIVE_EVENT,OLIVE_BRAND,OLIVE_QUICK_LINK',
    listnum: String(Math.max(1, Math.min(parseSize(listnum), OFFICIAL_SEARCH_PAGE_SIZE))),
    startCount: String(Math.max(0, Number.parseInt(String(startCount || 0), 10) || 0)),
    sort: 'RANK/DESC',
    goods_sort: 'WEIGHT/DESC,RANK/DESC',
    disPlayCateId: '',
    cateId: '',
    cateId2: '',
    sale_below_price: '',
    sale_over_price: '',
    brandCheck: '',
    benefitCheck: '',
    attrCheck0: '',
    attrCheck1: '',
    attrCheck2: '',
    attrCheck3: '',
    attrCheck4: '',
    authenticYn: '',
    typeChk: '',
    onlyOneBrand: '',
    quickYn: 'N',
    displayMediaTypes: '02'
  });

  const result = await fetchTextWithTimeout(
    'https://www.oliveyoung.co.kr/store/search/NewMainSearchApi.do',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: cookieHeader,
        Origin: 'https://www.oliveyoung.co.kr',
        Referer:
          'https://www.oliveyoung.co.kr/store/search/getSearchMain.do?query=' +
          encodeURIComponent(String(keyword || '')) +
          '&giftYn=N',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body
    },
    OFFICIAL_SEARCH_TIMEOUT_MS,
    outerSignal
  );
  return { status: result.r.status, parsed: tryParseJson(result.text), text: result.text };
}

function officialGoodsFromPayload(payload) {
  const data = payload && Array.isArray(payload.Data) ? payload.Data : [];
  return data.find((item) => item && item.CollName === 'OLIVE_GOODS') || null;
}

async function fetchOfficialSearchProducts(keyword, size, outerSignal) {
  const limit = parseSize(size);
  const firstPageSize = Math.min(OFFICIAL_SEARCH_PAGE_SIZE, limit);
  const first = await fetchOfficialSearchPage(keyword, 0, firstPageSize, outerSignal);
  const firstGoods = officialGoodsFromPayload(first.parsed);
  const firstRows = firstGoods && Array.isArray(firstGoods.Result) ? firstGoods.Result : [];
  const totalCount = parseOfficialTotalCount(firstGoods && firstGoods.TotalCount);
  const hasExplicitTotal = totalCount != null;

  if (!firstGoods || first.status < 200 || first.status >= 300) {
    return {
      status: first.status || 500,
      parsed: null,
      products: [],
      totalCount: 0,
      hasExplicitTotal: false,
      text: first.text || ''
    };
  }

  const products = firstRows.map(normalizeOfficialProduct).filter(Boolean);
  const wanted = Math.min(limit, totalCount == null ? products.length : totalCount);
  const starts = [];
  let incomplete =
    totalCount == null ||
    totalCount < products.length ||
    (totalCount > 0 && firstRows.length === 0);
  for (let start = firstPageSize; start < wanted; start += OFFICIAL_SEARCH_PAGE_SIZE) {
    starts.push(start);
  }

  if (starts.length) {
    const pages = await Promise.allSettled(
      starts.map((start) =>
        fetchOfficialSearchPage(
          keyword,
          start,
          Math.min(OFFICIAL_SEARCH_PAGE_SIZE, wanted - start),
          outerSignal
        )
      )
    );
    pages.forEach((page) => {
      if (
        page.status !== 'fulfilled' ||
        !page.value ||
        page.value.status < 200 ||
        page.value.status >= 300
      ) {
        incomplete = true;
        return;
      }
      const goods = officialGoodsFromPayload(page.value && page.value.parsed);
      const rows = goods && Array.isArray(goods.Result) ? goods.Result : [];
      if (!goods) incomplete = true;
      rows.map(normalizeOfficialProduct).filter(Boolean).forEach((p) => products.push(p));
    });
  }

  return {
    status: first.status,
    parsed: first.parsed,
    products,
    totalCount,
    hasExplicitTotal,
    incomplete,
    text: first.text || ''
  };
}

function getProducts(payload) {
  const data = (payload && payload.data) || {};
  if (Array.isArray(data.products)) return data.products;
  const inv = data.inventory != null ? data.inventory : payload && payload.inventory;
  if (Array.isArray(inv)) return inv;
  if (inv && typeof inv === 'object' && Array.isArray(inv.products)) return inv.products;
  if (Array.isArray(payload && payload.products)) return payload.products;
  return [];
}

function explicitTotalFromPayload(payload) {
  const data = (payload && payload.data) || {};
  const inventory = data.inventory != null ? data.inventory : payload && payload.inventory;
  const candidates = [
    payload && payload.meta && payload.meta.total,
    data.totalCount,
    inventory && !Array.isArray(inventory) && inventory.totalCount,
    payload && payload.totalCount
  ];
  const totals = candidates
    .filter((value) => value != null && String(value).trim() !== '')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return totals.length ? Math.max.apply(Math, totals) : null;
}

function searchPayloadSource(payload) {
  const data = (payload && payload.data) || {};
  return String((payload && payload.source) || data.source || '').trim().toLowerCase();
}

function isNonAuthoritativePayload(payload) {
  const data = (payload && payload.data) || {};
  const sourceBase = searchPayloadSource(payload).split('+')[0];
  return !!(
    (payload &&
      (payload.fallback === true ||
        payload.partial === true ||
        payload.incomplete === true ||
        payload.complete === false)) ||
    data.fallback === true ||
    data.partial === true ||
    data.incomplete === true ||
    data.complete === false ||
    sourceBase === 'search-supplement' ||
    sourceBase === 'vendor-supplement' ||
    sourceBase === 'local-stock-detail-cache' ||
    /^fallback/.test(sourceBase)
  );
}

function buildOfficialCandidate(result, keyword, size) {
  if (!result || result.status < 200 || result.status >= 300) return null;
  const products = mergeSearchProducts(result.products || [], [], keyword, size);
  const explicitTotal = result.hasExplicitTotal ? Number(result.totalCount) : null;
  const expected = explicitTotal == null ? null : Math.min(parseSize(size), explicitTotal);
  const complete = !!(
    explicitTotal != null &&
    Number.isFinite(explicitTotal) &&
    explicitTotal >= 0 &&
    explicitTotal >= products.length &&
    result.incomplete !== true &&
    products.length >= expected
  );
  return {
    type: 'official',
    sourceBase: 'official-search',
    products,
    explicitTotal,
    totalCount: Math.max(explicitTotal == null ? 0 : explicitTotal, products.length),
    complete,
    updatedAt: new Date().toISOString()
  };
}

function buildUpstreamCandidate(result, keyword, size) {
  const payload = result && result.parsed;
  if (
    !result ||
    result.status < 200 ||
    result.status >= 300 ||
    !payload ||
    payload.success === false
  ) {
    return null;
  }
  const products = mergeSearchProducts(getProducts(payload), [], keyword, size);
  const explicitTotal = explicitTotalFromPayload(payload);
  const expected = explicitTotal == null ? null : Math.min(parseSize(size), explicitTotal);
  const complete = !!(
    explicitTotal != null &&
    !isNonAuthoritativePayload(payload) &&
    products.length >= expected
  );
  return {
    type: 'upstream',
    sourceBase: 'products-primary',
    products,
    explicitTotal,
    totalCount: Math.max(explicitTotal == null ? 0 : explicitTotal, products.length),
    complete,
    updatedAt: payload && payload.data && payload.data.updatedAt
  };
}

function compareSearchCandidates(a, b) {
  const countDiff = b.products.length - a.products.length;
  if (countDiff) return countDiff;
  const totalDiff = b.totalCount - a.totalCount;
  if (totalDiff) return totalDiff;
  if (a.type === b.type) return 0;
  return a.type === 'upstream' ? -1 : 1;
}

function chooseRicherCandidate(candidates, predicate) {
  return candidates.filter((candidate) => candidate && predicate(candidate)).sort(compareSearchCandidates)[0] || null;
}

function settleSearchSource(type, promise) {
  return Promise.resolve(promise).then(
    (result) => ({ type, result, error: null }),
    (error) => ({ type, result: null, error })
  );
}

async function waitForSourceOutcome(promise, timeoutMs) {
  const waitMs = Math.max(0, Number(timeoutMs) || 0);
  if (waitMs === 0) return null;
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function collectSearchSourceResults(
  officialPromise,
  upstreamPromise,
  controller,
  keyword,
  size,
  options
) {
  options = options || {};
  const graceMs = Number.isFinite(options.graceMs)
    ? Math.max(0, Number(options.graceMs))
    : SEARCH_RECONCILIATION_GRACE_MS;
  const budgetMs = Number.isFinite(options.budgetMs)
    ? Math.max(1, Number(options.budgetMs))
    : SEARCH_SOURCE_BUDGET_MS;
  const startedAt = Date.now();
  const tasks = {
    official: settleSearchSource('official', officialPromise),
    upstream: settleSearchSource('upstream', upstreamPromise)
  };
  const results = { officialResult: null, productsResult: null };

  function record(outcome) {
    if (!outcome || outcome.error) return;
    if (outcome.type === 'official') results.officialResult = outcome.result;
    else results.productsResult = outcome.result;
  }

  const first = await waitForSourceOutcome(
    Promise.race([tasks.official, tasks.upstream]),
    budgetMs
  );
  if (!first) {
    controller.abort();
    await Promise.all([
      waitForSourceOutcome(tasks.official, SEARCH_ABORT_SETTLE_MS),
      waitForSourceOutcome(tasks.upstream, SEARCH_ABORT_SETTLE_MS)
    ]);
    return results;
  }
  record(first);

  const firstCandidate =
    first.type === 'official'
      ? buildOfficialCandidate(first.result, keyword, size)
      : buildUpstreamCandidate(first.result, keyword, size);
  const otherTask = first.type === 'official' ? tasks.upstream : tasks.official;
  const remainingBudget = Math.max(0, budgetMs - (Date.now() - startedAt));
  const waitMs =
    firstCandidate && firstCandidate.complete && firstCandidate.products.length > 0
      ? Math.min(graceMs, remainingBudget)
      : remainingBudget;
  const second = await waitForSourceOutcome(otherTask, waitMs);
  if (second) {
    record(second);
    return results;
  }

  controller.abort();
  // Both source promises have rejection handlers from settleSearchSource. Give
  // an aborted fetch a short window to release its body/timers without delaying
  // the user response if an upstream implementation ignores AbortSignal.
  await waitForSourceOutcome(otherTask, SEARCH_ABORT_SETTLE_MS);
  return results;
}

async function loadLocalDetailData() {
  const now = Date.now();
  if (localDetailCache.data && now - localDetailCache.ts < LOCAL_DETAIL_CACHE_TTL_MS) {
    return localDetailCache.data;
  }

  const candidatePaths = [
    path.join(process.cwd(), 'public', 'data', 'stock-detail.json'),
    path.join(__dirname, '..', '..', 'public', 'data', 'stock-detail.json')
  ];

  let parsed = null;
  let lastErr = null;
  for (const p of candidatePaths) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      parsed = JSON.parse(raw);
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!parsed) throw lastErr || new Error('stock-detail.json load failed');

  localDetailCache.ts = now;
  localDetailCache.data = parsed;
  return parsed;
}

function requestOrigin(req) {
  const host =
    (req &&
      req.headers &&
      (req.headers['x-forwarded-host'] || req.headers.host)) ||
    process.env.VERCEL_URL ||
    '';
  if (!host) return '';
  const proto =
    (req && req.headers && req.headers['x-forwarded-proto']) ||
    (String(host).includes('localhost') ? 'http' : 'https');
  return String(host).startsWith('http://') || String(host).startsWith('https://')
    ? String(host)
    : proto + '://' + String(host);
}

async function loadVendorSupplementData(origin) {
  const now = Date.now();
  if (localVendorCache.data && now - localVendorCache.ts < LOCAL_DETAIL_CACHE_TTL_MS) {
    return localVendorCache.data;
  }

  const candidatePaths = [
    path.join(process.cwd(), 'public', 'data', 'vendor-products.json'),
    path.join(__dirname, '..', '..', 'public', 'data', 'vendor-products.json')
  ];

  for (const p of candidatePaths) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      const parsed = JSON.parse(raw);
      localVendorCache.ts = now;
      localVendorCache.data = parsed;
      return parsed;
    } catch (_) {}
  }

  if (origin) {
    try {
      const r = await fetch(origin.replace(/\/$/, '') + '/data/vendor-products.json', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(2500) : undefined
      });
      if (r.ok) {
        const parsed = await r.json();
        localVendorCache.ts = now;
        localVendorCache.data = parsed;
        return parsed;
      }
    } catch (_) {}
  }

  localVendorCache.ts = now;
  localVendorCache.data = { products: [] };
  return localVendorCache.data;
}

function productMatchesKeyword(product, keyword) {
  const kw = normalizeText(keyword);
  if (!kw) return true;
  const fields = [
    product && product.goodsNo,
    product && product.goodsNumber,
    product && product.goodsName,
    product && product.brandName,
    product && product.source
  ];
  (Array.isArray(product && product.keywordAliases) ? product.keywordAliases : []).forEach((v) =>
    fields.push(v)
  );
  return fields.some((v) => normalizeText(v).includes(kw));
}

function normalizeProduct(product) {
  const goodsNo = String(
    (product && (product.goodsNo || product.goodsNumber)) || ''
  ).trim();
  if (!goodsNo) return null;
  const price = Number(product.priceToPay || product.price || product.salePrice || 0);
  const original = Number(product.originalPrice || product.normalPrice || price || 0);
  return Object.assign({}, product, {
    goodsNo,
    goodsNumber: goodsNo,
    goodsName: String(product.goodsName || product.name || goodsNo),
    imageUrl: product.imageUrl || product.thumbnail || '',
    priceToPay: price,
    originalPrice: original,
    discountRate:
      product.discountRate != null
        ? Number(product.discountRate) || 0
        : original > price && price > 0
          ? Math.round((1 - price / original) * 100)
          : 0
  });
}

function buildUnifiedPayload(products, keyword, source, updatedAt, message, options) {
  options = options || {};
  const normalized = products.map(normalizeProduct).filter(Boolean);
  const totalCount =
    Number.isFinite(options.totalCount) && options.totalCount > normalized.length
      ? options.totalCount
      : normalized.length;
  return {
    success: true,
    complete: true,
    incomplete: false,
    fallback: false,
    message,
    data: {
      keyword: String(keyword || ''),
      totalCount,
      nextPage: normalized.length < totalCount,
      count: normalized.length,
      products: normalized,
      inventory: {
        totalCount,
        products: normalized
      },
      source,
      complete: true,
      incomplete: false,
      updatedAt: updatedAt || null
    }
  };
}

function buildUnavailablePayload(products, keyword, source, updatedAt, message, totalCount) {
  const normalized = (products || []).map(normalizeProduct).filter(Boolean);
  const reportedTotal = Number(totalCount);
  const sourceBase = String(source || '').toLowerCase().split('+')[0];
  const fallback =
    sourceBase === 'search-supplement' ||
    sourceBase === 'vendor-supplement' ||
    sourceBase === 'local-stock-detail-cache' ||
    /^fallback/.test(sourceBase);
  const normalizedTotal = Math.max(
    Number.isFinite(reportedTotal) && reportedTotal >= 0 ? reportedTotal : 0,
    normalized.length
  );
  return {
    success: false,
    error: 'search_temporarily_unavailable',
    complete: false,
    incomplete: true,
    fallback,
    message: message || '검색 결과를 완전히 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
    data: {
      keyword: String(keyword || ''),
      totalCount: normalizedTotal,
      count: normalized.length,
      nextPage: normalized.length < normalizedTotal,
      products: normalized,
      inventory: {
        totalCount: normalizedTotal,
        products: normalized
      },
      source: source || 'search-unavailable',
      complete: false,
      incomplete: true,
      updatedAt: updatedAt || null
    }
  };
}

function isCacheableSearchPayload(payload, size) {
  if (
    !payload ||
    payload.success === false ||
    payload.complete !== true ||
    payload.incomplete === true ||
    isNonAuthoritativePayload(payload)
  ) {
    return false;
  }
  const products = getProducts(payload);
  const explicitTotal = explicitTotalFromPayload(payload);
  return explicitTotal != null && products.length >= Math.min(parseSize(size), explicitTotal);
}

function normalizeSupplementProduct(product) {
  const normalized = normalizeProduct(product);
  if (!normalized) return null;
  const vendorDelivery = isVendorDeliveryProduct(normalized);
  return Object.assign({}, normalized, {
    source: normalized.source || 'oliveyoung-official-search-supplement',
    vendorDelivery,
    inventoryScope: vendorDelivery ? 'vendor' : normalized.inventoryScope || 'official-search',
    stockStatus: vendorDelivery ? 'vendor_delivery' : normalized.stockStatus || 'official_search'
  });
}

async function getVendorSupplementMatches(keyword, origin) {
  const supplement = await loadVendorSupplementData(origin);
  const rows = Array.isArray(supplement && supplement.products) ? supplement.products : [];
  return rows
    .filter((p) => productMatchesKeyword(p, keyword))
    .map(normalizeSupplementProduct)
    .filter(Boolean)
    .sort((a, b) => supplementRankForKeyword(a, keyword) - supplementRankForKeyword(b, keyword));
}

function supplementRankForKeyword(product, keyword) {
  const kw = normalizeText(keyword);
  const ranks = (product && product.keywordRanks) || {};
  let best = Number.POSITIVE_INFINITY;
  Object.keys(ranks).forEach((k) => {
    if (normalizeText(k) === kw || normalizeText(k).includes(kw) || kw.includes(normalizeText(k))) {
      const n = Number(ranks[k]);
      if (Number.isFinite(n) && n > 0 && n < best) best = n;
    }
  });
  if (Number.isFinite(best)) return best;
  const rank = Number(product && product.rank);
  return Number.isFinite(rank) && rank > 0 ? rank + 10000 : Number.MAX_SAFE_INTEGER;
}

function supplementSourceSuffix(products) {
  if (!products || !products.length) return '';
  return products.some(isVendorDeliveryProduct) ? 'vendor-supplement' : 'search-supplement';
}

function combinedSearchSource(base, supplementProducts) {
  const suffix = supplementSourceSuffix(supplementProducts);
  return suffix ? base + '+' + suffix : base;
}

function supplementMessage(products) {
  if (!products || !products.length) return undefined;
  return products.some(isVendorDeliveryProduct)
    ? '공식 검색 보조 상품을 함께 표시합니다. 업체배송 상품은 상품 정보만 표시됩니다.'
    : '공식 검색 보조 상품을 함께 표시합니다.';
}

function mergeSearchProducts(primaryProducts, supplementProducts, keyword, size) {
  const limit = parseSize(size);
  const merged = [];
  const seen = new Set();

  function push(product) {
    const normalized = normalizeProduct(product);
    if (!normalized) return;
    const key = normalized.goodsNumber || normalized.goodsNo;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(normalized);
  }

  // Preserve the upstream ranking and every primary row. Supplements may fill
  // missing products, but must never displace or filter the authoritative list.
  primaryProducts.forEach(push);
  supplementProducts.forEach(push);

  return merged.slice(0, limit);
}

function buildFallbackPayloadFromDetail(detail, keyword, size) {
  const kwRaw = String(keyword || '').trim();
  const kw = normalizeText(kwRaw);
  const limit = parseSize(size);
  const productsObj = (detail && detail.products) || {};
  const list = Object.values(productsObj)
    .map((p) => {
      const goodsNo = String((p && p.goodsNo) || '').trim();
      const goodsName = String((p && p.goodsName) || '').trim();
      if (!goodsNo || !goodsName) return null;
      return {
        goodsNo,
        goodsNumber: goodsNo,
        goodsName,
        imageUrl: p.thumbnail || '',
        priceToPay: Number(p.price || 0),
        originalPrice: Number(p.originalPrice || p.price || 0),
        discountRate: Number(p.discountRate || 0),
        categoryNumber: p.categoryNumber || ''
      };
    })
    .filter(Boolean);

  const filtered = kw
    ? list.filter((p) => {
        const nameNorm = normalizeText(p.goodsName);
        const noNorm = normalizeText(p.goodsNo);
        return nameNorm.includes(kw) || noNorm.includes(kw);
      })
    : list;

  const products = filtered.slice(0, limit);
  return buildUnavailablePayload(
    products,
    kwRaw,
    'local-stock-detail-cache',
    detail && detail.updatedAt ? detail.updatedAt : null,
    '검색 서버가 일시적으로 응답하지 않아 전체 결과를 확인할 수 없습니다.',
    filtered.length
  );
}

async function fetchUpstreamInventory(url, timeoutMs, outerSignal) {
  const effectiveTimeout =
    Number.isFinite(timeoutMs) && Number(timeoutMs) > 0 ? Number(timeoutMs) : PRODUCTS_TIMEOUT_MS;
  return fetchTextWithTimeout(
    url,
    {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    },
    effectiveTimeout,
    outerSignal
  );
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, message: 'Method not allowed' }));
    return;
  }

  const q = req.query || {};
  const keyword = q.keyword;
  const lat = q.lat || '37.6152';
  const lng = q.lng || '126.7156';
  const size = q.size || '50';

  if (!keyword) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, message: 'keyword required' }));
    return;
  }

  const originalKeyword = String(keyword || '').trim();
  const queryKeyword = getKeywordCorrection(originalKeyword) || originalKeyword;
  if (queryKeyword !== originalKeyword) {
    res.setHeader('X-Search-Corrected', encodeURIComponent(String(queryKeyword)));
    res.setHeader('X-Search-Original', encodeURIComponent(String(keyword)));
  }

  const ck = cacheKey(queryKeyword, lat, lng, size);
  const hit = searchCache.get(ck);
  const hitPayload = hit && tryParseJson(hit.body);
  if (
    hit &&
    hit.status < 500 &&
    Date.now() - hit.ts < SEARCH_CACHE_TTL_MS &&
    isCacheableSearchPayload(hitPayload, size)
  ) {
    res.statusCode = hit.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Cache', 'HIT');
    res.end(hit.body);
    return;
  }
  if (hit) searchCache.delete(ck);

  try {
    const sourceController = new AbortController();
    const sourceResults = await collectSearchSourceResults(
      fetchOfficialSearchProducts(queryKeyword, size, sourceController.signal),
      fetchUpstreamProducts(queryKeyword, size, sourceController.signal),
      sourceController,
      queryKeyword,
      size
    );
    const officialResult = sourceResults.officialResult;
    const productsResult = sourceResults.productsResult;
    const candidates = [
      buildOfficialCandidate(officialResult, queryKeyword, size),
      buildUpstreamCandidate(productsResult, queryKeyword, size)
    ].filter(Boolean);
    const supplementProducts = await getVendorSupplementMatches(queryKeyword, requestOrigin(req));

    const completeNonEmpty = chooseRicherCandidate(
      candidates,
      (candidate) => candidate.complete && candidate.products.length > 0
    );
    if (completeNonEmpty) {
      const mergedProducts = mergeSearchProducts(
        completeNonEmpty.products,
        supplementProducts,
        queryKeyword,
        size
      );
      const source = combinedSearchSource(completeNonEmpty.sourceBase, supplementProducts);
      const body = JSON.stringify(
        buildUnifiedPayload(
          mergedProducts,
          queryKeyword,
          source,
          completeNonEmpty.updatedAt,
          supplementMessage(supplementProducts),
          { totalCount: Math.max(completeNonEmpty.totalCount, mergedProducts.length) }
        )
      );
      pruneSearchCache();
      searchCache.set(ck, { body, status: 200, ts: Date.now() });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Search-Source', source);
      res.end(body);
      return;
    }

    const incompleteNonEmpty = chooseRicherCandidate(
      candidates,
      (candidate) => !candidate.complete && candidate.products.length > 0
    );
    if (incompleteNonEmpty) {
      const mergedProducts = mergeSearchProducts(
        incompleteNonEmpty.products,
        supplementProducts,
        queryKeyword,
        size
      );
      const source = combinedSearchSource(incompleteNonEmpty.sourceBase, supplementProducts);
      const body = JSON.stringify(
        buildUnavailablePayload(
          mergedProducts,
          queryKeyword,
          source,
          incompleteNonEmpty.updatedAt,
          '검색 결과 일부만 수신되어 정상 결과로 저장하지 않았습니다.',
          incompleteNonEmpty.totalCount
        )
      );
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Cache', 'BYPASS');
      res.setHeader('X-Search-Source', source);
      res.end(body);
      return;
    }

    if (supplementProducts.length > 0) {
      const source = supplementSourceSuffix(supplementProducts) || 'search-supplement';
      const products = mergeSearchProducts([], supplementProducts, queryKeyword, size);
      const body = JSON.stringify(
        buildUnavailablePayload(
          products,
          queryKeyword,
          source,
          null,
          '공식 검색 결과를 확인하지 못해 보조 상품만 표시할 수 없습니다.',
          products.length
        )
      );
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Cache', 'BYPASS');
      res.setHeader('X-Search-Source', source);
      res.end(body);
      return;
    }

    const completeEmpty = chooseRicherCandidate(
      candidates,
      (candidate) => candidate.complete && candidate.products.length === 0
    );
    if (completeEmpty) {
      const source = completeEmpty.sourceBase;
      const body = JSON.stringify(
        buildUnifiedPayload(
          [],
          queryKeyword,
          source,
          completeEmpty.updatedAt,
          '검색 결과가 없습니다.',
          { totalCount: 0 }
        )
      );
      pruneSearchCache();
      searchCache.set(ck, { body, status: 200, ts: Date.now() });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Search-Source', source);
      res.end(body);
      return;
    }

    const detail = await loadLocalDetailData();
    const fallbackBody = JSON.stringify(buildFallbackPayloadFromDetail(detail, queryKeyword, size));
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Cache', 'BYPASS');
    res.setHeader('X-Search-Source', 'fallback-local');
    res.setHeader('X-Upstream-Status', String((productsResult && productsResult.status) || 500));
    res.end(fallbackBody);
  } catch (e) {
    const isAbort = e && e.name === 'AbortError';
    try {
      const detail = await loadLocalDetailData();
      const fallbackBody = JSON.stringify(buildFallbackPayloadFromDetail(detail, queryKeyword, size));

      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Cache', 'BYPASS');
      res.setHeader('X-Search-Source', 'fallback-local');
      res.setHeader('X-Upstream-Error', isAbort ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_FETCH');
      res.end(fallbackBody);
    } catch (fallbackErr) {
      const emptyBody = JSON.stringify(
        buildUnavailablePayload(
          [],
          queryKeyword,
          'fallback-empty',
          null,
          '검색 결과를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
          0
        )
      );

      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Cache', 'BYPASS');
      res.setHeader('X-Search-Source', 'fallback-empty');
      res.setHeader('X-Upstream-Error', isAbort ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_FETCH');
      res.setHeader(
        'X-Fallback-Error',
        fallbackErr && fallbackErr.message ? String(fallbackErr.message).slice(0, 180) : 'fallback_failed'
      );
      res.end(emptyBody);
    }
  }
};

module.exports._test = {
  SEARCH_RECONCILIATION_GRACE_MS,
  buildOfficialCandidate,
  buildUpstreamCandidate,
  buildUnifiedPayload,
  buildUnavailablePayload,
  chooseRicherCandidate,
  collectSearchSourceResults,
  fetchTextWithTimeout,
  getOfficialCookieHeader,
  isCacheableSearchPayload,
  mergeSearchProducts,
  parseOfficialTotalCount
};
