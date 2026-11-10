const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const modulePromise = import('../scripts/lib/oy-dashboard-navigation.mjs');
const DASHBOARD = 'https://m.oliveyoung.co.kr/m/mtn/affiliate/dashboard';
const timeout = () => Object.assign(new Error('synthetic navigation timeout'), { name: 'TimeoutError' });

function element(textContent = '', shown = true) {
  return { isConnected: true, textContent, shown, getClientRects: () => shown ? [{}] : [] };
}

function documentPage(inspect, fixture = {}) {
  const { url = DASHBOARD, title = '올리브영', text = '쇼핑 큐레이터\n누적 수익금', login = false,
    challenge = false, activation = false, shown = true } = fixture;
  const user = element(), password = element();
  const form = { querySelectorAll: selector => selector.includes('password') ? [password] : [user] };
  const body = Object.assign(element('', shown), { innerText: text });
  return vm.runInNewContext(`(${inspect.toString()})()`, {
    URL, location: { href: url }, getComputedStyle: node => ({ visibility: node.shown ? 'visible' : 'hidden', display: 'block' }),
    document: { body, title, forms: login ? [form] : [], querySelectorAll: selector =>
      selector.includes('cloudflare') ? (challenge ? [element()] : []) : (activation ? [element('큐레이터 활동 시작하기')] : []) }
  });
}

function pageFixture({ status = 200, domError, commitError, kind = 'dashboard', url = DASHBOARD, afterInspectUrl } = {}) {
  const calls = [];
  let currentUrl = url;
  const response = { status: () => status };
  const page = {
    calls, response, url: () => currentUrl,
    async goto(target, options) { calls.push(['goto', target, options]); if (commitError) throw commitError; return response; },
    async waitForLoadState(state, options) { calls.push(['wait', state, options]); if (domError) throw domError; },
    async evaluate(inspect) { calls.push(['inspect', typeof inspect]); if (afterInspectUrl) currentUrl = afterInspectUrl; return kind; }
  };
  return page;
}

test('a normally loaded dashboard needs a committed response and bounded DOM readiness', async () => {
  const { navigateDashboard } = await modulePromise;
  const page = pageFixture();
  assert.equal(await navigateDashboard(page), page.response);
  assert.deepEqual(page.calls, [
    ['goto', DASHBOARD, { waitUntil: 'commit', timeout: 25000 }],
    ['wait', 'domcontentloaded', { timeout: 10000 }]
  ]);
});

test('only a post-commit DOM timeout can continue to existing authentication checks', async () => {
  const { navigateDashboard } = await modulePromise;
  for (const kind of ['dashboard', 'login', 'challenge', 'activation']) {
    const page = pageFixture({ domError: timeout(), kind });
    assert.equal(await navigateDashboard(page), page.response);
    assert.equal(page.calls.filter(call => call[0] === 'goto').length, 1, 'do not restart a committed navigation');
    assert.equal(page.calls.filter(call => call[0] === 'inspect').length, 1);
  }
});

test('network, commit timeouts, HTTP throttling and server errors never use DOM fallback', async () => {
  const { navigateDashboard } = await modulePromise;
  for (const commitError of [timeout(), new Error('net::ERR_CONNECTION_RESET')]) {
    const page = pageFixture({ commitError });
    await assert.rejects(navigateDashboard(page), error => error === commitError);
    assert.equal(page.calls.length, 1);
  }
  for (const status of [408, 429, 500, 501, 502, 503, 504, 505]) {
    const page = pageFixture({ status });
    await assert.rejects(navigateDashboard(page), { code: 'DASHBOARD_TEMPORARILY_UNAVAILABLE' });
    assert.equal(page.calls.length, 1);
  }
  const error = new Error('page is navigating');
  const page = pageFixture({ domError: error });
  await assert.rejects(navigateDashboard(page), failure => failure === error);
  assert.equal(page.calls.some(call => call[0] === 'inspect'), false);
});

test('unknown, failed or changing documents cannot turn a timeout into success', async () => {
  const { navigateDashboard } = await modulePromise;
  const error = timeout();
  for (const kind of ['unknown', '', null, 'authenticated']) {
    await assert.rejects(navigateDashboard(pageFixture({ domError: error, kind })), failure => failure === error);
  }
  const page = pageFixture({ domError: error });
  page.evaluate = async () => { throw new Error('execution context destroyed'); };
  await assert.rejects(navigateDashboard(page), failure => failure === error);
  await assert.rejects(navigateDashboard(pageFixture({ domError: error, afterInspectUrl: DASHBOARD + '?navigating=1' })), failure => failure === error);
});

test('untrusted redirects are rejected before and after readiness inspection', async () => {
  const { navigateDashboard } = await modulePromise;
  for (const url of ['about:blank', 'https://oliveyoung.co.kr.attacker.test/', 'http://m.oliveyoung.co.kr/',
    'https://owner:password@m.oliveyoung.co.kr/', 'https://m.oliveyoung.co.kr:444/']) {
    const page = pageFixture({ url, domError: timeout() });
    await assert.rejects(navigateDashboard(page), { code: 'UNTRUSTED_HOST' });
    assert.equal(page.calls.length, 1);
  }
  await assert.rejects(navigateDashboard(pageFixture({ domError: timeout(), afterInspectUrl: 'https://attacker.test/' })), { code: 'UNTRUSTED_HOST' });
});

test('visible dashboard, login, challenge and activation evidence receive fixed classifications', async () => {
  const { inspectDashboardDocument } = await modulePromise;
  const fixtures = [
    [{}, 'dashboard'],
    [{ url: 'https://www.oliveyoung.co.kr/store/login/loginForm.do', text: '올리브영 로그인', login: true }, 'login'],
    [{ text: '보안 문자 입력이 필요합니다.', challenge: true }, 'challenge'],
    [{ url: 'https://m.oliveyoung.co.kr/m/mtn/affiliate/apply', text: '쇼핑 큐레이터\n큐레이터 활동 시작하기', activation: true }, 'activation']
  ];
  for (const [fixture, kind] of fixtures) assert.equal(documentPage(inspectDashboardDocument, fixture), kind);
});

test('blank, hidden, generic, error and spoofed documents fail closed despite matching cookies or URL', async () => {
  const { inspectDashboardDocument } = await modulePromise;
  const fixtures = [
    { text: '' }, { shown: false }, { text: '올리브영' }, { text: '쇼핑 큐레이터' },
    { text: '수익금' }, { title: 'General Error' }, { title: '오류' },
    { text: '쇼핑 큐레이터 수익금 Service Unavailable' },
    { text: '쇼핑 큐레이터 수익금 서비스 점검 중입니다' },
    { url: 'https://www.oliveyoung.co.kr/store/main/main.do' },
    { url: 'https://oliveyoung.co.kr.attacker.test/m/mtn/affiliate/dashboard' },
    { url: 'https://www.oliveyoung.co.kr/store/login/loginForm.do', text: '로그인', login: false },
    { url: 'https://m.oliveyoung.co.kr/m/mtn/affiliate/apply', text: '큐레이터 활동 시작하기', activation: false }
  ];
  for (const fixture of fixtures) assert.equal(documentPage(inspectDashboardDocument, fixture), 'unknown', JSON.stringify(fixture));
});
