const test = require('node:test');
const assert = require('node:assert/strict');

function state(overrides = {}) {
  return {
    url: 'https://m.oliveyoung.co.kr/m/mtn/affiliate/dashboard', text: '', captchaDetected: false,
    cookies: { linkageHex: 'synthetic', oySessionId: 'synthetic', raw: 'synthetic' },
    exp: Date.now() / 1000 + 7200, ...overrides,
  };
}

test('only confirmed curator dashboard with usable cookies succeeds', async () => {
  const { assertUsableCookies, hasUsableCookies } = await import('../scripts/refresh-oy-cookie-from-profile.mjs');
  assert.equal(hasUsableCookies(state()), true);
  assert.doesNotThrow(() => assertUsableCookies(state()));
  for (const candidate of [
    state({ url: 'https://m.oliveyoung.co.kr/m/mtn/affiliate/apply' }),
    state({ text: '큐레이터 활동 시작하기' }),
    state({ url: 'https://www.oliveyoung.co.kr/store/login/loginForm.do' }),
    state({ captchaDetected: true }),
    state({ exp: Date.now() / 1000 + 30 }),
    state({ exp: null }),
    state({ cookies: {} }),
  ]) assert.throws(() => assertUsableCookies(candidate), { exitCode: 42 });
  assert.throws(() => assertUsableCookies(state({ url: 'https://m.oliveyoung.co.kr/m/other' })), /DASHBOARD_NOT_CONFIRMED/);
  assert.throws(() => assertUsableCookies(state({ title: 'General Error' })), /DASHBOARD_UNAVAILABLE/);
});
