/**
 * 브라우저 CORS 우회: Vercel → m.oliveyoung shorten API.
 * (landing 등 다른 API는 여전히 Cloudflare에 막힐 수 있음)
 */

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

function isAllowedOriginalUrl(u) {
  try {
    const parsed = new URL(String(u || '').trim());
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== 'm.oliveyoung.co.kr') return false;
    return parsed.pathname === '/m/goods/getGoodsDetail.do';
  } catch {
    return false;
  }
}

const DEFAULT_REGISTER_ID = '4ee076cc92da4447a1b4b42c590e4495';

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

  const originalUrl = body && String(body.originalUrl || '').trim();
  let registerId =
    body && body.registerId != null
      ? String(body.registerId).trim()
      : DEFAULT_REGISTER_ID;

  if (!originalUrl || !isAllowedOriginalUrl(originalUrl)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        error: 'invalid_originalUrl',
        message: 'm.oliveyoung.co.kr 모바일 상품 상세 URL만 허용'
      })
    );
    return;
  }

  if (!registerId) registerId = DEFAULT_REGISTER_ID;

  const url = 'https://m.oliveyoung.co.kr/base/shorten/v2/verified';
  const payload = JSON.stringify([{ originalUrl, registerId }]);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': generateApiKey(),
        Origin: 'https://m.oliveyoung.co.kr',
        Referer: 'https://m.oliveyoung.co.kr/',
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
      },
      body: payload
    });

    const text = await response.text();
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

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
