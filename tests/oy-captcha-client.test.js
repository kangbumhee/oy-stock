const test = require('node:test');
const assert = require('node:assert/strict');

const modulePromise = import('../scripts/lib/oy-captcha-client.mjs');
const KEY = 'synthetic-key-not-a-real-credential';
const TASK = { type: 'TurnstileTaskProxyless', websiteURL: 'https://www.oliveyoung.co.kr/login', websiteKey: 'synthetic-sitekey' };
function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function created(id = 71) { return response({ errorId: 0, taskId: id }); }
function ready(solution = { token: 'synthetic-token' }) { return response({ errorId: 0, status: 'ready', solution }); }
async function fixture(sequence, config = {}, options = {}) {
  const { TwoCaptchaClient, readCaptchaConfig } = await modulePromise;
  const calls = [];
  const sleeps = [];
  const client = new TwoCaptchaClient({ ...readCaptchaConfig({ TWOCAPTCHA_API_KEY: KEY }), ...config }, {
    sleep: async ms => { sleeps.push(ms); },
    fetchImpl: async (url, request) => {
      calls.push({ url, ...request, body: JSON.parse(request.body) });
      const next = sequence.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(url, request) : next;
    },
    ...options
  });
  return { client, calls, sleeps };
}
function hasCode(code, properties = {}) {
  return error => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    for (const [key, value] of Object.entries(properties)) assert.equal(error[key], value);
    assert.equal(JSON.stringify(error).includes(KEY), false);
    return true;
  };
}
async function microtasks(count = 30) { for (let index = 0; index < count; index += 1) await Promise.resolve(); }

test('JSON v2 creates once, counts ID before polling, checks currentness again before return', async () => {
  const state = [];
  const { client, calls, sleeps } = await fixture([created(), response({ errorId: 0, status: 'processing' }), ready()]);
  const result = await client.solve(TASK, {
    beforeCreate: () => state.push('current-create'),
    onTaskCreated: id => state.push(`created-${id}`),
    beforePoll: () => state.push('current-poll'),
    beforeReturn: () => state.push('current-return')
  });
  assert.deepEqual(result, { token: 'synthetic-token' });
  assert.deepEqual(state, ['current-create', 'created-71', 'current-poll', 'current-poll', 'current-return']);
  assert.deepEqual(sleeps, [5000, 5000]);
  assert.deepEqual(calls.map(call => call.url), ['https://api.2captcha.com/createTask', 'https://api.2captcha.com/getTaskResult', 'https://api.2captcha.com/getTaskResult']);
  assert.deepEqual(calls[0].body, { clientKey: KEY, task: TASK });
  assert.ok(calls.every(call => call.method === 'POST' && call.redirect === 'error' && !call.url.includes(KEY)));
  assert.deepEqual(calls.slice(1).map(call => call.body), [{ clientKey: KEY, taskId: 71 }, { clientKey: KEY, taskId: 71 }]);
  assert.equal(JSON.stringify(client), '{}');
});

test('invalid safe task IDs never notify creation or poll', async () => {
  for (const id of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, '71', null]) {
    const { client, calls } = await fixture([created(id)]);
    let notified = 0;
    await assert.rejects(client.solve(TASK, { onTaskCreated: () => { notified += 1; } }), hasCode('INVALID_TASK_ID', { ambiguous: true, retryable: false }));
    assert.equal(notified, 0);
    assert.equal(calls.length, 1);
  }
});

test('provider text and arbitrary uppercase codes never escape errors', async () => {
  const { CaptchaError } = await modulePromise;
  const secret = `${KEY} synthetic-image-answer`;
  for (const errorCode of [secret, 'ERROR_UPPERCASE_SECRET', 'ABORTED', 'HTTP_503']) {
    const { client, calls } = await fixture([response({ errorId: 1, errorCode, errorDescription: secret })]);
    await assert.rejects(client.solve(TASK), error => {
      hasCode('PROVIDER_ERROR')(error);
      assert.equal(error.stack.includes(secret), false);
      return true;
    });
    assert.equal(calls.length, 1);
  }
  assert.equal(new CaptchaError('ERROR_FAKE_KEY').code, 'PROVIDER_ERROR');
});

