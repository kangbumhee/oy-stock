const crypto = require('node:crypto');
const {
  configuredPromotion,
  promotionMatches
} = require('./price-alerts/_entitlement');

const COOKIE_NAME = '__Host-oy-entry';
const SESSION_SECONDS = 12 * 60 * 60;
const MAX_FORM_BYTES = 2048;

function configuredSiteAccess() {
  const promotion = configuredPromotion();
  if (!promotion) return null;
  const signingKey = crypto.createHmac('sha256', promotion.pepper)
    .update('oliveyoung-private-site:session:v1\0')
    .update(promotion.digest)
    .digest();
  return { promotion, signingKey };
}

function createSessionToken(host, configuration, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    h: host,
    iat: issuedAt,
    exp: issuedAt + SESSION_SECONDS,
    n: crypto.randomBytes(16).toString('base64url')
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', configuration.signingKey)
    .update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifySessionToken(token, host, configuration, now = Date.now()) {
  if (!configuration || typeof token !== 'string' || token.length > 1024) return false;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return false;
  const actual = Buffer.from(match[2], 'base64url');
  const expected = crypto.createHmac('sha256', configuration.signingKey)
    .update(match[1]).digest();
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    const seconds = Math.floor(now / 1000);
    return payload.v === 1 && payload.h === host &&
      Number.isInteger(payload.iat) && Number.isInteger(payload.exp) &&
      payload.iat >= 0 && payload.iat <= seconds + 30 &&
      payload.exp === payload.iat + SESSION_SECONDS && payload.exp > seconds &&
      /^[A-Za-z0-9_-]{22}$/.test(payload.n);
  } catch (_) {
    return false;
  }
}

function sessionCookieValue(request) {
  const values = String(request.headers.get('cookie') || '').split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (values.length !== 1) return '';
  return values[0].slice(COOKIE_NAME.length + 1);
}

function operationalPassThrough(request, url = new URL(request.url)) {
  const method = request.method.toUpperCase();
  const path = url.pathname;
  if (['GET', 'HEAD'].includes(method) && /^\/(?:public\/)?sw\.js$/.test(path)) return true;
  if (['GET', 'HEAD'].includes(method) && /^\/api\/oliveyoung\/landing-proxy(?:\.js)?$/.test(path)) {
    return ['1', 'true'].includes(url.searchParams.get('check'));
  }
  if (['GET', 'HEAD'].includes(method) && /^\/api\/oliveyoung\/hot-ranking-history(?:\.js)?$/.test(path)) {
    return true;
  }
  if (['GET', 'POST'].includes(method) &&
    /^\/api\/(?:oliveyoung\/hot-ranking-cron|price-alerts\/hourly)(?:\.js)?$/.test(path)) return true;
  return method === 'POST' &&
    /^\/api\/(?:price-alerts\/payment\/(?:webhook|complete)|ph-guide)(?:\.js)?$/.test(path);
}

function securityHeaders(nonce) {
  return {
    'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'"
    ].join('; ')
  };
}

function gateResponse(status, message, head = false, extraHeaders = {}) {
  const nonce = crypto.randomBytes(18).toString('base64');
  const body = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title></title><style nonce="${nonce}">*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#fff}body{min-height:100dvh;display:grid;place-items:center;font-family:system-ui,sans-serif}form{width:min(280px,calc(100vw - 48px))}input{display:block;width:100%;height:46px;border:1px solid #d6d6d6;border-radius:6px;padding:0 14px;font:16px system-ui,sans-serif;background:#fff;color:#222}input:focus{outline:2px solid #555;outline-offset:2px}p{margin:12px 0 0;font-size:13px;color:#a11;text-align:center}</style></head><body><form method="post" action="/_entry"><input type="password" name="password" autocomplete="current-password" aria-label="비밀번호" placeholder="비밀번호" maxlength="160" required autofocus>${message ? `<p role="alert">${message}</p>` : ''}</form><script nonce="${nonce}">if('caches' in window){caches.keys().then(function(keys){return Promise.all(keys.filter(function(key){return key.indexOf('olivestock-app-')===0}).map(function(key){return caches.delete(key)}))}).catch(function(){})}</script></body></html>`;
  return new Response(head ? null : body, {
    status,
    headers: {
      ...securityHeaders(nonce),
      'Content-Type': 'text/html; charset=utf-8',
      ...extraHeaders
    }
  });
}

