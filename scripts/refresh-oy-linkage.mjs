/**
 * additionalInfo.do 는 403 등으로 막힐 수 있어, OY_REFRESH_COOKIE(또는 조합 쿠키)에 있는
 * linkageString(hex)를 그대로 읽어 AES 복호화 → JWT exp 확인 후
 * 같은 세션에서 Vercel/Cloud Run의 모든 큐레이터 인증 별칭을 함께 갱신한다.
 *
 * ALERT_EMAIL_* 설정 시 Gmail SMTP 알림:
 *   - Vercel PATCH 성공 → 메일 없음 (정상 갱신 완료)
 *   - linkageString 없음 / JWT 만료 / Vercel 실패 → 메일 발송
 *
 * GitHub Secrets (또는 로컬 env):
 *   OY_REFRESH_COOKIE — 필수: OYSESSIONID와 linkageString을 포함한 Cookie 헤더
 *   OLIVEYOUNG_AFFILIATE_REGISTER_ID — 지정되면 같은 게시에 포함
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
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import nodemailer from 'nodemailer';
import { redeployProduction } from './lib/oy-vercel-redeploy.mjs';

const LINKAGE_AES_KEY = Buffer.from('cjone_g4de7353f1', 'utf8');
const MS_PER_DAY = 86400000;
const runFile = promisify(execFile);

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function uniqueCookieValue(cookie, name) {
  const values = cookie.split(';').map(part => part.trim()).filter(part => {
    const separator = part.indexOf('=');
    return separator > 0 && part.slice(0, separator).toLowerCase() === name.toLowerCase();
  }).map(part => part.slice(part.indexOf('=') + 1).trim());
  if (values.length !== 1 || !values[0]) throw new Error('OY_AUTH_COOKIE_INVALID');
  return values[0];
}

/** Never mix an older alias into a newly published canonical session. */
export function buildAuthPublicationEnv(env = process.env, { now = Date.now() } = {}) {
  const cookie = String(env.OY_REFRESH_COOKIE || '').trim();
  if (!cookie || /[\r\n\0]/.test(cookie)) throw new Error('OY_AUTH_COOKIE_INVALID');
  const sessionId = uniqueCookieValue(cookie, 'OYSESSIONID');
  let linkageHex;
  try { linkageHex = decodeURIComponent(uniqueCookieValue(cookie, 'linkageString')); }
  catch { throw new Error('OY_AUTH_COOKIE_INVALID'); }
  if (!/^(?:[a-f\d]{2})+$/i.test(linkageHex)) throw new Error('OY_AUTH_LINKAGE_INVALID');
  let jwt;
  try { jwt = decryptLinkageString(linkageHex); }
  catch { throw new Error('OY_AUTH_LINKAGE_INVALID'); }
  const payload = decodeJwtPayload(jwt);
  if (jwt.split('.').length !== 3 || !payload || !Number.isFinite(payload.exp) || payload.exp <= now / 1000 + 60) {
    throw new Error('OY_AUTH_TOKEN_INVALID');
  }
  const values = {
    OY_REFRESH_COOKIE: cookie,
    OY_CURATOR_COOKIE: cookie,
    OY_SESSION_ID: sessionId,
    OY_LINKAGE_STRING: linkageHex,
    OY_LINKAGE_JWT: jwt,
    OLIVEYOUNG_LINKAGE_STRING: linkageHex,
    OLIVEYOUNG_LINKAGE_JWT: jwt
  };
  const partnerId = String(env.OLIVEYOUNG_AFFILIATE_REGISTER_ID || '').trim();
  if (partnerId) {
    if (!/^[a-f\d]{32}$/i.test(partnerId)) throw new Error('OY_AUTH_PARTNER_INVALID');
    values.OLIVEYOUNG_AFFILIATE_REGISTER_ID = partnerId;
  }
  return values;
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
    console.error('[알림] 메일 발송 실패');
  }
}

function teamQs(teamId) {
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
}

async function vercelListEnv(projectId, token, teamId, fetchImpl) {
  const url = `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}/env${teamQs(teamId)}`;
  const r = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) {
    throw new Error('OY_AUTH_VERCEL_LIST_FAILED');
  }
  return r.json();
}

async function vercelPatchEnv(projectId, envRecordId, value, token, teamId, fetchImpl) {
  const url = `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envRecordId)}${teamQs(teamId)}`;
  const r = await fetchImpl(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ value })
  });
  if (!r.ok) {
    throw new Error('OY_AUTH_VERCEL_UPDATE_FAILED');
  }
}

async function vercelCreateEnv(projectId, key, value, targets, token, teamId, fetchImpl) {
  const url = `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/env${teamQs(teamId)}`;
  const r = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([
      {
        key,
        value,
        type: 'encrypted',
        target: targets
      }
    ])
  });
  if (!r.ok) {
    throw new Error('OY_AUTH_VERCEL_UPDATE_FAILED');
  }
}

