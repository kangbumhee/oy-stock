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

function isMobileUserAgent(req) {
  const ua = String((req.headers && req.headers['user-agent']) || '');
  return /Android|iPhone|iPad|iPod|Mobile|NAVER|KAKAOTALK|Instagram|FBAN|FBAV/i.test(ua);
}

function htmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function oliveYoungAndroidIntentUrl(appUrl, fallbackUrl) {
  try {
    const url = new URL(appUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'm.oliveyoung.co.kr') {
      return '';
    }
    return (
      'intent://' +
      url.host +
      url.pathname +
      url.search +
      '#Intent;scheme=https;package=com.oliveyoung;S.browser_fallback_url=' +
      encodeURIComponent(fallbackUrl) +
      ';end'
    );
  } catch {
    return '';
  }
}

function mobileBridgeHtml({ goodsNo, appUrl, webUrl, androidIntentUrl }) {
  const title = '올리브영으로 이동 중';
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow">
  <title>${title}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;background:#f0fdff;color:#143344}
    main{width:100%;max-width:420px;padding:24px;border:1px solid #b8eef3;border-radius:12px;background:#fff;text-align:center;box-shadow:0 18px 50px rgba(15,55,70,.12)}
    .dot{width:46px;height:46px;margin:0 auto 14px;border-radius:14px;background:#15c6d1;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900}
    h1{font-size:22px;line-height:1.35;margin-bottom:8px}
    p{font-size:14px;line-height:1.7;color:#4a6472;margin-bottom:16px}
    .actions{display:grid;gap:8px;margin-top:14px}
    a,button{min-height:44px;border-radius:8px;border:0;text-decoration:none;font:inherit;font-weight:900;display:flex;align-items:center;justify-content:center;cursor:pointer}
    .primary{background:#15c6d1;color:#fff}
    .secondary{background:#eefbfc;color:#0f5660}
    small{display:block;margin-top:14px;color:#7a8c96;font-size:12px}
  </style>
</head>
<body>
  <main>
    <div class="dot">OY</div>
    <h1>올리브영으로 열어볼게요</h1>
    <p>앱이 설치되어 있으면 앱으로 열리고, 없으면 모바일 웹으로 이어집니다.</p>
    <div class="actions">
      <button class="primary" type="button" id="open-app">앱으로 열기</button>
      <a class="secondary" href="${htmlEscape(webUrl)}">웹으로 보기</a>
    </div>
    <small>잠시만 기다려주세요.</small>
  </main>
  <script>
    (function () {
      var appUrl = ${JSON.stringify(appUrl)};
      var webUrl = ${JSON.stringify(webUrl)};
      var androidIntentUrl = ${JSON.stringify(androidIntentUrl)};
      var openedApp = false;
      var fallbackTimer = null;

      function markOpened() {
        openedApp = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
      }

      function openWeb() {
        if (openedApp) return;
        window.location.replace(webUrl);
      }

      function openTarget() {
        var ua = navigator.userAgent || '';
        var isAndroid = /Android/i.test(ua);
        var isIOS = /iPhone|iPad|iPod/i.test(ua);
        document.addEventListener('visibilitychange', function () {
          if (document.hidden) markOpened();
        });
        window.addEventListener('pagehide', markOpened);
        window.addEventListener('blur', markOpened);

        if (isAndroid && androidIntentUrl) {
          window.location.href = androidIntentUrl;
          fallbackTimer = setTimeout(openWeb, 1800);
          return;
        }

        if (isIOS) {
          window.location.href = appUrl;
          fallbackTimer = setTimeout(openWeb, 1800);
          return;
        }

        openWeb();
      }

      var btn = document.getElementById('open-app');
      if (btn) btn.addEventListener('click', openTarget);
      setTimeout(openTarget, 120);
    })();
  </script>
</body>
</html>`;
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
  const appUrl = cachedLong || basicLong;
  const androidIntentUrl = oliveYoungAndroidIntentUrl(appUrl, redirectTarget);

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
        appUrl,
        androidIntentUrl,
        source,
        cacheUpdatedAt: data && data.updatedAt,
        loadError: loadError || undefined,
        affiliateActivityId: entry && entry.affiliateActivityId,
        generatedAt: entry && entry.generatedAt
      })
    );
    return;
  }

  if (isMobileUserAgent(req)) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      mobileBridgeHtml({
        goodsNo,
        appUrl,
        webUrl: redirectTarget,
        androidIntentUrl
      })
    );
    return;
  }

  res.writeHead(302, { Location: redirectTarget });
  res.end();
};