test('malformed JSON, malformed envelopes and missing solution fail without exposing body', async () => {
  for (const bad of [null, [], {}, { errorId: '0', taskId: 1 }]) {
    const { client } = await fixture([response(bad)]);
    await assert.rejects(client.solve(TASK), hasCode('MALFORMED_RESPONSE'));
  }
  const malformed = await fixture([{ ok: true, status: 200, json: () => { throw new Error(KEY); } }]);
  await assert.rejects(malformed.client.solve(TASK), hasCode('MALFORMED_RESPONSE', { ambiguous: true }));
  for (const value of [undefined, null, [], 'answer']) {
    const { client, calls } = await fixture([created(), response({ errorId: 0, status: 'ready', solution: value })]);
    await assert.rejects(client.solve(TASK), hasCode('INVALID_SOLUTION', { taskCreated: true }));
    assert.equal(calls.length, 2);
  }
  const unknown = await fixture([created(), response({ errorId: 0, status: 'unknown' })]);
  await assert.rejects(unknown.client.solve(TASK), hasCode('INVALID_TASK_STATUS'));
});

test('only transient polling failures retry at most three times using the same ID', async () => {
  for (const status of [500, 502, 503, 504, 520, 521, 522, 523, 524]) {
    const { client, calls, sleeps } = await fixture([created(), ...Array.from({ length: 4 }, () => response(null, status)), ready()]);
    await assert.rejects(client.solve(TASK), hasCode(`HTTP_${status}`, { taskCreated: true }));
    assert.equal(calls.length, 5);
    assert.equal(sleeps.length, 4);
    assert.ok(calls.slice(1).every(call => call.body.taskId === 71));
  }
  for (const status of [400, 401, 403, 404, 429, 501, 505, 525]) {
    const { client, calls } = await fixture([created(), response(null, status), ready()]);
    await assert.rejects(client.solve(TASK), hasCode(`HTTP_${status}`));
    assert.equal(calls.length, 2);
  }
  const intermittent = await fixture([created(), new Error(KEY), response({ errorId: 0, status: 'processing' }), new Error(KEY), new Error(KEY), new Error(KEY)]);
  await assert.rejects(intermittent.client.solve(TASK), hasCode('NETWORK_ERROR'));
  assert.equal(intermittent.calls.length, 6);
});

test('uncertain task creation consumes reservation and cannot restart across handler calls', async () => {
  const { createCaptchaBudget } = await modulePromise;
  for (const failure of [new Error(KEY), response(null, 503), created(0)]) {
    const budget = createCaptchaBudget();
    const { client, calls } = await fixture([failure, created(), ready()]);
    const hooks = { beforeCreate: () => budget.reserve('same-event'), onTaskCreated: id => budget.markCreated('same-event', id) };
    await assert.rejects(client.solve(TASK, hooks), error => error.ambiguous === true && error.retryable === false);
    assert.deepEqual(budget.snapshot('same-event'), { reserved: 1, created: 0, maxAttempts: 3, maxJobTasks: 12, eventReserved: 1, eventCreated: 0, uncertain: true });
    await assert.rejects(client.solve(TASK, hooks), hasCode('CREATE_TASK_UNCERTAIN'));
    assert.equal(calls.length, 1);
  }
});

test('budget reservations are atomic under concurrent handler entry, persist by identity and cap whole job', async () => {
  const { createCaptchaBudget } = await modulePromise;
  const budget = createCaptchaBudget({ maxAttempts: 99, maxJobTasks: 99 });
  const attempts = await Promise.allSettled(Array.from({ length: 6 }, async () => budget.reserve('one')));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  budget.markCreated('one', 1);
  budget.reserve('one'); budget.markCreated('one', 2);
  budget.reserve('one'); budget.markCreated('one', 3);
  assert.throws(() => budget.reserve('one'), hasCode('CHALLENGE_TASK_LIMIT'));
  for (let index = 0; index < 9; index += 1) {
    budget.reserve(`event-${index}`);
    budget.markCreated(`event-${index}`, index + 4);
  }
  assert.throws(() => budget.reserve('thirteenth'), hasCode('JOB_TASK_LIMIT'));
  assert.equal(budget.snapshot().reserved, 12);
  assert.equal(budget.snapshot().created, 12);
  assert.equal(budget.canReserve('thirteenth'), false);
});