function envTargets(record) {
  if (!record) return [];
  if (Array.isArray(record.target)) return record.target.map(String);
  return record.target ? [String(record.target)] : [];
}

function matchesTarget(record, targetFilter) {
  if (!targetFilter.length) return true;
  const targets = envTargets(record);
  return targets.some((target) => targetFilter.includes(target));
}

async function upsertVercelEnv(projectId, envs, key, value, targetFilter, token, teamId, fetchImpl, log) {
  let toPatch = (Array.isArray(envs) ? envs : []).filter(
    (e) => e && e.key === key && matchesTarget(e, targetFilter)
  );

  if (toPatch.length === 0) {
    const targets = targetFilter.length ? targetFilter : ['production'];
    await vercelCreateEnv(projectId, key, value, targets, token, teamId, fetchImpl);
    log(`[auth] ${key} created`);
    return;
  }

  for (const e of toPatch) {
    await vercelPatchEnv(projectId, e.id, value, token, teamId, fetchImpl);
    log(`[auth] ${key} updated`);
  }
}

export async function publishVercelAuth(values, { token, projectId, teamId = '', targets = [] }, {
  fetchImpl = fetch, log = console.log
} = {}) {
  if (!token || !projectId) throw new Error('OY_AUTH_VERCEL_CONFIG_INVALID');
  try {
    const list = await vercelListEnv(projectId, token, teamId, fetchImpl);
    const envs = list.envs || list;
    for (const [key, value] of Object.entries(values)) {
      await upsertVercelEnv(projectId, envs, key, value, targets, token, teamId, fetchImpl, log);
    }
  } catch {
    // Provider errors can echo submitted secrets; never propagate their body or stack.
    throw new Error('OY_AUTH_VERCEL_PUBLICATION_FAILED');
  }
}

export async function publishCloudRunAuth(values, { projectId, region = 'asia-northeast3', service = 'oy-stock-api' }, {
  runCommand = runFile, tempRoot = process.env.RUNNER_TEMP || os.tmpdir()
} = {}) {
  if (!projectId) throw new Error('OY_AUTH_CLOUD_RUN_CONFIG_INVALID');
  const directory = await mkdtemp(path.join(tempRoot, 'oy-auth-publication-'));
  try {
    const flagsPath = path.join(directory, 'flags.json');
    // --update-env-vars preserves unrelated service settings. A private flags file
    // keeps cookies/JWTs out of argv and avoids delimiter corruption in Cookie headers.
    await writeFile(flagsPath, JSON.stringify({ '--update-env-vars': values }), { mode: 0o600 });
    await runCommand('gcloud', [
      'run', 'services', 'update', service,
      '--region', region, '--project', projectId,
      '--flags-file', flagsPath, '--quiet', '--verbosity', 'error'
    ], {
      env: { ...process.env, CLOUDSDK_CORE_DISABLE_FILE_LOGGING: '1' },
      encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024
    });
  } catch {
    throw new Error('OY_AUTH_CLOUD_RUN_PUBLICATION_FAILED');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const values = buildAuthPublicationEnv();
  if (process.argv.includes('--cloud-run')) {
    await publishCloudRunAuth(values, { projectId: (process.env.GCP_PROJECT_ID || '').trim() });
    console.log('[완료] Cloud Run 큐레이터 인증 별칭 반영 완료.');
    return;
  }
  const token = (process.env.VERCEL_TOKEN || '').trim();
  const projectId = (process.env.VERCEL_PROJECT_ID || '').trim();
  const teamId = (process.env.VERCEL_TEAM_ID || '').trim();
  const targets = (process.env.VERCEL_ENV_TARGETS || '').split(',').map(value => value.trim()).filter(Boolean);
  await publishVercelAuth(values, { token, projectId, teamId, targets });
  console.log('[완료] Vercel 큐레이터 인증 별칭 반영 완료.');

  let redeployed = false;
  if (process.env.SKIP_VERCEL_DEPLOY_HOOK !== '1') {
    const deployment = await redeployProduction({ token, projectId, teamId });
    console.log(`[재배포] 현재 운영 버전으로 인증 갱신 빌드 시작: ${deployment.id}`);
    redeployed = true;
  }
  if (!redeployed) {
    console.log('[안내] 환경변수만 갱신됨. 실제 적용하려면 Vercel 재배포가 필요합니다.');
    if (process.env.SKIP_VERCEL_DEPLOY_HOOK !== '1') {
      throw new Error('OY_PUBLICATION_DEPLOY_FAILED');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async error => {
    const code = /^OY_AUTH_[A-Z_]+$/.test(error?.message || '') ? error.message : 'OY_AUTH_PUBLICATION_FAILED';
    console.error('[실패]', code);
    await sendLinkageExpiryAlert({ vercelError: code });
    process.exitCode = 1;
  });
}
