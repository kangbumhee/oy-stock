/**
 * additionalInfo.do 는 403 등으로 막힐 수 있어, OY_REFRESH_COOKIE(또는 조합 쿠키)에 있는
 * linkageString(hex)를 그대로 읽어 AES 복호화 → JWT exp 확인 후
 * Vercel OLIVEYOUNG_LINKAGE_STRING(hex)을 PATCH.
 *
 * ALERT_EMAIL_* 설정 시 Gmail SMTP 알림:
 *   - Vercel PATCH 성공 → 메일 없음 (정상 갱신 완료)
 *   - linkageString 없음 / JWT 만료 / Vercel 실패 → 메일 발송
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

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

const RENEWAL_STEPS_HTML = `
      <h3>🔐 Gmail 알림용 앱 비밀번호 (Secrets 설정 시)</h3>
      <ol>
        <li>Google 계정 → <strong>보안</strong></li>
        <li><strong>2단계 인증</strong> 켜기</li>
        <li><strong>앱 비밀번호</strong> → 새 앱 비밀번호 생성</li>
        <li>생성된 16자리 코드를 GitHub Secret <code>ALERT_EMAIL_PASSWORD</code>에 저장 (일반 Gmail 비밀번호 아님)</li>
      </ol>

      <h3>📋 OY_REFRESH_COOKIE 갱신 방법</h3>
      <ol>
        <li>올리브영 큐레이터 대시보드 접속<br>
            <a href="https://m.oliveyoung.co.kr/m/mtn/affiliate/dashboard">
            https://m.oliveyoung.co.kr/m/mtn/affiliate/dashboard</a></li>
        <li>로그인 후 페이지 완전히 로드될 때까지 기다리기</li>
        <li>F12 → <strong>Console</strong> 탭 열고 아래 코드 붙여넣고 실행:<br>
            <pre style="background:#f4f4f4;padding:10px;border-radius:4px;font-size:12px;overflow-x:auto;">(() =&gt; {
  const cookies = document.cookie.split(';').map(c =&gt; c.trim());
  const ls = cookies.find(c =&gt; c.startsWith('linkageString='));
  if (!ls) {
    console.log('❌ linkageString 없음 - Network 탭에서 가져와야 함');
    return;
  }
  console.log('✅ linkageString 있음!');
  console.log('길이:', ls.split('=')[1].length);
  console.log('\\n=== 전체 쿠키 (OY_REFRESH_COOKIE에 넣을 값) ===');
  console.log(document.cookie);
})();</pre>
        </li>
        <li>✅ linkageString 있음! 이 뜨면 콘솔에 출력된 전체 쿠키값 복사</li>
        <li>❌ linkageString 없음 이 뜨면 아래 Network 방법 사용:
            <ul>
              <li>Network 탭 → Preserve log ✅</li>
              <li>아무 상품 &quot;링크 복사&quot; 버튼 클릭</li>
              <li>Network에서 &quot;landing&quot; 요청 클릭</li>
              <li>Request Headers → cookie: 값 전체 복사</li>
            </ul>
        </li>
        <li>GitHub Secret 업데이트:<br>
            <a href="https://github.com/kangbumhee/oy-stock/settings/secrets/actions">
            https://github.com/kangbumhee/oy-stock/settings/secrets/actions</a></li>
        <li><code>OY_REFRESH_COOKIE</code> → Update → 복사한 값 붙여넣기 → Save</li>
        <li>Actions 수동 실행으로 확인:<br>
            <a href="https://github.com/kangbumhee/oy-stock/actions">
            https://github.com/kangbumhee/oy-stock/actions</a></li>
      </ol>

      <p>✅ 완료되면 Vercel <code>OLIVEYOUNG_LINKAGE_STRING</code> 반영 및 큐레이터 연동이 계속 동작합니다.</p>
`;

/**
 * @param {{
 *   expired?: boolean,
 *   expMs?: number,
 *   msRemaining?: number,
 *   noLinkageString?: boolean,
 *   vercelError?: string
 * }} p
 */
