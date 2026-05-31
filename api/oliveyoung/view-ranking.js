const RTS_URL = 'https://rts.ai.oliveyoung.co.kr/api/stats';
const IMAGE_BASE =
  'https://image.oliveyoung.co.kr/cfimages/cf-goods/uploads/images/thumbnails/';

let cache = null;

function parseSize(value) {
  const n = Number.parseInt(String(value || '100'), 10);
  if (!Number.isFinite(n)) return 100;
  if (n < 1) return 1;
  if (n > 200) return 200;
  return n;
}

function goodsNoFromItem(item) {
  const raw = String((item && item.itemUrl) || '').trim();
  const match = raw.match(/goodsNo=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : raw;
}

function imageUrlFromItem(item) {
  const raw = String((item && item.imageUrl) || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return IMAGE_BASE + raw.replace(/^\/+/, '');
}

function normalizeItem(item, idx) {
  const goodsNo = goodsNoFromItem(item);
  return {
    rank: idx + 1,
    sourceRank: Number(item && item.rank) || idx + 1,
    goodsNo,
    goodsNumber: goodsNo,
    goodsName: String((item && item.itemName) || goodsNo),
    imageUrl: imageUrlFromItem(item),
    categoryNumber: String((item && item.categoryId) || ''),
    brandId: String((item && item.brandId) || ''),
    viewCount: Number((item && item.count) || 0),
    itemId: String((item && item.itemId) || ''),
    source: 'oliveyoung-view-rank'
  };
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ success: false, error: 'method not allowed' });
    return;
  }

  const size = parseSize(req.query && req.query.size);
  const now = Date.now();
  const cacheKey = String(size);
  if (cache && cache.key === cacheKey && now - cache.ts < 30 * 1000) {
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    res.status(200).json(cache.data);
    return;
  }

  const url = new URL(RTS_URL);
  const upstreamSize = Math.min(200, Math.max(size, Math.ceil(size * 1.6)));
  url.searchParams.set('type', 'view');
  url.searchParams.set('size', String(upstreamSize));

  try {
    const upstream = await fetchWithTimeout(url.toString(), 5000);
    const text = await upstream.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = null;
    }

    if (!upstream.ok || !json || !Array.isArray(json.items)) {
      res.status(upstream.status || 502).json({
        success: false,
        error: 'oliveyoung view ranking failed',
        status: upstream.status,
        detail: text.slice(0, 300)
      });
      return;
    }

    const products = json.items
      .map(normalizeItem)
      .filter((p) => p.goodsNo)
      .slice(0, size);
    const data = {
      success: true,
      data: {
        type: 'view',
        requestedSize: size,
        totalCount: products.length,
        updatedAt: json.dateTime || new Date().toISOString(),
        products
      }
    };

    cache = { key: cacheKey, ts: now, data };
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({
      success: false,
      error: 'oliveyoung view ranking error',
      message: e && e.message ? e.message : String(e)
    });
  }
};
