/**
 * Secret / Vercel env 갱신 (원문 로그 금지)
 *
 * GitHub: gh CLI stdin (암호화는 gh가 처리)
 * Vercel: REST API (refresh-oy-linkage.mjs와 동일 패턴)
 */

import { spawnSync } from 'child_process';
import {
  extractLinkageHex,
  jwtExpFromLinkageHex
} from './cookie-extractor.mjs';

const ENV_KEY = 'OLIVEYOUNG_LINKAGE_STRING';

export async function readSecrets() {
  const username = (process.env.OY_USERNAME || '').trim();
  const password = (process.env.OY_PASSWORD || '').trim();
  const currentCookie = (process.env.OY_REFRESH_COOKIE || '').trim();

  if (!username || !password) {
    throw new Error('OY_USERNAME 또는 OY_PASSWORD 환경변수가 없습니다.');
  }

  let currentJwtExp = null;
  const hex = extractLinkageHex(currentCookie);
  if (hex) {
    currentJwtExp = jwtExpFromLinkageHex(hex);
  }

  return { username, password, currentCookie, currentJwtExp };
}

function githubRepoSlug() {
  const explicit =
    (process.env.GITHUB_REPO || '').trim() ||
    (process.env.GITHUB_REPOSITORY || '').trim();
  if (explicit) return explicit;

  const remote = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
    encoding: 'utf8'
  });
  const url = (remote.stdout || '').trim();
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  return m ? `${m[1]}/${m[2]}` : '';
}

export function githubRepoArgs() {
  const repo = githubRepoSlug();
  return repo ? ['--repo', repo] : [];
}

export async function updateGitHubSecret(name, value) {
  const args = ['secret', 'set', name];
  args.push(...githubRepoArgs());

  const r = spawnSync('gh', args, {
    input: value,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });

  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').trim() || `exit ${r.status}`;
    throw new Error(`gh secret set 실패: ${err}`);
  }

  console.log(`[INFO] GitHub Secret '${name}' 갱신됨 (값 미출력)`);
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

async function triggerVercelRedeploy() {
  const hookUrl = (process.env.VERCEL_DEPLOY_HOOK || '').trim();
  if (!hookUrl) {
    console.log('[재배포] VERCEL_DEPLOY_HOOK 미설정 — 배포 후 수동 확인 필요');
    return false;
  }
  console.log('[재배포] Vercel Deploy Hook 호출…');
  const r = await fetch(hookUrl, { method: 'POST' });
  if (!r.ok) {
    const t = await r.text();
    console.error('[재배포 실패]', r.status, t);
    return false;
  }
  console.log('[재배포] 빌드 요청됨 — 반영까지 1~2분 걸릴 수 있음');
  return true;
}

/**
 * @param {string} linkageHex linkageString 쿠키 값(hex)
 */
export async function updateVercelLinkageString(linkageHex) {
  const token = (process.env.VERCEL_TOKEN || '').trim();
  const projectId = (process.env.VERCEL_PROJECT_ID || '').trim();
  const teamId = (process.env.VERCEL_TEAM_ID || '').trim();

  if (!token || !projectId) {
    throw new Error('VERCEL_TOKEN, VERCEL_PROJECT_ID 가 필요합니다.');
  }

  let list;
  try {
    list = await vercelListEnv(projectId, token, teamId);
  } catch (e) {
    throw new Error(e.message || String(e));
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
    throw new Error(
      `일치하는 Vercel env 없음. 프로젝트에 ${ENV_KEY} 를 추가하세요.`
    );
  }

  for (const e of toPatch) {
    console.log(`[INFO] Vercel PATCH ${e.target} ${e.id} …`);
    await vercelPatchEnv(projectId, e.id, linkageHex, token, teamId);
    console.log(`[INFO] Vercel '${ENV_KEY}' (${e.target}) 갱신됨 (값 미출력)`);
  }

  await triggerVercelRedeploy();
}
