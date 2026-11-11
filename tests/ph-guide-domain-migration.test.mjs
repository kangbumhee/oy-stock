import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { fixture, message } from './helpers/relay-fixture.mjs';
import { buildTransactionalMail } from '../lib/ph-guide-mail.mjs';
import { PROJECT_ID, SITE_ORIGIN as SETUP_ORIGIN, configureRelay, runConfigureRelay } from '../scripts/configure-ph-guide-relay.mjs';
import { STATUS_URL, checkRelayStatus } from '../scripts/check-ph-guide-relay-status.mjs';
const require = createRequire(import.meta.url);
const { SITE_ORIGIN, LEGACY_SITE_ORIGIN, SITE_ORIGINS } = require('../lib/ph-guide-relay.js');

test('both approved configured origins remain ready and report their actual configuration', async () => {
  assert.equal(SITE_ORIGIN, 'https://olivestock.co.kr');
  assert.equal(SETUP_ORIGIN, SITE_ORIGIN);
  assert.deepEqual(SITE_ORIGINS, [SITE_ORIGIN, LEGACY_SITE_ORIGIN]);
  for (const siteOrigin of SITE_ORIGINS) {
    const f = fixture({ PH_GUIDE_SITE_ORIGIN: siteOrigin });
    const result = await f.invoke({ action: 'status' });
    assert.equal(result.status, 200);
    assert.equal(result.data.siteOrigin, siteOrigin);
    assert.equal(result.data.mailReady, true);
    assert.equal(result.data.paymentReady, true);
  }
  for (const siteOrigin of ['', undefined, 'http://olivestock.co.kr', 'https://www.olivestock.co.kr', SITE_ORIGIN + '/', SITE_ORIGIN + '.evil.example', 'https://user:pass@olivestock.co.kr']) {
    const f = fixture({ PH_GUIDE_SITE_ORIGIN: siteOrigin });
    assert.equal((await f.invoke({ action: 'status' })).data.error, 'relay_site_origin_mismatch');
    assert.equal(f.writes.length, 0);
    assert.equal(f.smtpCalls.length, 0);
  }
});

test('old queued links and new mail render from their own validated origin during either configuration', async () => {
  for (const configuredOrigin of SITE_ORIGINS) for (const linkOrigin of SITE_ORIGINS) {
    const f = fixture({ PH_GUIDE_SITE_ORIGIN: configuredOrigin });
    const actionUrl = linkOrigin + '/guide?token=synthetic-token';
    const rendered = buildTransactionalMail({ kind: 'promotion-guide', connectionTransport: 'http-direct', publicUrl: linkOrigin, actionUrl });
    const input = { ...message(1), subject: '[PH 연결 가이드] 프로모션 이용 안내', text: rendered.text };
    assert.equal((await f.invoke(input)).status, 200);
    assert.equal(f.smtpCalls[0].mail.html, rendered.html);
    assert.equal(f.smtpCalls[0].mail.text, rendered.text);
    assert.ok(f.smtpCalls[0].mail.html.includes(actionUrl));
    assert.equal((await f.invoke(input)).data.deduplicated, true);
    assert.equal(f.smtpCalls.length, 1);
  }
});

test('origin migration rejects lookalikes, www, credentials, foreign paths and mixed-origin messages', async () => {
  const f = fixture();
  const urls = [
    'https://olivestock.co.kr.evil.example/verify', 'https://www.olivestock.co.kr/verify',
    'http://olivestock.co.kr/verify', 'https://user:pass@olivestock.co.kr/verify',
    'https://olivestock.co.kr:444/verify', 'https://olivestock.co.kr/admin',
    'https://ph-pro-guide.kbhjjan100.chatgpt.site.evil.example/verify',
    SITE_ORIGIN + '/verify?token=a\n' + LEGACY_SITE_ORIGIN + '/unsubscribe?token=b'
  ];
  for (let i = 0; i < urls.length; i++) {
    const result = await f.invoke({ ...message(i + 1), text: '이메일 확인: ' + urls[i] });
    assert.equal(result.status, 400);
    assert.equal(result.data.error, 'invalid_mail_link');
  }
  assert.equal(f.smtpCalls.length, 0);
});

