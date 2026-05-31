/**
 * Playwright context에서 올리브영 쿠키 추출 + linkageString(hex) → JWT exp
 *
 * linkageString은 JWT가 아니라 AES-128-ECB로 암호화된 hex (landing-proxy / refresh-oy-linkage와 동일)
 */

import crypto from 'crypto';

const LINKAGE_AES_KEY = Buffer.from('cjone_g4de7353f1', 'utf8');

const REQUIRED_NAMES = ['linkageString', 'OYSESSIONID'];

function decodeCookieValue(v) {
  let out = String(v || '').trim();
  try {
    out = decodeURIComponent(out);
  } catch {
    /* keep */
  }
  return out.trim();
}

export function extractLinkageHex(cookieString) {
  const m = String(cookieString || '').match(/(?:^|;\s*)linkageString=([^;]+)/i);
  if (!m?.[1]) return null;
  return decodeCookieValue(m[1]);
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
    const json = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** linkageString hex → JWT exp (초). 실패 시 null */
export function jwtExpFromLinkageHex(hex) {
  if (!hex) return null;
  let jwt;
  try {
    jwt = decryptLinkageString(hex);
  } catch {
    return null;
  }
  const payload = decodeJwtPayload(jwt);
  if (!payload || payload.exp == null || !Number.isFinite(Number(payload.exp))) {
    return null;
  }
  return Number(payload.exp);
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {string} domain 예: m.oliveyoung.co.kr
 */
export async function extractCookies(context, domain) {
  const allCookies = await context.cookies();
  const host = domain.replace(/^\./, '');
  const oyCookies = allCookies.filter((c) => {
    const d = (c.domain || '').replace(/^\./, '');
    return d === host || d.endsWith('oliveyoung.co.kr');
  });

  const result = {
    linkageHex: null,
    oySessionId: null,
    raw: ''
  };

  for (const c of oyCookies) {
    if (c.name === 'linkageString') result.linkageHex = c.value;
    if (c.name === 'OYSESSIONID') result.oySessionId = c.value;
  }

  const forHeader = oyCookies.filter(
    (c) =>
      REQUIRED_NAMES.includes(c.name) ||
      c.name.startsWith('OY') ||
      c.name === 'linkageString'
  );
  const byName = new Map(forHeader.map((c) => [c.name, c]));
  result.raw = Array.from(byName.values())
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  for (const name of REQUIRED_NAMES) {
    const found = oyCookies.some((c) => c.name === name);
    if (!found) console.warn(`[WARN] '${name}' 쿠키 없음`);
  }

  return result;
}
