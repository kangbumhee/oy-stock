const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const healthUrl = pathToFileURL(path.join(__dirname, '..', 'scripts', 'lib', 'oy-login-health.mjs'));
const mailUrl = pathToFileURL(path.join(__dirname, '..', 'scripts', 'send-oy-login-alert.mjs'));
const AT = '2026-09-06T01:00:00.000Z';
const SAFE = { reason: 'reconnect_required', source: 'periodic_check', detectedAt: AT };

async function fixture(t) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oy-login-health-test-'));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  const calls = [];
  let time = Date.parse(AT);
  return {
    repoRoot, calls,
    options: { repoRoot, now: () => time, checkProduction: async () => 0, dispatchAlert: async (metadata) => { calls.push(metadata); return true; } },
    advance: () => { time += 900000; },
    statePath: path.join(repoRoot, '.auth', 'oy-login-health.json'),
  };
}

test('local monitor runs only read-only check and discards child output and error details', async () => {
  const { checkLocalLogin } = await import(healthUrl);
  const calls = [];
  const base = { repoRoot: 'C:\\fake-repo', env: { PATH: 'fake-path' }, runProcess: async (...args) => { calls.push(args); return { stdout: 'fake-sensitive-cookie' }; } };
  assert.equal(await checkLocalLogin(base), 0);
  assert.equal(calls[0][0], process.execPath);
  assert.equal(calls[0][1].at(-1), '--check-only');
  assert.equal(calls[0][1].length, 2);
  assert.equal(calls[0][2].env.OY_HEADLESS, '1');
  assert.equal(calls[0][2].env.OY_SKIP_WORKFLOW_DISPATCH, '1');
  assert.equal(calls[0][2].windowsHide, true);
  for (const code of [42, 75, 1, 'ETIMEDOUT']) {
    assert.equal(await checkLocalLogin({ ...base, runProcess: async () => { throw { code, stderr: 'fake-private-password' }; } }), [42, 75].includes(code) ? code : 1);
  }
});

test('production GET classifies explicit expired auth separately from unavailable checks', async () => {
  const { checkProductionLogin } = await import(healthUrl);
  const requests = [];
  const now = () => Date.parse(AT);
  for (const [payload, expected] of [
    [{ jwtValid: true, jwtExpSeconds: now() / 1000 + 1000, sub: 'fake-private-subject' }, 0],
    [{ jwtValid: false, jwtExpSeconds: null }, 42],
    [{ jwtValid: null }, 1], [{ jwtValid: true }, 1],
    [{ jwtValid: true, jwtExpSeconds: now() / 1000 - 1 }, 1],
  ]) {
    assert.equal(await checkProductionLogin({ now, fetchImpl: async (...args) => { requests.push(args); return { ok: true, json: async () => payload }; } }), expected);
  }
  assert.ok(requests.every(([url, opts]) => url === 'https://olivestock.co.kr/api/oliveyoung/landing-proxy?check=1'
    && opts.method === 'GET' && opts.body === undefined && opts.redirect === 'error'));
  assert.equal(await checkProductionLogin({ fetchImpl: async () => { throw new Error('fake-private-response'); } }), 1);
  assert.equal(await checkProductionLogin({ fetchImpl: async () => ({ ok: false }) }), 1);
});

test('confirmed local expiry alerts immediately once until actual recovery', async (t) => {
  const { runLoginHealthCheck } = await import(healthUrl);
  const f = await fixture(t);
  let local = 42;
  let production = 42;
  const check = () => runLoginHealthCheck({ ...f.options, runCheck: async () => local, checkProduction: async () => production });
  assert.equal((await check()).notification, 'sent');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], SAFE);
  f.advance();
  local = 42;
  assert.equal((await check()).notification, 'already_sent');
  assert.equal(f.calls.length, 1);
  local = 0;
  production = 0;
  assert.equal((await check()).status, 'healthy');
  f.advance();
  local = 42;
  assert.equal((await check()).notification, 'sent');
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].detectedAt, f.calls[1].detectedAt);
});

