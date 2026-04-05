/**
 * Playwright 브라우저 컨텍스트에서 m.oliveyoung 큐레이터 API 호출 → public/data/curator-links.json 갱신.
 *
 * GitHub Actions: secrets.OY_CURATOR_COOKIE 에 m.oliveyoung.co.kr 로그인 후
 * DevTools → Network → 요청의 Cookie 헤더 전체(또는 document.cookie 기반)를 넣으면 됨.
 *
 * (detail-stock.mjs 와 달리 큐레이터 API는 로그인 세션 필요 — 무인 www만으로는 부족할 수 있음)
 *
 * env:
 *   OY_CURATOR_COOKIE — 필수(비어 있으면 스킵, exit 0). linkageString 포함 권장.
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

const POPULAR_PRODUCTS = ['A000000207822', 'A000000154189'];

const LINKAGE_AES_KEY = Buffer.from('cjone_g4de7353f1', 'utf8');
const AFFILIATE_REFERER =
  'https://m.oliveyoung.co.kr/m/mtn/affiliate/product/search';

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

/** Cookie 문자열에서 linkageString → JWT (Bearer 없이 그대로) */
function getJwtFromCookie(cookieString) {
  const m = String(cookieString).match(/(?:^|;\s*)linkageString=([^;]+)/i);
  if (!m) return null;
  let hex = m[1].trim();
  try {
    hex = decodeURIComponent(hex);
  } catch {
    /* keep */
  }
  hex = hex.trim();
  try {
    return decryptLinkageString(hex);
  } catch (e) {
    console.warn('linkageString 복호화 실패:', e.message || e);
    return null;
  }
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

function collectGoodsNos() {
  const set = new Set(POPULAR_PRODUCTS);
  try {
    const raw = fs.readFileSync(DETAIL_FILE, 'utf8');
    const j = JSON.parse(raw);
    const products = j.products || {};
    Object.keys(products).forEach((k) => set.add(k));
  } catch {
    /* no stock-detail */
  }
  return [...set].filter((g) => /^A\d+$/i.test(String(g)));
}

function loadPrevCurator() {
  try {
    return JSON.parse(fs.readFileSync(CURATOR_FILE, 'utf8'));
  } catch {
    return { updatedAt: null, links: {} };
  }
}

async function main() {
  const cookieHeader = (process.env.OY_CURATOR_COOKIE || '').trim();
  if (!cookieHeader) {
    console.log(
      'OY_CURATOR_COOKIE 없음 → 큐레이터 링크 생성 스킵 (GitHub Secrets에 쿠키 추가 후 재실행)'
    );
    process.exit(0);
  }

  const goodsList = collectGoodsNos();
  if (goodsList.length === 0) {
    console.log('goodsNo 목록 없음');
    process.exit(0);
  }

  const prev = loadPrevCurator();
  const links = { ...(prev.links || {}) };
  const regId = getRegisterId();
  const now = new Date().toISOString();
  const authJwt = getJwtFromCookie(cookieHeader);

  if (!authJwt) {
    console.warn(
      '⚠️ linkageString 없거나 복호화 실패 → landing API가 code 3000 등으로 실패할 수 있음'
    );
  } else {
    console.log('✅ linkageString → JWT 추출 성공 (앞 50자):', authJwt.slice(0, 50) + '…');
  }

  console.log(`대상 상품 ${goodsList.length}개 | registerId ${regId.slice(0, 8)}…\n`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    locale: 'ko-KR'
  });

  try {
    await ctx.addCookies(parseCookieHeader(cookieHeader, OY_M));

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

    for (const gn of goodsList) {
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
        links[gn] = {
          shortenedUrl: pack.shortenedUrl,
          originalUrl: pack.originalUrl,
          affiliateActivityId: pack.affiliateActivityId,
          affiliatePartnerId: pack.affiliatePartnerId,
          generatedAt: now
        };
        console.log('  ✅ oy.run + utm');
      } else if (pack.ok && pack.partial) {
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

      await sleep(800);
    }

    const out = {
      updatedAt: now,
      links
    };
    fs.writeFileSync(CURATOR_FILE, JSON.stringify(out, null, 2), 'utf8');
    console.log(`\n저장: ${CURATOR_FILE}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
