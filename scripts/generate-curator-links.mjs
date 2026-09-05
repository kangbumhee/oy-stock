/**
 * Playwright 브라우저 컨텍스트에서 m.oliveyoung 큐레이터 API 호출 → public/data/curator-links.json 갱신.
 *
 * GitHub Actions: secrets.OY_CURATOR_COOKIE 에 m.oliveyoung.co.kr 로그인 후
 * DevTools → Network → 요청의 Cookie 헤더 전체(또는 document.cookie 기반)를 넣으면 됨.
 *
 * (detail-stock.mjs 와 달리 큐레이터 API는 로그인 세션 필요 — 무인 www만으로는 부족할 수 있음)
 *
 * env:
 *   OY_CURATOR_COOKIE — 선택. linkageString 포함 권장.
 *   OY_REFRESH_COOKIE / OY_LINKAGE_STRING / OLIVEYOUNG_LINKAGE_STRING /
 *   OLIVEYOUNG_LINKAGE_JWT — 선택. OY_CURATOR_COOKIE가 만료되면 자동 후보로 사용.
 *   OLIVEYOUNG_AFFILIATE_REGISTER_ID — 선택 (기본 4ee076cc92da4447a1b4b42c590e4495)
 *
 * landing API는 authorization(JWT) 필수. JWT = linkageString(hex) AES-128-ECB 복호화.
 */

import { chromium } from 'playwright';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  evaluateCuratorBatchFailure,
  isReadyCuratorShortUrl,
  landingFailureStatus,
  runCuratorRequestWithRetry
} from './lib/curator-request-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'public/data');
const DETAIL_FILE = path.join(DATA_DIR, 'stock-detail.json');
const CURATOR_FILE = path.join(DATA_DIR, 'curator-links.json');

const OY_WWW = 'https://www.oliveyoung.co.kr';
const OY_M = 'https://m.oliveyoung.co.kr';
const REGISTER_ID_DEFAULT = '4ee076cc92da4447a1b4b42c590e4495';
const SHRT_SECRET = 'e3ea1c526eef4570946ebdf083dad7a7';
const PLACEHOLDER_CATEGORY = '1000001000000000000';
const AFFILIATE_DASHBOARD_URL =
  'https://m.oliveyoung.co.kr/m/mtn/affiliate/dashboard';
const CURATOR_ACTIVATION_TEXT = '큐레이터 활동 시작하기';
const AUTH_REFRESH_WAIT_MS = 25000;

/** curator-links 항목이 이 시간 이내면 landing/shorten 재호출 안 함 */
const CURATOR_ENTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CURATOR_UNAVAILABLE_RETRY_MS = 24 * 60 * 60 * 1000;
const CURATOR_TRANSIENT_RETRY_MS = 15 * 60 * 1000;
const CURATOR_MISSING_ONLY =
  String(process.env.CURATOR_MISSING_ONLY || '').trim().toLowerCase() === '1' ||
  String(process.env.CURATOR_MISSING_ONLY || '').trim().toLowerCase() === 'true';

const LINKAGE_AES_KEY = Buffer.from('cjone_g4de7353f1', 'utf8');
const AFFILIATE_REFERER =
  'https://m.oliveyoung.co.kr/m/mtn/affiliate/product/search';
const LIVE_RANKING_URL =
  process.env.CURATOR_LIVE_RANKING_URL ||
  'https://olivestock.co.kr/api/oliveyoung/hot-ranking-history?size=128&period=24h&sort=view';
