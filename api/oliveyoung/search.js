const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 200;
const searchCache = new Map();

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

  const ck = cacheKey(keyword, lat, lng, size);
  const hit = searchCache.get(ck);
  if (hit && Date.now() - hit.ts < SEARCH_CACHE_TTL_MS) {
    res.statusCode = hit.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Cache', 'HIT');
    res.end(hit.body);
    return;
  }

  try {
    const url =
      'https://mcp.aka.page/api/oliveyoung/inventory?keyword=' +
      encodeURIComponent(keyword) +
      '&lat=' +
      encodeURIComponent(lat) +
      '&lng=' +
      encodeURIComponent(lng) +
      '&size=' +
      encodeURIComponent(size);

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 20000);
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'OliveyoungStockChecker/1.0' },
      signal: controller.signal
    });
    clearTimeout(t);

    const text = await r.text();
    pruneSearchCache();
    searchCache.set(ck, { body: text, status: r.status, ts: Date.now() });

    res.statusCode = r.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Cache', 'MISS');
    res.end(text);
  } catch (e) {
    // fetch / AbortController timeout / r.text() 등에서 throw 시 여기로 옴
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Cache', 'ERROR');
    res.end(
      JSON.stringify({
        error: e && e.message != null ? String(e.message) : 'Proxy error',
        stack: e && e.stack ? String(e.stack).slice(0, 500) : undefined
      })
    );
  }
};
