const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

let browser, api;
const credentials = Object.freeze({ username: 'synthetic-own-account', password: 'synthetic-password-only' });
const URL = 'https://www.oliveyoung.co.kr/store/login/loginForm.do';
const fields = '<input id="loginId" name="loginId"><input id="password" name="password" type="password">';
const form = (extra = '', action = '') => `<form id="formLogin" action="${action}">${fields}${extra}<button type="button">로그인</button></form>`;
const clear = async () => ({ status: 'clear', detected: false });

before(async () => {
  api = await import('../scripts/lib/oy-auto-login.mjs');
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });

async function fixture(html, url = URL) {
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  const page = await context.newPage();
  await page.goto(url);
  return { page, context };
}

function login(page, options = {}) {
  return api.runAutoLogin(page, credentials, { handleCaptcha: clear, sleep: async () => {}, outcomePolls: 1, ...options });
}

test('credentials are filled in the current form before solver and only its login button is submitted', async () => {
  const { page, context } = await fixture(`${form()}<form id="other"><input name="otherId" value="untouched"><button type="button">로그인</button></form><script>
    window.otherClicks=0;window.loginClicks=0;
    document.querySelector('#other button').onclick=()=>window.otherClicks++;
    document.querySelector('#formLogin button').onclick=()=>{window.loginClicks++;document.body.insertAdjacentHTML('beforeend','<button>로그아웃</button>');};
  </script>`);
  try {
    const solverObservations = [];
    const result = await login(page, { handleCaptcha: async () => {
      solverObservations.push(await page.locator('#formLogin input').evaluateAll(inputs => inputs.map(input => input.value)));
      return { status: 'clear', detected: false };
    } });
    assert.deepEqual(result, { status: 'authenticated', submits: 1 });
    assert.deepEqual(solverObservations[0], [credentials.username, credentials.password]);
    assert.equal(await page.evaluate(() => window.loginClicks), 1);
    assert.equal(await page.evaluate(() => window.otherClicks), 0);
    assert.equal(await page.locator('#other input').inputValue(), 'untouched');
    assert.equal(page.listenerCount('dialog'), 0);
  } finally { await context.close(); }
});

test('repeated CAPTCHA never causes a third submit or refills existing credentials', async () => {
  const { page, context } = await fixture(`${form()}<script>
    window.clicks=0;window.fills={loginId:0,password:0};
    for(const input of document.querySelectorAll('#formLogin input')) input.addEventListener('input',()=>window.fills[input.name]++);
    document.querySelector('button').onclick=()=>window.clicks++;
  </script>`);
  try {
    const result = await login(page, { handleCaptcha: async () => ({ status: 'applied', detected: true, identity: 'same-challenge' }) });
    assert.equal(result.reason, 'LOGIN_NOT_CONFIRMED');
    assert.equal(result.submits, 2);
    assert.equal(await page.evaluate(() => window.clicks), 2);
    assert.deepEqual(await page.evaluate(() => window.fills), { loginId: 1, password: 1 });
  } finally { await context.close(); }
});

test('no CAPTCHA and no confirmed login results in one submit only', async () => {
  const { page, context } = await fixture(form());
  try {
    const result = await login(page);
    assert.equal(result.reason, 'LOGIN_NOT_CONFIRMED');
    assert.equal(result.submits, 1);
  } finally { await context.close(); }
});

test('erased password alone is refilled and CAPTCHA is rechecked after that input event', async () => {
  const { page, context } = await fixture(`${form()}<script>
    window.clicks=0;window.fills={loginId:0,password:0};window.answerReady=false;
    for(const input of document.querySelectorAll('input')) input.addEventListener('input',()=>{window.fills[input.name]++;window.answerReady=false;});
    document.querySelector('button').onclick=()=>{window.clicks++;if(window.clicks===1)document.querySelector('#password').value='';};
  </script>`);
  try {
    const result = await login(page, { handleCaptcha: async () => {
      await page.evaluate(() => { window.answerReady = true; });
      return { status: 'applied', detected: true, identity: 'captcha' };
    } });
    assert.equal(result.submits, 2);
    assert.deepEqual(await page.evaluate(() => window.fills), { loginId: 1, password: 2 });
    assert.equal(await page.evaluate(() => window.answerReady), true);
  } finally { await context.close(); }
});

test('external page or form action is rejected before credentials are filled or submitted', async () => {
  const cases = [
    { html: form(), url: 'https://foreign.test/login' },
    { html: form('', 'https://foreign.test/login'), url: URL },
  ];
  for (const item of cases) {
    const { page, context } = await fixture(item.html, item.url);
    try {
      const result = await login(page);
      assert.equal(result.reason, 'UNTRUSTED_HOST');
      assert.equal(result.submits, 0);
      assert.deepEqual(await page.locator('input').evaluateAll(inputs => inputs.map(input => input.value)), ['', '']);
    } finally { await context.close(); }
  }
});