test('healthy local login with expired publication does not request user login', async (t) => {
  const { runLoginHealthCheck } = await import(healthUrl);
  const f = await fixture(t);
  const check = () => runLoginHealthCheck({ ...f.options, runCheck: async () => 0, checkProduction: async () => 42 });
  assert.equal((await check()).notification, 'not_needed');
  assert.equal((await check()).notification, 'not_needed');
  assert.equal((await check()).notification, 'sent');
  assert.equal(f.calls[0].reason, 'check_failed');
  assert.equal((await check()).notification, 'already_sent');
});

test('general failures alert at three observations; busy skips without changing state', async (t) => {
  const { runLoginHealthCheck } = await import(healthUrl);
  const f = await fixture(t);
  const failed = () => runLoginHealthCheck({ ...f.options, runCheck: async () => 1 });
  assert.equal((await failed()).consecutiveFailures, 1);
  const beforeBusy = await fs.readFile(f.statePath, 'utf8');
  const busy = await runLoginHealthCheck({ ...f.options, runCheck: async () => 75, checkProduction: async () => { throw new Error('must not run'); } });
  assert.equal(busy.exitCode, 75);
  assert.equal(await fs.readFile(f.statePath, 'utf8'), beforeBusy);
  assert.equal((await failed()).consecutiveFailures, 2);
  assert.equal(f.calls.length, 0);
  assert.equal((await failed()).notification, 'sent');
  assert.equal(f.calls[0].reason, 'check_failed');
  assert.equal((await failed()).notification, 'already_sent');
  assert.equal(f.calls.length, 1);
});

test('daily failures alert immediately and only confirmed publication success resets dedupe', async (t) => {
  const { reportRefreshFailure, reportRefreshSuccess } = await import(healthUrl);
  const f = await fixture(t);
  assert.equal((await reportRefreshFailure({ ...f.options, exitCode: 1 })).notification, 'sent');
  assert.equal(f.calls[0].source, 'daily_refresh');
  assert.equal((await reportRefreshFailure({ ...f.options, exitCode: 42 })).notification, 'already_sent');
  assert.equal((await reportRefreshSuccess(f.options)).exitCode, 0);
  assert.equal((await reportRefreshFailure({ ...f.options, exitCode: 42 })).notification, 'sent');
  assert.equal(f.calls.length, 2);
});

test('dispatch failure stays pending and retries with original safe incident metadata', async (t) => {
  const { runLoginHealthCheck } = await import(healthUrl);
  const f = await fixture(t);
  let attempts = 0;
  const options = { ...f.options, runCheck: async () => 42, dispatchAlert: async () => { attempts++; if (attempts === 1) throw new Error('fake-cookie-password-key'); return true; } };
  const failed = await runLoginHealthCheck(options);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.notification, 'dispatch_failed');
  assert.equal(JSON.stringify(failed).includes('fake-cookie'), false);
  assert.equal((JSON.parse(await fs.readFile(f.statePath, 'utf8'))).incident.notifiedAt, null);
  f.advance();
  assert.equal((await runLoginHealthCheck(options)).notification, 'sent');
  assert.equal(attempts, 2);
  assert.equal((JSON.parse(await fs.readFile(f.statePath, 'utf8'))).incident.detectedAt, AT);
});

test('concurrent outcome reporting dispatches once and returns busy to the other process', async (t) => {
  const { reportRefreshFailure } = await import(healthUrl);
  const f = await fixture(t);
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let finish;
  const hold = new Promise((resolve) => { finish = resolve; });
  const first = reportRefreshFailure({ ...f.options, exitCode: 42, dispatchAlert: async () => { signalStarted(); await hold; f.calls.push(SAFE); return true; } });
  await started;
  const second = await reportRefreshFailure({ ...f.options, exitCode: 42 });
  assert.equal(second.exitCode, 75);
  finish();
  assert.equal((await first).notification, 'sent');
  assert.equal(f.calls.length, 1);
});

