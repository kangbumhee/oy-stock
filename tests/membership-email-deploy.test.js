const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'configure-membership-email.mjs'), 'utf8');
const executableSource = source.replace(/^import nodemailer from 'nodemailer';\r?$/m, '');
const projectId = 'prj_Sj0zepEyW8AB3956ssl7zx163DOP';
const teamId = 'team_kCYpXTZeNpSxqcelRRUUSUKy';
const fixtureToken = 'PUBLIC-DUMMY-VERCEL-TOKEN-NOT-A-SECRET';
const fixturePassword = 'PUBLIC-DUMMY-SMTP-PASSWORD-NOT-A-SECRET';
const fixtureEmail = 'fixture@example.test';
const keys = [
  'PRICE_ALERT_SMTP_HOST', 'PRICE_ALERT_SMTP_PORT', 'PRICE_ALERT_SMTP_USER',
  'PRICE_ALERT_SMTP_FROM', 'PRICE_ALERT_SMTP_PASSWORD', 'PRICE_ALERT_ACCOUNT_RECOVERY_ENABLED'
];
const created = () => keys.map(key => ({ key, id: 'fixture-' + key }));

async function execute({ env = {}, status = 201, result = { created: created(), failed: [] }, fetchError, jsonError, smtpError } = {}) {
  const calls = [];
  const logs = [];
  const errors = [];
  const timeouts = [];
  const smtpOptions = [];
  const events = [];
  let jsonReads = 0;
  // Never inherit host environment or install a real network primitive in this VM.
  const fakeProcess = {
    env: {
      VERCEL_PROJECT_ID: projectId,
      VERCEL_TOKEN: fixtureToken,
      ALERT_EMAIL_FROM: fixtureEmail,
      ALERT_EMAIL_PASSWORD: fixturePassword,
      ...env
    },
    exitCode: 0
  };
  const signal = { fixture: true };
  const context = vm.createContext({
    process: fakeProcess,
    console: { log: value => logs.push(String(value)), error: value => errors.push(String(value)) },
    AbortSignal: { timeout(milliseconds) { timeouts.push(milliseconds); return signal; } },
    nodemailer: {
      createTransport(options) {
        smtpOptions.push(JSON.parse(JSON.stringify(options)));
        events.push('smtp:create');
        return {
          async verify() { events.push('smtp:verify'); if (smtpError) throw smtpError; return true; },
          close() { events.push('smtp:close'); },
          sendMail() { throw new Error('Configuration check must never send mail'); }
        };
      }
    },
    async fetch(url, options) {
      events.push('fetch');
      calls.push({ url, options });
      if (fetchError) throw fetchError;
      return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
          jsonReads++;
          if (jsonError) throw jsonError;
          return result;
        }
      };
    }
  });
  let rejection = null;
  try {
    await new vm.Script('(async () => {\n' + executableSource + '\n})()', { filename: 'configure-membership-email.mjs' })
      .runInContext(context, { timeout: 1000 });
  } catch (error) {
    rejection = error;
  }
  return { calls, logs, errors, timeouts, signal, jsonReads, smtpOptions, events, rejection, exitCode: fakeProcess.exitCode };
}

function assertRedacted(run) {
  const output = [...run.logs, ...run.errors, run.rejection && run.rejection.message].join('\n');
  for (const value of [fixtureToken, fixturePassword, fixtureEmail]) assert.ok(!output.includes(value));
}

test('membership email deployment saves exactly six sensitive production keys and accepts HTTP 201 with empty failed list', async () => {
  const run = await execute();
  assert.equal(run.rejection, null);
  assert.equal(run.exitCode, 0);
  assert.equal(run.calls.length, 1);
  const call = run.calls[0];
  assert.equal(call.url, `https://api.vercel.com/v10/projects/${projectId}/env?teamId=${teamId}&upsert=true`);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers.Authorization, `Bearer ${fixtureToken}`);
  assert.equal(call.options.headers['Content-Type'], 'application/json');
  assert.equal(call.options.signal, run.signal);
  assert.deepEqual(run.timeouts, [30000]);
  assert.deepEqual(run.events, ['smtp:create', 'smtp:verify', 'smtp:close', 'fetch']);
  assert.deepEqual(run.smtpOptions, [{
    host: 'smtp.gmail.com', port: 465, secure: true, requireTLS: true,
    auth: { user: fixtureEmail, pass: fixturePassword },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    logger: false, debug: false
  }]);
  const entries = JSON.parse(call.options.body);
  assert.deepEqual(entries.map(entry => entry.key).sort(), [...keys].sort());
  assert.equal(entries.length, 6);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['key', 'target', 'type', 'value']);
    assert.equal(entry.type, 'sensitive');
    assert.deepEqual(entry.target, ['production']);
  }
  assert.deepEqual(Object.fromEntries(entries.map(entry => [entry.key, entry.value])), {
    PRICE_ALERT_SMTP_HOST: 'smtp.gmail.com',
    PRICE_ALERT_SMTP_PORT: '465',
    PRICE_ALERT_SMTP_USER: fixtureEmail,
    PRICE_ALERT_SMTP_FROM: fixtureEmail,
    PRICE_ALERT_SMTP_PASSWORD: fixturePassword,
    PRICE_ALERT_ACCOUNT_RECOVERY_ENABLED: 'true'
  });
  assert.equal(run.jsonReads, 1);
  assert.equal(run.errors.length, 0);
  assert.match(run.logs.join('\n'), /configuration saved\. Redeploy required\. No email sent\./);
  assertRedacted(run);
});

