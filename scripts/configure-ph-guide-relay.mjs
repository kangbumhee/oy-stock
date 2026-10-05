// Explicit, manual setup only. Never enumerate/decrypt existing Vercel env values.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ID = 'prj_Sj0zepEyW8AB3956ssl7zx163DOP';
export const TEAM_ID = 'team_kCYpXTZeNpSxqcelRRUUSUKy';
export const SITE_ORIGIN = 'https://ph-pro-guide.kbhjjan100.chatgpt.site';
export const ENV_KEYS = Object.freeze(['PH_GUIDE_RELAY_SECRET', 'PH_GUIDE_SITE_ORIGIN']);

class SetupError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

export async function configureRelay(env, dependencies = {}) {
  const token = env.VERCEL_TOKEN;
  const secret = env.PH_GUIDE_RELAY_SECRET;
  if (env.VERCEL_PROJECT_ID !== PROJECT_ID || typeof token !== 'string' || !token ||
      /[\x00-\x20\x7f]/.test(token) || typeof secret !== 'string' ||
      secret.length < 32 || secret.length > 2048 || /[\x00-\x20\x7f]/.test(secret)) {
    throw new SetupError('invalid_configuration');
  }
  const entries = [
    { key: ENV_KEYS[0], value: secret, type: 'sensitive', target: ['production'] },
    { key: ENV_KEYS[1], value: SITE_ORIGIN, type: 'plain', target: ['production'] }
  ];
  const url = new URL(`https://api.vercel.com/v10/projects/${PROJECT_ID}/env`);
  url.searchParams.set('teamId', TEAM_ID);
  url.searchParams.set('upsert', 'true');
  let response;
  try {
    response = await (dependencies.fetch || fetch)(url.href, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(entries), signal: AbortSignal.timeout(30000), redirect: 'error'
    });
  } catch { throw new SetupError('vercel_unavailable'); }
  if (!response.ok) {
    const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status : undefined;
    throw new SetupError('vercel_rejected', status);
  }
  let result;
  try { result = await response.json(); } catch { throw new SetupError('vercel_invalid_response'); }
  // Provider responses can include values. Only inspect success metadata; never log the body.
  if (!result || typeof result !== 'object' || result.error || result.errors?.length || result.failed?.length) {
    throw new SetupError('vercel_update_failed');
  }
  const created = Array.isArray(result.created) ? result.created : result.created ? [result.created] : [];
  const saved = new Set(created.filter(entry => entry && ENV_KEYS.includes(entry.key) &&
    Array.isArray(entry.target) && entry.target.length === 1 && entry.target[0] === 'production')
    .map(entry => entry.key));
  if (!ENV_KEYS.every(key => saved.has(key))) throw new SetupError('vercel_update_incomplete');
  return { savedKeys: [...ENV_KEYS], target: 'production' };
}

export async function runConfigureRelay(env, dependencies = {}) {
  const log = dependencies.log || console.log;
  const errorLog = dependencies.errorLog || console.error;
  try {
    await configureRelay(env, dependencies);
    log('PH relay: two production environment variables saved. Other environment variable keys were not enumerated or written.');
    return 0;
  } catch (error) {
    const safe = error instanceof SetupError ? error.code : 'configuration_failed';
    errorLog(`PH relay setup failed: ${safe}${error instanceof SetupError && error.status ? ` (HTTP ${error.status})` : ''}.`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runConfigureRelay(process.env);
}
