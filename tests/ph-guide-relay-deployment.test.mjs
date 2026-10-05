import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PROJECT_ID, TEAM_ID, SITE_ORIGIN, configureRelay, runConfigureRelay } from '../scripts/configure-ph-guide-relay.mjs';
import { STATUS_URL, checkRelayStatus, runRelayStatus } from '../scripts/check-ph-guide-relay-status.mjs';

const TOKEN = 'synthetic_vercel_token_never_print';
const SECRET = 'synthetic_relay_secret_never_print_0123456789';
const env = () => ({ VERCEL_PROJECT_ID: PROJECT_ID, VERCEL_TOKEN: TOKEN, PH_GUIDE_RELAY_SECRET: SECRET,
  PRICE_ALERT_SMTP_PASSWORD: 'synthetic_existing_password_preserve' });
const accepted = entries => ({ ok: true, status: 201, json: async () => ({ created: entries, failed: [] }) });

test('upsert mutates exactly two production keys and preserves every other variable and preview scope', async () => {
  const original = new Map([
    ['production:PRICE_ALERT_SMTP_PASSWORD', 'synthetic_original_password'],
    ['production:PRICE_ALERT_PORTONE_API_SECRET', 'synthetic_original_portone'],
    ['preview:PH_GUIDE_SITE_ORIGIN', 'https://preview.example.invalid'],
    ['production:PH_GUIDE_RELAY_SECRET', 'synthetic_old_relay_secret']
  ]);
  const state = new Map(original), calls = [];
  const result = await configureRelay(env(), { fetch: async (url, options) => {
    calls.push({ url, options });
    const entries = JSON.parse(options.body);
    for (const entry of entries) for (const target of entry.target) state.set(`${target}:${entry.key}`, entry.value);
    return accepted(entries);
  } });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://api.vercel.com');
  assert.equal(url.pathname, `/v10/projects/${PROJECT_ID}/env`);
  assert.equal(url.searchParams.get('teamId'), TEAM_ID);
  assert.equal(url.searchParams.get('upsert'), 'true');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), [
    { key: 'PH_GUIDE_RELAY_SECRET', value: SECRET, type: 'sensitive', target: ['production'] },
    { key: 'PH_GUIDE_SITE_ORIGIN', value: SITE_ORIGIN, type: 'plain', target: ['production'] }
  ]);
  for (const [key, value] of original) if (key !== 'production:PH_GUIDE_RELAY_SECRET') assert.equal(state.get(key), value);
  assert.equal(state.get('production:PH_GUIDE_RELAY_SECRET'), SECRET);
  assert.deepEqual(result, { savedKeys: ['PH_GUIDE_RELAY_SECRET', 'PH_GUIDE_SITE_ORIGIN'], target: 'production' });
});

test('wrong project, missing token and invalid relay secret make no API request', async () => {
  let calls = 0;
  for (const inputs of [ { ...env(), VERCEL_PROJECT_ID: 'prj_other' }, { ...env(), VERCEL_TOKEN: '' },
    { ...env(), PH_GUIDE_RELAY_SECRET: 'short' }, { ...env(), PH_GUIDE_RELAY_SECRET: SECRET + '\n' } ]) {
    assert.equal(await runConfigureRelay(inputs, { fetch: async () => { calls++; }, log: () => {}, errorLog: () => {} }), 1);
  }
  assert.equal(calls, 0);
});

test('HTTP failure never reads or prints a provider error body', async () => {
  const output = []; let read = 0;
  const code = await runConfigureRelay(env(), { fetch: async () => ({ ok: false, status: 403,
    json: async () => { read++; throw new Error(TOKEN + SECRET); }, text: async () => { read++; return SECRET; } }),
    log: x => output.push(x), errorLog: x => output.push(x) });
  assert.equal(code, 1); assert.equal(read, 0);
  assert.deepEqual(output, ['PH relay setup failed: vercel_rejected (HTTP 403).']);
});

test('provider values and thrown network secrets never appear in script output', async () => {
  const output = [];
  const dependencies = { log: x => output.push(x), errorLog: x => output.push(x) };
  assert.equal(await runConfigureRelay(env(), { ...dependencies, fetch: async (_url, options) => accepted(JSON.parse(options.body)) }), 0);
  assert.equal(await runConfigureRelay(env(), { ...dependencies, fetch: async () => { throw new Error(TOKEN + SECRET); } }), 1);
  const text = output.join('\n');
  for (const value of [TOKEN, SECRET, env().PRICE_ALERT_SMTP_PASSWORD]) assert.equal(text.includes(value), false);
  assert.match(text, /vercel_unavailable/);
});

