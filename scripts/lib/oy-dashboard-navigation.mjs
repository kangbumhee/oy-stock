const DASHBOARD_URL = 'https://m.oliveyoung.co.kr/m/mtn/affiliate/dashboard';

function assertTrustedHost(value) {
  let url;
  try { url = new URL(value); } catch { /* Fail closed below. */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname === 'oliveyoung.co.kr' || url.hostname.endsWith('.oliveyoung.co.kr'))) {
    throw Object.assign(new Error('UNTRUSTED_HOST'), { code: 'UNTRUSTED_HOST' });
  }
}

// Runs inside the page. Return a fixed classification only, never body text,
// form values, cookies, or challenge metadata. This is readiness, not login proof.
export function inspectDashboardDocument() {
  const url = new URL(location.href);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname === 'oliveyoung.co.kr' || url.hostname.endsWith('.oliveyoung.co.kr'))) return 'unknown';
  const visible = element => !!element && element.isConnected &&
    element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' &&
    getComputedStyle(element).display !== 'none';
  if (!visible(document.body)) return 'unknown';
  const text = (document.body.innerText || '').trim();
  if (!text || /error|access\s*denied|service\s*unavailable|오류/i.test(document.title || '') ||
      /general\s*error|access\s*denied|service\s*unavailable|temporarily\s*unavailable|ERR_[A-Z_]+/i.test(text) ||
      /요청하신\s*(?:페이지|서비스).{0,30}(?:없|불가|오류)|서비스.{0,25}(?:점검|이용할 수 없)/.test(text)) return 'unknown';
  const challenge = [...document.querySelectorAll(
    '#cloudflare-captcha, .cf-turnstile, iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]'
  )].some(visible);
  if (challenge || /보안\s*문자|자동\s*입력\s*방지|로봇이\s*아닙니다|verify you are human|checking your browser/i.test(text)) return 'challenge';
  if (/\/(?:login(?:\/|$)|members\/login)/i.test(url.pathname)) {
    const loginForm = [...document.forms].some(form =>
      [...form.querySelectorAll('input[name="loginId"], input#loginId, input[autocomplete="username"]')].some(visible) &&
      [...form.querySelectorAll('input[type="password"]')].some(visible));
    if (loginForm && /로그인/.test(text)) return 'login';
  }
  if (url.hostname === 'm.oliveyoung.co.kr' && url.pathname === '/m/mtn/affiliate/apply' &&
      [...document.querySelectorAll('button, a, [role="button"]')].some(element =>
        visible(element) && element.textContent?.trim() === '큐레이터 활동 시작하기')) return 'activation';
  if (url.hostname === 'm.oliveyoung.co.kr' && url.pathname === '/m/mtn/affiliate/dashboard' &&
      /쇼핑\s*큐레이터|큐레이터\s*대시보드/.test(text) &&
      /수익금|누적\s*수익|판매\s*실적|정산\s*예정|링크\s*생성|링크\s*만들기/.test(text)) return 'dashboard';
  return 'unknown';
}

export async function navigateDashboard(page) {
  // Navigation must actually commit. A network failure, HTTP outage, or security
  // redirect never becomes a successful read just because old cookies exist.
  const response = await page.goto(DASHBOARD_URL, { waitUntil: 'commit', timeout: 25000 });
  assertTrustedHost(page.url());
  if (!response) throw Object.assign(new Error('CURATOR_DASHBOARD_NOT_CONFIRMED'), { code: 'CURATOR_DASHBOARD_NOT_CONFIRMED' });
  const status = response.status();
  if (status === 408 || status === 429 || status >= 500) {
    throw Object.assign(new Error('DASHBOARD_TEMPORARILY_UNAVAILABLE'), { code: 'DASHBOARD_TEMPORARILY_UNAVAILABLE' });
  }
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
    assertTrustedHost(page.url());
  } catch (error) {
    // Only a post-commit DOM event timeout may use the already visible document.
    // All existing downstream login/challenge/cookie checks still run unchanged.
    if (error?.name !== 'TimeoutError') throw error;
    const url = page.url();
    assertTrustedHost(url);
    let timer;
    let kind;
    try {
      kind = await Promise.race([
        page.evaluate(inspectDashboardDocument),
        new Promise(resolve => { timer = setTimeout(() => resolve('unknown'), 3000); })
      ]);
    } catch { throw error; }
    finally { clearTimeout(timer); }
    assertTrustedHost(page.url());
    if (page.url() !== url || !['dashboard', 'login', 'challenge', 'activation'].includes(kind)) throw error;
  }
  return response;
}