test('creation callback is validated, idempotency violations do not inflate budget', async () => {
  const { createCaptchaBudget } = await modulePromise;
  const budget = createCaptchaBudget();
  assert.throws(() => budget.reserve(''), hasCode('INVALID_CHALLENGE_IDENTITY'));
  assert.throws(() => budget.markCreated('one', 1), hasCode('INVALID_RESERVATION'));
  budget.reserve('one');
  assert.throws(() => budget.markCreated('one', 0), hasCode('INVALID_TASK_ID'));
  budget.markCreated('one', 1);
  assert.throws(() => budget.markCreated('one', 1), hasCode('INVALID_RESERVATION'));
  assert.equal(budget.snapshot().created, 1);
});

test('currentness hooks can block before creation, before polling, and immediately before returning answer', async () => {
  const { CaptchaError } = await modulePromise;
  for (const hookName of ['beforeCreate', 'beforePoll', 'beforeReturn']) {
    const { client, calls } = await fixture([created(), ready()]);
    await assert.rejects(client.solve(TASK, { [hookName]: () => { throw new CaptchaError('CHALLENGE_CHANGED'); } }), hasCode('CHALLENGE_CHANGED'));
    assert.equal(calls.length, { beforeCreate: 0, beforePoll: 1, beforeReturn: 2 }[hookName]);
  }
  const denied = await fixture([created()]);
  await assert.rejects(denied.client.solve(TASK, { beforeCreate: () => false }), hasCode('CHALLENGE_CHANGED'));
  assert.equal(denied.calls.length, 0);
  const throws = await fixture([created()]);
  await assert.rejects(throws.client.solve(TASK, { beforeCreate: () => { throw new Error(KEY); } }), hasCode('HOOK_FAILED'));
  assert.equal(throws.calls.length, 0);
});

test('abort interrupts sleep, stuck provider fetch and stuck currentness hooks', async () => {
  const { abortableSleep } = await modulePromise;
  const first = new AbortController();
  const sleeping = abortableSleep(5000, first.signal);
  first.abort(new Error(KEY));
  await assert.rejects(sleeping, hasCode('ABORTED'));
  for (const stage of ['create', 'poll', 'hook']) {
    const control = new AbortController();
    const hang = () => new Promise(() => {});
    const { client, calls } = await fixture(stage === 'poll' ? [created(), hang] : [hang]);
    const solving = client.solve(TASK, { signal: control.signal, ...(stage === 'hook' ? { beforeCreate: hang } : {}) });
    await microtasks();
    control.abort(new Error(KEY));
    await assert.rejects(solving, hasCode('ABORTED'));
    if (stage === 'hook') assert.equal(calls.length, 0);
    else assert.ok(calls.at(-1).signal.aborted);
  }
});

test('abort after valid creation retains budget charge and never begins polling', async () => {
  const { createCaptchaBudget } = await modulePromise;
  const budget = createCaptchaBudget();
  const control = new AbortController();
  const { client, calls } = await fixture([created(), ready()]);
  await assert.rejects(client.solve(TASK, {
    signal: control.signal,
    beforeCreate: () => budget.reserve('one'),
    onTaskCreated: id => { budget.markCreated('one', id); control.abort(); }
  }), hasCode('ABORTED', { taskCreated: true }));
  assert.equal(budget.snapshot().created, 1);
  assert.equal(calls.length, 1);
});

test('individual request timeout aborts create once without retry', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, calls } = await fixture([() => new Promise(() => {})], { requestTimeoutMs: 5000 });
  const solving = client.solve(TASK);
  const assertion = assert.rejects(solving, hasCode('REQUEST_TIMEOUT', { ambiguous: true }));
  await microtasks();
  context.mock.timers.tick(5001);
  await assertion;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, true);
});

test('polling request timeouts retry three times at the original paid task ID', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const hang = () => new Promise(() => {});
  const { client, calls } = await fixture([created(), hang, hang, hang, hang], { requestTimeoutMs: 5000 });
  const solving = client.solve(TASK);
  const assertion = assert.rejects(solving, hasCode('REQUEST_TIMEOUT', { taskCreated: true, ambiguous: false }));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await microtasks(70);
    assert.equal(calls.length, attempt + 2);
    context.mock.timers.tick(5001);
  }
  await assertion;
  assert.equal(calls.length, 5);
  assert.ok(calls.slice(1).every(call => call.body.taskId === 71 && call.signal.aborted));
});

