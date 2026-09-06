const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

let browser, api, createCaptchaBudget;
const URL = 'https://www.oliveyoung.co.kr/store/login/loginForm.do';
const KEY = '0x123456789012345678901234567890';
const TOKEN = 'synthetic-provider-token-for-testing-only';
const config = { enabled: true, applyTimeoutMs: 1000, maxAttempts: 3, maxJobTasks: 12 };
const credentials = '<input name="loginId"><input type="password" name="password">';

before(async () => {
  api = await import('../scripts/lib/oy-captcha-dom.mjs');
  ({ createCaptchaBudget } = await import('../scripts/lib/oy-captcha-client.mjs'));
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });

async function fixture(html, { enabled = true } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.route('**/*', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await api.installCapture(page, { enabled });
  await page.goto(URL);
  return { page, context };
}

function standalone(extra = '') {
  return `<form id="login">${credentials}<div class="cf-turnstile" data-sitekey="${KEY}" style="width:150px;height:60px"></div><input type="hidden" name="cf-turnstile-response">${extra}</form>`;
}

function provider({ beforeCreate, beforePoll, beforeReturn, solution = { token: TOKEN } } = {}) {
  const calls = [];
  return {
    calls,
    async solve(task, hooks) {
      await beforeCreate?.();
      await hooks.beforeCreate();
      calls.push(task);
      await hooks.onTaskCreated(calls.length);
      await beforePoll?.();
      await hooks.beforePoll();
      await beforeReturn?.();
      await hooks.beforeReturn();
      return solution;
    },
  };
}

function solve(page, client, options = {}) {
  return api.solveChallenge(page, { client, config, budget: createCaptchaBudget(config), ...options });
}

test('trusted allowlist rejects lookalikes, HTTP, userinfo, and foreign domains', () => {
  for (const value of ['http://oliveyoung.co.kr', 'https://oliveyoung.co.kr.evil.test', 'https://evil.test', 'https://name@oliveyoung.co.kr', 'https://oliveyoung.co.kr:8443']) assert.equal(api.isTrustedOliveYoungURL(value), false);
  for (const value of [URL, 'https://oliveyoung.co.kr/', 'https://m.oliveyoung.co.kr/']) assert.equal(api.isTrustedOliveYoungURL(value), true);
});

test('standalone orchestration writes only current credential form and preserves native widget', async () => {
  const { page, context } = await fixture(`${standalone()}<form id="unrelated"><input name="cf-turnstile-response" type="hidden" value="untouched"></form>`);
  try {
    const client = provider();
    const budget = createCaptchaBudget(config);
    const result = await solve(page, client, { budget });
    assert.equal(result.providerApplied, true);
    assert.equal(result.clear, true);
    assert.equal(client.calls[0].type, 'TurnstileTaskProxyless');
    assert.equal(client.calls[0].websiteURL, URL);
    assert.equal(client.calls[0].websiteKey, KEY);
    assert.equal(await page.locator('#login [name="cf-turnstile-response"]').inputValue(), TOKEN);
    assert.equal(await page.locator('#unrelated input').inputValue(), 'untouched');
    assert.equal(await page.locator('.cf-turnstile').isVisible(), true);
    assert.equal(budget.canReserve(result.identity), true);
  } finally { await context.close(); }
});

test('ambiguous active response fields are not written and another form cannot disambiguate', async () => {
  const { page, context } = await fixture(standalone('<input type="hidden" name="cf-turnstile-response">'));
  try {
    const result = await solve(page, provider());
    assert.equal(result.reason, 'TOKEN_NOT_APPLIED');
    assert.deepEqual(await page.locator('[name="cf-turnstile-response"]').evaluateAll((fields) => fields.map((field) => field.value)), ['', '']);
  } finally { await context.close(); }
});

test('multiple visible credential forms leave widget pending without a paid task', async () => {
  const { page, context } = await fixture(`${standalone()}<form>${credentials}</form>`);
  try {
    const client = provider();
    const current = await api.inspectChallenge(page);
    assert.equal(current.detected, true);
    assert.equal(current.pending, true);
    assert.equal(current.type, 'unknown');
    const result = await solve(page, client);
    assert.equal(result.reason, 'NO_DESCRIPTOR');
    assert.equal(client.calls.length, 0);
  } finally { await context.close(); }
});

test('external redirect after descriptor extraction is blocked before any provider task', async () => {
  const { page, context } = await fixture(standalone());
  try {
    const client = provider({ beforeCreate: () => page.goto('https://foreign.test/login') });
    const result = await solve(page, client);
    assert.equal(result.reason, 'UNTRUSTED_HOST');
    assert.equal(client.calls.length, 0);
  } finally { await context.close(); }
});

test('sitekey changes before polling or returned answer prevent stale writes', async () => {
  for (const phase of ['beforePoll', 'beforeReturn']) {
    const { page, context } = await fixture(standalone());
    try {
      const client = provider({ [phase]: () => page.locator('.cf-turnstile').evaluate((element) => element.dataset.sitekey = '0x999999999999999999999999999999') });
      const result = await solve(page, client);
      assert.equal(result.reason, 'CHALLENGE_CHANGED');
      assert.equal(await page.locator('[name="cf-turnstile-response"]').inputValue(), '');
    } finally { await context.close(); }
  }
});

test('render capture leaves standalone native rendering active and executes exact callback once', async () => {
  const { page, context } = await fixture(standalone());
  try {
    await page.evaluate(() => {
      window.nativeCount = 0; window.callbackCount = 0;
      window.turnstile = { render() { window.nativeCount++; return 'widget123'; } };
    });
    await page.waitForTimeout(30);
    await page.evaluate((key) => window.turnstile.render(document.querySelector('.cf-turnstile'), {
      sitekey: key, callback: async () => { window.callbackCount++; },
    }), KEY);
    assert.equal(await page.evaluate(() => window.nativeCount), 1);
    const result = await solve(page, provider());
    assert.equal(result.clear, true);
    assert.equal(await page.evaluate(() => window.callbackCount), 1);
    assert.equal(await api.releaseManaged(page), false);
    assert.equal(await page.evaluate(() => window.nativeCount), 1);
  } finally { await context.close(); }
});

async function oliveYoungLoginFixture() {
  const html = `<form id="formLogin">
    <input type="hidden" id="captchaYn" name="captchaYn">
    <input id="loginId" name="loginId">
    <input type="password" id="password" name="password" placeholder="8~12자">
    <p>정보 보호를 위해 아래 인증 절차를 진행해주세요.</p>
    <div id="cloudflare-captcha" class="auto-info-cloudflare" style="width:300px;height:65px"></div>
    <input type="hidden" id="cf-chl-widget-synthetic-login_response" name="cf-turnstile-response">
    <div id="captcha" class="img-brake-box" hidden>
      <canvas id="captchaImage" width="100" height="40"></canvas>
      <input id="autoBlockText" name="answer" disabled placeholder="자동입력방지문자를 입력해주세요">
    </div>
    <input type="checkbox" id="chk01" name="saveLoginIdYn">
    <button type="button">로그인</button>
  </form><script>
    window.nativeCount = 0;
    window.turnstile = { render(target) {
      window.nativeCount++;
      target.attachShadow({ mode: 'closed' }).appendChild(document.createElement('span'));
      return 'synthetic-login';
    } };
    setTimeout(() => window.turnstile.render(document.querySelector('#cloudflare-captcha'), {
      sitekey: '${KEY}', action: 'synthetic-private-action', cData: 'synthetic-private-challenge-data',
    }), 50);
  </script>`;
  const result = await fixture(html);
  await result.page.waitForFunction(() => window.nativeCount === 1);
  return result;
}

test('realistic formLogin associates captured closed-shadow widget despite disabled hidden image answer', async () => {
  const { page, context } = await oliveYoungLoginFixture();
  try {
    assert.deepEqual(await page.locator('#loginId').evaluate(input => ({ attribute: input.getAttribute('type'), type: input.type })), {
      attribute: null, type: 'text',
    });
    assert.equal(await page.locator('#autoBlockText').isEditable(), false);
    assert.equal(await page.locator('#autoBlockText').isVisible(), false);
    assert.equal(await page.locator('#cloudflare-captcha').getAttribute('data-sitekey'), null);
    assert.equal(await page.locator('#cloudflare-captcha').evaluate(element => element.shadowRoot === null), true);
    assert.equal(await page.locator('#formLogin iframe').count(), 0);

    const current = await api.inspectChallenge(page);
    assert.equal(current.type, 'turnstile');
    assert.equal(current.pending, true);
    assert.equal(current.managed, false);
    assert.equal(current.image, null);
    assert.equal(current.descriptor.websiteKey, KEY);
    assert.equal(current.descriptor.widgetId, 'synthetic-login');
    assert.ok(current.descriptor.formId);
    assert.ok(current.descriptor.elementId);
    assert.ok(current.descriptor.fieldId);

    const client = provider();
    const result = await solve(page, client);
    assert.equal(result.clear, true);
    assert.equal(result.providerApplied, true);
    assert.equal(client.calls.length, 1);
    assert.equal(await page.locator('#formLogin [name="cf-turnstile-response"]').inputValue(), TOKEN);
    assert.equal(await page.locator('#autoBlockText').inputValue(), '');
    assert.equal(await page.evaluate(() => window.nativeCount), 1);
  } finally { await context.close(); }
});

test('challenge diagnostics expose only counts and flags, never credentials, token or descriptor data', async () => {
  const { page, context } = await oliveYoungLoginFixture();
  try {
    const username = 'synthetic-private-login-user';
    const password = 'synthetic-private-login-password';
    await page.locator('#loginId').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('[name="cf-turnstile-response"]').evaluate((input, value) => { input.value = value; }, TOKEN);

    const diagnostics = await api.inspectChallengeDiagnostics(page);
    assert.deepEqual(diagnostics, {
      bridgeReady: true,
      credentialForms: 1,
      captures: 1,
      connectedCaptures: 1,
      validKeyCaptures: 1,
      managedCaptures: 0,
      visibleWidgetContainer: true,
      responseFields: 1,
      providerReady: true,
      captureFormAssociated: true,
    });
    assert.ok(Object.values(diagnostics).every(value => typeof value === 'number' || typeof value === 'boolean'));
    const serialized = JSON.stringify(diagnostics);
    for (const sensitive of [username, password, TOKEN, KEY, URL, 'synthetic-private-action', 'synthetic-private-challenge-data']) {
      assert.equal(serialized.includes(sensitive), false);
    }
    for (const field of ['descriptor', 'image', 'signature', 'response', 'token', 'websiteKey', 'data', 'pagedata']) {
      assert.equal(Object.hasOwn(diagnostics, field), false);
    }
  } finally { await context.close(); }
});

async function managedFixture() {
  const html = `<h1>Just a moment</h1><div id="challenge" style="width:150px;height:60px"></div><script>
    window.nativeCount = 0; window.callbackUA = '';
    window.turnstile = {render() {window.nativeCount++; return 'native';}};
    setTimeout(() => window.turnstile.render(document.querySelector('#challenge'), {
      sitekey: '${KEY}', action: 'managed', cData: 'synthetic-data', chlPageData: 'synthetic-page-data',
      callback() {window.callbackUA = navigator.userAgent; document.body.innerHTML = '<p>Login complete</p>';}
    }), 50);
  </script>`;
  const result = await fixture(html);
  await result.page.waitForTimeout(90);
  return result;
}

test('managed metadata preserved, native render held, provider UA applied and restored after clear', async () => {
  const { page, context } = await managedFixture();
  try {
    const originalUA = await page.evaluate(() => navigator.userAgent);
    const solverUA = 'Mozilla/5.0 Synthetic Captcha Testing Browser';
    assert.equal(await page.evaluate(() => window.nativeCount), 0);
    const client = provider({ solution: { token: TOKEN, userAgent: solverUA } });
    const result = await solve(page, client);
    assert.equal(result.providerApplied, true);
    assert.equal(result.clear, true);
    assert.equal(client.calls[0].action, 'managed');
    assert.equal(client.calls[0].data, 'synthetic-data');
    assert.equal(client.calls[0].pagedata, 'synthetic-page-data');
    assert.equal(await page.evaluate(() => window.callbackUA), solverUA);
    assert.equal(await page.evaluate(() => navigator.userAgent), originalUA);
  } finally { await context.close(); }
});

test('managed missing UA fails closed and native fallback reload occurs once', async () => {
  const { page, context } = await managedFixture();
  try {
    const result = await solve(page, provider());
    assert.equal(result.reason, 'MANAGED_UA_REQUIRED');
    assert.equal(result.providerApplied, false);
    assert.equal(await api.releaseManaged(page), true);
    await page.waitForTimeout(90);
    assert.equal(await page.evaluate(() => window.nativeCount), 1);
    assert.equal(await api.releaseManaged(page), false);
  } finally { await context.close(); }
});

test('managed callback rejection can retry but fulfillment is not called twice', async () => {
  const { page, context } = await managedFixture();
  try {
    await page.evaluate(() => {
      window.callbackCount = 0;
      const bridge = window.__oliveYoungTurnstileBridge;
      bridge.callbacks.set(bridge.captures.at(-1).captureId, async () => {
        window.callbackCount++;
        if (window.callbackCount === 1) throw new Error('synthetic rejection');
        document.body.innerHTML = '<p>Ready</p>';
      });
    });
    const client = provider({ solution: { token: TOKEN, userAgent: 'Mozilla/5.0 Synthetic Captcha Browser Test' } });
    const budget = createCaptchaBudget(config);
    const first = await solve(page, client, { budget });
    assert.equal(first.providerApplied, true);
    assert.equal(first.clear, false);
    assert.equal(await api.isProviderApplicationCurrent(page, first.identity), false);
    const second = await solve(page, client, { budget });
    assert.equal(second.clear, true);
    await solve(page, client, { budget });
    assert.equal(await page.evaluate(() => window.callbackCount), 2);
    assert.equal(client.calls.length, 2);
  } finally { await context.close(); }
});

test('managed abort after provider UA application always restores original UA', async () => {
  const { page, context } = await managedFixture();
  try {
    const originalUA = await page.evaluate(() => navigator.userAgent);
    await page.evaluate(() => {
      const bridge = window.__oliveYoungTurnstileBridge;
      bridge.callbacks.set(bridge.captures.at(-1).captureId, () => { window.callbackUA = navigator.userAgent; });
    });
    const controller = new AbortController();
    const client = provider({
      solution: { token: TOKEN, userAgent: 'Mozilla/5.0 Synthetic Captcha Browser Test' },
      beforeReturn: () => { setTimeout(() => controller.abort(), 100); },
    });
    await assert.rejects(() => solve(page, client, { signal: controller.signal }), { code: 'ABORTED' });
    assert.equal(await page.evaluate(() => navigator.userAgent), originalUA);
  } finally { await context.close(); }
});

function imageFixture() {
  return `<form id="login">${credentials}<div id="captcha-area">자동입력 방지문자<canvas id="captchaImage" width="140" height="40"></canvas><input name="answer" placeholder="자동입력 방지문자"></div><button type="submit">로그인</button></form><script>
    window.submits = 0; document.querySelector('form').onsubmit = e => {e.preventDefault();window.submits++;};
    const ctx = document.querySelector('canvas').getContext('2d'); ctx.fillStyle='white';ctx.fillRect(0,0,140,40);ctx.fillStyle='black';ctx.fillText('synthetic',10,25);
  </script>`;
}

test('image orchestration validates PNG, pairs current form, fills answer without submitting', async () => {
  const { page, context } = await fixture(imageFixture());
  try {
    const client = provider({ solution: { text: '  가나   다라 ' } });
    const result = await solve(page, client);
    assert.equal(result.type, 'image');
    assert.equal(result.providerApplied, true);
    assert.equal(result.clear, false);
    assert.equal(client.calls[0].type, 'ImageToTextTask');
    assert.ok(api.validateCaptchaPNG(Buffer.from(client.calls[0].body, 'base64')));
    assert.equal(await page.locator('[name="answer"]').inputValue(), '가나 다라');
    assert.equal(await page.evaluate(() => window.submits), 0);
    assert.equal(await api.isProviderApplicationCurrent(page, result.identity), true);
    await page.locator('[name="answer"]').fill('');
    assert.equal(await api.isProviderApplicationCurrent(page, result.identity), false);
  } finally { await context.close(); }
});

test('mobile formLogin pairs numeric CAPTCHA answer and preserves email login and password inputs', async () => {
  const html = `<form id="formLogin">
    <input type="email" id="loginId" name="loginId">
    <input type="password" id="password" name="password">
    <section class="auto-info">
      <p>자동입력 방지문자를 입력해주세요.</p>
      <div class="img-brake-box">
        <div class="mobile-wrapper"><div class="image-layout"><div class="image-content"><div class="image-wrapper"><canvas id="captchaImage" width="140" height="40"></canvas></div></div></div></div>
        <div class="answer-wrapper"><input type="number" id="autoBlockText" name="answer" placeholder="자동입력방지문자를 입력해주세요"></div>
      </div>
    </section>
    <input type="number" id="unrelatedNumber" name="unrelatedNumber" value="77">
    <button type="submit">로그인</button>
  </form><script>
    window.submits = 0;
    document.querySelector('form').onsubmit = event => { event.preventDefault(); window.submits++; };
    const ctx = document.querySelector('canvas').getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 140, 40);
    ctx.fillStyle = 'black'; ctx.fillText('123456', 10, 25);
  </script>`;
  const { page, context } = await fixture(html);
  try {
    const username = 'synthetic-mobile-user@example.test';
    const password = 'synthetic-mobile-password';
    await page.locator('#loginId').fill(username);
    await page.locator('#password').fill(password);
    const current = await api.inspectChallenge(page);
    assert.equal(current.type, 'image');
    assert.equal(current.pending, true);
    assert.equal(current.descriptor, null);
    assert.ok(current.image.formId);
    assert.ok(current.image.imageId);
    assert.ok(current.image.inputId);

    const client = provider({ solution: { text: '123456' } });
    const result = await solve(page, client);
    assert.equal(result.type, 'image');
    assert.equal(result.providerApplied, true);
    assert.equal(result.clear, false);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].type, 'ImageToTextTask');
    assert.equal(await page.locator('#autoBlockText').inputValue(), '123456');
    assert.equal(await page.locator('#loginId').inputValue(), username);
    assert.equal(await page.locator('#password').inputValue(), password);
    assert.equal(await page.locator('#unrelatedNumber').inputValue(), '77');
    assert.equal(await page.evaluate(() => window.submits), 0);
    assert.equal(await api.isProviderApplicationCurrent(page, result.identity), true);
  } finally { await context.close(); }
});

