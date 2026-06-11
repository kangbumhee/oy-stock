/**
 * GitHub Actions + Playwright로 생성한 public/data/curator-links.json 만 조회.
 * (Vercel 서버에서 m.oliveyoung API 직접 호출은 Cloudflare 403)
 *
 * format=json — JSON 응답
 * format=debug — 캐시 URL, 조회 결과, 항목 요약
 */

const FALLBACK_WWW =
  'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=';
const CURATOR_CACHE_TTL_MS = 60 * 1000;
const GENERATION_REQUEST_TTL_MS = 10 * 60 * 1000;
const ON_DEMAND_WORKFLOW_FILE = 'curator-link-on-demand.yml';

let curatorLinksCache = null;
const generationRequestCache = new Map();

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

function pendingCuratorHtml({ goodsNo, pollUrl, fallbackUrl, queueStatus }) {
  const title = '사이트 여는 중';
  const fallback = htmlEscape(fallbackUrl);
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow">
  <title>${title}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;background:#f6fbf8;color:#12251a}
    main{width:100%;max-width:420px;padding:24px;border:1px solid #b9ead0;border-radius:12px;background:#fff;text-align:center;box-shadow:0 18px 50px rgba(20,80,45,.12)}
    .spinner{width:44px;height:44px;margin:0 auto 16px;border:4px solid #dff6e8;border-top-color:#16a34a;border-radius:999px;animation:spin 1s linear infinite}
    h1{font-size:22px;line-height:1.35;margin-bottom:8px}
    p{font-size:14px;line-height:1.7;color:#496154;margin-bottom:14px}
    a{min-height:44px;border-radius:8px;border:1px solid #17a34a;text-decoration:none;font:inherit;font-weight:900;display:flex;align-items:center;justify-content:center;color:#12833b;background:#f0fdf4}
    small{display:block;margin-top:14px;color:#7a8c82;font-size:12px}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <main>
    <div class="spinner" aria-hidden="true"></div>
    <h1>사이트여는중</h1>
    <p>큐레이터 링크를 확인하고 있습니다. 처음 보는 상품이면 자동 생성 후 열립니다.</p>
    <a href="${fallback}" id="fallback">올리브영 상품 보기</a>
    <small id="status">${htmlEscape(queueStatus || '링크 확인 중')}</small>
  </main>
  <script>
    (function () {
      var pollUrl = ${JSON.stringify(pollUrl)};
      var fallbackUrl = ${JSON.stringify(fallbackUrl)};
      var goodsNo = ${JSON.stringify(goodsNo)};
      var status = document.getElementById('status');
      var started = Date.now();
      var timeoutMs = 95000;
      var intervalMs = 4500;

      function setStatus(text) {
        if (status) status.textContent = text;
      }

      async function poll() {
        try {
          var res = await fetch(pollUrl, { cache: 'no-store' });
          var data = await res.json();
          if (
            data &&
            data.redirectUrl &&
            data.source &&
            data.source !== 'fallback_basic_utm'
          ) {
            setStatus('큐레이터 링크 확인 완료');
            window.location.replace(data.redirectUrl);
            return;
          }
          if (data && data.queueStatus) setStatus(data.queueStatus);
        } catch (e) {
          setStatus('링크 확인 재시도 중');
        }

        if (Date.now() - started > timeoutMs) {
          setStatus('생성이 늦어져 일반 상품 페이지로 이동합니다. 잠시 후 다시 누르면 큐레이터 링크로 열릴 수 있습니다.');
          window.setTimeout(function () {
            window.location.replace(fallbackUrl);
          }, 1200);
          return;
        }
        window.setTimeout(poll, intervalMs);
      }

      setStatus('링크 생성 작업 확인 중: ' + goodsNo);
      window.setTimeout(poll, 1800);
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

function publicBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https')
    .split(',')[0]
    .trim();
  const host = req.headers.host;
  return host ? `${proto}://${host}` : '';
}

function parseGithubRepo() {
  const rawRepo = String(process.env.GITHUB_REPO || 'kangbumhee/oy-stock').trim();
  const rawOwner = String(process.env.GITHUB_OWNER || '').trim();
  if (rawRepo.includes('/')) {
    const parts = rawRepo.split('/');
    return { owner: parts[0], repo: parts[1] };
  }
  return { owner: rawOwner || 'kangbumhee', repo: rawRepo || 'oy-stock' };
}

function normalizeGoodsNo(goodsNo) {
  const gn = String(goodsNo || '').trim().toUpperCase();
  return /^[AB]\d+$/.test(gn) ? gn : '';
}

function githubToken() {
  return (
    String(process.env.CURATOR_GITHUB_TOKEN || '').trim() ||
    String(process.env.GITHUB_TOKEN || '').trim()
  );
}

function pruneGenerationRequestCache() {
  const now = Date.now();
  for (const [goodsNo, item] of generationRequestCache) {
    if (!item || now - item.ts > GENERATION_REQUEST_TTL_MS) {
      generationRequestCache.delete(goodsNo);
    }
  }
}

async function triggerCuratorGeneration(goodsNo) {
  const normalized = normalizeGoodsNo(goodsNo);
  if (!normalized) return { ok: false, status: '상품번호 확인 실패' };

  pruneGenerationRequestCache();
  const cached = generationRequestCache.get(normalized);
  if (cached && Date.now() - cached.ts < GENERATION_REQUEST_TTL_MS) {
    return {
      ...cached.result,
      throttled: true,
      status: cached.result.status || '링크 생성 작업이 이미 요청됨'
    };
  }

  const token = githubToken();
  if (!token) {
    const result = { ok: false, status: 'GitHub 토큰 미설정으로 자동 생성 요청 실패' };
    generationRequestCache.set(normalized, { ts: Date.now(), result });
    return result;
  }

  const { owner, repo } = parseGithubRepo();
  const workflow = String(process.env.CURATOR_ON_DEMAND_WORKFLOW || ON_DEMAND_WORKFLOW_FILE).trim();
  const branch = String(process.env.GITHUB_BRANCH || 'main').trim() || 'main';
  const url =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'oy-stock-curator-redirect',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        ref: branch,
        inputs: { goodsNos: normalized }
      })
    });

    const text = await response.text();
    const ok = response.status === 204 || response.ok;
    const result = ok
      ? { ok: true, status: '큐레이터 링크 생성 작업 요청됨' }
      : {
          ok: false,
          status: `GitHub Action 요청 실패: HTTP ${response.status}`,
          detail: text.slice(0, 200)
        };
    generationRequestCache.set(normalized, { ts: Date.now(), result });
    return result;
  } catch (e) {
    const result = {
      ok: false,
      status: 'GitHub Action 요청 실패',
      detail: String(e.message || e)
    };
    generationRequestCache.set(normalized, { ts: Date.now(), result });
    return result;
  }
}

function githubCuratorDataUrl() {
  const explicit = String(process.env.CURATOR_LINKS_SOURCE_URL || '').trim();
  if (explicit) return explicit;
  const { owner, repo } = parseGithubRepo();
  const branch = String(process.env.GITHUB_BRANCH || 'main').trim() || 'main';
  const filePath =
    String(process.env.CURATOR_LINKS_FILE || 'public/data/curator-links.json')
      .trim()
      .replace(/^\/+/, '') || 'public/data/curator-links.json';
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${filePath}`;
}

async function fetchCuratorLinksFrom(url, source) {
  if (!url) return { url, source, data: null, error: 'empty url' };
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    if (!r.ok) {
      return { url, source, data: null, error: 'HTTP ' + r.status };
    }
    const data = await r.json();
    return { url, source, data, error: null };
  } catch (e) {
    return { url, source, data: null, error: String(e.message || e) };
  }
}

async function loadCuratorLinks(req, options = {}) {
  const now = Date.now();
  if (
    !options.forceRefresh &&
    curatorLinksCache &&
    now - curatorLinksCache.ts < CURATOR_CACHE_TTL_MS &&
    curatorLinksCache.data
  ) {
    return { ...curatorLinksCache.result, cacheHit: true };
  }

  const urls = [
    { url: githubCuratorDataUrl(), source: 'github_raw' },
    { url: curatorDataUrl(req), source: 'host_static' }
  ];
  const errors = [];

  for (const item of urls) {
    if (!item.url) {
      errors.push({ source: item.source, url: item.url, error: 'no Host header' });
      continue;
    }
    const result = await fetchCuratorLinksFrom(item.url, item.source);
    if (result.data && result.data.links) {
      const saved = {
        url: result.url,
        source: result.source,
        data: result.data,
        error: null,
        errors
      };
      curatorLinksCache = { ts: now, data: result.data, result: saved };
      return saved;
    }
    errors.push({
      source: result.source,
      url: result.url,
      error: result.error || 'invalid data'
    });
  }

  return {
    url: urls[0].url || urls[1].url || null,
    source: 'none',
    data: null,
    error: errors.map((e) => `${e.source}: ${e.error}`).join(' | ') || 'load failed',
    errors
  };
}

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status: r.status, json: null, text };
  }
  return { ok: r.ok, status: r.status, json, text };
}

async function createLiveCuratorLink(req, goodsNo, categoryNumber) {
  const base = publicBaseUrl(req);
  if (!base) return { ok: false, error: 'missing host' };

  try {
    const landingPayload = { goodsNo };
    if (categoryNumber) landingPayload.categoryNumber = categoryNumber;

    const landing = await fetchJson(`${base}/api/oliveyoung/landing-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(landingPayload)
    });
    const affiliateActivityId =
      landing.json && landing.json.affiliateActivityId
        ? String(landing.json.affiliateActivityId)
        : '';
    const affiliatePartnerId =
      landing.json && landing.json.affiliatePartnerId
        ? String(landing.json.affiliatePartnerId)
        : '';

    if (!affiliateActivityId) {
      return {
        ok: false,
        error: 'landing_failed',
        landingStatus: landing.status,
        landingBody: landing.json || landing.text.slice(0, 200)
      };
    }

    const originalUrl =
      mobileUrlBasicAffiliate(goodsNo) +
      '&utm_content=OY_' +
      encodeURIComponent(affiliateActivityId);

    const shorten = await fetchJson(`${base}/api/oliveyoung/shorten-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        originalUrl,
        registerId: affiliatePartnerId || undefined
      })
    });
    const row =
      shorten.json &&
      shorten.json.data &&
      Array.isArray(shorten.json.data) &&
      shorten.json.data[0];
    const shortenedUrl = row && row.shortenedUrl ? String(row.shortenedUrl) : '';

    return {
      ok: true,
      shortenedUrl: shortenedUrl || null,
      originalUrl,
      affiliateActivityId,
      affiliatePartnerId: affiliatePartnerId || null,
      shortenStatus: shorten.status,
      shortenBody: shortenedUrl ? undefined : shorten.json || shorten.text.slice(0, 200)
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
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
  const categoryNumber = String(q.categoryNumber || q.category || '').trim();
  const jsonMode = q.format === 'json';
  const debugMode = q.format === 'debug';
  const noTrigger = q.noTrigger === '1' || q.noTrigger === 'true';
  const forceRefresh = q.refresh === '1' || q.refresh === 'true';

  if (!goodsNo) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, message: 'goodsNo required' }));
    return;
  }

  const {
    url: cacheUrl,
    source: cacheSource,
    data,
    error: loadError,
    errors: loadErrors,
    cacheHit
  } = await loadCuratorLinks(req, { forceRefresh });
  const links = (data && data.links) || {};
  const entry = links[goodsNo];
  const shortenedUrl = entry && entry.shortenedUrl;
  const cachedLong =
    entry && entry.originalUrl && String(entry.originalUrl).trim()
      ? entry.originalUrl
      : null;
  const basicLong = mobileUrlBasicAffiliate(goodsNo);

  const allowLiveLink = process.env.ENABLE_LIVE_CURATOR_LINKS === '1';
  const liveLink =
    allowLiveLink && !shortenedUrl && !cachedLong
      ? await createLiveCuratorLink(req, goodsNo, categoryNumber)
      : null;

  let redirectTarget =
    shortenedUrl ||
    cachedLong ||
    (liveLink && liveLink.ok && (liveLink.shortenedUrl || liveLink.originalUrl)) ||
    basicLong;
  let source = shortenedUrl
    ? 'cache_shortened'
    : cachedLong
      ? 'cache_original'
      : liveLink && liveLink.ok && liveLink.shortenedUrl
        ? 'live_shortened'
        : liveLink && liveLink.ok && liveLink.originalUrl
          ? 'live_original'
          : 'fallback_basic_utm';
  const queueRequest =
    source === 'fallback_basic_utm' && !noTrigger
      ? await triggerCuratorGeneration(goodsNo)
      : null;
  const queueStatus =
    queueRequest && queueRequest.status
      ? queueRequest.status
      : source === 'fallback_basic_utm'
        ? '큐레이터 링크 생성 대기 중'
        : null;
  const appUrl =
    cachedLong ||
    (liveLink && liveLink.ok && liveLink.originalUrl) ||
    basicLong;
  const androidIntentUrl = oliveYoungAndroidIntentUrl(appUrl, redirectTarget);

  if (debugMode) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        format: 'debug',
        goodsNo,
        curatorLinksUrl: cacheUrl,
        curatorLinksSource: cacheSource,
        loadError,
        loadErrors,
        cacheHit: !!cacheHit,
        cacheUpdatedAt: data && data.updatedAt,
        entry: entry || null,
        liveLink,
        queueRequest,
        resolvedRedirect: redirectTarget,
        source,
        note:
          'curator-links.json 은 stock.yml 또는 curator-link-on-demand.yml → generate-curator-links.mjs 로 갱신. OY_REFRESH_COOKIE 필요.'
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
        shortenedUrl:
          shortenedUrl || (liveLink && liveLink.ok && liveLink.shortenedUrl) || null,
        longUrl:
          cachedLong ||
          (liveLink && liveLink.ok && liveLink.originalUrl) ||
          basicLong,
        redirectUrl: redirectTarget,
        appUrl,
        androidIntentUrl,
        source,
        curatorLinksSource: cacheSource,
        cacheUpdatedAt: data && data.updatedAt,
        loadError: loadError || undefined,
        liveError:
          liveLink && !liveLink.ok
            ? liveLink.error || liveLink.landingBody || 'live link failed'
            : undefined,
        queueStatus,
        queueRequest:
          queueRequest && {
            ok: queueRequest.ok,
            throttled: !!queueRequest.throttled,
            status: queueRequest.status,
            detail: queueRequest.detail
          },
        affiliateActivityId:
          (entry && entry.affiliateActivityId) ||
          (liveLink && liveLink.ok ? liveLink.affiliateActivityId : undefined),
        generatedAt: entry && entry.generatedAt
      })
    );
    return;
  }

  if (source === 'fallback_basic_utm' && queueRequest && queueRequest.ok) {
    const base = publicBaseUrl(req);
    const poll = new URL('/api/oliveyoung/curator-redirect', base);
    poll.searchParams.set('goodsNo', goodsNo);
    poll.searchParams.set('format', 'json');
    poll.searchParams.set('refresh', '1');
    poll.searchParams.set('noTrigger', '1');
    if (categoryNumber) poll.searchParams.set('categoryNumber', categoryNumber);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      pendingCuratorHtml({
        goodsNo,
        pollUrl: poll.toString(),
        fallbackUrl: basicLong,
        queueStatus
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
