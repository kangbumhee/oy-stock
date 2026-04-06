/**
 * additionalInfo.do 는 403 등으로 막힐 수 있어, OY_REFRESH_COOKIE(또는 조합 쿠키)에 있는
 * linkageString(hex)를 그대로 읽어 AES 복호화 → JWT exp 확인 후
 * Vercel OLIVEYOUNG_LINKAGE_STRING(hex)을 PATCH.
 *
 * GitHub Secrets (또는 로컬 env):
 *   OY_REFRESH_COOKIE — 권장: Cookie 헤더 전체 (… linkageString=<hex> …)
 *   또는 OY_SESSION_ID + OY_LINKAGE_STRING — buildCookie 로 linkageString= 조합
 *   VERCEL_TOKEN — https://vercel.com/account/tokens
 *   VERCEL_PROJECT_ID — Project Settings → General
 *   VERCEL_TEAM_ID — (선택) 팀 프로젝트일 때만
 *
 * 한계: 쿠키의 linkageString JWT가 아직 유효할 때만 의미 있음.
 * OY_REFRESH_COOKIE 는 수동으로 주기적으로 갱신 필요(약 30일·만료 전 등).
 */

import crypto from 'crypto';

const ENV_KEY = 'OLIVEYOUNG_LINKAGE_STRING';
const LINKAGE_AES_KEY = Buffer.from('cjone_g4de7353f1', 'utf8');

function buildCookie() {
  const full = (process.env.OY_REFRESH_COOKIE || '').trim();
  if (full) return full;
  const sid = (process.env.OY_SESSION_ID || '').trim();
  const ls = (process.env.OY_LINKAGE_STRING || '').trim();
  if (sid && ls) {
    return `OYSESSIONID=${sid}; linkageString=${ls}`;
  }
  return '';
}

/** OY_REFRESH_COOKIE 우선, 없으면 buildCookie() 전체에서 추출 */
function extractLinkageHexFromEnv() {
  const fromRefresh = process.env.OY_REFRESH_COOKIE?.match(
    /linkageString=([^;]+)/i
  );
  if (fromRefresh?.[1]) {
    let hex = fromRefresh[1].trim();
    try {
      hex = decodeURIComponent(hex);
    } catch {
      /* keep */
    }
    return hex.trim();
  }
  const cookie = buildCookie();
  if (!cookie) return null;
  const m = cookie.match(/(?:^|;\s*)linkageString=([^;]+)/i);
  if (!m) return null;
  let hex = m[1].trim();
  try {
    hex = decodeURIComponent(hex);
  } catch {
    /* keep */
  }
  return hex.trim();
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

function teamQs(teamId) {
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
}

async function vercelListEnv(projectId, token, teamId) {
  const url = `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}/env${teamQs(teamId)}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Vercel list env failed ${r.status}: ${t}`);
  }
  return r.json();
}

async function vercelPatchEnv(projectId, envRecordId, value, token, teamId) {
  const url = `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envRecordId)}${teamQs(teamId)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ value })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Vercel PATCH env failed ${r.status}: ${t}`);
  }
}

async function main() {
  const token = (process.env.VERCEL_TOKEN || '').trim();
  const projectId = (process.env.VERCEL_PROJECT_ID || '').trim();
  const teamId = (process.env.VERCEL_TEAM_ID || '').trim();

  if (!token || !projectId) {
    console.error('[실패] VERCEL_TOKEN, VERCEL_PROJECT_ID 필요');
    process.exit(1);
  }

  console.log('1) OY_REFRESH_COOKIE / 조합 쿠키에서 linkageString(hex) 추출…');
  const linkageHex = extractLinkageHexFromEnv();
  if (!linkageHex) {
    console.error(
      '[실패] linkageString 없음. OY_REFRESH_COOKIE 또는 OY_SESSION_ID+OY_LINKAGE_STRING 설정'
    );
    process.exit(1);
  }
  console.log('   hex 길이:', linkageHex.length);

  let jwt;
  try {
    jwt = decryptLinkageString(linkageHex);
  } catch (e) {
    console.error('[실패] AES 복호화:', e.message || e);
    process.exit(1);
  }

  const payload = decodeJwtPayload(jwt);
  if (!payload) {
    console.error('[실패] JWT payload 디코드 불가');
    process.exit(1);
  }

  if (payload.exp != null) {
    console.log('JWT 만료:', new Date(payload.exp * 1000).toLocaleString());
    console.log(
      '남은 시간:',
      Math.round((payload.exp - Date.now() / 1000) / 3600),
      '시간'
    );
    const nowSec = Date.now() / 1000;
    if (payload.exp <= nowSec) {
      console.error('[실패] JWT 만료됨. OY_REFRESH_COOKIE 를 브라우저에서 새로 복사하세요.');
      process.exit(1);
    }
  } else {
    console.warn('[경고] JWT에 exp 없음 — 그대로 Vercel 반영 시도');
  }

  console.log('2) Vercel에서', ENV_KEY, '항목 조회…');
  let list;
  try {
    list = await vercelListEnv(projectId, token, teamId);
  } catch (e) {
    console.error('[실패]', e.message || e);
    process.exit(1);
  }

  const envs = list.envs || list;
  const targetFilter = (process.env.VERCEL_ENV_TARGETS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let toPatch = (Array.isArray(envs) ? envs : []).filter(
    (e) => e && e.key === ENV_KEY
  );
  if (targetFilter.length > 0) {
    toPatch = toPatch.filter((e) => targetFilter.includes(e.target));
  }

  if (toPatch.length === 0) {
    console.error(
      '[실패] 일치하는 env 없음. Vercel Project에',
      ENV_KEY,
      '추가 후 재실행'
    );
    process.exit(1);
  }

  for (const e of toPatch) {
    try {
      console.log('   PATCH', e.target, e.id, '…');
      await vercelPatchEnv(projectId, e.id, linkageHex, token, teamId);
      console.log('   [성공]', e.target, e.id);
    } catch (err) {
      console.error('   [실패]', e.target, e.id, err.message || err);
      process.exit(1);
    }
  }

  console.log(
    '[완료] OLIVEYOUNG_LINKAGE_STRING 반영. 재배포 없이 다음 요청부터 적용됩니다.'
  );
}

main().catch((err) => {
  console.error('[실패]', err);
  process.exit(1);
});