const CURATOR_MAX_GOODS = Math.max(
  1,
  Number.parseInt(process.env.CURATOR_MAX_GOODS || '260', 10) || 260
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    expired: expSec != null ? expSec <= Date.now() / 1000 : false,
    sub: payload && payload.sub
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

function buildSessionCookie() {
  const sid = (process.env.OY_SESSION_ID || '').trim();
  const ls = (process.env.OY_LINKAGE_STRING || '').trim();
  if (sid && ls) return `OYSESSIONID=${sid}; linkageString=${ls}`;
  return '';
}

function collectAuthCandidates() {
  const candidates = [];
  const cookieSources = [
    ['OY_CURATOR_COOKIE', (process.env.OY_CURATOR_COOKIE || '').trim()],
    ['OY_REFRESH_COOKIE', (process.env.OY_REFRESH_COOKIE || '').trim()],
    ['OY_SESSION_ID+OY_LINKAGE_STRING', buildSessionCookie()]
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

function selectAuthCandidate(candidates) {
  const valid = candidates.filter((c) => !c.expired);
  const pool = valid.length ? valid : candidates;
  return pool
    .slice()
    .sort((a, b) => {
      const ae = a.expSec == null ? 0 : a.expSec;
      const be = b.expSec == null ? 0 : b.expSec;
      return be - ae;
    })[0] || null;
}

function describeExp(candidate) {
  if (!candidate || candidate.expSec == null) return '만료 정보 없음';
  return new Date(candidate.expSec * 1000).toISOString();
}

function generateApiKey() {
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
  const raw = `${SHRT_SECRET}:shrt-auth:${timeStr}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

function getRegisterId() {
  return (
    (process.env.OLIVEYOUNG_AFFILIATE_REGISTER_ID || '').trim() ||
    REGISTER_ID_DEFAULT
  );
}

/** "a=b; c=d" → Playwright cookies (.oliveyoung.co.kr) */
function parseCookieHeader(header, domainHost) {
  const host = domainHost.replace(/^https?:\/\//, '').split('/')[0];
  const domain = host.includes('oliveyoung') ? '.oliveyoung.co.kr' : host;
  const out = [];
  for (const part of String(header).split(';')) {
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

function serializeOliveYoungCookies(cookies) {
  const byName = new Map();
  for (const cookie of cookies || []) {
    const domain = String(cookie.domain || '').replace(/^\./, '');
    if (!domain.endsWith('oliveyoung.co.kr')) continue;
    if (
      cookie.name === 'linkageString' ||
      cookie.name.startsWith('OY')
    ) {
      byName.set(cookie.name, cookie.value);
    }
  }
  return Array.from(byName.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

async function authCandidateFromContext(context, source) {
  const cookies = await context.cookies();
  const linkage = cookies.find((cookie) => cookie.name === 'linkageString');
  if (!linkage?.value) return null;
  return authCandidateFromLinkageHex(
    linkage.value,
    source,
    serializeOliveYoungCookies(cookies)
  );
}

async function waitForFreshContextAuth(context, timeoutMs = AUTH_REFRESH_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let candidate = await authCandidateFromContext(
    context,
    'OY_REFRESH_COOKIE 자동 갱신'
  );

  while ((!candidate || candidate.expired) && Date.now() < deadline) {
    await sleep(1000);
    candidate = await authCandidateFromContext(
      context,
      'OY_REFRESH_COOKIE 자동 갱신'
    );
  }

  return candidate && !candidate.expired ? candidate : null;
}

async function renewExpiredAuthFromSession(context) {
  const page = await context.newPage();
  let loginRequired = false;
  const acceptDialog = async (dialog) => {
    if (dialog.message().includes('로그인 후')) loginRequired = true;
    await dialog.accept().catch(() => {});
  };
  page.on('dialog', acceptDialog);

  try {
    console.log('🔄 저장된 로그인 세션으로 큐레이터 JWT 자동 갱신 시도…');
    await context.clearCookies({ name: 'linkageString' }).catch(() => {});
    await page.goto(AFFILIATE_DASHBOARD_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await sleep(3000);

    let candidate = await authCandidateFromContext(
      context,
      'OY_REFRESH_COOKIE 자동 갱신'
    );
    if (candidate && !candidate.expired) {
      console.log(`✅ 큐레이터 JWT 자동 갱신 완료 | 만료: ${describeExp(candidate)}`);
      return candidate;
    }

    const bodyText = await page
      .locator('body')
      .innerText({ timeout: 5000 })
      .catch(() => '');
    const sessionCookie = (await context.cookies()).find(
      (cookie) => cookie.name === 'OYSESSIONID'
    );
    if (
      !sessionCookie ||
      /\/login\//i.test(page.url()) ||
      bodyText.includes('올리브영 로그인') ||
      bodyText.includes('카카오로 로그인')
    ) {
      console.error('❌ 저장된 올리브영 로그인 세션이 만료되었습니다.');
      return null;
    }

    const activationCandidates = [
      page.getByRole('button', {
        name: CURATOR_ACTIVATION_TEXT,
        exact: true
      }),
      page.getByRole('link', {
        name: CURATOR_ACTIVATION_TEXT,
        exact: true
      }),
      page
        .locator('button, a, [role="button"], [onclick]')
        .filter({ hasText: CURATOR_ACTIVATION_TEXT }),
      page.getByText(CURATOR_ACTIVATION_TEXT, { exact: true })
    ];

    let clicked = false;
    for (const locator of activationCandidates) {
      const target = locator.first();
      if (!(await target.isVisible({ timeout: 1500 }).catch(() => false))) {
        continue;
      }
      await target.scrollIntoViewIfNeeded().catch(() => {});
      await target.click({ timeout: 5000 });
      clicked = true;
      break;
    }

    if (!clicked) {
      console.error('❌ 큐레이터 활동 시작 버튼을 찾지 못했습니다.');
      return null;
    }

    candidate = await waitForFreshContextAuth(context);
    if (loginRequired) {
      console.error('❌ 큐레이터 인증 갱신 중 로그인이 필요하다는 응답을 받았습니다.');
      return null;
    }
    if (candidate) {
      console.log(`✅ 큐레이터 JWT 자동 갱신 완료 | 만료: ${describeExp(candidate)}`);
      return candidate;
    }

    console.error('❌ 새 linkageString이 제한 시간 안에 발급되지 않았습니다.');
    return null;
  } finally {
    page.off('dialog', acceptDialog);
    await page.close().catch(() => {});
  }
}

function addGoodsNo(out, value) {
  const gn = String(value || '').trim();
  if (/^[AB]\d+$/i.test(gn)) out.add(gn.toUpperCase());
}

function collectGoodsNosFromEnv(out) {
  const raw = String(process.env.CURATOR_GOODS_NOS || '').trim();
  if (!raw) return;
  raw
    .split(/[\s,;]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .forEach((goodsNo) => addGoodsNo(out, goodsNo));
}

function collectGoodsNosFromStockDetail(out) {
  try {
    const raw = fs.readFileSync(DETAIL_FILE, 'utf8');
    const j = JSON.parse(raw);
    const products = j.products || {};
    Object.keys(products).forEach((goodsNo) => addGoodsNo(out, goodsNo));
  } catch {
    /* optional */
  }
}

function collectGoodsNosFromJsonFile(out, relativePath, reader) {
  try {
    const raw = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    const parsed = JSON.parse(raw);
    reader(parsed).forEach((goodsNo) => addGoodsNo(out, goodsNo));
  } catch {
    /* optional */
  }
}

async function collectGoodsNosFromLiveRanking(out) {
  if (process.env.CURATOR_INCLUDE_LIVE_RANKING === '0') return;
  try {
    const r = await fetch(LIVE_RANKING_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) {
      console.warn(`실시간 인기템 링크 대상 조회 실패: HTTP ${r.status}`);
      return;
    }
    const json = await r.json();
    const products =
      (json && json.data && Array.isArray(json.data.products) && json.data.products) ||
      (Array.isArray(json.products) && json.products) ||
      [];
    products.forEach((item) => addGoodsNo(out, item && (item.goodsNo || item.goodsNumber)));
  } catch (e) {
    console.warn('실시간 인기템 링크 대상 조회 실패:', e.message || e);
  }
}

async function collectGoodsNos() {
  const explicit = new Set();
  collectGoodsNosFromEnv(explicit);
  if (explicit.size > 0) return Array.from(explicit).slice(0, CURATOR_MAX_GOODS);

  const out = new Set();
  collectGoodsNosFromStockDetail(out);
  collectGoodsNosFromJsonFile(out, 'public/data/blog-posts.json', (j) =>
    Array.isArray(j.posts) ? j.posts.map((post) => post && post.goodsNo) : []
  );
  collectGoodsNosFromJsonFile(out, 'public/data/vendor-products.json', (j) =>
    Array.isArray(j.products) ? j.products.map((product) => product && product.goodsNo) : []
  );
  collectGoodsNosFromJsonFile(out, 'scripts/watchlist.json', (j) =>
    Array.isArray(j.favorites) ? j.favorites.map((product) => product && product.goodsNo) : []
  );
  await collectGoodsNosFromLiveRanking(out);
  return Array.from(out).slice(0, CURATOR_MAX_GOODS);
}

function isFreshCuratorEntry(entry) {
  if (!hasReadyCuratorShortLink(entry) || !entry.generatedAt) return false;
  const t = Date.parse(entry.generatedAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < CURATOR_ENTRY_MAX_AGE_MS;
}

function hasReadyCuratorShortLink(entry) {
  return isReadyCuratorShortUrl(entry && entry.shortenedUrl);
}

function hasUsableCuratorEntry(entry) {
  return !!(entry && (entry.shortenedUrl || entry.originalUrl));
}

function isDeferredCuratorEntry(entry) {
  if (!entry || !entry.error || !entry.retryAfter) return false;
  const retryAfter = Date.parse(entry.retryAfter);
  return Number.isFinite(retryAfter) && Date.now() < retryAfter;
}

function loadPrevCurator() {
  try {
    return JSON.parse(fs.readFileSync(CURATOR_FILE, 'utf8'));
  } catch {
    return { updatedAt: null, links: {} };
  }
}

async function main() {
  const authCandidates = collectAuthCandidates();
  let selectedAuth = selectAuthCandidate(authCandidates);
  const cookieHeader = selectedAuth?.cookieHeader || '';

  if (!selectedAuth) {
    console.error(
      '큐레이터 인증 후보 없음 (OY_CURATOR_COOKIE / OY_REFRESH_COOKIE / linkageString 계열 Secret 확인)'
    );
    process.exitCode = 1;
    return;
  }

  const goodsList = await collectGoodsNos();
  if (goodsList.length === 0) {
    console.log('큐레이터 링크 생성 대상 goodsNo 없음');
    process.exit(0);
  }

  const prev = loadPrevCurator();
  const links = { ...(prev.links || {}) };
  goodsList.sort();
  const regId = getRegisterId();
  const now = new Date().toISOString();

  for (const candidate of authCandidates) {
    if (candidate.expired) {
      console.warn(
        `⚠️ ${candidate.source} JWT 만료됨 (${describeExp(candidate)}) → 다른 후보 사용 시도`
      );
    }
  }

  console.log(`대상 상품 ${goodsList.length}개 | registerId ${regId.slice(0, 8)}…\n`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    locale: 'ko-KR'
  });

  try {
    if (cookieHeader) {
      await ctx.addCookies(parseCookieHeader(cookieHeader, OY_M));
    }

    if (selectedAuth.expired) {
      console.warn(
        `⚠️ 유효한 JWT가 없어 ${selectedAuth.source} 로그인 세션으로 자동 갱신합니다.`
      );
      const renewedAuth = await renewExpiredAuthFromSession(ctx);
      if (!renewedAuth) {
        console.error(
          '❌ 자동 갱신 실패: 전용 로그인 프로필을 다시 로그인한 뒤 OY_REFRESH_COOKIE를 갱신하세요.'
        );
        process.exitCode = 1;
        return;
      }
      selectedAuth = renewedAuth;
    } else {
      console.log(
        `✅ ${selectedAuth.source} 인증 사용 | JWT 만료: ${describeExp(selectedAuth)}`
      );
    }

    const authJwt = selectedAuth.jwt;
    const page = await ctx.newPage();
    console.log('www 워밍업…');
    await page.goto(OY_WWW + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    let bodyText = await page.locator('body').innerText();
    if (bodyText.includes('Just a moment') || bodyText.includes('Enable JavaScript')) {
      console.error('❌ www Cloudflare 실패');
      process.exitCode = 1;
      return;
    }

    console.log('모바일 진입…');
    await page.goto(OY_M + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    bodyText = await page.locator('body').innerText();
    if (bodyText.includes('Just a moment') || bodyText.includes('Enable JavaScript')) {
      console.error('❌ m Cloudflare 실패');
      process.exitCode = 1;
      return;
    }

    console.log('큐레이터 상품 검색 페이지 워밍업…');
    await page.goto(AFFILIATE_REFERER, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await sleep(2000);

    let generatedCount = 0;
    let shortenFailureCount = 0;
    let landingFailureCount = 0;
    let affiliateUnavailableCount = 0;
    let exceptionFailureCount = 0;
    let hardFailureCount = 0;
    let authFailureCount = 0;
    let consecutiveHardFailureCount = 0;
    let consecutivePolicyFailureCount = 0;
    let maxConsecutiveHardFailures = 0;
    let maxConsecutivePolicyFailures = 0;
    let skippedCount = 0;

    for (const gn of goodsList) {
      if (isDeferredCuratorEntry(links[gn])) {
        console.log(`\n📎 ${gn} → 발급 불가 재확인 대기 중, 스킵`);
        skippedCount += 1;
        continue;
      }

      if (CURATOR_MISSING_ONLY && hasReadyCuratorShortLink(links[gn])) {
        console.log(`\n📎 ${gn} → 유효한 oy.run 링크 있음, 스킵`);
        skippedCount += 1;
        continue;
      }

      if (isFreshCuratorEntry(links[gn])) {
        console.log(`\n📎 ${gn} → 24h 이내 유효한 shortenedUrl 있음, 스킵`);
        skippedCount += 1;
        continue;
      }

      let apiKey = generateApiKey();
      console.log(`\n📎 ${gn}`);

      let pack;
      let lastEvaluateError = null;
      const requestOutcome = await runCuratorRequestWithRetry({
        maxAttempts: 3,
        retryDelayMs: 1200,
        sleep,
        runAttempt: async ({ attempt, maxAttempts }) => {
          try {
            const evaluatedPack = await page.evaluate(
          async ({
            goodsNo,
            registerId,
            apiKey,
            placeholderCat,
            authJwt: jwt
          }) => {
            async function landing(body) {
              const headers = {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/plain, */*',
                Origin: 'https://m.oliveyoung.co.kr',
                Referer:
                  'https://m.oliveyoung.co.kr/m/mtn/affiliate/product/search',
                'x-api-key': apiKey
              };
              if (jwt) {
                headers.authorization = jwt;
              }
              try {
                const r = await fetch(
                  'https://m.oliveyoung.co.kr/review/api/affiliate/v1/activities/landing',
                  {
                    method: 'POST',
                    credentials: 'include',
                    headers,
                    body: JSON.stringify(body)
                  }
                );
                const t = await r.text();
                let json;
                try {
                  json = JSON.parse(t);
                } catch {
                  return { ok: false, status: r.status, preview: t.slice(0, 120) };
                }
                return { ok: r.ok, status: r.status, json };
              } catch (e) {
                return {
                  ok: false,
                  status: 0,
                  error: e && e.message ? e.message : String(e)
                };
              }
            }

            async function shorten(originalUrl, rid) {
              try {
                const r = await fetch(
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
                const t = await r.text();
                let json;
                try {
                  json = JSON.parse(t);
                } catch {
                  return { ok: false, status: r.status, preview: t.slice(0, 120) };
                }
                return { ok: r.ok, status: r.status, json };
              } catch (e) {
                return {
                  ok: false,
                  status: 0,
                  error: e && e.message ? e.message : String(e)
                };
              }
            }

            const attempts = [
              { goodsNumber: goodsNo, categoryNumber: placeholderCat },
              { goodsNumber: goodsNo },
              { goodsNumber: goodsNo, categoryNumber: '' }
            ];

            let affiliateActivityId = null;
            let affiliatePartnerId = registerId;
            let lastLanding = null;

            for (const body of attempts) {
              const L = await landing(body);
              lastLanding = L;
              const retryOutsideBodyVariants =
                L.status === 0 ||
                L.status === 401 ||
                L.status === 403 ||
                L.status === 429 ||
                L.status >= 500 ||
                !!L.error;
              if (retryOutsideBodyVariants) break;
              const id = L.json && L.json.data && L.json.data.affiliateActivityId;
              if (L.ok && id) {
                affiliateActivityId = id;
                affiliatePartnerId =
                  (L.json.data.affiliatePartnerId || registerId);
                break;
              }
            }

            if (!affiliateActivityId) {
              const fallbackOriginalUrl =
                'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=' +
                encodeURIComponent(goodsNo) +
                '&utm_source=shutter&utm_medium=affiliate';
              const hardFailure =
                !lastLanding ||
                lastLanding.status === 401 ||
                lastLanding.status === 403 ||
                lastLanding.status === 429 ||
                lastLanding.status >= 500 ||
                !!lastLanding.error;
              let fallbackShorten = null;
              let fallbackShortenedUrl = null;
              if (!hardFailure) {
                fallbackShorten = await shorten(fallbackOriginalUrl, registerId);
                const fallbackRow =
                  fallbackShorten.json &&
                  fallbackShorten.json.data &&
                  fallbackShorten.json.data[0];
                fallbackShortenedUrl = fallbackRow && fallbackRow.shortenedUrl;
              }
              return {
                ok: false,
                step: 'missing_affiliate_activity_id',
                detail: lastLanding,
                fallbackShortenDetail: fallbackShorten,
                fallbackShortenedUrl: fallbackShortenedUrl || null,
                fallbackOriginalUrl,
                hardFailure
              };
            }

            const originalUrl =
              'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=' +
              encodeURIComponent(goodsNo) +
              '&utm_source=shutter&utm_medium=affiliate&utm_content=OY_' +
              affiliateActivityId;

            const S = await shorten(originalUrl, affiliatePartnerId);
            const row = S.json && S.json.data && S.json.data[0];
            const shortenedUrl = row && row.shortenedUrl;
            let readyShortenedUrl = null;
            try {
              const parsedShortUrl = new URL(String(shortenedUrl || '').trim());
              if (
                parsedShortUrl.protocol === 'https:' &&
                parsedShortUrl.hostname === 'oy.run' &&
                parsedShortUrl.pathname !== '/'
              ) {
                readyShortenedUrl = String(shortenedUrl).trim();
              }
            } catch {}

            if (S.ok && readyShortenedUrl) {
              return {
                ok: true,
                shortenedUrl: readyShortenedUrl,
                originalUrl,
                affiliateActivityId,
                affiliatePartnerId
              };
            }

            return {
              ok: true,
              partial: true,
              shortenedUrl: null,
              originalUrl,
              affiliateActivityId,
              affiliatePartnerId,
              shortenDetail: S
            };
          },
          {
            goodsNo: gn,
            registerId: regId,
            apiKey,
            placeholderCat: PLACEHOLDER_CATEGORY,
            authJwt: authJwt || ''
          }
            );
            lastEvaluateError = null;
            return evaluatedPack;
          } catch (e) {
            lastEvaluateError = e;
            const message = e && e.message ? e.message : String(e);
            console.log(`  ⚠️ 생성 요청 예외 (${attempt}/${maxAttempts}) ${message}`);
            throw e;
          }
        },
        prepareRetry: async ({ attempt, maxAttempts, result, status }) => {
          if (result) {
            console.log(
              `  ⚠️ 일시적 landing 실패 HTTP ${status} (${attempt}/${maxAttempts}) → 재워밍 후 재시도`
            );
          }
          try {
            await page.goto(AFFILIATE_REFERER, {
              waitUntil: 'domcontentloaded',
              timeout: 60000
            });
          } catch (warmupError) {
            console.log(
              '  ⚠️ 큐레이터 페이지 재진입 실패',
              warmupError && warmupError.message
                ? warmupError.message
                : String(warmupError)
            );
          }
          apiKey = generateApiKey();
        }
      });
      pack = requestOutcome.result;
      if (requestOutcome.lastError) {
        lastEvaluateError = requestOutcome.lastError;
      }

      if (!pack) {
        exceptionFailureCount += 1;
        consecutiveHardFailureCount = 0;
        console.log(
          '  ❌ 생성 요청 예외 최종 실패',
          lastEvaluateError && lastEvaluateError.message
            ? lastEvaluateError.message
            : String(lastEvaluateError)
        );
        if (!hasUsableCuratorEntry(links[gn])) {
          links[gn] = {
            shortenedUrl: null,
            originalUrl: null,
            error: 'request_exception',
            detail:
              lastEvaluateError && lastEvaluateError.message
                ? lastEvaluateError.message
                : String(lastEvaluateError),
            generatedAt: now,
            retryAfter: new Date(
              Date.now() + CURATOR_TRANSIENT_RETRY_MS
            ).toISOString()
          };
        }
        await sleep(1000);
        continue;
      }

      if (pack.ok && !pack.partial) {
        generatedCount += 1;
        consecutiveHardFailureCount = 0;
        consecutivePolicyFailureCount = 0;
        links[gn] = {
          shortenedUrl: pack.shortenedUrl,
          originalUrl: pack.originalUrl,
          affiliateActivityId: pack.affiliateActivityId,
          affiliatePartnerId: pack.affiliatePartnerId,
          generatedAt: now
        };
        console.log('  ✅ oy.run + utm');
      } else if (pack.ok && pack.partial) {
        shortenFailureCount += 1;
        consecutiveHardFailureCount = 0;
        consecutivePolicyFailureCount = 0;
        links[gn] = {
          shortenedUrl: null,
          originalUrl: pack.originalUrl,
          affiliateActivityId: pack.affiliateActivityId,
          affiliatePartnerId: pack.affiliatePartnerId,
          generatedAt: now,
          note: 'shorten 실패, originalUrl만 저장'
        };
        console.log('  ⚠️ landing만 성공 (단축 실패)');
      } else {
        landingFailureCount += 1;
        const failureStatus = landingFailureStatus(pack);
        const responseCode = Number(
          pack && pack.detail && pack.detail.json && pack.detail.json.code
        );
        const unavailable = !pack.hardFailure && responseCode === 7015;

        if (unavailable) {
          affiliateUnavailableCount += 1;
          consecutiveHardFailureCount = 0;
          consecutivePolicyFailureCount = 0;
          links[gn] = {
            shortenedUrl: null,
            originalUrl: null,
            fallbackShortenedUrl: pack.fallbackShortenedUrl || null,
            fallbackOriginalUrl: pack.fallbackOriginalUrl || null,
            error: 'affiliate_link_unavailable',
            errorCode: responseCode,
            generatedAt: now,
            retryAfter: new Date(
              Date.now() + CURATOR_UNAVAILABLE_RETRY_MS
            ).toISOString()
          };
          console.log(
            '  ℹ️ 이 상품은 현재 큐레이터 링크 발급 불가 (7015). 일반 상품 페이지로 연결합니다.'
          );
        } else {
          if (pack.hardFailure) {
            hardFailureCount += 1;
            if (failureStatus === 401) authFailureCount += 1;
            consecutiveHardFailureCount += 1;
            consecutivePolicyFailureCount = 0;
            maxConsecutiveHardFailures = Math.max(
              maxConsecutiveHardFailures,
              consecutiveHardFailureCount
            );
          } else {
            consecutiveHardFailureCount = 0;
            consecutivePolicyFailureCount =
              responseCode === 7016
                ? consecutivePolicyFailureCount + 1
                : 0;
            maxConsecutivePolicyFailures = Math.max(
              maxConsecutivePolicyFailures,
              consecutivePolicyFailureCount
            );
          }
          console.log(
            '  ❌ landing 실패',
            JSON.stringify(pack.detail || pack).slice(0, 200)
          );
          if (!hasUsableCuratorEntry(links[gn])) {
            links[gn] = {
              shortenedUrl: null,
              originalUrl: null,
              fallbackShortenedUrl: pack.fallbackShortenedUrl || null,
              fallbackOriginalUrl: pack.fallbackOriginalUrl || null,
              error: 'landing_failed',
              errorCode: failureStatus,
              generatedAt: now,
              retryAfter: new Date(
                Date.now() + CURATOR_TRANSIENT_RETRY_MS
              ).toISOString()
            };
          }
          if (failureStatus === 401) {
            console.error('  ❌ 인증 HTTP 401 감지 → 남은 상품 처리를 중단합니다.');
            break;
          }
          if (consecutiveHardFailureCount >= 3) {
            console.error('  ❌ landing hard failure 3건 연속 → 남은 상품 처리를 중단합니다.');
            break;
          }
          if (consecutivePolicyFailureCount >= 3) {
            console.error('  ❌ 큐레이터 정책 오류 7016 3건 연속 → 동의/활동 상태 확인이 필요합니다.');
            break;
          }
        }
      }

      await sleep(500);
    }

    const out = {
      updatedAt: now,
      links
    };
    fs.writeFileSync(CURATOR_FILE, JSON.stringify(out, null, 2), 'utf8');
    console.log(`\n저장: ${CURATOR_FILE}`);
    console.log(
      `요약: 생성 ${generatedCount}건, 단축 실패 ${shortenFailureCount}건, 스킵 ${skippedCount}건, 발급 불가 ${affiliateUnavailableCount}건, landing 실패 ${landingFailureCount - affiliateUnavailableCount}건, 예외 ${exceptionFailureCount}건`
    );

    const persistableOutcomeCount =
      generatedCount + shortenFailureCount + affiliateUnavailableCount + skippedCount;
    const failureEvaluation = evaluateCuratorBatchFailure({
      generatedCount,
      shortenFailureCount,
      landingFailureCount,
      affiliateUnavailableCount,
      exceptionFailureCount,
      hardFailureCount,
      authFailureCount,
      maxConsecutiveHardFailures,
      maxConsecutivePolicyFailures
    });
    const { systemicHardFailure, criticalFailureCount } = failureEvaluation;

    if (exceptionFailureCount > 0 && persistableOutcomeCount > 0) {
      console.warn(
        `일부 상품 생성 예외 ${exceptionFailureCount}건은 다음 backfill에서 재시도합니다. 성공분은 저장합니다.`
      );
    }

    if (shortenFailureCount > 0 && criticalFailureCount === 0) {
      console.warn(
        `단축 링크 실패 ${shortenFailureCount}건은 다음 backfill에서 재시도합니다. 성공분은 저장합니다.`
      );
    }

    if (
      hardFailureCount > 0 &&
      !systemicHardFailure &&
      criticalFailureCount === 0
    ) {
      console.warn(
        `고립된 landing hard failure ${hardFailureCount}건은 다음 backfill에서 재시도합니다. 정상 처리분은 저장합니다.`
      );
    }

    if (criticalFailureCount > 0) {
      console.error(
        `큐레이터 생성 중요 실패 (${criticalFailureCount}건). 쿠키/토큰 Secret을 확인하세요.`
      );
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
