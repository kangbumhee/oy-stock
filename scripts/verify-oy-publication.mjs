import { pathToFileURL } from 'node:url';
import { extractLinkageHex, jwtExpFromLinkageHex } from './lib/cookie-extractor.mjs';

const CHECK_URL = 'https://olivestock.co.kr/api/oliveyoung/landing-proxy?check=1';

// Compare against the token being published, not merely any unexpired deployment.
// Never print the cookie, JWT, or the response's account subject.
export async function waitForPublishedAuth(expectedExpiry, {
  fetchImpl = fetch, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 12 * 60 * 1000, intervalMs = 15000,
} = {}) {
  if (!Number.isFinite(expectedExpiry) || expectedExpiry <= now() / 1000 + 60) {
    throw new Error('OY_PUBLICATION_TOKEN_INVALID');
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const response = await fetchImpl(CHECK_URL, {
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      const payload = response.ok ? await response.json() : null;
      if (payload?.jwtValid === true && Number.isFinite(payload.jwtExpSeconds)
        && payload.jwtExpSeconds >= expectedExpiry && payload.jwtExpSeconds > now() / 1000 + 60) {
        return { published: true, expiresAt: new Date(payload.jwtExpSeconds * 1000).toISOString() };
      }
    } catch { /* A deployment may be switching; retry without exposing response data. */ }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  throw new Error('OY_PUBLICATION_NOT_CONFIRMED');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const exp = jwtExpFromLinkageHex(extractLinkageHex(process.env.OY_REFRESH_COOKIE));
    const result = await waitForPublishedAuth(exp);
    console.log(`OY_PUBLICATION_CONFIRMED expiresAt=${result.expiresAt}`);
  } catch {
    console.error('OY_PUBLICATION_NOT_CONFIRMED');
    process.exitCode = 1;
  }
}
