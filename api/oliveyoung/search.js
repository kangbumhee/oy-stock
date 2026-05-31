const fs = require('fs/promises');
const path = require('path');

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 200;
const searchCache = new Map();

const PRODUCTS_TIMEOUT_MS = 4500;
const LOCAL_DETAIL_CACHE_TTL_MS = 60 * 1000;
const localDetailCache = { ts: 0, data: null };
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
    const productsResult = await fetchUpstreamProducts(queryKeyword, size);
    const productCount = getProducts(productsResult && productsResult.parsed).length;

    if (
      productsResult &&
      productsResult.status < 500 &&
      productsResult.parsed &&
      productsResult.parsed.success !== false &&
      productCount > 0
    ) {
      const body = JSON.stringify(productsResult.parsed);
      pruneSearchCache();
      searchCache.set(ck, { body, status: 200, ts: Date.now() });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Search-Source', 'products-primary');
      res.end(body);
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
