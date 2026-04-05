/**
 * GitHub Actions + Playwright로 생성한 public/data/curator-links.json 만 조회.
 * (Vercel 서버에서 m.oliveyoung API 직접 호출은 Cloudflare 403)
 *
 * format=json — JSON 응답
 * format=debug — 캐시 URL, 조회 결과, 항목 요약
 */

const FALLBACK_WWW =
  'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=';

function mobileUrlBasicAffiliate(goodsNo) {
  return (
    'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=' +
    encodeURIComponent(goodsNo) +
    '&utm_source=shutter&utm_medium=affiliate'
  );
}

function curatorDataUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https')
    .split(',')[0]
    .trim();
  const host = req.headers.host;
  if (!host) return null;
  return `${proto}://${host}/data/curator-links.json`;
}

async function loadCuratorLinks(req) {
  const url = curatorDataUrl(req);
  if (!url) {
    return { url: null, data: null, error: 'no Host header' };
  }
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    if (!r.ok) {
      return { url, data: null, error: 'HTTP ' + r.status };
    }
    const data = await r.json();
    return { url, data, error: null };
  } catch (e) {
    return { url, data: null, error: String(e.message || e) };
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
    res.end(JSON.stringify({ success: false, message: 'GET only' }));
    return;
  }

  const q = req.query || {};
  const goodsNo = String(q.goodsNo || '').trim();
  const jsonMode = q.format === 'json';
  const debugMode = q.format === 'debug';

  if (!goodsNo) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, message: 'goodsNo required' }));
    return;
  }

  const { url: cacheUrl, data, error: loadError } = await loadCuratorLinks(req);
  const links = (data && data.links) || {};
  const entry = links[goodsNo];
  const shortenedUrl = entry && entry.shortenedUrl;
  const cachedLong =
    entry && entry.originalUrl && String(entry.originalUrl).trim()
      ? entry.originalUrl
      : null;
  const basicLong = mobileUrlBasicAffiliate(goodsNo);

  let redirectTarget = shortenedUrl || cachedLong || basicLong;
  let source = shortenedUrl
    ? 'cache_shortened'
    : cachedLong
      ? 'cache_original'
      : 'fallback_basic_utm';

  if (debugMode) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        format: 'debug',
        goodsNo,
        curatorLinksUrl: cacheUrl,
        loadError,
        cacheUpdatedAt: data && data.updatedAt,
        entry: entry || null,
        resolvedRedirect: redirectTarget,
        source,
        note:
          'curator-links.json 은 stock.yml → generate-curator-links.mjs 로 갱신. OY_CURATOR_COOKIE 필요.'
      })
    );
    return;
  }

  if (jsonMode) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        success: true,
        shortenedUrl: shortenedUrl || null,
        longUrl: cachedLong || basicLong,
        redirectUrl: redirectTarget,
        source,
        cacheUpdatedAt: data && data.updatedAt,
        loadError: loadError || undefined,
        affiliateActivityId: entry && entry.affiliateActivityId,
        generatedAt: entry && entry.generatedAt
      })
    );
    return;
  }

  res.writeHead(302, { Location: redirectTarget });
  res.end();
};