test('partial success, unexpected scope and malformed success fail before the deployment can start', async () => {
  for (const result of [
    { created: [{ key: 'PH_GUIDE_RELAY_SECRET', target: ['production'] }], failed: [] },
    { created: [{ key: 'PH_GUIDE_RELAY_SECRET', target: ['production'] }, { key: 'PH_GUIDE_SITE_ORIGIN', target: ['preview'] }], failed: [] },
    { created: [], failed: [{ error: { message: SECRET } }] }, null
  ]) {
    assert.equal(await runConfigureRelay(env(), { fetch: async () => ({ ok: true, status: 201, json: async () => result }),
      log: () => {}, errorLog: () => {} }), 1);
  }
});

test('workflow is manual, serialized with existing production deploys and uses configure before pinned deploy stages', () => {
  const source = fs.readFileSync(new URL('../.github/workflows/configure-ph-guide-relay.yml', import.meta.url), 'utf8');
  assert.match(source, /on:\s*\n\s+workflow_dispatch:/);
  assert.doesNotMatch(source, /\n\s+(?:push|pull_request|schedule|workflow_run):/);
  assert.match(source, /group: vercel-production-deploy/); assert.match(source, /cancel-in-progress: false/);
  const stages = ['node scripts/configure-ph-guide-relay.mjs', 'vercel@50.32.5 pull', 'vercel@50.32.5 build', 'vercel@50.32.5 deploy', 'node scripts/check-ph-guide-relay-status.mjs'];
  let previous = -1; for (const stage of stages) { const index = source.indexOf(stage); assert.ok(index > previous); previous = index; }
  assert.equal((source.match(/vercel@50\.32\.5 /g) || []).length, 3);
  assert.doesNotMatch(source, /(?:ALERT_EMAIL_PASSWORD|PRICE_ALERT_SMTP_PASSWORD|PORTONE_API_SECRET|sendMail|env\s+ls|env\s+rm)/);
});

test('deployed diagnostic requests only status plus SMTP verify and discards all private response fields', async () => {
  const calls = [], output = [];
  const result = { success: true, mailReady: true, paymentReady: true, smtpVerified: true, siteOrigin: SITE_ORIGIN,
    storeId: 'synthetic_private_store_id', channelKey: 'synthetic_private_channel_key', injectedSecret: SECRET };
  const dependencies = { fetch: async (url, options) => { calls.push({ url, options });
    return { ok: true, status: 200, json: async () => result }; }, log: x => output.push(x), errorLog: x => output.push(x) };
  assert.deepEqual(await checkRelayStatus(env(), dependencies), {
    smtpVerified: true, mailConfigured: true, portOneConfigured: true, siteOriginMatches: true
  });
  assert.equal(calls[0].url, STATUS_URL); assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'status', verifySmtp: true });
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(await runRelayStatus(env(), dependencies), 0);
  for (const value of [TOKEN, SECRET, result.storeId, result.channelKey]) assert.equal(output.join('\n').includes(value), false);
  assert.match(output.join('\n'), /No email was sent/);
});

test('incomplete SMTP or PortOne configuration remains unverified and diagnostic errors never reveal bodies', async () => {
  const output = [], logs = { log: x => output.push(x), errorLog: x => output.push(x) };
  for (const fields of [{ smtpVerified: false }, { paymentReady: false }, { mailReady: false }, { smtpVerified: null }]) {
    assert.equal(await runRelayStatus(env(), { ...logs, fetch: async () => ({ ok: true, status: 200,
      json: async () => ({ success: true, mailReady: true, paymentReady: true, smtpVerified: true, siteOrigin: SITE_ORIGIN, ...fields }) }) }), 1);
  }
  let read = 0;
  assert.equal(await runRelayStatus(env(), { ...logs, fetch: async () => ({ ok: false, status: 401,
    json: async () => { read++; return { error: SECRET }; } }) }), 1);
  assert.equal(read, 0); assert.equal(output.join('\n').includes(SECRET), false);
  assert.equal(await runRelayStatus(env(), { ...logs, fetch: async () => { throw new Error(SECRET); } }), 1);
  assert.equal(output.join('\n').includes(SECRET), false);
});
