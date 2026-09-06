const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

let createCaptchaHandler, dom, clientApi, browser;
const config = { enabled: true, timeoutMs: 1000, maxAttempts: 3, maxJobTasks: 12, applyTimeoutMs: 1000 };

before(async () => {
  ({ createCaptchaHandler } = await import('../scripts/lib/oy-captcha-flow.mjs'));
  dom = await import('../scripts/lib/oy-captcha-dom.mjs');
  clientApi = await import('../scripts/lib/oy-captcha-client.mjs');
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });

function harness(overrides = {}) {
  const state = {
    current: { type: 'image', identity: 'challenge-1', detected: true, pending: true, managed: false },
    clock: 100000, sleeps: [], solves: 0, solveTimes: [], releaseCount: 0, restoreCount: 0,
    applicationCurrent: false, allowed: true, events: [],
  };
  const deps = {
    inspectChallenge: async () => state.current,
    confirmClear: async () => !state.current.pending,
    releaseManaged: async () => { state.releaseCount++; },
    restoreUserAgent: async () => { state.restoreCount++; },
    isProviderApplicationCurrent: async () => state.applicationCurrent,
    solveChallenge: async () => {
      state.solves++;state.solveTimes.push(state.clock);
      if (overrides.solve) return overrides.solve(state);
      state.applicationCurrent = true;
      return { providerApplied: true, clear: false, managed: state.current.managed, identity: state.current.identity };
    },
  };
  const handler = createCaptchaHandler({}, {
    config: { ...config, ...overrides.config }, client: {}, budget: { canReserve: () => state.allowed },
    signal: overrides.signal,
    now: () => state.clock,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new clientApi.CaptchaError('ABORTED');
      state.clock += ms;state.sleeps.push(ms);await overrides.onSleep?.(state, ms);
    },
    deps: { ...deps, ...overrides.deps }, onEvent: event => state.events.push(event),
  });
  return { state, handler };
}

test('natural grace-period completion does not create a provider task', async () => {
  const { state, handler } = harness({ onSleep: state => { state.current = { ...state.current, pending: false }; } });
  assert.deepEqual(await handler(), { status: 'clear', detected: true });
  assert.equal(state.solves, 0);
  assert.deepEqual(state.sleeps, [3500]);
  assert.equal(state.restoreCount, 1);
});

test('disabled provider and exhausted job budget do not call solver', async () => {
  const disabled = harness({ config: { enabled: false } });
  assert.equal((await disabled.handler()).reason, 'CAPTCHA_AUTOMATIC_DISABLED');
  assert.equal(disabled.state.solves, 0);
  const exhausted = harness();exhausted.state.allowed = false;
  assert.equal((await exhausted.handler()).reason, 'CAPTCHA_TASK_LIMIT');
  assert.equal(exhausted.state.solves, 0);
});

test('missing descriptor readiness is bounded without paid requests', async () => {
  const { state, handler } = harness();
  state.current.type = 'unknown';
  const result = await handler();
  assert.equal(result.reason, 'NO_DESCRIPTOR');
  assert.equal(state.solves, 0);
  assert.deepEqual(state.sleeps, [3500, 5000, 5000, 5000]);
  assert.equal(state.releaseCount, 1);
});

test('provider retries respect six-second cooldown and the shared budget', async () => {
  const { state, handler } = harness({ solve: state => {
    state.allowed = state.solves < 3;
    return { reason: 'PROVIDER_ERROR', providerApplied: false, clear: false };
  } });
  const result = await handler();
  assert.equal(result.reason, 'CAPTCHA_TASK_LIMIT');
  assert.equal(state.solves, 3);
  assert.ok(state.solveTimes[1] - state.solveTimes[0] >= 6000);
  assert.ok(state.solveTimes[2] - state.solveTimes[1] >= 6000);
});

test('cached image result is reused only while its exact applied answer is still current', async () => {
  const { state, handler } = harness();
  assert.equal((await handler()).status, 'applied');
  assert.equal((await handler()).status, 'applied');
  assert.equal(state.solves, 1);
  state.applicationCurrent = false;
  assert.equal((await handler()).status, 'applied');
  assert.equal(state.solves, 2);
  state.current = { ...state.current, identity: 'challenge-2' };
  assert.equal((await handler()).status, 'applied');
  assert.equal(state.solves, 3);
});