test('an external form action changed by CAPTCHA handling is rejected at submit', async () => {
  const { page, context } = await fixture(form());
  try {
    const result = await login(page, { handleCaptcha: async () => {
      await page.locator('form').evaluate(element => { element.action = 'https://foreign.test/collect'; });
      return { status: 'clear', detected: false };
    } });
    assert.equal(result.reason, 'UNTRUSTED_HOST');
    assert.ok(result.submits <= 1);
  } finally { await context.close(); }
});

test('ambiguous active credential forms are not filled', async () => {
  const { page, context } = await fixture(`${form()}<form>${fields}<button type="button">로그인</button></form>`);
  try {
    const result = await login(page);
    assert.equal(result.reason, 'LOGIN_FORM_UNAVAILABLE');
    assert.equal(result.submits, 0);
    assert.deepEqual(await page.locator('input').evaluateAll(inputs => inputs.map(input => input.value)), ['', '', '', '']);
  } finally { await context.close(); }
});

test('OTP and rejected credentials already visible at entry stop before solver or credential fill', async () => {
  const cases = [
    { extra: '<input autocomplete="one-time-code" name="otp">', reason: 'ADDITIONAL_VERIFICATION' },
    { extra: '<p>아이디와 비밀번호가 일치하지 않습니다.</p>', reason: 'CREDENTIALS_REJECTED' },
    { extra: '<p>계정이 잠금 상태입니다.</p>', reason: 'CREDENTIALS_REJECTED' },
  ];
  for (const item of cases) {
    const { page, context } = await fixture(form(item.extra));
    try {
      let solverCalls = 0;
      const result = await login(page, { handleCaptcha: async () => { solverCalls++; return { status: 'clear' }; } });
      assert.equal(result.reason, item.reason);
      assert.equal(result.submits, 0);
      assert.equal(solverCalls, 0);
      assert.equal(await page.locator('#loginId').inputValue(), '');
      assert.equal(await page.locator('#password').inputValue(), '');
    } finally { await context.close(); }
  }
});

test('credential rejection after first submit prevents second submit and avoids sensitive dialog output', async () => {
  const { page, context } = await fixture(`${form()}<script>
    document.querySelector('button').onclick=()=>alert('아이디와 비밀번호가 일치하지 않습니다. synthetic-password-only');
  </script>`);
  try {
    const events = [];
    const result = await login(page, { handleCaptcha: async () => ({ status: 'applied', detected: true }), onEvent: event => events.push(event) });
    assert.equal(result.reason, 'CREDENTIALS_REJECTED');
    assert.equal(result.submits, 1);
    assert.equal(JSON.stringify({ result, events }).includes(credentials.password), false);
    assert.equal(page.listenerCount('dialog'), 0);
  } finally { await context.close(); }
});

test('fill/provider exceptions cannot expose credential values', async () => {
  const { page, context } = await fixture(form());
  try {
    for (const operation of ['fill', 'handleCaptcha']) {
      const result = await login(page, { [operation]: async () => { throw new Error(`call failed with ${credentials.password}`); } });
      assert.equal(result.reason, 'LOGIN_FAILED');
      assert.equal(JSON.stringify(result).includes(credentials.password), false);
      assert.equal(result.submits, 0);
    }
  } finally { await context.close(); }
});

test('already signed-in page is returned without solver, fill or submit', async () => {
  const { page, context } = await fixture('<button>로그아웃</button>');
  try {
    const unexpected = async () => { throw new Error('must not run'); };
    assert.deepEqual(await login(page, { handleCaptcha: unexpected, fill: unexpected, submit: unexpected }), { status: 'authenticated', submits: 0 });
  } finally { await context.close(); }
});

test('abort before login rejects immediately and removes dialog handler', async () => {
  const { page, context } = await fixture(form());
  try {
    const controller = new AbortController();controller.abort();
    await assert.rejects(() => login(page, { signal: controller.signal }), { code: 'ABORTED' });
    assert.equal(await page.locator('#password').inputValue(), '');
    assert.equal(page.listenerCount('dialog'), 0);
  } finally { await context.close(); }
});

test('post-submit navigation races retry only authentication and outcome reads without duplicate writes', async () => {
  for (const operation of ['authentication', 'outcome']) {
    const { page, context } = await fixture(`${form()}<script>
      window.fills = { loginId: 0, password: 0 };
      for (const input of document.querySelectorAll('input')) input.addEventListener('input', () => window.fills[input.name]++);
    </script>`);
    try {
      let submitCalls = 0, readCalls = 0, solverCalls = 0;
      let outcomeReady = false;
      const sleeps = [];
      const result = await login(page, {
        outcomePolls: 2,
        sleep: async ms => { sleeps.push(ms); },
        handleCaptcha: async () => { solverCalls++; return clear(); },
        submit: async () => { submitCalls++; },
        isAuthenticated: async () => {
          if (!submitCalls) return false;
          if (operation === 'outcome') return outcomeReady;
          if (++readCalls <= 2) throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation.');
          return true;
        },
        inspectOutcome: async () => {
          if (submitCalls && operation === 'outcome') {
            if (++readCalls <= 2) throw new Error('page.evaluate: Protocol error (Runtime.callFunctionOn): Cannot find context with specified id');
            outcomeReady = true;
          }
          return { credentialsRejected: false, additionalVerification: false, signedIn: false };
        },
      });
      assert.deepEqual(result, { status: 'authenticated', submits: 1 });
      assert.equal(submitCalls, 1);
      assert.equal(solverCalls, 1);
      assert.equal(readCalls, 3);
      assert.equal(sleeps.filter(ms => ms === 250).length, 2);
      assert.deepEqual(await page.evaluate(() => window.fills), { loginId: 1, password: 1 });
      assert.equal(page.listenerCount('dialog'), 0);
    } finally { await context.close(); }
  }
});