test('image replacement, pixel changes, hidden or readonly input invalidate provider answer', async () => {
  const mutations = [
    () => { const element = document.querySelector('canvas'); element.replaceWith(element.cloneNode(true)); },
    () => { const ctx = document.querySelector('canvas').getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,30,30); },
    () => { document.querySelector('[name="answer"]').hidden = true; },
    () => { document.querySelector('[name="answer"]').readOnly = true; },
  ];
  for (const mutate of mutations) {
    const { page, context } = await fixture(imageFixture());
    try {
      const result = await solve(page, provider({ solution: { text: 'stale' }, beforeReturn: () => page.evaluate(mutate) }));
      assert.equal(result.providerApplied, false);
      assert.equal(await page.locator('[name="answer"]').inputValue(), '');
    } finally { await context.close(); }
  }
});

test('image outside an active credential form never creates a task', async () => {
  const { page, context } = await fixture('<div>자동입력 방지문자<canvas id="captchaImage" width="100" height="40"></canvas><input name="captchaAnswer"></div>');
  try {
    const client = provider({ solution: { text: 'must not apply' } });
    const result = await solve(page, client);
    assert.equal(result.reason, 'NO_DESCRIPTOR');
    assert.equal(client.calls.length, 0);
  } finally { await context.close(); }
});