test('an uncertain paid create stops further creation even if challenge identity changes', async () => {
  const { state, handler } = harness({ solve: () => ({ reason: 'CREATE_TASK_UNCERTAIN', providerApplied: false, clear: false }) });
  assert.equal((await handler()).reason, 'CREATE_TASK_UNCERTAIN');
  state.current = { ...state.current, identity: 'different-challenge' };
  assert.equal((await handler()).reason, 'CREATE_TASK_UNCERTAIN');
  assert.equal(state.solves, 1);
  assert.equal(state.restoreCount, 2);
});

test('managed provider application without challenge clear releases native mode and restores UA', async () => {
  const { state, handler } = harness();state.current.managed = true;
  const result = await handler();
  assert.equal(result.reason, 'CAPTCHA_NOT_CLEARED');
  assert.equal(state.solves, 1);
  assert.equal(state.releaseCount, 1);
  assert.equal(state.restoreCount, 1);
});

test('cancellation during grace always restores UA and never enters solve', async () => {
  const controller = new AbortController();controller.abort();
  const { state, handler } = harness({ signal: controller.signal });
  await assert.rejects(handler, { code: 'ABORTED' });
  assert.equal(state.solves, 0);
  assert.equal(state.restoreCount, 1);
});

test('changed challenge immediately after applying an answer is not returned as applied', async () => {
  const { state, handler } = harness({ solve: state => {
    state.allowed = false;
    return { identity: 'previous-challenge', providerApplied: true, clear: false, managed: false };
  } });
  const result = await handler();
  assert.equal(result.status, 'manual');
  assert.equal(result.reason, 'CAPTCHA_TASK_LIMIT');
  assert.equal(state.solves, 1);
});

test('real synthetic login DOM: fractional image position does not buy twice; cleared answer invalidates cache', async () => {
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
    <form><input name="loginId"><input type="password" name="password"><div>자동입력 방지문자
    <canvas id="captchaImage" width="100" height="40"></canvas><input name="answer" placeholder="자동입력 방지문자"></div>
    <button type="submit">로그인</button></form><script>
      window.submits=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++;};
      const ctx=document.querySelector('canvas').getContext('2d');ctx.fillStyle='black';ctx.fillRect(0,0,100,40);
    </script>` }));
  const page = await context.newPage();
  await dom.installCapture(page, { enabled: true });
  await page.goto('https://www.oliveyoung.co.kr/store/login/loginForm.do');
  try {
    let tasks = 0, clock = 100000;
    const observations = [];
    const client = { solve: async (task, hooks) => {
      assert.equal(task.type, 'ImageToTextTask');
      await hooks.beforeCreate();tasks++;await hooks.onTaskCreated(tasks);
      await hooks.beforePoll();await hooks.beforeReturn();
      return { text: '가나다' };
    } };
    const handler = createCaptchaHandler(page, {
      config, client, budget: clientApi.createCaptchaBudget(config), now: () => clock, sleep: async ms => { clock += ms; },
      deps: { ...dom, solveChallenge: async (...args) => {
        const result = await dom.solveChallenge(...args);
        observations.push({ reason: result.reason, providerApplied: result.providerApplied });
        return result;
      } },
    });
    const first = await handler();
    assert.equal(first.status, 'applied');
    assert.equal(tasks, 1, `first image handler must create exactly one task: ${JSON.stringify(observations)}`);
    assert.equal(await dom.isProviderApplicationCurrent(page, first.identity), true);
    assert.equal((await handler()).status, 'applied');
    assert.equal(tasks, 1);
    await page.locator('[name="answer"]').fill('');
    assert.equal((await handler()).status, 'applied');
    assert.equal(tasks, 2);
    assert.equal(await page.locator('[name="answer"]').inputValue(), '가나다');
    assert.equal(await page.evaluate(() => window.submits), 0);
  } finally { await context.close(); }
});