test('persistent navigation observation errors stop after three retries and remain sanitized', async () => {
  const { page, context } = await fixture(form());
  try {
    let submitCalls = 0, readCalls = 0;
    const sleeps = [], events = [];
    const result = await login(page, {
      sleep: async ms => { sleeps.push(ms); },
      submit: async () => { submitCalls++; },
      isAuthenticated: async () => {
        if (!submitCalls) return false;
        readCalls++;
        throw new Error(`page.evaluate: Execution context was destroyed, most likely because of a navigation. ${credentials.password}`);
      },
      onEvent: event => events.push(event),
    });
    assert.deepEqual(result, { status: 'manual', reason: 'LOGIN_FAILED', submits: 1 });
    assert.equal(submitCalls, 1);
    assert.equal(readCalls, 4);
    assert.equal(sleeps.filter(ms => ms === 250).length, 3);
    assert.equal(JSON.stringify({ result, events }).includes(credentials.password), false);
    assert.equal(page.listenerCount('dialog'), 0);
  } finally { await context.close(); }
});

test('navigation observation failures after foreign redirects stop without retrying', async () => {
  const { page, context } = await fixture(form());
  try {
    let submitCalls = 0, readCalls = 0;
    const sleeps = [];
    const result = await login(page, {
      sleep: async ms => { sleeps.push(ms); },
      submit: async () => { submitCalls++; },
      isAuthenticated: async () => {
        if (!submitCalls) return false;
        readCalls++;
        await page.goto('https://foreign.test/login');
        throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation.');
      },
    });
    assert.deepEqual(result, { status: 'manual', reason: 'UNTRUSTED_HOST', submits: 1 });
    assert.equal(submitCalls, 1);
    assert.equal(readCalls, 1);
    assert.equal(sleeps.filter(ms => ms === 250).length, 0);
    assert.equal(await page.locator('#password').inputValue(), '');
  } finally { await context.close(); }
});

test('navigation retries preserve post-submit OTP and credential-rejection stops', async () => {
  for (const reason of ['ADDITIONAL_VERIFICATION', 'CREDENTIALS_REJECTED']) {
    const { page, context } = await fixture(form());
    try {
      let submitCalls = 0, readCalls = 0;
      const result = await login(page, {
        submit: async () => { submitCalls++; },
        isAuthenticated: async () => false,
        inspectOutcome: async () => {
          if (submitCalls && ++readCalls === 1) throw new Error('Execution context was destroyed, most likely because of a navigation.');
          return {
            credentialsRejected: !!submitCalls && reason === 'CREDENTIALS_REJECTED',
            additionalVerification: !!submitCalls && reason === 'ADDITIONAL_VERIFICATION',
            signedIn: false,
          };
        },
      });
      assert.deepEqual(result, { status: 'manual', reason, submits: 1 });
      assert.equal(submitCalls, 1);
      assert.equal(readCalls, 2);
    } finally { await context.close(); }
  }
});

test('navigation-like fill or submit failures are never retried', async () => {
  for (const operation of ['fill', 'submit']) {
    const { page, context } = await fixture(form());
    try {
      let calls = 0;
      const sleeps = [];
      const result = await login(page, {
        sleep: async ms => { sleeps.push(ms); },
        [operation]: async () => {
          calls++;
          throw new Error(`Execution context was destroyed, most likely because of a navigation. ${credentials.password}`);
        },
      });
      assert.equal(result.reason, 'LOGIN_FAILED');
      assert.equal(result.submits, operation === 'submit' ? 1 : 0);
      assert.equal(calls, 1);
      assert.deepEqual(sleeps, []);
      assert.equal(JSON.stringify(result).includes(credentials.password), false);
    } finally { await context.close(); }
  }
});

test('non-navigation read errors are sanitized and not retried', async () => {
  const { page, context } = await fixture(form());
  try {
    let reads = 0;
    const sleeps = [];
    const result = await login(page, {
      sleep: async ms => { sleeps.push(ms); },
      isAuthenticated: async () => {
        reads++;
        throw new Error(`page.evaluate: Target page, context or browser has been closed. ${credentials.password}`);
      },
    });
    assert.deepEqual(result, { status: 'manual', reason: 'LOGIN_FAILED', submits: 0 });
    assert.equal(reads, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(JSON.stringify(result).includes(credentials.password), false);
  } finally { await context.close(); }
});