async function sendLinkageExpiryAlert(p) {
  if (!alertEmailConfigured()) {
    console.log('[알림] ALERT_EMAIL_* 미설정 — 알림 메일 생략');
    return;
  }

  const from = (process.env.ALERT_EMAIL_FROM || '').trim();
  const pass = (process.env.ALERT_EMAIL_PASSWORD || '').trim();
  const to = (process.env.ALERT_EMAIL_TO || '').trim();

  let subject;
  let headline;
  let metaBlock = '';
  let errorBlock = '';

  if (p.noLinkageString) {
    subject = '🚨 [oy-stock] OY_REFRESH_COOKIE에 linkageString 없음';
    headline = '🚨 linkageString을 찾을 수 없음';
    metaBlock =
      '<p>Cookie 문자열에 <code>linkageString=</code> 이 없습니다. 아래 절차로 쿠키를 다시 복사해 주세요.</p>';
  } else if (p.vercelError) {
    subject = '🚨 [oy-stock] Vercel OLIVEYOUNG_LINKAGE_STRING 반영 실패';
    headline = '🚨 Vercel 환경변수 반영 실패';
    errorBlock = `<p><strong>사유:</strong> ${escapeHtml(p.vercelError)}</p>`;
    if (p.expMs != null) {
      const expDateStr = new Date(p.expMs).toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul'
      });
      const daysLeftLabel = p.expired
        ? '이미 만료됨 (즉시 갱신 필요)'
        : `${Math.max(0, Math.ceil((p.msRemaining ?? 0) / MS_PER_DAY))}일`;
      metaBlock = `<p><strong>JWT 만료일(한국 기준):</strong> ${expDateStr}</p>
      <p><strong>남은 일수:</strong> ${daysLeftLabel}</p>`;
    }
  } else if (p.expired && p.expMs != null) {
    const expDateStr = new Date(p.expMs).toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul'
    });
    subject = '🚨 [oy-stock] 올리브영 JWT 만료됨 — OY_REFRESH_COOKIE 즉시 갱신';
    headline = '🚨 OY_REFRESH_COOKIE / JWT 만료됨';
    metaBlock = `<p><strong>만료일(한국 기준):</strong> ${expDateStr}</p>
      <p><strong>남은 일수:</strong> 이미 만료됨 (즉시 갱신 필요)</p>`;
  } else {
    console.warn('[알림] sendLinkageExpiryAlert: 알 수 없는 유형 — 메일 생략');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: from, pass }
  });

  const html = `
      <h2>${headline}</h2>
      ${errorBlock}
      ${metaBlock}
      ${RENEWAL_STEPS_HTML}
    `;

  try {
    await transporter.sendMail({
      from,
      to,
      subject,
      html
    });
    console.log('[알림] 알림 메일 발송 완료 →', to);
  } catch (e) {
    console.error('[알림] 메일 발송 실패:', e.message || e);
  }
}

async function triggerVercelRedeploy() {
  const hookUrl = (process.env.VERCEL_DEPLOY_HOOK || '').trim();
  if (!hookUrl) {
    console.log('[재배포] VERCEL_DEPLOY_HOOK 미설정 — 수동 재배포 필요');
    console.log('         Vercel Dashboard → Settings → Git → Deploy Hooks 에서 생성 후');
    console.log('         GitHub Secret VERCEL_DEPLOY_HOOK 에 URL 저장하세요.');
    return false;
  }
  console.log('3) Vercel 재배포 트리거…');
  const r = await fetch(hookUrl, { method: 'POST' });
  if (!r.ok) {
    const t = await r.text();
    console.error('[재배포 실패]', r.status, t);
    return false;
  }
  console.log('[재배포] Vercel 빌드 시작됨 — 1~2분 후 반영됩니다.');
  return true;
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
    await sendLinkageExpiryAlert({ noLinkageString: true });
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

  /** @type {{ expMs: number, msRemaining: number, expired: boolean } | null} */
  let jwtAlertCtx = null;

  if (payload.exp != null) {
    const nowSec = Date.now() / 1000;
    const expSec = payload.exp;
    const expMs = expSec * 1000;
    const expired = expSec <= nowSec;
    const msRemaining = expMs - Date.now();

    jwtAlertCtx = { expMs, msRemaining, expired };

    console.log('JWT 만료:', new Date(expMs).toLocaleString());
    console.log(
      '남은 시간:',
      Math.round((expSec - nowSec) / 3600),
      '시간'
    );

    if (expired) {
      await sendLinkageExpiryAlert({ expired: true, expMs, msRemaining });
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
    const em = e.message || String(e);
    console.error('[실패]', em);
    await sendLinkageExpiryAlert({
      vercelError: em,
      ...(jwtAlertCtx || {})
    });
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
    const em = `일치하는 env 없음. Vercel Project에 ${ENV_KEY} 추가 후 재실행`;
    console.error('[실패]', em);
    await sendLinkageExpiryAlert({
      vercelError: em,
      ...(jwtAlertCtx || {})
    });
    process.exit(1);
  }

  for (const e of toPatch) {
    try {
      console.log('   PATCH', e.target, e.id, '…');
      await vercelPatchEnv(projectId, e.id, linkageHex, token, teamId);
      console.log('   [성공]', e.target, e.id);
    } catch (err) {
      const em = err.message || String(err);
      console.error('   [실패]', e.target, e.id, em);
      await sendLinkageExpiryAlert({
        vercelError: `${e.target} / ${e.id}: ${em}`,
        ...(jwtAlertCtx || {})
      });
      process.exit(1);
    }
  }

  console.log('[완료] OLIVEYOUNG_LINKAGE_STRING Vercel 환경변수 반영 완료.');

  const redeployed = await triggerVercelRedeploy();
  if (!redeployed) {
    console.log('[안내] 환경변수만 갱신됨. 실제 적용하려면 Vercel 재배포가 필요합니다.');
  }
}

main().catch((err) => {
  console.error('[실패]', err);
  process.exit(1);
});