test('same challenge budget persists across handler calls and ends at three tasks', async () => {
  const { page, context } = await fixture(standalone('<input type="hidden" name="cf-turnstile-response">'));
  try {
    const client = provider();
    const budget = createCaptchaBudget(config);
    for (let i = 0; i < 4; i++) await solve(page, client, { budget });
    assert.equal(client.calls.length, 3);
  } finally { await context.close(); }
});

test('unsafe provider error details never appear in result or events', async () => {
  const { page, context } = await fixture(standalone());
  try {
    const events = [];
    const client = { solve() { throw Object.assign(new Error('fake-secret fake-image-base64'), { code: 'ERROR_FAKE_SECRET' }); } };
    const result = await solve(page, client, { onEvent: (event) => events.push(event) });
    assert.equal(result.reason, 'PROVIDER_ERROR');
    assert.equal(JSON.stringify({ result, events }).includes('fake-secret'), false);
  } finally { await context.close(); }
});

test('clear requires four stable observations and supports immediate cancellation', async () => {
  const { page, context } = await fixture('<p>Ready</p>');
  try {
    const start = Date.now();
    assert.equal(await api.confirmClear(page), true);
    assert.ok(Date.now() - start >= 700);
    await assert.rejects(() => api.confirmClear(page, { samples: 0 }), { code: 'INVALID_SOLUTION' });
    const controller = new AbortController();
    const wait = api.confirmClear(page, { signal: controller.signal });
    controller.abort();
    await assert.rejects(wait, { code: 'ABORTED' });
  } finally { await context.close(); }
});

test('oversize or malformed PNG rejected before provider calls', () => {
  assert.throws(() => api.validateCaptchaPNG(Buffer.alloc(101 * 1024)), { code: 'IMAGE_INVALID' });
  assert.throws(() => api.validateCaptchaPNG(Buffer.from('not an image')), { code: 'IMAGE_INVALID' });
});
