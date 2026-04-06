/**
 * additionalInfo.do 는 403 등으로 막힐 수 있어, OY_REFRESH_COOKIE(또는 조합 쿠키)에 있는
 * linkageString(hex)를 그대로 읽어 AES 복호화 → JWT exp 확인 후
 * Vercel OLIVEYOUNG_LINKAGE_STRING(hex)을 PATCH.
 *
 * JWT 만료 7일 이내(또는 이미 만료)이고 ALERT_EMAIL_* 가 설정되어 있으면 Gmail SMTP로 알림.
 *
 * GitHub Secrets (또는 로컬 env):
 *   OY_REFRESH_COOKIE — 권장: Cookie 헤더 전체 (… linkageString=<hex> …)
 *   또는 OY_SESSION_ID + OY_LINKAGE_STRING — buildCookie 로 linkageString= 조합
 *   VERCEL_TOKEN — https://vercel.com/account/tokens
 *   VERCEL_PROJECT_ID — Project Settings → General
 *   VERCEL_TEAM_ID — (선택) 팀 프로젝트일 때만
 *
 *   ALERT_EMAIL_FROM — 발신 Gmail
 *   ALERT_EMAIL_PASSWORD — Gmail 앱 비밀번호 (일반 비밀번호 아님)
 *   ALERT_EMAIL_TO — 수신 주소
 *
 * 한계: 쿠키의 linkageString JWT가 아직 유효할 때만 의미 있음.
 * OY_REFRESH_COOKIE 는 수동으로 주기적으로 갱신 필요(약 30일·만료 전 등).
 */

import crypto from 'crypto';
import nodemailer from 'nodemailer';

const ENV_KEY = 'OLIVEYOUNG_LINKAGE_STRING';
const LINKAGE_AES_KEY = Buffer.from('cjone_g4de7353f1', 'utf8');
const MS_PER_DAY = 86400000;
const ALERT_WITHIN_MS = 7 * MS_PER_DAY;

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

function alertEmailConfigured() {
  return !!(
    (process.env.ALERT_EMAIL_FROM || '').trim() &&
    (process.env.ALERT_EMAIL_PASSWORD || '').trim() &&
    (process.env.ALERT_EMAIL_TO || '').trim()
  );
}

/**
 * @param {{ expired: boolean, expMs: number, msRemaining: number }} p
 */
async function sendLinkageExpiryAlert(p) {
  if (!alertEmailConfigured()) {
    console.log('[알림] ALERT_EMAIL_* 미설정 — 만료 경고 메일 생략');
    return;
  }

  const from = (process.env.ALERT_EMAIL_FROM || '').trim();
  const pass = (process.env.ALERT_EMAIL_PASSWORD || '').trim();
  const to = (process.env.ALERT_EMAIL_TO || '').trim();

  const expDateStr = new Date(p.expMs).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul'
  });

  let daysLeftLabel;
  let subject;
  if (p.expired) {
    daysLeftLabel = '이미 만료됨 (즉시 갱신 필요)';
    subject = '🚨 [oy-stock] 올리브영 JWT 만료됨 — OY_REFRESH_COOKIE 즉시 갱신';
  } else {
    const ceilDays = Math.max(0, Math.ceil(p.msRemaining / MS_PER_DAY));
    daysLeftLabel = `${ceilDays}일`;
    const within3 =
      p.msRemaining > 0 && p.msRemaining <= 3 * MS_PER_DAY;
    subject = within3
      ? `🚨 [oy-stock] 올리브영 쿠키 만료 ${ceilDays}일 전!`
      : `⚠️ [oy-stock] 올리브영 쿠키 만료 ${ceilDays}일 전!`;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: from, pass }
  });

  const html = `
      <h2>${p.expired ? '🚨 OY_REFRESH_COOKIE / JWT 만료됨' : '⚠️ OY_REFRESH_COOKIE 만료 예정'}</h2>
      <p><strong>만료일(한국 기준):</strong> ${expDateStr}</p>
      <p><strong>남은 일수:</strong> ${daysLeftLabel}</p>

      <h3>🔐 Gmail 알림용 앱 비밀번호 (Secrets 설정 시)</h3>
      <ol>
        <li>Google 계정 → <strong>보안</strong></li>
        <li><strong>2단계 인증</strong> 켜기</li>
        <li><strong>앱 비밀번호</strong> → 새 앱 비밀번호 생성</li>
        <li>생성된 16자리 코드를 GitHub Secret <code>ALERT_EMAIL_PASSWORD</code>에 저장 (일반 Gmail 비밀번호 아님)</li>
      </ol>

      <h3>📋 OY_REFRESH_COOKIE 갱신 방법</h3>
      <ol>
        <li>올리브영 큐레이터 대시보드 접속 (반드시 이 주소로!)<br>
            <a href="https://m.oliveyoung.co.kr/m/mtn/affiliate/dashboard">
            https://m.oliveyoung.co.kr/m/mtn/affiliate/dashboard</a></li>
        <li>로그인 후 페이지 완전히 로드될 때까지 기다리기</li>
        <li>F12 → <strong>Network</strong> 탭 열기</li>
        <li><strong>Preserve log</strong> ✅ 체크</li>
        <li>아무 상품 <strong>링크 복사</strong> 버튼 클릭</li>
        <li>Network에서 <strong>landing</strong> 요청 클릭</li>
        <li><strong>Request Headers</strong> → <code>cookie:</code> 값 전체 복사</li>
        <li>GitHub Secret 업데이트:<br>
            <a href="https://github.com/kangbumhee/oy-stock/settings/secrets/actions">
            https://github.com/kangbumhee/oy-stock/settings/secrets/actions</a></li>
        <li><code>OY_REFRESH_COOKIE</code> → Update → 새 값 붙여넣기 → Save</li>
        <li>Actions 수동 실행으로 확인:<br>
            <a href="https://github.com/kangbumhee/oy-stock/actions">
            https://github.com/kangbumhee/oy-stock/actions</a></li>
      </ol>

      <p>✅ 완료되면 Vercel <code>OLIVEYOUNG_LINKAGE_STRING</code> 반영 및 큐레이터 연동이 계속 동작합니다.</p>
    `;

  try {
    await transporter.sendMail({
      from,
      to,
      subject,
      html
    });
    console.log('[알림] 만료 경고 메일 발송 완료 →', to);
  } catch (e) {
    console.error('[알림] 메일 발송 실패:', e.message || e);
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
    const nowSec = Date.now() / 1000;
    const expSec = payload.exp;
    const expMs = expSec * 1000;
    const expired = expSec <= nowSec;
    const msRemaining = expMs - Date.now();

    console.log('JWT 만료:', new Date(expMs).toLocaleString());
    console.log(
      '남은 시간:',
      Math.round((expSec - nowSec) / 3600),
      '시간'
    );

    const needAlert =
      expired || (msRemaining > 0 && msRemaining <= ALERT_WITHIN_MS);
    if (needAlert) {
      await sendLinkageExpiryAlert({ expired, expMs, msRemaining });
    }

    if (expired) {
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
