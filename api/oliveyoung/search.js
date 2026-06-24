const fs = require('fs/promises');
const path = require('path');

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 200;
const searchCache = new Map();

const PRODUCTS_TIMEOUT_MS = 4500;
const OFFICIAL_SEARCH_TIMEOUT_MS = 3500;
const OFFICIAL_SEARCH_PAGE_SIZE = 48;
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
  const normalized = raw.normalize('NFC').toLowerCase().replace(/\s+/g, '');
  if (COMMON_KEYWORD_CORRECTIONS[normalized]) return COMMON_KEYWORD_CORRECTIONS[normalized];
  if (normalized.includes('여뮤즈')) return '어뮤즈';
  return '';
}

async function fetchUpstreamProducts(keyword, size) {
  const url =
    'https://mcp.aka.page/api/oliveyoung/products?keyword=' +
    encodeURIComponent(String(keyword || '')) +
    '&size=' +
    encodeURIComponent(String(parseSize(size)));
  const result = await fetchUpstreamInventory(url, PRODUCTS_TIMEOUT_MS);
  const parsed = result ? tryParseJson(result.text) : null;
  return { status: result ? result.r.status : 500, text: result ? result.text : '', parsed };
}

function getOfficialCookieHeader() {
  return String(
    process.env.OLIVEYOUNG_SEARCH_COOKIE ||
      process.env.OY_REFRESH_COOKIE ||
      process.env.OY_CURATOR_COOKIE ||
      ''
  ).trim();
}

