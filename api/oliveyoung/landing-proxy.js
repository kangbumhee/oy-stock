/**
 * 브라우저 CORS 우회: Vercel → m.oliveyoung 큐레이터 landing API.
 *
 * env:
 *   OLIVEYOUNG_LINKAGE_STRING — linkageString 값(hex). AES-128-ECB 복호화 → Authorization JWT
 *   OLIVEYOUNG_LINKAGE_JWT — 선택, 설정 시 복호화 생략하고 그대로 Authorization
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

function getAuthJwt() {
  const direct = (process.env.OLIVEYOUNG_LINKAGE_JWT || '').trim();
  if (direct) return direct;

  const hex = (process.env.OLIVEYOUNG_LINKAGE_STRING || '').trim();
  if (!hex) return null;
  try {
    return decryptLinkageString(hex);
  } catch {
    return null;
  }
}

function isValidGoodsNo(g) {
  return /^A\d+$/i.test(String(g || '').trim());
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'POST only' }));
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