test('persisted state strips unknown private fields and never preserves response bodies', async (t) => {
  const { runLoginHealthCheck } = await import(healthUrl);
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.statePath), { recursive: true });
  await fs.writeFile(f.statePath, JSON.stringify({ version: 1, consecutiveFailures: 0, password: 'fake-password', token: 'fake-token', incident: null }));
  await runLoginHealthCheck({ ...f.options, runCheck: async () => { throw new Error('fake-cookie'); } });
  const saved = await fs.readFile(f.statePath, 'utf8');
  assert.equal(saved.includes('fake-'), false);
  assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ['consecutiveFailures', 'incident', 'lastCheckedAt', 'lastHealthyAt', 'version']);
});

test('GitHub dispatch only sends allowlisted metadata and suppresses process error details', async () => {
  const { dispatchLoginAlert } = await import(healthUrl);
  const calls = [];
  const options = { repoRoot: 'fake-root', metadata: SAFE, env: { GITHUB_REPO: 'owner/oy-stock' }, runProcess: async (...args) => { calls.push(args); return { stdout: '[]' }; } };
  assert.deepEqual(await dispatchLoginAlert(options), { status: 'pending', delivery: { dispatchAccepted: true, attempts: 1, runId: null } });
  assert.equal(calls[1][0], 'gh');
  assert.deepEqual(calls[1][1], ['workflow', 'run', 'oy-login-alert.yml', '--repo', 'owner/oy-stock', '-f', 'reason=reconnect_required', '-f', 'source=periodic_check', '-f', `detectedAt=${AT}`]);
  await assert.rejects(dispatchLoginAlert({ ...options, metadata: { ...SAFE, reason: 'fake-cookie' } }), { message: 'OY_LOGIN_ALERT_METADATA_INVALID' });
  const failed = await dispatchLoginAlert({ ...options, runProcess: async () => { throw new Error('fake-key'); } });
  assert.equal(failed.status, 'failed');
  assert.equal(JSON.stringify(failed).includes('fake-key'), false);
});

test('accepted dispatch remains pending until the email step succeeds despite intentional workflow failure', async (t) => {
  const { runLoginHealthCheck } = await import(healthUrl);
  const f = await fixture(t);
  let checks = 0;
  const options = { ...f.options, runCheck: async () => 42, dispatchAlert: async (_metadata, delivery) => {
    checks++;
    if (checks === 1) return { status: 'pending', delivery: { dispatchAccepted: true, attempts: 1, runId: 100 } };
    assert.equal(delivery.runId, 100);
    return { status: 'sent', delivery };
  } };
  assert.equal((await runLoginHealthCheck(options)).notification, 'pending');
  assert.equal(JSON.parse(await fs.readFile(f.statePath, 'utf8')).incident.notifiedAt, null);
  f.advance();
  assert.equal((await runLoginHealthCheck(options)).notification, 'sent');
  assert.ok(JSON.parse(await fs.readFile(f.statePath, 'utf8')).incident.notifiedAt);
  assert.equal((await runLoginHealthCheck(options)).notification, 'already_sent');
  assert.equal(checks, 2);
});

test('GitHub run verification suppresses duplicates while pending and after SMTP success', async () => {
  const { dispatchLoginAlert } = await import(healthUrl);
  const title = `OY login alert ${AT}`;
  const calls = [];
  let status = 'in_progress';
  const options = { repoRoot: 'fake-root', metadata: SAFE, env: { GITHUB_REPO: 'owner/repo' },
    runProcess: async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'api') return { stdout: JSON.stringify({ display_title: title, status, run_attempt: 1 }) };
      if (args[1] === 'list') return { stdout: JSON.stringify([{ databaseId: 100, displayTitle: title }]) };
      if (args[1] === 'view') return { stdout: JSON.stringify({ jobs: [{ steps: [{ name: 'Send reconnect email', conclusion: 'success' }, { name: 'Mark login attention required for GitHub failure notifications', conclusion: 'failure' }] }] }) };
      throw new Error('duplicate dispatch or rerun');
    } };
  const pending = await dispatchLoginAlert(options);
  assert.equal(pending.status, 'pending');
  status = 'completed';
  const sent = await dispatchLoginAlert({ ...options, delivery: pending.delivery });
  assert.equal(sent.status, 'sent');
  assert.equal(calls.some((args) => args[0] === 'workflow' || args[1] === 'rerun'), false);
});