test('HTTP 201 with rejected entries fails even if all six keys also appear in created', async () => {
  const run = await execute({ result: {
    created: created(),
    failed: [{ key: keys[0], error: { message: fixturePassword } }]
  } });
  assert.equal(run.exitCode, 1);
  assert.equal(run.calls.length, 1);
  assert.deepEqual(run.errors, ['Vercel environment update rejected']);
  assert.deepEqual(run.logs, []);
  assertRedacted(run);
});

test('empty failed list never hides a missing key or absent created acknowledgement', async () => {
  for (const result of [
    { created: created().slice(0, -1), failed: [] },
    { created: [], failed: [] },
    { failed: [] },
    { created: created()[0], failed: [] },
    { created: [...created().slice(0, -1), created()[0]], failed: [] }
  ]) {
    const run = await execute({ result });
    assert.equal(run.exitCode, 1);
    assert.equal(run.calls.length, 1);
    assert.deepEqual(run.errors, ['Vercel environment update incomplete']);
    assert.deepEqual(run.logs, []);
    assertRedacted(run);
  }
});

test('HTTP error is fail-closed, does not parse provider body and never reports success', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    const run = await execute({ status, result: { error: { message: fixturePassword } } });
    assert.equal(run.exitCode, 1);
    assert.equal(run.jsonReads, 0);
    assert.equal(run.calls.length, 1);
    assert.deepEqual(run.errors, [`Vercel environment update HTTP ${status}`]);
    assert.deepEqual(run.logs, []);
    assertRedacted(run);
  }
});

test('wrong project or invalid inputs reject before any network call', async () => {
  for (const env of [
    { VERCEL_PROJECT_ID: 'prj_wrong-project' },
    { VERCEL_PROJECT_ID: '' },
    { VERCEL_TOKEN: '' },
    { ALERT_EMAIL_FROM: 'invalid-email' },
    { ALERT_EMAIL_FROM: 'a@example.test\r\nBcc:evil@example.test' },
    { ALERT_EMAIL_PASSWORD: '' },
    { ALERT_EMAIL_PASSWORD: 'dummy\r\nvalue' }
  ]) {
    const run = await execute({ env });
    assert.equal(run.calls.length, 0);
    assert.equal(run.smtpOptions.length, 0);
    assert.equal(run.jsonReads, 0);
    assert.equal(run.rejection && run.rejection.message, 'Membership email deployment inputs missing or invalid');
    assert.deepEqual(run.logs, []);
    assert.deepEqual(run.errors, []);
    assertRedacted(run);
  }
});

test('SMTP verify failure closes the transport, prevents deployment and logs no credentials', async () => {
  const run = await execute({ smtpError: new Error('SMTP authentication failed for ' + fixtureEmail + ' using ' + fixturePassword) });
  assert.equal(run.exitCode, 1);
  assert.equal(run.rejection, null);
  assert.equal(run.calls.length, 0);
  assert.equal(run.jsonReads, 0);
  assert.deepEqual(run.events, ['smtp:create', 'smtp:verify', 'smtp:close']);
  assert.deepEqual(run.errors, ['Membership email configuration failed']);
  assert.deepEqual(run.logs, []);
  assertRedacted(run);
});

test('provider rejection objects, transport failures and malformed JSON are redacted failures', async () => {
  for (const options of [
    { result: { created: created(), error: { message: fixturePassword } } },
    { result: { created: created(), errors: [{ message: fixturePassword }] } },
    { fetchError: new Error('Network error containing ' + fixtureToken) },
    { jsonError: new Error('Invalid response containing ' + fixturePassword) }
  ]) {
    const run = await execute(options);
    assert.equal(run.exitCode, 1);
    assert.equal(run.rejection, null);
    assert.equal(run.calls.length, 1);
    assert.equal(run.errors.length, 1);
    assert.deepEqual(run.logs, []);
    assertRedacted(run);
  }
});