test('whole solve deadline aborts an in-flight HTTP request before its longer individual limit', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, calls } = await fixture([() => new Promise(() => {})], { timeoutMs: 30000, requestTimeoutMs: 60000 });
  const solving = client.solve(TASK);
  const assertion = assert.rejects(solving, hasCode('SOLVE_TIMEOUT', { ambiguous: true }));
  await microtasks();
  context.mock.timers.tick(30001);
  await assertion;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, true);
});

test('whole solve timeout includes HTTP and hooks, uses wall clock even with injected sleep', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const stuck = await fixture([created()], { timeoutMs: 30000, requestTimeoutMs: 60000 });
  const solving = stuck.client.solve(TASK, { beforeCreate: () => new Promise(() => {}) });
  const assertion = assert.rejects(solving, hasCode('SOLVE_TIMEOUT'));
  await microtasks();
  context.mock.timers.tick(30001);
  await assertion;
  assert.equal(stuck.calls.length, 0);
  let time = 0;
  const polled = await fixture([created(), response({ errorId: 0, status: 'processing' })], { timeoutMs: 30000 }, { now: () => time, sleep: async () => { time += 30000; } });
  await assert.rejects(polled.client.solve(TASK), hasCode('SOLVE_TIMEOUT'));
  assert.equal(polled.calls.length, 1);
});

test('config validates keys, disable aliases and clamps every numeric setting', async () => {
  const { readCaptchaConfig } = await modulePromise;
  for (const key of ['', ' ', 'x'.repeat(513), 'key\n', 'key\r', 'key\0']) assert.equal(readCaptchaConfig({ TWOCAPTCHA_API_KEY: key }).configured, false);
  assert.equal(readCaptchaConfig({ TWOCAPTCHA_API_KEY: ` ${KEY} ` }).apiKey, KEY);
  assert.equal(readCaptchaConfig({ TWO_CAPTCHA_API_KEY: KEY }).configured, true);
  assert.equal(readCaptchaConfig({ TWOCAPTCHA_API_KEY: 'primary', TWO_CAPTCHA_API_KEY: 'secondary' }).apiKey, 'primary');
  for (const prefix of ['OLIVEYOUNG', 'KOREA_TOP']) {
    for (const flag of ['0', 'false', 'NO', 'off', 'disabled']) {
      const config = readCaptchaConfig({ TWOCAPTCHA_API_KEY: KEY, [`${prefix}_2CAPTCHA_ENABLED`]: flag });
      assert.equal(config.configured, true);
      assert.equal(config.enabled, false);
    }
    const fields = [
      ['POLL_INTERVAL_MS', 'pollIntervalMs', 5000, 30000, 5000],
      ['TIMEOUT_MS', 'timeoutMs', 30000, 300000, 120000],
      ['REQUEST_TIMEOUT_MS', 'requestTimeoutMs', 5000, 60000, 30000],
      ['APPLY_TIMEOUT_MS', 'applyTimeoutMs', 5000, 60000, 15000],
      ['MAX_ATTEMPTS', 'maxAttempts', 1, 3, 3],
      ['JOB_TASK_LIMIT', 'maxJobTasks', 1, 12, 12]
    ];
    for (const [name, field, min, max, fallback] of fields) {
      assert.equal(readCaptchaConfig({ [`${prefix}_2CAPTCHA_${name}`]: '-1' })[field], min);
      assert.equal(readCaptchaConfig({ [`${prefix}_2CAPTCHA_${name}`]: '9999999' })[field], max);
      assert.equal(readCaptchaConfig({ [`${prefix}_2CAPTCHA_${name}`]: 'invalid' })[field], fallback);
      assert.equal(readCaptchaConfig({ [`${prefix}_2CAPTCHA_${name}`]: '   ' })[field], fallback);
    }
  }
  const override = readCaptchaConfig({ TWOCAPTCHA_API_KEY: KEY, OLIVEYOUNG_2CAPTCHA_ENABLED: 'false', KOREA_TOP_2CAPTCHA_ENABLED: 'true' });
  assert.equal(override.enabled, false);
});

test('missing key and disabled config never invoke hooks or make provider requests', async () => {
  for (const [config, code] of [[{ apiKey: '' }, 'NO_API_KEY'], [{ enabled: false }, 'DISABLED']]) {
    const { client, calls } = await fixture([created()], config);
    let hooks = 0;
    await assert.rejects(client.solve(TASK, { beforeCreate: () => { hooks += 1; } }), hasCode(code));
    assert.equal(calls.length, 0);
    assert.equal(hooks, 0);
  }
});