test('SMTP or pre-email failure reruns only the failed job, bounded to three attempts', async () => {
  const { dispatchLoginAlert } = await import(healthUrl);
  const title = `OY login alert ${AT}`;
  const calls = [];
  let attempt = 1;
  let steps = [{ name: 'Send reconnect email', conclusion: 'failure' }];
  const options = { repoRoot: 'fake-root', metadata: SAFE, delivery: { dispatchAccepted: true, runId: 100, attempts: 1 }, env: { GITHUB_REPO: 'owner/repo' },
    runProcess: async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'api') return { stdout: JSON.stringify({ display_title: title, status: 'completed', run_attempt: attempt }) };
      if (args[1] === 'view') return { stdout: JSON.stringify({ jobs: [{ steps }] }) };
      if (args[1] === 'rerun') return { stdout: '' };
      throw new Error('unexpected dispatch');
    } };
  const retry = await dispatchLoginAlert(options);
  assert.equal(retry.status, 'pending');
  assert.equal(retry.delivery.attempts, 2);
  assert.deepEqual(calls.at(-1), ['run', 'rerun', '100', '--failed', '--repo', 'owner/repo']);
  steps = [];
  assert.equal((await dispatchLoginAlert(options)).status, 'pending');
  attempt = 3;
  const before = calls.filter((args) => args[1] === 'rerun').length;
  assert.equal((await dispatchLoginAlert({ ...options, delivery: { ...options.delivery, attempts: 3 } })).status, 'failed');
  assert.equal(calls.filter((args) => args[1] === 'rerun').length, before);
});

test('email uses existing SMTP names and safe Korean reconnect copy without account data', async () => {
  const { sendLoginAlert } = await import(mailUrl);
  const env = {
    ALERT_EMAIL_FROM: 'sender@example.com', ALERT_EMAIL_PASSWORD: 'fake-smtp-password', ALERT_EMAIL_TO: 'owner@example.com',
    OY_LOGIN_ALERT_REASON: 'reconnect_required', OY_LOGIN_ALERT_SOURCE: 'periodic_check', OY_LOGIN_ALERT_DETECTED_AT: AT,
    GITHUB_REPOSITORY: 'owner/oy-stock', GITHUB_RUN_ID: '1234', OY_PASSWORD: 'fake-oy-password', TWOCAPTCHA_API_KEY: 'fake-api-key',
  };
  let transport;
  let message;
  let closed = false;
  assert.deepEqual(await sendLoginAlert({ env, createTransport: (config) => { transport = config; return { sendMail: async (value) => { message = value; }, close: () => { closed = true; } }; } }), { sent: true, reason: 'reconnect_required' });
  assert.equal(transport.service, 'gmail');
  assert.equal(transport.auth.pass, env.ALERT_EMAIL_PASSWORD);
  assert.equal(message.to, env.ALERT_EMAIL_TO);
  assert.match(message.subject, /재연결/);
  assert.match(message.text, /https:\/\/github.com\/owner\/oy-stock\/actions\/runs\/1234/);
  assert.equal(message.text.includes('fake-'), false);
  assert.equal(closed, true);
  await assert.rejects(sendLoginAlert({ env, createTransport: () => ({ sendMail: async () => { throw new Error('fake-smtp-password'); } }) }), { message: 'OY_LOGIN_ALERT_SMTP_FAILED' });
});
