/**
 * landing-proxy ?check=1 로 갱신·배포 후 JWT 상태 검증
 */

const DEFAULT_CHECK_URL =
  'https://oy-stock.vercel.app/api/oliveyoung/landing-proxy?check=1';

export async function verifyLandingProxy() {
  const url = (process.env.LANDING_PROXY_CHECK_URL || '').trim() || DEFAULT_CHECK_URL;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();

    const jwtValid = data.jwtValid === true;
    const selectedSource = data.selectedSource || '';

    return {
      ok: jwtValid && !!selectedSource,
      selectedSource: selectedSource || 'N/A',
      jwtValid: data.jwtValid ?? false,
      expiry: data.jwtExp || 'unknown'
    };
  } catch (err) {
    return {
      ok: false,
      selectedSource: 'ERROR',
      jwtValid: false,
      expiry: 'fetch failed: ' + err.message
    };
  }
}
