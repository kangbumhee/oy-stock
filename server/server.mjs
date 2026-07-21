import http from 'http';
import { chromium } from 'playwright';
import crypto from 'crypto';
import { searchOfficialProducts } from './official-search.mjs';

const PORT = Number(process.env.PORT) || 8080;
const OY = 'https://www.oliveyoung.co.kr';
const OY_M = 'https://m.oliveyoung.co.kr';
const CURATOR_AFFILIATE_REFERER =
  'https://m.oliveyoung.co.kr/m/mtn/affiliate/product/search';
const CURATOR_PLACEHOLDER_CATEGORY = '1000001000000000000';
const CURATOR_REGISTER_ID_DEFAULT = '4ee076cc92da4447a1b4b42c590e4495';
const CURATOR_SHRT_SECRET = 'e3ea1c526eef4570946ebdf083dad7a7';
const LINKAGE_AES_KEY = Buffer.from('cjone_g4de7353f1', 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const onlineCache = new Map();
const ONLINE_CACHE_TTL = 10 * 60 * 1000;
const STOCK_STORE_BATCH_CONCURRENCY = Math.max(
  1,
  Math.min(6, Number.parseInt(process.env.STOCK_STORE_BATCH_CONCURRENCY || '4', 10) || 4)
);
const STOCK_STORE_FETCH_TIMEOUT_MS = Math.max(
  1500,
  Number.parseInt(process.env.STOCK_STORE_FETCH_TIMEOUT_MS || '4500', 10) || 4500
);
const OY_API_FETCH_TIMEOUT_MS = Math.max(
  2000,
  Number.parseInt(process.env.OY_API_FETCH_TIMEOUT_MS || '3500', 10) || 3500
);
const OY_SEARCH_FETCH_TIMEOUT_MS = Math.max(
  4000,
  Number.parseInt(process.env.OY_SEARCH_FETCH_TIMEOUT_MS || '8000', 10) || 8000
);
const OY_SEARCH_TOTAL_TIMEOUT_MS = Math.max(
  12000,
  Number.parseInt(process.env.OY_SEARCH_TOTAL_TIMEOUT_MS || '22000', 10) || 22000
);
const STOCK_DETAIL_TOTAL_TIMEOUT_MS = Math.max(
  6000,
  Number.parseInt(process.env.STOCK_DETAIL_TOTAL_TIMEOUT_MS || '18000', 10) || 18000
);
const STOCK_DETAIL_ONLINE_ONLY_TIMEOUT_MS = Math.max(
  3000,
  Number.parseInt(process.env.STOCK_DETAIL_ONLINE_ONLY_TIMEOUT_MS || '6500', 10) || 6500
);
const STOCK_SESSION_READY_TIMEOUT_MS = Math.max(
  8000,
  Number.parseInt(process.env.STOCK_SESSION_READY_TIMEOUT_MS || '16000', 10) || 16000
);
const SESSION_HEALTHCHECK_TIMEOUT_MS = Math.max(
  800,
  Number.parseInt(process.env.SESSION_HEALTHCHECK_TIMEOUT_MS || '1500', 10) || 1500
);

/** 팝업 등 동일 상품·위치 반복 조회 시 Playwright 부하 완화 (TTL 짧게 유지) */
const detailResponseCache = new Map();
const DETAIL_RESPONSE_TTL_MS = 3 * 60 * 1000;
const DETAIL_RESPONSE_CACHE_MAX = 80;
const allRegionsResponseCache = new Map();
const ALL_REGIONS_RESPONSE_TTL_MS = 3 * 60 * 1000;
const ALL_REGIONS_RESPONSE_CACHE_MAX = 80;

function detailResponseCacheKey(goodsNo, lat, lng, withOnline, onlineOnly) {
  return `${goodsNo}|${lat}|${lng}|${withOnline ? 1 : 0}|${onlineOnly ? 1 : 0}`;
}

function pruneDetailResponseCache() {
  const now = Date.now();
  for (const [k, v] of detailResponseCache) {
    if (now - v.ts > DETAIL_RESPONSE_TTL_MS) detailResponseCache.delete(k);
  }
  while (detailResponseCache.size > DETAIL_RESPONSE_CACHE_MAX) {
    const first = detailResponseCache.keys().next().value;
    if (first == null) break;
    detailResponseCache.delete(first);
  }
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timeout after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function allRegionsResponseCacheKey(goodsNo, productId) {
  return `${goodsNo}|${productId || ''}`;
}

function pruneAllRegionsResponseCache() {
  const now = Date.now();
  for (const [k, v] of allRegionsResponseCache) {
    if (now - v.ts > ALL_REGIONS_RESPONSE_TTL_MS) allRegionsResponseCache.delete(k);
  }
  while (allRegionsResponseCache.size > ALL_REGIONS_RESPONSE_CACHE_MAX) {
    const first = allRegionsResponseCache.keys().next().value;
    if (first == null) break;
    allRegionsResponseCache.delete(first);
  }
}

let busy = false;
async function withLock(fn) {
  const start = Date.now();
  while (busy) {
    if (Date.now() - start > 10000) return null;
    await sleep(200);
  }
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

const CURATOR_MAX_CONCURRENT = Math.max(
  1,
  Math.min(4, Number.parseInt(process.env.CURATOR_MAX_CONCURRENT || '3', 10) || 3)
);

async function withCuratorSlot(fn) {
  const start = Date.now();
  while (curatorActiveCount >= CURATOR_MAX_CONCURRENT) {
    if (Date.now() - start > 60000) {
      throw new Error('curator_link_busy');
    }
    await sleep(150);
  }
  curatorActiveCount += 1;
  try {
    return await fn();
  } finally {
    curatorActiveCount = Math.max(0, curatorActiveCount - 1);
  }
}

let browser = null;
let page = null;
let sessionReady = false;
let sessionCreatedAt = 0;
let initPromise = null;
let keepAliveTimer = null;
let keepAliveRunning = false;
let curatorContext = null;
let curatorPage = null;
let curatorBrowser = null;
let curatorReady = false;
let curatorInitPromise = null;
let curatorActiveCount = 0;
let curatorSharedPageBusy = false;
let curatorCreatedAt = 0;

const curatorLinkCache = new Map();
const CURATOR_LINK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CURATOR_LINK_CACHE_MAX = 500;

const SESSION_MAX_AGE = Number(process.env.SESSION_MAX_AGE_MS || 55 * 60 * 1000);
const SESSION_KEEPALIVE_MS = Number(process.env.SESSION_KEEPALIVE_MS || 5 * 60 * 1000);

function unwrapPayload(json) {
  if (!json || typeof json !== 'object') return {};
  const d = json.data;
  if (d && typeof d === 'object' && d.goodsInfo != null) return d;
  if (d && typeof d === 'object' && d.data && d.data.goodsInfo != null) return d.data;
  if (json.goodsInfo != null) return json;
  return d && typeof d === 'object' ? d : {};
}

function yn(v) {
  return v === true || v === 'Y' || v === 'y';
}

function isValidGoodsNo(g) {
  return /^[AB]\d+$/i.test(String(g || '').trim());
}

function normalizeGoodsNo(value) {
  const goodsNo = String(value || '').trim().toUpperCase();
  return isValidGoodsNo(goodsNo) ? goodsNo : '';
}

function decodeCookieValue(v) {
  let out = String(v || '').trim();
  try {
    out = decodeURIComponent(out);
  } catch {
    /* keep */
  }
  return out.trim();
}

function extractCookieValue(cookieString, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(cookieString || '').match(new RegExp('(?:^|;\\s*)' + escaped + '=([^;]+)', 'i'));
  return m ? decodeCookieValue(m[1]) : '';
}

function decryptLinkageString(hexString) {
  const encrypted = Buffer.from(String(hexString).trim(), 'hex');
  const decipher = crypto.createDecipheriv(
    'aes-128-ecb',
    LINKAGE_AES_KEY,
    Buffer.alloc(0)
  );
  decipher.setAutoPadding(true);
  let decrypted = decipher.update(encrypted, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted.trim();
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function authCandidateFromJwt(jwt, source, cookieHeader) {
  const token = String(jwt || '').trim();
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  const expSec =
    payload && payload.exp != null && Number.isFinite(Number(payload.exp))
      ? Number(payload.exp)
      : null;
  return {
    jwt: token,
    source,
    cookieHeader: cookieHeader || '',
    expSec,
    expired: expSec != null ? expSec <= Date.now() / 1000 : false
  };
}

function authCandidateFromLinkageHex(hex, source, cookieHeader) {
  const raw = decodeCookieValue(hex);
  if (!raw) return null;
  try {
    return authCandidateFromJwt(decryptLinkageString(raw), source, cookieHeader);
  } catch (e) {
    console.warn(`${source} linkageString 복호화 실패:`, e.message || e);
    return null;
  }
}

function buildCuratorSessionCookie() {
  const sid = String(process.env.OY_SESSION_ID || '').trim();
  const ls = String(process.env.OY_LINKAGE_STRING || '').trim();
  if (sid && ls) return `OYSESSIONID=${sid}; linkageString=${ls}`;
  return '';
}

function collectCuratorAuthCandidates() {
  const candidates = [];
  const cookieSources = [
    ['OY_CURATOR_COOKIE', String(process.env.OY_CURATOR_COOKIE || '').trim()],
    ['OY_REFRESH_COOKIE', String(process.env.OY_REFRESH_COOKIE || '').trim()],
    ['OY_SESSION_ID+OY_LINKAGE_STRING', buildCuratorSessionCookie()]
  ];

  for (const [source, cookieHeader] of cookieSources) {
    if (!cookieHeader) continue;
    const hex = extractCookieValue(cookieHeader, 'linkageString');
    const candidate = authCandidateFromLinkageHex(hex, source, cookieHeader);
    if (candidate) candidates.push(candidate);
  }

  const linkageSources = [
    ['OY_LINKAGE_STRING', process.env.OY_LINKAGE_STRING],
    ['OLIVEYOUNG_LINKAGE_STRING', process.env.OLIVEYOUNG_LINKAGE_STRING]
  ];
  for (const [source, hex] of linkageSources) {
    const candidate = authCandidateFromLinkageHex(hex, source, '');
    if (candidate) candidates.push(candidate);
  }

  const jwtSources = [
    ['OY_LINKAGE_JWT', process.env.OY_LINKAGE_JWT],
    ['OLIVEYOUNG_LINKAGE_JWT', process.env.OLIVEYOUNG_LINKAGE_JWT]
  ];
  for (const [source, jwt] of jwtSources) {
    const candidate = authCandidateFromJwt(jwt, source, '');
    if (candidate) candidates.push(candidate);
  }

  return candidates;
}

function selectCuratorAuthCandidate(candidates) {
  const valid = candidates.filter((c) => !c.expired);
  const pool = valid.length ? valid : candidates;
  return (
    pool
      .slice()
      .sort((a, b) => {
        const ae = a.expSec == null ? 0 : a.expSec;
        const be = b.expSec == null ? 0 : b.expSec;
        return be - ae;
      })[0] || null
  );
}

function curatorAuth() {
  const selected = selectCuratorAuthCandidate(collectCuratorAuthCandidates());
  if (!selected || selected.expired) return null;
  return selected;
}

function parseCookieHeader(header, domainHost) {
  const host = domainHost.replace(/^https?:\/\//, '').split('/')[0];
  const domain = host.includes('oliveyoung') ? '.oliveyoung.co.kr' : host;
  const out = [];
  for (const part of String(header || '').split(';')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const name = p.slice(0, eq).trim();
    let value = p.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep */
    }
    if (!name) continue;
    out.push({ name, value, domain, path: '/' });
  }
  return out;
}

function generateCuratorApiKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const t = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const timeStr = `${t.year}${t.month}${t.day}${t.hour}${t.minute}`;
  const raw = `${CURATOR_SHRT_SECRET}:shrt-auth:${timeStr}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

function curatorRegisterId() {
  return (
    String(process.env.OLIVEYOUNG_AFFILIATE_REGISTER_ID || '').trim() ||
    CURATOR_REGISTER_ID_DEFAULT
  );
}

function curatorLinkCacheKey(goodsNo) {
  return normalizeGoodsNo(goodsNo);
}

function getCuratorLinkCache(goodsNo) {
  const key = curatorLinkCacheKey(goodsNo);
  if (!key) return null;
  const hit = curatorLinkCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CURATOR_LINK_CACHE_TTL_MS) {
    curatorLinkCache.delete(key);
    return null;
  }
  return hit.data;
}

function setCuratorLinkCache(goodsNo, data) {
  const key = curatorLinkCacheKey(goodsNo);
  if (!key || !data) return;
  curatorLinkCache.set(key, { data, ts: Date.now() });
  while (curatorLinkCache.size > CURATOR_LINK_CACHE_MAX) {
    const first = curatorLinkCache.keys().next().value;
    if (first == null) break;
    curatorLinkCache.delete(first);
  }
}

function clearCuratorSession() {
  curatorReady = false;
  curatorSharedPageBusy = false;
  curatorCreatedAt = 0;
  if (curatorPage) {
    try {
      void curatorPage.close().catch(() => {});
    } catch {}
  }
  if (curatorContext) {
    try {
      void curatorContext.close().catch(() => {});
    } catch {}
  }
  if (curatorBrowser) {
    try {
      void curatorBrowser.close().catch(() => {});
    } catch {}
  }
  curatorPage = null;
  curatorContext = null;
  curatorBrowser = null;
}

async function ensureSession() {
  if (initPromise) return initPromise;

  if (sessionReady && page && Date.now() - sessionCreatedAt < SESSION_MAX_AGE) {
    try {
      const test = await withTimeout(
        page.evaluate(() => document.title),
        SESSION_HEALTHCHECK_TIMEOUT_MS,
        'session health check'
      );
      if (test) return;
    } catch {
      console.log('세션 만료, 재생성');
    }
  }

  initPromise = _createSession();
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

function sessionAgeSeconds() {
  return sessionCreatedAt ? Math.floor((Date.now() - sessionCreatedAt) / 1000) : 0;
}

function sessionHealthPayload() {
  return {
    ok: true,
    session: sessionReady,
    curator: curatorReady,
    curatorAge: curatorCreatedAt ? Math.floor((Date.now() - curatorCreatedAt) / 1000) : 0,
    curatorCacheSize: curatorLinkCache.size,
    curatorActiveCount,
    curatorMaxConcurrent: CURATOR_MAX_CONCURRENT,
    warming: !!initPromise || keepAliveRunning,
    uptime: process.uptime(),
    age: sessionAgeSeconds(),
    maxAge: Math.floor(SESSION_MAX_AGE / 1000)
  };
}

async function keepSessionWarm(reason) {
  if (keepAliveRunning) {
    if (initPromise) await initPromise;
    return;
  }
  keepAliveRunning = true;
  try {
    await ensureSession();
    console.log(`[keepalive] 세션 준비 완료 (${reason}, age=${sessionAgeSeconds()}s)`);
  } catch (e) {
    sessionReady = false;
    console.error(`[keepalive] 세션 준비 실패 (${reason}):`, e.message || e);
  } finally {
    keepAliveRunning = false;
  }
}

function startSessionKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    void keepSessionWarm('interval');
  }, SESSION_KEEPALIVE_MS);
  if (keepAliveTimer.unref) keepAliveTimer.unref();
}

async function keepCuratorWarm(reason) {
  try {
    const auth = curatorAuth();
    if (!auth) {
      console.warn(`[curator-keepalive] 인증 없음 (${reason})`);
      return;
    }
    await ensureCuratorSession(auth);
    console.log(`[curator-keepalive] 세션 준비 완료 (${reason})`);
  } catch (e) {
    curatorReady = false;
    console.error(`[curator-keepalive] 세션 준비 실패 (${reason}):`, e.message || e);
  }
}

async function ensureCuratorSession(auth) {
  if (curatorInitPromise) return curatorInitPromise;

  if (curatorReady && curatorPage && Date.now() - curatorCreatedAt < SESSION_MAX_AGE) {
    try {
      const title = await curatorPage.evaluate(() => document.title);
      if (title != null) return;
    } catch {
      clearCuratorSession();
    }
  }

  curatorInitPromise = (async () => {
    clearCuratorSession();
    curatorBrowser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    curatorContext = await curatorBrowser.newContext({
      userAgent:
        'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      locale: 'ko-KR'
    });

    if (auth && auth.cookieHeader) {
      await curatorContext.addCookies(parseCookieHeader(auth.cookieHeader, OY_M));
    }

    curatorPage = await curatorContext.newPage();
    await curatorPage.goto(OY_M + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);

    let bodyText = await curatorPage.locator('body').innerText().catch(() => '');
    if (bodyText.includes('Just a moment') || bodyText.includes('Enable JavaScript')) {
      throw new Error('curator_cloudflare_failed');
    }

    await curatorPage.goto(CURATOR_AFFILIATE_REFERER, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await sleep(1200);
    bodyText = await curatorPage.locator('body').innerText().catch(() => '');
    if (bodyText.includes('Just a moment') || bodyText.includes('Enable JavaScript')) {
      throw new Error('curator_affiliate_page_blocked');
    }

    curatorReady = true;
    curatorCreatedAt = Date.now();
    console.log(`✅ 큐레이터 세션 준비 완료 (${auth?.source || 'unknown'})`);
  })();

  try {
    await curatorInitPromise;
  } finally {
    curatorInitPromise = null;
  }
}

async function acquireCuratorWorkPage() {
  if (curatorPage && !curatorSharedPageBusy) {
    curatorSharedPageBusy = true;
    return {
      page: curatorPage,
      release: async () => {
        curatorSharedPageBusy = false;
      }
    };
  }

  const workPage = await curatorContext.newPage();
  await workPage.goto(CURATOR_AFFILIATE_REFERER, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  return {
    page: workPage,
    release: async () => {
      try {
        await workPage.close();
      } catch {}
    }
  };
}

async function generateCuratorLink(goodsNo, categoryNumber) {
  const normalized = normalizeGoodsNo(goodsNo);
  if (!normalized) {
    return { success: false, error: 'invalid_goodsNo' };
  }

  const cached = getCuratorLinkCache(normalized);
  if (cached) {
    return { ...cached, cacheHit: true };
  }

  const auth = curatorAuth();
  if (!auth) {
    return { success: false, error: 'missing_or_expired_curator_auth' };
  }

  return withCuratorSlot(async () => {
    const secondHit = getCuratorLinkCache(normalized);
    if (secondHit) return { ...secondHit, cacheHit: true };

    await ensureCuratorSession(auth);
    const work = await acquireCuratorWorkPage();

    const payload = {
      goodsNo: normalized,
      categoryNumber:
        String(categoryNumber || '').trim() || CURATOR_PLACEHOLDER_CATEGORY,
      registerId: curatorRegisterId(),
      apiKey: generateCuratorApiKey(),
      authJwt: auth.jwt || '',
      placeholderCategory: CURATOR_PLACEHOLDER_CATEGORY
    };

    let result;
    try {
      result = await work.page.evaluate(
        async ({
          goodsNo,
          categoryNumber,
          registerId,
          apiKey,
          authJwt,
          placeholderCategory
        }) => {
        async function landing(body) {
          const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/plain, */*',
            Origin: 'https://m.oliveyoung.co.kr',
            Referer: 'https://m.oliveyoung.co.kr/m/mtn/affiliate/product/search',
            'x-api-key': apiKey
          };
          if (authJwt) headers.authorization = authJwt;
          try {
            const response = await fetch(
              'https://m.oliveyoung.co.kr/review/api/affiliate/v1/activities/landing',
              {
                method: 'POST',
                credentials: 'include',
                headers,
                body: JSON.stringify(body)
              }
            );
            const text = await response.text();
            let json;
            try {
              json = JSON.parse(text);
            } catch {
              return { ok: false, status: response.status, preview: text.slice(0, 180) };
            }
            return { ok: response.ok, status: response.status, json };
          } catch (e) {
            return { ok: false, status: 0, error: e && e.message ? e.message : String(e) };
          }
        }

        async function shorten(originalUrl, rid) {
          try {
            const response = await fetch(
              'https://m.oliveyoung.co.kr/base/shorten/v2/verified',
              {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'Content-Type': 'application/json',
                  Accept: 'application/json, text/plain, */*',
                  Origin: 'https://m.oliveyoung.co.kr',
                  Referer: 'https://m.oliveyoung.co.kr/',
                  'x-api-key': apiKey
                },
                body: JSON.stringify([{ originalUrl, registerId: rid }])
              }
            );
            const text = await response.text();
            let json;
            try {
              json = JSON.parse(text);
            } catch {
              return { ok: false, status: response.status, preview: text.slice(0, 180) };
            }
            return { ok: response.ok, status: response.status, json };
          } catch (e) {
            return { ok: false, status: 0, error: e && e.message ? e.message : String(e) };
          }
        }

        const attempts = [
          { goodsNumber: goodsNo, categoryNumber: categoryNumber || placeholderCategory },
          { goodsNumber: goodsNo },
          { goodsNumber: goodsNo, categoryNumber: '' }
        ];
        let affiliateActivityId = null;
        let affiliatePartnerId = registerId;
        let lastLanding = null;

        for (const body of attempts) {
          const landed = await landing(body);
          lastLanding = landed;
          const row = landed.json && landed.json.data;
          const id = row && row.affiliateActivityId != null ? String(row.affiliateActivityId) : '';
          if (landed.ok && id) {
            affiliateActivityId = id;
            affiliatePartnerId =
              row.affiliatePartnerId != null ? String(row.affiliatePartnerId) : registerId;
            break;
          }
        }

        if (!affiliateActivityId) {
          const fallbackOriginalUrl =
            'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=' +
            encodeURIComponent(goodsNo) +
            '&utm_source=shutter&utm_medium=affiliate';
          const fallbackShortened = await shorten(fallbackOriginalUrl, registerId);
          const fallbackRow =
            fallbackShortened.json &&
            fallbackShortened.json.data &&
            Array.isArray(fallbackShortened.json.data) &&
            fallbackShortened.json.data[0];
          const fallbackShortenedUrl =
            fallbackRow && fallbackRow.shortenedUrl ? String(fallbackRow.shortenedUrl) : '';

          return {
            success: false,
            error: 'missing_affiliate_activity_id',
            detail: lastLanding,
            fallbackShortenDetail: fallbackShortened,
            fallbackShortenedUrl: fallbackShortenedUrl || null,
            fallbackOriginalUrl
          };
        }

        const originalUrl =
          'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=' +
          encodeURIComponent(goodsNo) +
          '&utm_source=shutter&utm_medium=affiliate&utm_content=OY_' +
          encodeURIComponent(affiliateActivityId);
        const shortened = await shorten(originalUrl, affiliatePartnerId);
        const shortRow =
          shortened.json &&
          shortened.json.data &&
          Array.isArray(shortened.json.data) &&
          shortened.json.data[0];
        const shortenedUrl = shortRow && shortRow.shortenedUrl ? String(shortRow.shortenedUrl) : '';

        return {
          success: true,
          shortenedUrl: shortenedUrl || null,
          originalUrl,
          affiliateActivityId,
          affiliatePartnerId,
          shortenStatus: shortened.status,
          shortenDetail: shortenedUrl ? undefined : shortened
        };
        },
        payload
      );
    } finally {
      await work.release();
    }

    if (result && result.success) {
      const saved = {
        ...result,
        goodsNo: normalized,
        generatedAt: new Date().toISOString(),
        source:
          result.sourceHint ||
          (result.shortenedUrl ? 'cloudrun_live_shortened' : 'cloudrun_live_original')
      };
      setCuratorLinkCache(normalized, saved);
      return saved;
    }

    if (result && result.error === 'landing_failed') {
      curatorReady = false;
    }
    return result || { success: false, error: 'empty_curator_result' };
  });
}

async function _createSession() {
  console.log('🔄 브라우저 세션 생성 중...');
  const start = Date.now();

  if (page) {
    try {
      await page.close();
    } catch {}
    page = null;
  }
  if (browser) {
    try {
      await browser.close();
    } catch {}
    browser = null;
  }

  sessionReady = false;

  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ko-KR'
  });

  page = await ctx.newPage();
  await page.goto(OY + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);

  const body = await page.locator('body').innerText();
  if (body.includes('Just a moment') || body.includes('Enable JavaScript')) {
    throw new Error('Cloudflare 챌린지 통과 실패');
  }

  // 워밍업: 상품 상세 방문으로 쿠키·세션 강화 (stock-stores 차단 완화)
  try {
    await page.goto(
      OY + '/store/goods/getGoodsDetail.do?goodsNo=A000000207822',
      { waitUntil: 'domcontentloaded', timeout: 15000 }
    );
    await sleep(3000);
    await page.goto(OY + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
  } catch (e) {
    console.log('워밍업 스킵:', e.message);
  }

  sessionReady = true;
  sessionCreatedAt = Date.now();
  console.log(`✅ 세션 준비 완료 (${((Date.now() - start) / 1000).toFixed(1)}초)`);
}

async function oyPost(apiPath, body) {
  if (!page || !sessionReady) {
    await ensureSession();
  }
  return page.evaluate(
    async ({ url, payload, timeoutMs }) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const r = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
          },
          body: JSON.stringify(payload)
        });
        const t = await r.text();
        try {
          return { ok: r.ok, status: r.status, data: JSON.parse(t) };
        } catch {
          return { ok: false, status: r.status, data: t };
        }
      } catch (e) {
        return {
          ok: false,
          status: 0,
          data: { error: e && e.name === 'AbortError' ? 'oy_api_timeout' : e.message || String(e) }
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },
    { url: OY + '/oystore/api' + apiPath, payload: body, timeoutMs: OY_API_FETCH_TIMEOUT_MS }
  );
}

async function fetchOfficialSearchPage({ keyword, startCount, listnum }) {
  async function requestFromSession() {
    if (!page || !sessionReady) await ensureSession();
    return page.evaluate(
      async ({ query, start, count, timeoutMs }) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const body = new URLSearchParams({
          query,
          reQuery: '',
          rt: '',
          collection: 'OLIVE_GOODS,OLIVE_PLAN,OLIVE_EVENT,OLIVE_BRAND,OLIVE_QUICK_LINK',
          listnum: String(count),
          startCount: String(start),
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

        try {
          const response = await fetch('/store/search/NewMainSearchApi.do', {
            method: 'POST',
            credentials: 'include',
            signal: controller.signal,
            headers: {
              Accept: 'application/json, text/javascript, */*; q=0.01',
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              'X-Requested-With': 'XMLHttpRequest'
            },
            body: body.toString()
          });
          const text = await response.text();
          let data = null;
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
          return {
            status: response.status,
            data,
            contentType: response.headers.get('content-type') || ''
          };
        } catch (error) {
          return {
            status: 0,
            data: null,
            error: error && error.name === 'AbortError' ? 'search_timeout' : String(error)
          };
        } finally {
          clearTimeout(timeoutId);
        }
      },
      {
        query: String(keyword || ''),
        start: Math.max(0, Number.parseInt(String(startCount || 0), 10) || 0),
        count: Math.max(1, Math.min(48, Number.parseInt(String(listnum || 48), 10) || 48)),
        timeoutMs: OY_SEARCH_FETCH_TIMEOUT_MS
      }
    );
  }

  let result = await requestFromSession();
  if (!result || result.status === 0 || result.status === 401 || result.status === 403 || !result.data) {
    sessionReady = false;
    await ensureSession();
    result = await requestFromSession();
  }
  return result;
}

async function oyPostWithRetry(apiPath, body, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await oyPost(apiPath, body);

      if (apiPath.includes('stock-stores')) {
        const inner =
          res.ok && res.data && res.data.status === 'SUCCESS' ? unwrapPayload(res.data) : {};
        const stores = inner.storeList || [];

        if (stores.length === 0 && attempt < retries) {
          console.log(
            '⚠️ stock-stores 빈 응답, 세션 리셋 시도... (attempt ' + (attempt + 1) + ')'
          );
          sessionReady = false;
          try {
            await ensureSession();
          } catch (e) {
            console.error('세션 리셋 실패:', e.message);
          }
          continue;
        }
      }
      return res;
    } catch (e) {
      console.error('oyPostWithRetry 에러 (attempt ' + attempt + '):', e.message);
      if (attempt < retries) {
        sessionReady = false;
        try {
          await ensureSession();
        } catch (e2) {
          console.error('세션 리셋 실패:', e2.message);
        }
        continue;
      }
      return { ok: false, status: 500, data: { error: e.message } };
    }
  }
  return { ok: false, status: 500, data: { error: 'max retries' } };
}

async function oyPostStockStoresBatch(requests) {
  if (!requests || requests.length === 0) return [];
  if (!page || !sessionReady) {
    await ensureSession();
  }

  return page.evaluate(
    async ({ url, requests: reqs, concurrency, timeoutMs }) => {
      let index = 0;
      const results = [];

      async function runOne(req) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const r = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'X-Requested-With': 'XMLHttpRequest'
            },
            body: JSON.stringify(req.payload)
          });
          const t = await r.text();
          let json = null;
          try {
            json = JSON.parse(t);
          } catch {
            json = t;
          }
          return { productId: req.productId, ok: r.ok, status: r.status, data: json };
        } catch (e) {
          return {
            productId: req.productId,
            ok: false,
            status: 0,
            error: e && e.message ? e.message : String(e)
          };
        } finally {
          clearTimeout(timeoutId);
        }
      }

      async function worker() {
        while (index < reqs.length) {
          const req = reqs[index++];
          results.push(await runOne(req));
        }
      }

      const workers = Array.from(
        { length: Math.min(concurrency, reqs.length) },
        () => worker()
      );
      await Promise.all(workers);
      return results;
    },
    {
      url: OY + '/oystore/api/stock/stock-stores',
      requests,
      concurrency: STOCK_STORE_BATCH_CONCURRENCY,
      timeoutMs: STOCK_STORE_FETCH_TIMEOUT_MS
    }
  );
}

async function getNearbyStoresByProductIds(productIds, lat, lng) {
  const unique = Array.from(
    new Set(
      (productIds || [])
        .map((pid) => String(pid || '').trim())
        .filter(Boolean)
    )
  );
  if (!unique.length) return {};

  const requests = unique.map((pid) => ({
    productId: pid,
    payload: {
      productId: pid,
      lat,
      lon: lng,
      pageIdx: 1,
      searchWords: '',
      mapLat: lat,
      mapLon: lng
    }
  }));

  let rows = [];
  try {
    rows = await oyPostStockStoresBatch(requests);
  } catch (e) {
    console.error('[매장배치] 예외:', e.message || e);
    return {};
  }

  const storesByPid = {};
  for (const row of rows || []) {
    const pid = String(row.productId || '').trim();
    if (!pid) continue;
    const stInner =
      row.ok && row.data && row.data.status === 'SUCCESS' ? unwrapPayload(row.data) : {};
    const storeList = stInner.storeList || [];
    if (!row.ok) {
      console.log('[매장배치] 실패:', pid, row.error || compactApiFailure(row));
    }
    storesByPid[pid] = storeList.map((s) => ({
      name: s.storeName,
      code: s.storeCode,
      dist: s.distance,
      qty: s.remainQuantity || 0,
      o2o: s.o2oRemainQuantity || 0,
      pickup: yn(s.pickupYn),
      open: yn(s.openYn),
      addr: s.address || s.storeAddr || ''
    }));
  }
  return storesByPid;
}

function isGoodsInfoSuccess(res) {
  if (!res || !res.ok || !res.data || res.data.status !== 'SUCCESS') return false;
  const inner = unwrapPayload(res.data);
  return !!(inner && inner.goodsInfo);
}

function compactApiFailure(res) {
  if (!res) return 'empty response';
  const data = res.data;
  if (data && typeof data === 'object') {
    return JSON.stringify({
      httpStatus: res.status,
      status: data.status,
      message: data.message || data.error || data.errorMessage || ''
    });
  }
  return JSON.stringify({ httpStatus: res.status, data: String(data || '').slice(0, 160) });
}

async function fetchGoodsInfoOnDetailPage(goodsNo) {
  return withLock(async () => {
    try {
      await ensureSession();
      await page.goto(
        OY + '/store/goods/getGoodsDetail.do?goodsNo=' + encodeURIComponent(goodsNo),
        { waitUntil: 'domcontentloaded', timeout: 15000 }
      );
      await sleep(700);

      return await page.evaluate(
        async ({ gn, timeoutMs }) => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const r = await fetch('/oystore/api/stock/stock-goods-info-v3', {
              method: 'POST',
              credentials: 'include',
              signal: controller.signal,
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
              },
              body: JSON.stringify({ goodsNo: gn })
            });
            const t = await r.text();
            try {
              return { ok: r.ok, status: r.status, data: JSON.parse(t) };
            } catch {
              return { ok: false, status: r.status, data: t };
            }
          } catch (e) {
            return {
              ok: false,
              status: 0,
              data: {
                error: e && e.name === 'AbortError' ? 'oy_detail_goods_info_timeout' : e.message || String(e)
              }
            };
          } finally {
            clearTimeout(timeoutId);
          }
        },
        { gn: goodsNo, timeoutMs: OY_API_FETCH_TIMEOUT_MS }
      );
    } catch (e) {
      console.log('[상품정보] 상세 페이지 재시도 실패:', goodsNo, e.message || e);
      return null;
    } finally {
      if (page) await page.goto('about:blank', { timeout: 5000 }).catch(() => {});
      await sleep(250);
    }
  });
}

async function getGoodsInfoResponse(goodsNo, opts = {}) {
  const direct = await oyPost('/stock/stock-goods-info-v3', { goodsNo });
  if (isGoodsInfoSuccess(direct)) return direct;

  if (opts.fastOnly) {
    console.log('[상품정보] fastOnly direct 실패:', goodsNo, compactApiFailure(direct));
    return direct;
  }

  console.log('[상품정보] direct 실패 → 상세 진입 재시도:', goodsNo, compactApiFailure(direct));
  const pageRetry = await fetchGoodsInfoOnDetailPage(goodsNo);
  if (isGoodsInfoSuccess(pageRetry)) return pageRetry;

  console.log('[상품정보] 상세 재시도 실패 → 세션 재생성:', goodsNo, compactApiFailure(pageRetry));
  sessionReady = false;
  try {
    await ensureSession();
  } catch (e) {
    console.error('[상품정보] 세션 재생성 실패:', e.message || e);
  }

  const resetRetry = await oyPost('/stock/stock-goods-info-v3', { goodsNo });
  if (isGoodsInfoSuccess(resetRetry)) return resetRetry;

  console.log('[상품정보] 최종 실패:', goodsNo, compactApiFailure(resetRetry));
  return resetRetry || pageRetry || direct;
}

async function getStockDetail(goodsNo, lat, lng, withOnline = false, onlineOnly = false, fresh = false) {
  const ck = detailResponseCacheKey(goodsNo, lat, lng, withOnline, onlineOnly);
  const hit = fresh ? null : detailResponseCache.get(ck);
  if (hit && Date.now() - hit.ts < DETAIL_RESPONSE_TTL_MS) {
    try {
      return JSON.parse(JSON.stringify(hit.data));
    } catch {
      /* fall through */
    }
  }
  if (!fresh && onlineOnly) {
    const fullHit = detailResponseCache.get(detailResponseCacheKey(goodsNo, lat, lng, true, false));
    if (fullHit && Date.now() - fullHit.ts < DETAIL_RESPONSE_TTL_MS) {
      try {
        return JSON.parse(JSON.stringify(fullHit.data));
      } catch {
        /* fall through */
      }
    }
  }
  try {
    const result = await getStockDetailBody(goodsNo, lat, lng, withOnline, onlineOnly);
    if (result && result.success) {
      pruneDetailResponseCache();
      detailResponseCache.set(ck, { data: result, ts: Date.now() });
    }
    return result;
  } catch (e) {
    console.error('[getStockDetail] 예외', goodsNo, e.message || e);
    return {
      success: false,
      error: true,
      goodsNo,
      message: String(e.message || e)
    };
  }
}

async function getStockDetailBody(goodsNo, lat, lng, withOnline = false, onlineOnly = false) {
  const infoRes = await getGoodsInfoResponse(goodsNo, { fastOnly: onlineOnly });
  if (!infoRes.ok || !infoRes.data || infoRes.data.status !== 'SUCCESS') {
    return {
      success: false,
      error: true,
      goodsNo,
      message: '상품 조회 실패 (단종 가능성)'
    };
  }

  const infoInner = unwrapPayload(infoRes.data);
  const gi = infoInner.goodsInfo;
  if (!gi) {
    return { success: false, error: true, goodsNo, message: '상품 정보 없음' };
  }

  const uploadUrl = infoInner.goodsUploadUrl || '';
  let optionUploadUrl = '';

  let options = [];
  let rawAvailableItems = [];
  const itemCount = Number(gi.itemCount) || 1;
  const v3Avail = Array.isArray(gi.availableItems) ? gi.availableItems : [];

  if (v3Avail.length > 0) {
    rawAvailableItems = v3Avail.slice();
    options = v3Avail.slice();
    console.log('[옵션] v3 availableItems만 사용 → 상세 page.goto 생략, items:', options.length);
  } else if (itemCount <= 1 && !withOnline && !onlineOnly) {
    console.log('[옵션] 단일 상품 → 온라인 옵션 API 생략');
  } else {
    const cached = onlineCache.get(goodsNo);
    if (cached && Date.now() - cached.ts < ONLINE_CACHE_TTL) {
      optionUploadUrl = cached.optionUploadUrl || '';
      rawAvailableItems = cached.data.slice();
      options = cached.data.slice();
      console.log('[옵션] 캐시 사용, items:', rawAvailableItems.length);
    } else {
      let optResult = null;
      let optResultSource = '';
      try {
        const directOpt = await oyPost('/stock/stock-goods-info-option', { goodsNo });
        if (directOpt.ok && directOpt.data && directOpt.data.status === 'SUCCESS') {
          const optInner = unwrapPayload(directOpt.data);
          const ou = optInner.optionUploadUrl || '';
          const opts = optInner.goodsInfo?.availableItems || [];
          optResult = { data: opts.slice(), optionUploadUrl: ou };
          optResultSource = 'direct API';
          console.log('[옵션] direct API 성공, items:', opts.length);
        }
      } catch (e) {
        console.log('[옵션] direct API 실패:', e.message);
      }

      if (!optResult) {
        optResult = await withLock(async () => {
          try {
            await page.goto(
              OY + '/store/goods/getGoodsDetail.do?goodsNo=' + encodeURIComponent(goodsNo),
              { waitUntil: 'domcontentloaded', timeout: 10000 }
            );
            await sleep(550);

            const optJson = await page.evaluate(
              async ({ gn, timeoutMs }) => {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                try {
                  const res = await fetch('/oystore/api/stock/stock-goods-info-option', {
                    method: 'POST',
                    credentials: 'include',
                    signal: controller.signal,
                    headers: {
                      'Content-Type': 'application/json',
                      Accept: 'application/json',
                      'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: JSON.stringify({ goodsNo: gn })
                  });
                  const t = await res.text();
                  try {
                    return JSON.parse(t);
                  } catch {
                    return null;
                  }
                } catch {
                  return null;
                } finally {
                  clearTimeout(timeoutId);
                }
              },
              { gn: goodsNo, timeoutMs: OY_API_FETCH_TIMEOUT_MS }
            );

            if (optJson && optJson.status === 'SUCCESS') {
              const optInner = unwrapPayload(optJson);
              const ou = optInner.optionUploadUrl || '';
              const opts = optInner.goodsInfo?.availableItems || [];
              const raw = opts.slice();
              await page.goto('about:blank', { timeout: 5000 }).catch(() => {});
              await sleep(350);
              return { data: raw, optionUploadUrl: ou };
            }

            await page.goto('about:blank', { timeout: 5000 }).catch(() => {});
            await sleep(350);
            return null;
          } catch (e) {
            console.log('[옵션] page 실패:', e.message);
            await page.goto('about:blank', { timeout: 5000 }).catch(() => {});
            return null;
          }
        });
        if (optResult) optResultSource = 'page fallback';
      }

      if (optResult) {
        optionUploadUrl = optResult.optionUploadUrl || '';
        rawAvailableItems = optResult.data.slice();
        options = optResult.data.slice();
        onlineCache.set(goodsNo, {
          data: rawAvailableItems.slice(),
          optionUploadUrl,
          ts: Date.now()
        });
        console.log('[옵션] ' + optResultSource + ' 성공 + 캐시 저장, items:', rawAvailableItems.length);
      } else {
        console.log(
          '[옵션] 스킵 (락 대기 초과 또는 조회 실패) → 매장 재고만 진행, goodsNo:',
          goodsNo
        );
      }
    }
  }
  // option API가 ERROR/차단일 때 v3 goodsInfo.availableItems로 온라인 수량·오늘배송 복구
  if (
    Array.isArray(gi.availableItems) &&
    gi.availableItems.length > 0 &&
    rawAvailableItems.length === 0
  ) {
    rawAvailableItems = gi.availableItems.slice();
    console.log('[옵션] v3 availableItems fallback (onlineMap), items:', rawAvailableItems.length);
    if (options.length === 0 && Number(gi.itemCount) > 1) {
      options = gi.availableItems.slice();
    }
  }
  if (options.length === 0) {
    options = [
      {
        itemName: gi.goodsName,
        legacyItemNumber: gi.masterGoodsNumber,
        imagePath: gi.goodsThumbnailPath
      }
    ];
  }

  console.log(
    '[디버그] optionData:',
    JSON.stringify(
      (rawAvailableItems || []).map((i) => ({
        leg: i.legacyItemNumber,
        qty: i.quantity,
        today: i.deliveredToday
      }))
    )
  );

  const onlineMap = {};
  for (const rawOpt of rawAvailableItems) {
    if (rawOpt.legacyItemNumber) {
      onlineMap[String(rawOpt.legacyItemNumber)] = {
        onlineQty: rawOpt.quantity ?? 0,
        maxOrderQty: rawOpt.orderableMaximumQuantity ?? 0,
        deliveredToday: !!rawOpt.deliveredToday,
        presentable: !!rawOpt.presentable
      };
    }
  }

  console.log('[디버그] onlineMap keys:', Object.keys(onlineMap));

  const storeResultsByPid = !onlineOnly
    ? await getNearbyStoresByProductIds(
        options.map((opt) => opt && opt.legacyItemNumber),
        lat,
        lng
      )
    : {};

  const optionResults = [];
  for (const opt of options) {
    const pid = opt.legacyItemNumber;
    if (!pid) continue;

    const imgPath = opt.imagePath || opt.goodsImagePath || opt.goodsThumbnailPath || '';
    const baseUpload = optionUploadUrl || uploadUrl;
    const optImage = imgPath ? baseUpload + imgPath : uploadUrl + (gi.goodsThumbnailPath || '');

    let stores = [];
    if (!onlineOnly) {
      stores = storeResultsByPid[String(pid)] || [];
    }

    console.log(
      '[디버그] 매핑시도 key:',
      String(pid),
      '→ found:',
      !!onlineMap[String(pid)],
      onlineOnly ? '(online-only, 매장 스킵)' : ''
    );

    const onlineInfo = onlineMap[String(pid)] || {};
    const onlineQty =
      onlineInfo.onlineQty != null
        ? onlineInfo.onlineQty
        : opt.quantity != null
          ? opt.quantity
          : gi.quantity ?? 0;

    optionResults.push({
      name: opt.itemName,
      productId: pid,
      image: optImage,
      totalStores: stores.length,
      inStock: stores.filter((s) => s.qty > 0).length,
      totalQty: stores.filter((s) => s.qty > 0).reduce((a, s) => a + s.qty, 0),
      onlineQty,
      maxOrderQty: onlineInfo.maxOrderQty || opt.orderableMaximumQuantity || 0,
      deliveredToday: onlineInfo.deliveredToday || !!opt.deliveredToday,
      presentable: onlineInfo.presentable || !!opt.presentable,
      stores: stores.slice(0, 30)
    });
  }

  if (optionResults.length === 0 && (gi.masterGoodsNumber || gi.goodsNumber)) {
    const pid = String(gi.masterGoodsNumber || gi.goodsNumber);
    if (onlineOnly) {
      optionResults.push({
        name: gi.goodsName,
        productId: pid,
        image: uploadUrl + (gi.goodsThumbnailPath || ''),
        totalStores: 0,
        inStock: 0,
        totalQty: 0,
        onlineQty: gi.quantity ?? 0,
        maxOrderQty: gi.orderableMaximumQuantity || 0,
        deliveredToday: !!gi.deliveredToday,
        presentable: !!gi.presentable,
        stores: []
      });
    } else {
      const singleStoresByPid = await getNearbyStoresByProductIds([pid], lat, lng);
      const stores = singleStoresByPid[pid] || [];
      optionResults.push({
        name: gi.goodsName,
        productId: pid,
        image: uploadUrl + (gi.goodsThumbnailPath || ''),
        totalStores: stores.length,
        inStock: stores.filter((s) => s.qty > 0).length,
        totalQty: stores.filter((s) => s.qty > 0).reduce((a, s) => a + s.qty, 0),
        onlineQty: gi.quantity ?? 0,
        maxOrderQty: gi.orderableMaximumQuantity || 0,
        deliveredToday: !!gi.deliveredToday,
        presentable: !!gi.presentable,
        stores: stores.slice(0, 30)
      });
    }
  }

  const totalInStock = optionResults.reduce((a, o) => a + o.inStock, 0);
  const anyOnline = optionResults.some((o) => (o.onlineQty || 0) > 0);
  const gName = gi.goodsName || '';

  let status;
  let statusLabel;
  if (onlineOnly) {
    status = anyOnline ? 'active' : 'soldout';
    statusLabel = anyOnline ? '🛒 온라인 재고' : '🛒 온라인 품절';
  } else {
    status = totalInStock > 0 ? 'active' : 'soldout';
    statusLabel = totalInStock > 0 ? '✅ 재고있음' : '🔴 주변품절';
  }

  return {
    success: true,
    source: onlineOnly ? 'live-online' : 'live',
    inventoryScope: onlineOnly ? 'online' : 'store',
    goodsNo,
    goodsName: gName,
    price: gi.priceToPay,
    originalPrice: gi.originalPrice,
    discountRate: gi.discountRate,
    thumbnail: uploadUrl + (gi.goodsThumbnailPath || ''),
    itemCount: gi.itemCount,
    status,
    statusLabel,
    options: optionResults,
    updatedAt: new Date().toISOString()
  };
}

const REGIONS = [
  { name: '서울', lat: 37.5665, lng: 126.978 },
  { name: '인천/김포', lat: 37.5075, lng: 126.7219 },
  { name: '경기 남부', lat: 37.2636, lng: 127.0286 },
  { name: '경기 북부', lat: 37.658, lng: 126.771 },
  { name: '부산', lat: 35.1576, lng: 129.0596 },
  { name: '대구', lat: 35.8691, lng: 128.595 },
  { name: '대전', lat: 36.3504, lng: 127.3845 },
  { name: '광주', lat: 35.1492, lng: 126.9173 },
  { name: '울산', lat: 35.5399, lng: 129.3379 },
  { name: '제주', lat: 33.489, lng: 126.4983 }
];

async function getStockAllRegions(goodsNo, targetProductId) {
  const cacheKey = allRegionsResponseCacheKey(goodsNo, targetProductId);
  const cacheHit = allRegionsResponseCache.get(cacheKey);
  if (cacheHit && Date.now() - cacheHit.ts < ALL_REGIONS_RESPONSE_TTL_MS) {
    try {
      return JSON.parse(JSON.stringify(cacheHit.data));
    } catch {
      /* fall through */
    }
  }

  const infoRes = await getGoodsInfoResponse(goodsNo);
  if (!infoRes.ok || !infoRes.data || infoRes.data.status !== 'SUCCESS') {
    return { success: false, error: '상품 조회 실패' };
  }
  const infoInner = unwrapPayload(infoRes.data);
  const gi = infoInner.goodsInfo;
  if (!gi) return { success: false, error: '상품 정보 없음' };

  const uploadUrl = infoInner.goodsUploadUrl || '';

  let options = [];
  let optionUploadUrl = '';
  const v3Avail = Array.isArray(gi.availableItems) ? gi.availableItems : [];
  if (v3Avail.length > 0) {
    options = v3Avail.slice();
  } else if (Number(gi.itemCount) > 1) {
    const optRes = await oyPost('/stock/stock-goods-info-option', { goodsNo });
    if (optRes.ok && optRes.data && optRes.data.status === 'SUCCESS') {
      const optInner = unwrapPayload(optRes.data);
      optionUploadUrl = optInner.optionUploadUrl || '';
      options = optInner.goodsInfo?.availableItems || [];
    }
  }
  if (options.length === 0) {
    options = [
      {
        itemName: gi.goodsName,
        legacyItemNumber: gi.masterGoodsNumber,
        imagePath: gi.goodsThumbnailPath,
        quantity: gi.quantity ?? 0
      }
    ];
  }

  if (targetProductId) {
    const filtered = options.filter((o) => String(o.legacyItemNumber) === String(targetProductId));
    if (filtered.length === 0) {
      return { success: false, error: '해당 옵션을 찾을 수 없음' };
    }
    options = filtered;
  }

  const regionBatchSize = 5;

  async function fetchStoresForRegions(pid, regions) {
    const promises = regions.map((region) =>
      oyPostWithRetry('/stock/stock-stores', {
        productId: String(pid),
        lat: region.lat,
        lon: region.lng,
        pageIdx: 1,
        searchWords: '',
        mapLat: region.lat,
        mapLon: region.lng
      })
        .then((stRes) => {
          const stInner =
            stRes.ok && stRes.data && stRes.data.status === 'SUCCESS'
              ? unwrapPayload(stRes.data)
              : {};
          return (stInner.storeList || []).map((s) => ({
            name: s.storeName,
            code: s.storeCode,
            region: region.name,
            qty: s.remainQuantity || 0,
            o2o: s.o2oRemainQuantity || 0,
            pickup: yn(s.pickupYn),
            open: yn(s.openYn),
            addr: s.address || s.storeAddr || ''
          }));
        })
        .catch(() => [])
    );
    const settled = await Promise.all(promises);
    return settled.flat();
  }

  async function fetchStoresAllRegions(pid) {
    const rows = [];
    for (let i = 0; i < REGIONS.length; i += regionBatchSize) {
      rows.push(...(await fetchStoresForRegions(pid, REGIONS.slice(i, i + regionBatchSize))));
      if (i + regionBatchSize < REGIONS.length) await sleep(150);
    }
    return rows;
  }

  const optionResults = [];

  for (const opt of options) {
    const pid = opt.legacyItemNumber;
    if (!pid) continue;

    const imgPath = opt.imagePath || opt.goodsImagePath || opt.goodsThumbnailPath || '';
    const baseUpload = optionUploadUrl || uploadUrl;
    const optImage = imgPath ? baseUpload + imgPath : uploadUrl + (gi.goodsThumbnailPath || '');

    const regionStores = await fetchStoresAllRegions(pid);

    const storeMap = {};
    regionStores.forEach((s) => {
      if (!s.code) return;
      if (!storeMap[s.code] || storeMap[s.code].qty < s.qty) {
        storeMap[s.code] = s;
      }
    });

    const allStores = Object.values(storeMap).sort((a, b) => b.qty - a.qty);

    optionResults.push({
      name: opt.itemName,
      productId: pid,
      image: optImage,
      onlineQty: opt.quantity ?? 0,
      totalStores: allStores.length,
      inStock: allStores.filter((s) => s.qty > 0).length,
      totalQty: allStores.filter((s) => s.qty > 0).reduce((a, s) => a + s.qty, 0),
      stores: allStores.slice(0, 100)
    });

    if (!targetProductId && options.length > 1) await sleep(120);
  }

  if (
    optionResults.length === 0 &&
    !targetProductId &&
    (gi.masterGoodsNumber || gi.goodsNumber)
  ) {
    const pid = String(gi.masterGoodsNumber || gi.goodsNumber);
    const optImage = uploadUrl + (gi.goodsThumbnailPath || '');
    const regionStores = await fetchStoresAllRegions(pid);
    const storeMap = {};
    regionStores.forEach((s) => {
      if (!s.code) return;
      if (!storeMap[s.code] || storeMap[s.code].qty < s.qty) {
        storeMap[s.code] = s;
      }
    });
    const allStores = Object.values(storeMap).sort((a, b) => b.qty - a.qty);
    optionResults.push({
      name: gi.goodsName,
      productId: pid,
      image: optImage,
      onlineQty: gi.quantity ?? 0,
      totalStores: allStores.length,
      inStock: allStores.filter((s) => s.qty > 0).length,
      totalQty: allStores.filter((s) => s.qty > 0).reduce((a, s) => a + s.qty, 0),
      stores: allStores.slice(0, 100)
    });
  }

  const response = {
    success: true,
    source: 'live-all',
    goodsNo,
    goodsName: gi.goodsName || '',
    price: gi.priceToPay,
    originalPrice: gi.originalPrice,
    discountRate: gi.discountRate,
    thumbnail: uploadUrl + (gi.goodsThumbnailPath || ''),
    options: optionResults,
    updatedAt: new Date().toISOString()
  };
  pruneAllRegionsResponseCache();
  allRegionsResponseCache.set(cacheKey, { data: response, ts: Date.now() });
  return JSON.parse(JSON.stringify(response));
}

/** CORS — 모든 응답에 동일 헤더 (Vercel 등 크로스 오리진 + 프리플라이트) */
function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

function expectedCuratorLiveSecret() {
  return String(process.env.CURATOR_LIVE_SECRET || process.env.CRON_SECRET || '').trim();
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function isCuratorRequestAuthorized(req, url) {
  const expected = expectedCuratorLiveSecret();
  if (!expected) return true;
  const auth = String(req.headers.authorization || '').trim();
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const querySecret = String(url.searchParams.get('secret') || '').trim();
  return safeEqual(bearer, expected) || safeEqual(querySecret, expected);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

const server = http.createServer(async (req, res) => {
  if (applyCors(req, res)) return;

  const _origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (statusCode, headers) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return _origWriteHead(statusCode, headers);
  };

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    if (url.searchParams.get('warm') === '1' || url.searchParams.get('warm') === 'true') {
      await keepSessionWarm('health');
    }
    if (
      url.searchParams.get('curator') === '1' ||
      url.searchParams.get('curator') === 'true' ||
      url.searchParams.get('warmCurator') === '1' ||
      url.searchParams.get('warmCurator') === 'true'
    ) {
      await keepCuratorWarm('health');
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(sessionHealthPayload()));
    return;
  }

  if (url.pathname === '/api/search' || url.pathname === '/api/products') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'method_not_allowed' }));
      return;
    }

    const keyword = String(url.searchParams.get('keyword') || '').trim();
    const size = url.searchParams.get('size') || '50';
    if (!keyword) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'keyword_required' }));
      return;
    }

    try {
      const result = await withTimeout(
        searchOfficialProducts(keyword, size, { fetchPage: fetchOfficialSearchPage }),
        OY_SEARCH_TOTAL_TIMEOUT_MS,
        'official search'
      );
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=60, s-maxage=300',
        'X-Search-Source': 'oliveyoung-official-cloud-run',
        'X-Cache': result.cache || 'MISS'
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('[api/search] 실패:', error.message || error);
      res.writeHead(502, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0'
      });
      res.end(
        JSON.stringify({
          success: false,
          error: 'official_search_unavailable',
          message: String(error.message || error)
        })
      );
    }
    return;
  }

  if (url.pathname === '/api/curator-link') {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'method_not_allowed' }));
      return;
    }

    if (!isCuratorRequestAuthorized(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'unauthorized' }));
      return;
    }

    let body = {};
    if (req.method === 'POST') {
      try {
        body = await readJsonBody(req);
      } catch {
        body = {};
      }
    }

    const goodsNo = normalizeGoodsNo(url.searchParams.get('goodsNo') || body.goodsNo);
    const categoryNumber = String(
      url.searchParams.get('categoryNumber') ||
        url.searchParams.get('category') ||
        body.categoryNumber ||
        body.category ||
        ''
    ).trim();

    if (!goodsNo) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'goodsNo_required' }));
      return;
    }

    try {
      const result = await generateCuratorLink(goodsNo, categoryNumber);
      const status = result && result.success ? 200 : 502;
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0'
      });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('[api/curator-link] 예외:', e.message || e);
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0'
      });
      res.end(JSON.stringify({ success: false, error: String(e.message || e) }));
    }
    return;
  }

  if (url.pathname === '/api/stock') {
    const goodsNo = url.searchParams.get('goodsNo');
    const lat = parseFloat(url.searchParams.get('lat')) || 37.6152;
    const lng = parseFloat(url.searchParams.get('lng')) || 126.7156;
    const withOnline = url.searchParams.get('withOnline') === 'true';
    const onlineOnly = url.searchParams.get('onlineOnly') === 'true';
    const fresh = url.searchParams.get('fresh') === 'true';

    if (!goodsNo) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: false, error: 'goodsNo 필요' }));
      return;
    }

    const stockJsonHdr = {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    };

    if (onlineOnly && fresh) {
      res.writeHead(200, stockJsonHdr);
      res.end(
        JSON.stringify({
          success: false,
          error: true,
          goodsNo,
          skipped: true,
          message: 'background online refresh throttled'
        })
      );
      return;
    }

    try {
      await withTimeout(ensureSession(), STOCK_SESSION_READY_TIMEOUT_MS, 'stock session ready');
    } catch (e) {
      console.error('[api/stock] 세션:', e.message);
      sessionReady = false;
      res.writeHead(200, stockJsonHdr);
      res.end(
        JSON.stringify({
          success: false,
          error: true,
          goodsNo,
          message: String(e.message || e)
        })
      );
      return;
    }

    try {
      const result = await withTimeout(
        getStockDetail(goodsNo, lat, lng, withOnline, onlineOnly, fresh),
        onlineOnly ? STOCK_DETAIL_ONLINE_ONLY_TIMEOUT_MS : STOCK_DETAIL_TOTAL_TIMEOUT_MS,
        onlineOnly ? 'stock online-only lookup' : 'stock detail lookup'
      );
      const out = result.success
        ? result
        : { ...result, error: true, goodsNo: result.goodsNo || goodsNo };
      res.writeHead(200, stockJsonHdr);
      res.end(JSON.stringify(out));
    } catch (e) {
      console.error('[api/stock] 예외:', e.message);
      sessionReady = false;
      res.writeHead(200, stockJsonHdr);
      res.end(
        JSON.stringify({
          success: false,
          error: true,
          goodsNo,
          message: String(e.message || e)
        })
      );
    }
    return;
  }

  if (url.pathname === '/api/stock-all') {
    const goodsNo = url.searchParams.get('goodsNo');
    const productId = url.searchParams.get('productId');
    if (!goodsNo) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: false, error: 'goodsNo 필요' }));
      return;
    }

    try {
      await ensureSession();
      const result = await getStockAllRegions(goodsNo, productId || null);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('전국재고 에러:', e.message);
      sessionReady = false;
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: false, error: e.message || String(e) }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

async function startServer() {
  server.listen(PORT, () => {
    console.log(`서버 시작: http://localhost:${PORT}`);
    startSessionKeepAlive();
    void keepSessionWarm('startup');
    if (String(process.env.CURATOR_WARM_ON_START || '1') !== '0') {
      void keepCuratorWarm('startup');
    }
  });
}

void startServer();

process.on('SIGTERM', async () => {
  console.log('종료 중...');
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
  if (curatorBrowser) {
    try {
      await curatorBrowser.close();
    } catch {}
  }
  process.exit(0);
});