function deniedResponse(request, status = 401) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const documentRequest = ['GET', 'HEAD'].includes(method) &&
    !/^\/(?:public\/)?(?:api|data)(?:\/|$)/i.test(url.pathname) &&
    (request.headers.get('accept')?.includes('text/html') ||
      url.pathname === '/' || /\/$|\.html?$/.test(url.pathname) ||
      !/\.[a-z0-9]+$/i.test(url.pathname));
  if (documentRequest) return gateResponse(status === 401 ? 200 : status, '', method === 'HEAD');
  return new Response(method === 'HEAD' ? null : JSON.stringify({ success: false, error: 'site_access_required' }), {
    status,
    headers: {
      ...securityHeaders(crypto.randomBytes(18).toString('base64')),
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function isSameOrigin(request, url) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = request.headers.get('origin');
  return origin === url.origin && url.protocol === 'https:';
}

async function readPassword(request) {
  const contentType = String(request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') return { error: 415 };
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_FORM_BYTES) return { error: 413 };
  const chunks = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_FORM_BYTES) {
          await reader.cancel();
          return { error: 413 };
        }
        chunks.push(Buffer.from(chunk.value));
      }
    } catch (_) {
      return { error: 400 };
    }
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  if (form.getAll('password').length !== 1) return { error: 400 };
  return { password: form.get('password') };
}

function createSiteAccessHandler(dependencies = {}) {
  const getConfiguration = dependencies.configuredSiteAccess || configuredSiteAccess;
  const now = dependencies.now || Date.now;
  const rateLimit = dependencies.consumeRateLimit || ((request, scope) =>
    require('./price-alerts/_limits').consumeRateLimit(request, scope));
  return async function handleSiteAccess(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (operationalPassThrough(request, url)) return null;
    const configuration = getConfiguration();
    if (url.pathname === '/_entry/logout') {
      if (method !== 'POST') return deniedResponse(request, 405);
      if (!isSameOrigin(request, url)) return deniedResponse(request, 403);
      return new Response(null, {
        status: 303,
        headers: {
          ...securityHeaders(crypto.randomBytes(18).toString('base64')),
          Location: '/',
          'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
        }
      });
    }
    if (url.pathname === '/_entry') {
      if (method !== 'POST') return deniedResponse(request, 405);
      if (!isSameOrigin(request, url)) return deniedResponse(request, 403);
      if (!configuration) return gateResponse(503, '잠시 후 다시 시도해 주세요.');
      try {
        await rateLimit({ headers: {
          ...Object.fromEntries(request.headers),
          host: url.host,
          'x-forwarded-host': url.host
        } }, 'site_entry');
      } catch (error) {
        const limited = Number(error?.statusCode) === 429;
        return gateResponse(limited ? 429 : 503,
          '잠시 후 다시 시도해 주세요.',
          false, { 'Retry-After': String(Math.max(1, Math.min(3600, Number(error?.retryAfter) || 60))) });
      }
      const result = await readPassword(request);
      if (result.error) return gateResponse(result.error, '입력 내용을 확인해 주세요.');
      if (!promotionMatches(result.password, configuration.promotion)) {
        return gateResponse(401, '비밀번호를 확인해 주세요.');
      }
      const token = createSessionToken(url.host, configuration, now());
      return new Response(null, {
        status: 303,
        headers: {
          ...securityHeaders(crypto.randomBytes(18).toString('base64')),
          Location: '/',
          'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`
        }
      });
    }
    if (verifySessionToken(sessionCookieValue(request), url.host, configuration, now())) return null;
    return configuration ? deniedResponse(request) : deniedResponse(request, 503);
  };
}

module.exports = {
  COOKIE_NAME,
  SESSION_SECONDS,
  configuredSiteAccess,
  createSessionToken,
  createSiteAccessHandler,
  operationalPassThrough,
  verifySessionToken
};