function numberFromOfficial(value) {
  if (value == null) return 0;
  const n = Number.parseInt(String(value).replace(/[^\d.-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
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

async function fetchOfficialSearchPage(keyword, startCount, listnum) {
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

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), OFFICIAL_SEARCH_TIMEOUT_MS);
  let r;
  try {
    r = await fetch('https://www.oliveyoung.co.kr/store/search/NewMainSearchApi.do', {
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
      body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(t);
  }

  const text = await r.text();
  return { status: r.status, parsed: tryParseJson(text), text };
}

function officialGoodsFromPayload(payload) {
  const data = payload && Array.isArray(payload.Data) ? payload.Data : [];
  return data.find((item) => item && item.CollName === 'OLIVE_GOODS') || null;
}

async function fetchOfficialSearchProducts(keyword, size) {
  const limit = parseSize(size);
  const firstPageSize = Math.min(OFFICIAL_SEARCH_PAGE_SIZE, limit);
  const first = await fetchOfficialSearchPage(keyword, 0, firstPageSize);
  const firstGoods = officialGoodsFromPayload(first.parsed);
  const firstRows = firstGoods && Array.isArray(firstGoods.Result) ? firstGoods.Result : [];
  const totalCount = numberFromOfficial(firstGoods && firstGoods.TotalCount);

  if (!firstRows.length || first.status >= 400) {
    return {
      status: first.status || 500,
      parsed: null,
      products: [],
      totalCount: 0,
      text: first.text || ''
    };
  }

  const products = firstRows.map(normalizeOfficialProduct).filter(Boolean);
  const wanted = Math.min(limit, totalCount || products.length);
  const starts = [];
  for (let start = firstPageSize; start < wanted; start += OFFICIAL_SEARCH_PAGE_SIZE) {
    starts.push(start);
  }

  if (starts.length) {
    const pages = await Promise.allSettled(
      starts.map((start) =>
        fetchOfficialSearchPage(keyword, start, Math.min(OFFICIAL_SEARCH_PAGE_SIZE, wanted - start))
      )
    );
    pages.forEach((page) => {
      if (page.status !== 'fulfilled') return;
      const goods = officialGoodsFromPayload(page.value && page.value.parsed);
      const rows = goods && Array.isArray(goods.Result) ? goods.Result : [];
      rows.map(normalizeOfficialProduct).filter(Boolean).forEach((p) => products.push(p));
    });
  }

  return {
    status: first.status,
    parsed: first.parsed,
    products,
    totalCount: totalCount || products.length,
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
    fallback:
      /^fallback/.test(String(source || '')) || String(source || '') === 'vendor-supplement',
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
      updatedAt: updatedAt || null
    }
  };
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
    .filter(Boolean);
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

  supplementProducts.forEach(push);
  primaryProducts
    .filter((p) => {
      if (!supplementProducts.length) return true;
      return isVendorDeliveryProduct(p) || productMatchesKeyword(p, keyword);
    })
    .forEach(push);

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
  return {
    success: true,
    fallback: true,
    message: '업스트림 장애로 캐시 데이터 기반 검색 결과를 표시합니다.',
    data: {
      inventory: {
        totalCount: filtered.length,
        products
      },
      source: 'local-stock-detail-cache',
      updatedAt: detail && detail.updatedAt ? detail.updatedAt : null,
      keyword: kwRaw
    }
  };
}

async function fetchUpstreamInventory(url, timeoutMs) {
  const effectiveTimeout =
    Number.isFinite(timeoutMs) && Number(timeoutMs) > 0 ? Number(timeoutMs) : PRODUCTS_TIMEOUT_MS;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), effectiveTimeout);
  let r;
  try {
    r = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(t);
  }
  const text = await r.text();
  return { r, text };
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

  const correctedKeyword = getKeywordCorrection(keyword);
  const queryKeyword = correctedKeyword || keyword;
  if (correctedKeyword) {
    res.setHeader('X-Search-Corrected', encodeURIComponent(String(correctedKeyword)));
    res.setHeader('X-Search-Original', encodeURIComponent(String(keyword)));
  }

  const ck = cacheKey(queryKeyword, lat, lng, size);
  const hit = searchCache.get(ck);
  if (hit && hit.status < 500 && Date.now() - hit.ts < SEARCH_CACHE_TTL_MS) {
    res.statusCode = hit.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Cache', 'HIT');
    res.end(hit.body);
    return;
  }

  try {
    const [officialResult, productsResult] = await Promise.allSettled([
      fetchOfficialSearchProducts(queryKeyword, size),
      fetchUpstreamProducts(queryKeyword, size)
    ]).then((results) => [
      results[0].status === 'fulfilled' ? results[0].value : null,
      results[1].status === 'fulfilled' ? results[1].value : null
    ]);
    const primaryProducts = getProducts(productsResult && productsResult.parsed);
    const productCount = primaryProducts.length;
    const supplementProducts = await getVendorSupplementMatches(queryKeyword, requestOrigin(req));

    if (
      officialResult &&
      officialResult.status < 500 &&
      officialResult.products &&
      officialResult.products.length > productCount
    ) {
      const mergedProducts = mergeSearchProducts(
        officialResult.products,
        supplementProducts,
        queryKeyword,
        size
      );
      const officialBody = JSON.stringify(
        buildUnifiedPayload(
          mergedProducts,
          queryKeyword,
          combinedSearchSource('official-search', supplementProducts),
          new Date().toISOString(),
          supplementMessage(supplementProducts),
          {
            totalCount: Math.max(
              officialResult.totalCount || 0,
              mergedProducts.length + Math.max(0, supplementProducts.length - officialResult.products.length)
            )
          }
        )
      );
      pruneSearchCache();
      searchCache.set(ck, { body: officialBody, status: 200, ts: Date.now() });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Cache', 'MISS');
      res.setHeader(
        'X-Search-Source',
        combinedSearchSource('official-search', supplementProducts)
      );
      res.end(officialBody);
      return;
    }

    if (
      productsResult &&
      productsResult.status < 500 &&
      productsResult.parsed &&
      productsResult.parsed.success !== false &&
      (productCount > 0 || supplementProducts.length > 0)
    ) {
      const mergedProducts = mergeSearchProducts(primaryProducts, supplementProducts, queryKeyword, size);
      const body = supplementProducts.length
        ? JSON.stringify(
            buildUnifiedPayload(
              mergedProducts,
              queryKeyword,
              combinedSearchSource('products-primary', supplementProducts),
              productsResult.parsed &&
                productsResult.parsed.data &&
                productsResult.parsed.data.updatedAt,
              supplementMessage(supplementProducts),
              {
                totalCount: Math.max(productCount, supplementProducts.length, mergedProducts.length)
              }
            )
          )
        : JSON.stringify(productsResult.parsed);
      pruneSearchCache();
      searchCache.set(ck, { body, status: 200, ts: Date.now() });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Cache', 'MISS');
      res.setHeader(
        'X-Search-Source',
        combinedSearchSource('products-primary', supplementProducts)
      );
      res.end(body);
      return;
    }

    if (supplementProducts.length > 0) {
      const source = supplementSourceSuffix(supplementProducts) || 'search-supplement';
      const supplementBody = JSON.stringify(
        buildUnifiedPayload(
          mergeSearchProducts([], supplementProducts, queryKeyword, size),
          queryKeyword,
          source,
          null,
          supplementMessage(supplementProducts),
          {
            totalCount: supplementProducts.length
          }
        )
      );
      pruneSearchCache();
      searchCache.set(ck, { body: supplementBody, status: 200, ts: Date.now() });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Search-Source', source);
      res.end(supplementBody);
      return;
    }

    if (!productsResult || productsResult.status >= 500 || !productsResult.parsed) {
      const detail = await loadLocalDetailData();
      const fallbackBody = JSON.stringify(buildFallbackPayloadFromDetail(detail, queryKeyword, size));

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Search-Source', 'fallback-local');
      res.setHeader('X-Upstream-Status', String((productsResult && productsResult.status) || 500));
      res.end(fallbackBody);
      return;
    }

    const emptyBody = JSON.stringify({
      success: true,
      message:
        '매장 재고 기준 검색 결과가 없습니다. 철자(예: 어뮤즈) 또는 다른 키워드로 다시 시도해 주세요.',
      data: {
        inventory: { totalCount: 0, products: [] },
        keyword: String(queryKeyword || '')
      }
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Search-Source', 'products-empty');
    res.end(emptyBody);
  } catch (e) {
    const msg = e && e.message != null ? String(e.message) : 'Proxy error';
    const isAbort = e && e.name === 'AbortError';
    try {
      const detail = await loadLocalDetailData();
      const fallbackBody = JSON.stringify(buildFallbackPayloadFromDetail(detail, queryKeyword, size));

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Cache', 'ERROR');
      res.setHeader('X-Search-Source', 'fallback-local');
      res.setHeader('X-Upstream-Error', isAbort ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_FETCH');
      res.end(fallbackBody);
    } catch (fallbackErr) {
      const emptyBody = JSON.stringify({
        success: true,
        fallback: true,
        message: '검색 결과를 불러오지 못했습니다. 다른 키워드로 다시 검색해 주세요.',
        data: {
          inventory: { totalCount: 0, products: [] },
          keyword: String(queryKeyword || '')
        },
        diagnostics: {
          upstreamError: isAbort ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_FETCH',
          fallbackError:
            fallbackErr && fallbackErr.message ? String(fallbackErr.message) : 'Fallback build failed'
        }
      });

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Cache', 'ERROR');
      res.setHeader('X-Search-Source', 'fallback-empty');
      res.setHeader('X-Upstream-Error', isAbort ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_FETCH');
      res.end(emptyBody);
    }
  }
};
