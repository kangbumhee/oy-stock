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

/** curator-links 항목이 이 시간 이내면 landing/shorten 재호출 안 함 */
const CURATOR_ENTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

function addGoodsNo(out, value) {
  const gn = String(value || '').trim();
  if (/^[AB]\d+$/i.test(gn)) out.add(gn.toUpperCase());
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
  if (!entry || !entry.shortenedUrl || !entry.generatedAt) return false;
  const t = Date.parse(entry.generatedAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < CURATOR_ENTRY_MAX_AGE_MS;
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
  const selectedAuth = selectAuthCandidate(authCandidates);
  const cookieHeader = selectedAuth?.cookieHeader || '';

  if (!selectedAuth) {
    console.log(
      '큐레이터 인증 후보 없음 → 링크 생성 스킵 (OY_CURATOR_COOKIE / OY_REFRESH_COOKIE / linkageString 계열 Secret 확인)'
    );
    process.exit(0);
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
  const authJwt = selectedAuth.jwt;

  for (const candidate of authCandidates) {
    if (candidate.expired) {
      console.warn(
        `⚠️ ${candidate.source} JWT 만료됨 (${describeExp(candidate)}) → 다른 후보 사용 시도`
      );
    }
  }

  if (selectedAuth.expired) {
    console.error(
      `⚠️ 유효한 JWT 후보가 없어 만료된 ${selectedAuth.source} 사용 시도 (${describeExp(selectedAuth)})`
    );
    process.exit(1);
  } else {
    console.log(
      `✅ ${selectedAuth.source} 인증 사용 | JWT 만료: ${describeExp(selectedAuth)}`
    );
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
    let landingFailureCount = 0;

    for (const gn of goodsList) {
      if (isFreshCuratorEntry(links[gn])) {
        console.log(`\n📎 ${gn} → 24h 이내 유효한 shortenedUrl 있음, 스킵`);
        continue;
      }

      const apiKey = generateApiKey();
      console.log(`\n📎 ${gn}`);

      const pack = await page.evaluate(
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
          }

          async function shorten(originalUrl, rid) {
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
            const id = L.json && L.json.data && L.json.data.affiliateActivityId;
            if (L.ok && id) {
              affiliateActivityId = id;
              affiliatePartnerId =
                (L.json.data.affiliatePartnerId || registerId);
              break;
            }
          }

          if (!affiliateActivityId) {
            return {
              ok: false,
              step: 'landing',
              detail: lastLanding
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

          if (S.ok && shortenedUrl) {
            return {
              ok: true,
              shortenedUrl,
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

      if (pack.ok && !pack.partial) {
        generatedCount += 1;
        links[gn] = {
          shortenedUrl: pack.shortenedUrl,
          originalUrl: pack.originalUrl,
          affiliateActivityId: pack.affiliateActivityId,
          affiliatePartnerId: pack.affiliatePartnerId,
          generatedAt: now
        };
        console.log('  ✅ oy.run + utm');
      } else if (pack.ok && pack.partial) {
        generatedCount += 1;
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
        console.log('  ❌ landing 실패', JSON.stringify(pack.detail || pack).slice(0, 200));
        if (!links[gn]) {
          links[gn] = {
            shortenedUrl: null,
            originalUrl: null,
            error: 'landing_failed',
            generatedAt: now
          };
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

    if (generatedCount === 0 && landingFailureCount > 0) {
      console.error(
        `큐레이터 landing 전부 실패 (${landingFailureCount}건). 쿠키/토큰 Secret을 갱신하세요.`
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