test('a persisted legacy queued event retries after changing configured origin without a hash mismatch', async () => {
  const records = new Map(); let version = 0, timestamp = Date.now();
  const blob = {
    async get(key) { const record = records.get(key); return record ? { stream: Readable.from([Buffer.from(record.value)]), blob: { etag: record.etag } } : null; },
    async put(key, value, options) {
      const previous = records.get(key);
      if ((previous && !options.allowOverwrite) || (options.ifMatch && options.ifMatch !== previous?.etag)) { const error = new Error('CAS conflict'); error.statusCode = 412; throw error; }
      const etag = '"migration-' + (++version) + '"'; records.set(key, { value, etag }); return { etag };
    }
  };
  const input = { ...message(1), text: '이메일 확인 링크입니다.\n' + LEGACY_SITE_ORIGIN + '/verify?token=legacy-queued-token' };
  const before = fixture({ PH_GUIDE_SITE_ORIGIN: LEGACY_SITE_ORIGIN }, { blob, clock: () => timestamp,
    createTransport() { return { async sendMail() { const error = new Error('synthetic SMTP auth refusal'); error.code = 'EAUTH'; throw error; }, close() {} }; } });
  assert.equal((await before.invoke(input)).data.error, 'mail_not_accepted');
  timestamp += 60001;
  const after = fixture({ PH_GUIDE_SITE_ORIGIN: SITE_ORIGIN }, { blob, clock: () => timestamp });
  const delivered = await after.invoke(input);
  assert.equal(delivered.status, 200);
  assert.equal(after.smtpCalls.length, 1);
  assert.ok(after.smtpCalls[0].mail.html.includes(LEGACY_SITE_ORIGIN + '/verify?token=legacy-queued-token'));
  assert.equal((await after.invoke(input)).data.deduplicated, true);
  assert.equal(after.smtpCalls.length, 1);
});

test('configuration defaults to the new origin, permits explicit legacy transition, and rejects all other targets before writes', async () => {
  const base = { VERCEL_PROJECT_ID: PROJECT_ID, VERCEL_TOKEN: 'synthetic-token', PH_GUIDE_RELAY_SECRET: 'synthetic-secret-'.repeat(4) };
  for (const desired of [undefined, ...SITE_ORIGINS]) {
    let saved;
    await configureRelay({ ...base, ...(desired === undefined ? {} : { PH_GUIDE_SITE_ORIGIN: desired }) }, { fetch: async (_url, options) => {
      saved = JSON.parse(options.body); return { ok: true, json: async () => ({ created: saved, failed: [] }) };
    } });
    assert.equal(saved.find(entry => entry.key === 'PH_GUIDE_SITE_ORIGIN').value, desired || SITE_ORIGIN);
  }
  let writes = 0;
  for (const siteOrigin of ['https://evil.example', 'http://olivestock.co.kr', 'https://www.olivestock.co.kr', SITE_ORIGIN + '/', '']) {
    assert.equal(await runConfigureRelay({ ...base, PH_GUIDE_SITE_ORIGIN: siteOrigin }, { fetch: async () => { writes++; }, log() {}, errorLog() {} }), 1);
  }
  assert.equal(writes, 0);
});

test('diagnostics retain the stable Vercel relay address and only accept the two approved reported origins', async () => {
  assert.equal(STATUS_URL, 'https://oy-stock.vercel.app/api/ph-guide');
  for (const siteOrigin of SITE_ORIGINS) {
    const result = await checkRelayStatus({ PH_GUIDE_RELAY_SECRET: 'synthetic-secret-'.repeat(4) }, { fetch: async (url) => {
      assert.equal(url, STATUS_URL); return { ok: true, json: async () => ({ success: true, mailReady: true, paymentReady: true, smtpVerified: true, siteOrigin }) };
    } });
    assert.equal(result.siteOriginMatches, true);
  }
  await assert.rejects(checkRelayStatus({ PH_GUIDE_RELAY_SECRET: 'synthetic-secret-'.repeat(4) }, { fetch: async () => ({ ok: true, json: async () => ({ success: true, mailReady: true, paymentReady: true, smtpVerified: true, siteOrigin: 'https://evil.example' }) }) }), /status_invalid_response/);
});
