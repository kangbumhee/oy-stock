/**
 * additionalInfo.do?refreshYn=Y 로 새 linkageString(hex) 받은 뒤
 * Vercel 프로젝트의 OLIVEYOUNG_LINKAGE_STRING 값을 PATCH.
 *
 * GitHub Secrets (또는 로컬 env):
 *   OY_REFRESH_COOKIE — 권장: Cookie 헤더 전체 (OYSESSIONID=…; linkageString=…; …)
 *   또는 OY_SESSION_ID + OY_LINKAGE_STRING — 위와 같이 조합
 *   VERCEL_TOKEN — https://vercel.com/account/tokens
 *   VERCEL_PROJECT_ID — Project Settings → General
 *   VERCEL_TEAM_ID — (선택) 팀 프로젝트일 때만
 */

const REFRESH_URL =
  'https://m.oliveyoung.co.kr/m/login/additionalInfo.do?refreshYn=Y';
const ENV_KEY = 'OLIVEYOUNG_LINKAGE_STRING';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

function parseLinkageFromResponse(res) {
  const lines = [];
  if (typeof res.headers.getSetCookie === 'function') {
    lines.push(...res.headers.getSetCookie());
  } else {
    const single = res.headers.get('set-cookie');
    if (single) lines.push(single);
  }
  for (const line of lines) {
    const m = /linkageString=([^;]+)/i.exec(line);
    if (m) {
      try {
        return decodeURIComponent(m[1].trim());
      } catch {
        return m[1].trim();
      }
    }
  }
  return null;
}

async function refreshLinkage(cookie) {
  const r = await fetch(REFRESH_URL, {
    method: 'GET',
    headers: {
      Cookie: cookie,
      'User-Agent': UA,
      Accept: '*/*'
    },
    redirect: 'manual'
  });
  const hex = parseLinkageFromResponse(r);
  if (!hex) {
    console.error('Set-Cookie에 linkageString 없음. status=', r.status);
    return null;
  }
  return hex;
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
  const cookie = buildCookie();
  if (!cookie) {
    console.error(
      'OY_REFRESH_COOKIE 또는 (OY_SESSION_ID + OY_LINKAGE_STRING) 필요'
    );
    process.exit(1);
  }

  const token = (process.env.VERCEL_TOKEN || '').trim();
  const projectId = (process.env.VERCEL_PROJECT_ID || '').trim();
  const teamId = (process.env.VERCEL_TEAM_ID || '').trim();

  if (!token || !projectId) {
    console.error('VERCEL_TOKEN, VERCEL_PROJECT_ID 필요');
    process.exit(1);
  }

  console.log('1) additionalInfo 로 linkageString 갱신…');
  const newHex = await refreshLinkage(cookie);
  if (!newHex) {
    process.exit(1);
  }
  console.log('   새 linkageString 길이:', newHex.length);

  console.log('2) Vercel에서', ENV_KEY, '항목 조회…');
  const list = await vercelListEnv(projectId, token, teamId);
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
      '일치하는 env 없음. Vercel Project에',
      ENV_KEY,
      '를 추가한 뒤 다시 실행하세요.'
    );
    process.exit(1);
  }

  for (const e of toPatch) {
    console.log('   PATCH', e.target, e.id);
    await vercelPatchEnv(projectId, e.id, newHex, token, teamId);
  }

  console.log('완료. Vercel에 재배포 없이 다음 요청부터 새 값이 적용됩니다.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
