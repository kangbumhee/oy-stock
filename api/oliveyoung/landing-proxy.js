/**
 * 브라우저 CORS 우회: Vercel → m.oliveyoung 큐레이터 landing API.
 *
 * env:
 *   OLIVEYOUNG_LINKAGE_STRING — linkageString 값(hex). AES-128-ECB 복호화 → Authorization JWT
 *   OLIVEYOUNG_LINKAGE_JWT — 선택, 설정 시 복호화 생략하고 그대로 Authorization
 *
 * GET ?check=1 — JWT 만료·출처 점검 (올리브영 API 호출 없음)
 */

const crypto = require('crypto');

const LINKAGE_AES_KEY = Buffer.from('cjone_g4de7353f1', 'utf8');
const DEFAULT_CATEGORY = '1000001000000000000';
const LANDING_URL =
  'https://m.oliveyoung.co.kr/review/api/affiliate/v1/activities/landing';

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
  const raw = `e3ea1c526eef4570946ebdf083dad7a7:shrt-auth:${timeStr}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

function getJwtFromEnv() {
  const direct = (process.env.OLIVEYOUNG_LINKAGE_JWT || '').trim();
  if (direct) {
    return { jwt: direct, jwtSource: 'direct', decryptError: null };
  }
  const hex = (process.env.OLIVEYOUNG_LINKAGE_STRING || '').trim();
  if (!hex) {
    return { jwt: null, jwtSource: null, decryptError: null };
  }
  try {
    return {
      jwt: decryptLinkageString(hex),
      jwtSource: 'linkage',
      decryptError: null
    };
  } catch (e) {
    return {
      jwt: null,
      jwtSource: 'linkage',
      decryptError: String(e.message || e)
    };
  }
}

/** JWT payload 디코드 (검증 없음). exp 는 초 단위 Unix time */
function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const json = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function buildJwtCheckResponse() {
  const nowSec = Math.floor(Date.now() / 1000);
  const { jwt, jwtSource, decryptError } = getJwtFromEnv();

  if (decryptError) {
    return {
      jwtValid: false,
      jwtExp: null,
      jwtExpSeconds: null,
      jwtSource: 'linkage',
      decryptError,
      note: 'OLIVEYOUNG_LINKAGE_STRING 복호화 실패'
    };
  }

  if (!jwt) {
    return {
      jwtValid: false,
      jwtExp: null,
      jwtExpSeconds: null,
      jwtSource: null,
      note: 'OLIVEYOUNG_LINKAGE_JWT / OLIVEYOUNG_LINKAGE_STRING 미설정'
    };
  }

  const payload = decodeJwtPayload(jwt);
  if (!payload) {
    return {
      jwtValid: null,
      jwtExp: null,
      jwtExpSeconds: null,
      jwtSource: jwtSource || 'unknown',
      note: 'JWT 형식 아님(점 2개 구간 없음) — 토큰 그대로 authorization 사용',
      tokenLength: jwt.length
    };
  }

  const expSec =
    payload.exp != null && Number.isFinite(Number(payload.exp))
      ? Number(payload.exp)
      : null;
  const jwtValid = expSec == null ? null : expSec > nowSec;
  const jwtExp =
    expSec != null ? new Date(expSec * 1000).toISOString() : null;

  return {
    jwtValid,
    jwtExp,
    jwtExpSeconds: expSec,
    nowSeconds: nowSec,
    secondsRemaining:
      expSec != null ? Math.max(0, expSec - nowSec) : null,
    jwtSource: jwtSource || 'unknown',
    sub: payload.sub,
    iat:
      payload.iat != null
        ? new Date(Number(payload.iat) * 1000).toISOString()
        : undefined
  };
}

function getAuthJwt() {
  const { jwt } = getJwtFromEnv();
  return jwt;
}

function isValidGoodsNo(g) {
  return /^A\d+$/i.test(String(g || '').trim());
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === 'GET') {
    const q = req.query || {};
    if (q.check === '1' || q.check === 'true') {
      const body = buildJwtCheckResponse();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(body));
      return;
    }
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        error: 'bad_request',
        message: 'landing 호출은 POST, JWT 점검은 GET ?check=1'
      })
    );
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body = req.body;
  if (Buffer.isBuffer(body)) {
    body = JSON.parse(body.toString('utf8') || '{}');
  } else if (typeof body === 'string') {
    body = JSON.parse(body || '{}');
  }

  const goodsNo = String(body && body.goodsNo != null ? body.goodsNo : '').trim();
  let categoryNumber =
    body && body.categoryNumber != null && String(body.categoryNumber).trim() !== ''
      ? String(body.categoryNumber).trim()
      : DEFAULT_CATEGORY;

  if (!isValidGoodsNo(goodsNo)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'invalid_goodsNo' }));
    return;
  }

  const jwt = getAuthJwt();
  if (!jwt) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        error: 'missing_or_invalid_linkage',
        message:
          'OLIVEYOUNG_LINKAGE_JWT 또는 OLIVEYOUNG_LINKAGE_STRING(hex) 환경변수 필요'
      })
    );
    return;
  }

  const attempts = [
    { goodsNumber: goodsNo, categoryNumber },
    { goodsNumber: goodsNo },
    { goodsNumber: goodsNo, categoryNumber: '' }
  ];

  try {
    let lastText = '';
    let lastStatus = 0;
    let lastData = null;

    for (const bodyObj of attempts) {
      const response = await fetch(LANDING_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Origin: 'https://m.oliveyoung.co.kr',
          Referer:
            'https://m.oliveyoung.co.kr/m/mtn/affiliate/product/search',
          'x-api-key': generateApiKey(),
          authorization: jwt,
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
        },
        body: JSON.stringify(bodyObj)
      });

      const text = await response.text();
      lastText = text;
      lastStatus = response.status;
      const trimmed = text.trim();

      if (trimmed.startsWith('<')) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            error: 'blocked',
            status: response.status,
            preview: text.slice(0, 200)
          })
        );
        return;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            error: 'invalid_json',
            status: response.status,
            preview: text.slice(0, 200)
          })
        );
        return;
      }

      lastData = data;
      const inner = data && data.data;
      const affiliateActivityId =
        inner && inner.affiliateActivityId != null
          ? String(inner.affiliateActivityId)
          : null;
      const affiliatePartnerId =
        inner && inner.affiliatePartnerId != null
          ? String(inner.affiliatePartnerId)
          : null;

      if (response.ok && affiliateActivityId) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            affiliateActivityId,
            affiliatePartnerId: affiliatePartnerId || undefined
          })
        );
        return;
      }
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        error: 'landing_failed',
        status: lastStatus,
        preview: lastText.slice(0, 300),
        code: lastData && lastData.code,
        message: lastData && lastData.message
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
