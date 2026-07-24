const DEFAULT_PAGE_SIZE = 48;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CACHE_MAX = 200;

const searchCache = new Map();

function numberValue(value) {
  if (value == null) return 0;
  const parsed = Number.parseInt(String(value).replace(/[^\d.-]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
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

  if (!first || first.status >= 400 || !firstCollection) {
    const status = first && first.status ? first.status : 502;
    throw new Error('official_search_failed_' + status);
  }

  const totalCount = numberValue(firstCollection.TotalCount) || firstRows.length;
  if (!firstRows.length) {
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
    for (const page of pages) {
      if (page.status !== 'fulfilled' || !page.value || page.value.status >= 400) continue;
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
    if (products.length >= limit) break;
  }

  if (!products.length) throw new Error('official_search_empty');

  const payload = buildPayload(query, totalCount, products);

  pruneCache(cacheMax, cacheTtlMs);
  searchCache.set(cacheKey, { ts: Date.now(), payload });
  return { ...payload, cache: 'MISS' };
}
