import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
const require = createRequire(import.meta.url);
const { createRelay, SITE_ORIGIN } = require('../../lib/ph-guide-relay.js');
const secret = 'synthetic_relay_secret_'.repeat(3);
const env = { PH_GUIDE_RELAY_SECRET: secret, PH_GUIDE_SITE_ORIGIN: SITE_ORIGIN, BLOB_READ_WRITE_TOKEN: 'synthetic_blob_token', PRICE_ALERT_DATA_KEY: '23'.repeat(32), PRICE_ALERT_SMTP_HOST: 'smtp.example.invalid', PRICE_ALERT_SMTP_PORT: '465', PRICE_ALERT_SMTP_USER: 'synthetic@example.invalid', PRICE_ALERT_SMTP_PASSWORD: 'synthetic_smtp_password', PRICE_ALERT_SMTP_FROM: 'synthetic@example.invalid', PRICE_ALERT_PORTONE_STORE_ID: 'store-synthetic', PRICE_ALERT_PORTONE_CHANNEL_KEY: 'channel-key-synthetic', PRICE_ALERT_PORTONE_API_SECRET: 'synthetic_portone_secret', PRICE_ALERT_PORTONE_EXPECTED_CHANNEL_TYPE: 'LIVE' };
const paymentId = n => 'ph_' + String(n).padStart(32, '0');
const mailId = n => 'mail_' + String(n).padStart(32, '0');
const message = n => ({ action: 'mail', eventId: mailId(n), to: 'buyer@example.invalid', subject: '[PH 연결 가이드] 이메일 확인', text: '요청하신 이메일 확인 링크입니다.\n' + SITE_ORIGIN + '/verify?token=synthetic-token' });
function fixture(overrides = {}, additions = {}) {
  const stored = new Map(), smtpCalls = [], providerCalls = [], headers = [], writes = [];
  let timestamp = Date.now(), version = 0, failPut = false, weakEtag = false;
  const blob = {
    async get(key, options) { headers.push(options); const old = stored.get(key); return old ? { stream: Readable.from([Buffer.from(old.value)]), blob: { etag: weakEtag ? 'W/"weak"' : old.etag } } : null; },
    async put(key, value, options) {
      if (failPut) { failPut = false; throw new Error('synthetic storage failure'); }
      const old = stored.get(key); if ((old && !options.allowOverwrite) || (options.ifMatch && old?.etag !== options.ifMatch)) { const e = new Error('synthetic CAS conflict'); e.statusCode = 412; throw e; }
      const etag = '"v' + (++version) + '"'; stored.set(key, { value, etag }); writes.push({ key, value, options }); return { etag };
    },
  };
  const deps = {
    env: { ...env, ...overrides }, blob, clock: () => timestamp,
    createTransport(options) { return { async verify() {}, async sendMail(mail) { smtpCalls.push({ mail, options }); return { accepted: [mail.to], rejected: [] }; }, close() {} }; },
    async fetch(url, options) { providerCalls.push({ url, options }); return new Response(null, { status: 204 }); }, ...additions,
  };
  const handler = createRelay(deps);
  async function invoke(body, auth = 'Bearer ' + secret, requestChanges = {}) {
    let status, result, responseHeaders = {};
    const req = { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body, ...requestChanges };
    const res = { set statusCode(value) { status = value; }, setHeader(key, value) { responseHeaders[key] = value; }, end(text) { result = JSON.parse(text); } };
    await handler(req, res); return { status, data: result, headers: responseHeaders };
  }
  return { invoke, stored, smtpCalls, providerCalls, headers, writes, advance(ms) { timestamp += ms; }, get timestamp() { return timestamp; }, failNextPut() { failPut = true; }, setWeakEtag() { weakEtag = true; } };
}
const prereg = n => ({ action: 'pre-register', paymentId: paymentId(n), idempotencyKey: 'ph-pre-register:' + paymentId(n) });
function rawPayment(n, changes = {}) { return { id: paymentId(n), status: 'PAID', storeId: env.PRICE_ALERT_PORTONE_STORE_ID, currency: 'KRW', channel: { key: env.PRICE_ALERT_PORTONE_CHANNEL_KEY, type: 'LIVE' }, amount: { total: 50000, cancelled: 0 }, method: { type: 'PaymentMethodEasyPay', provider: 'KAKAOPAY', card: { number: 'sensitive-card-fixture' } }, paidAt: '2026-10-05T10:00:00Z', customer: { email: 'private-customer@example.invalid' }, receiptUrl: 'https://private.example.invalid', ...changes }; }

export { fixture, env, secret, SITE_ORIGIN, prereg, paymentId, message, rawPayment };
