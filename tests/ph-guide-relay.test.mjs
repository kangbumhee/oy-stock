import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, env, secret, SITE_ORIGIN, prereg, paymentId, message, rawPayment } from './helpers/relay-fixture.mjs';
test('unique relay authorization fails before storage, provider, or SMTP side effects', async () => {
  const f = fixture(); assert.equal((await f.invoke({ action: 'status' }, 'wrong')).status, 401); assert.equal(f.writes.length, 0); assert.equal(f.providerCalls.length, 0); assert.equal(f.smtpCalls.length, 0);
  assert.equal((await f.invoke({ action: 'status' }, undefined, { method: 'GET' })).status, 405);
  const missing = fixture({ PH_GUIDE_RELAY_SECRET: '' }); assert.equal((await missing.invoke({ action: 'status' })).status, 401);
});
test('authenticated status reports configuration only, secrets never leave, optional SMTP verify sends nothing', async () => {
  let verified = 0, sent = 0;
  const f = fixture({}, { createTransport() { return { async verify() { verified++; }, async sendMail() { sent++; }, close() {} }; } });
  const ready = await f.invoke({ action: 'status', verifySmtp: true }); assert.equal(ready.status, 200); assert.equal(ready.data.mailReady, true); assert.equal(ready.data.paymentReady, true); assert.equal(ready.data.smtpVerified, true); assert.equal(verified, 1); assert.equal(sent, 0);
  for (const value of [secret, env.PRICE_ALERT_SMTP_PASSWORD, env.PRICE_ALERT_PORTONE_API_SECRET, env.PRICE_ALERT_DATA_KEY]) assert.ok(!JSON.stringify(ready.data).includes(value));
  const disabled = fixture({ PRICE_ALERT_PORTONE_EXPECTED_CHANNEL_TYPE: 'TEST' }); const s = await disabled.invoke({ action: 'status' }); assert.equal(s.data.paymentReady, false); assert.equal(s.data.mailReady, true);
  const broken = fixture({ BLOB_READ_WRITE_TOKEN: '' }); const b = await broken.invoke({ action: 'status' }); assert.equal(b.data.paymentReady, false); assert.equal(b.data.mailReady, false);
  const wrongOrigin = fixture({ PH_GUIDE_SITE_ORIGIN: 'https://wrong.example.invalid' }); assert.equal((await wrongOrigin.invoke({ action: 'status' })).data.error, 'relay_site_origin_mismatch'); assert.equal(wrongOrigin.writes.length, 0);
});
test('mail rejects foreign URLs, header injection, HTML payload, original namespace, and oversized requests', async () => {
  const f = fixture();
  const cases = [{ text: 'Link https://evil.example/verify?token=hidden' }, { text: 'Link https://ph-pro-guide.kbhjjan100.chatgpt.site.evil.example/verify' }, { text: 'Link https://user:pass@ph-pro-guide.kbhjjan100.chatgpt.site/verify' }, { text: 'Link mailto:attacker@example.invalid' }, { text: 'Link javascript:alert(1)' }, { subject: '[PH 연결 가이드] test\r\nBcc:attacker@example.invalid' }, { html: '<img src="https://evil.example">' }, { eventId: 'oypa_existingpayment' }];
  for (const changes of cases) assert.equal((await f.invoke({ ...message(1), ...changes })).status, 400);
  assert.equal((await f.invoke({ ...message(1), text: 'a'.repeat(17000) })).status, 413); assert.equal(f.smtpCalls.length, 0);
  assert.equal((await f.invoke({ ...message(1), text: '고객 지원: mailto:kbhjjan@naver.com' })).status, 200);
});
test('SMTP accepted receipt is persistent, idempotent, encrypted, and scoped outside original stock records', async () => {
  const f = fixture(); const first = await f.invoke(message(1)); assert.equal(first.status, 200); assert.equal(first.data.smtpAccepted, true); assert.equal(first.data.deduplicated, false);
  const duplicate = await f.invoke(message(1)); assert.equal(duplicate.data.deduplicated, true); assert.equal(f.smtpCalls.length, 1);
  const different = await f.invoke({ ...message(1), to: 'another@example.invalid' }); assert.equal(different.status, 409); assert.equal(different.data.error, 'mail_event_mismatch');
  for (const write of f.writes) { assert.ok(write.key.startsWith('ph-guide-relay/v1/')); assert.ok(!write.key.includes('oliveyoung/price-alerts')); for (const value of [message(1).to, message(1).text, message(1).subject, 'synthetic-token', env.PRICE_ALERT_SMTP_PASSWORD]) assert.ok(!write.value.includes(value)); }
  assert.ok(f.headers.every(options => options.headers['Accept-Encoding'] === 'identity' && options.useCache === false));
  assert.ok(f.writes.some(item => item.options.ifMatch)); assert.match(f.smtpCalls[0].mail.messageId, /^<[a-f0-9]{64}@ph-pro-guide\.kbhjjan100\.chatgpt\.site>$/);
  assert.equal(f.smtpCalls[0].options.requireTLS, true); assert.equal(f.smtpCalls[0].mail.disableFileAccess, true); assert.equal(f.smtpCalls[0].mail.disableUrlAccess, true);
});
test('HTML mail keeps safe purchase CTA, Windows-PC restriction and separate OpenAI fee while escaping body HTML', async () => {
  const f = fixture(); const input = { ...message(1), text: '이메일 확인 완료. <img src=x onerror=alert(1)>\n구매하기: ' + SITE_ORIGIN + '/checkout?token=synthetic-token\n이메일 확인 자체는 결제 승인이 아닙니다.' };
  assert.equal((await f.invoke(input)).status, 200); const mail = f.smtpCalls[0].mail;
  assert.ok(mail.html.includes('50,000원 안내 구매하기')); assert.ok(mail.html.includes('Windows PC 전용')); assert.ok(mail.html.includes('ChatGPT 구독료는 OpenAI에 별도로 결제')); assert.ok(mail.html.includes('&lt;img')); assert.ok(!mail.html.includes('<img src=x'));
  assert.ok(mail.html.includes(SITE_ORIGIN + '/checkout?token=synthetic-token')); assert.ok(mail.text.includes('50,000원'));
});
test('concurrent same-event mail requests acquire one strong-CAS lease and transmit once', async () => {
  let calls = 0, release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({}, { createTransport() { return { async sendMail(mail) { calls++; await gate; return { accepted: [mail.to], rejected: [] }; }, close() {} }; } });
  const a = f.invoke(message(1)), b = f.invoke(message(1)); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 1); release(); const results = await Promise.all([a, b]);
  assert.equal(results.filter(result => result.status === 200).length, 1); assert.equal(results.filter(result => result.status === 409).length, 1); assert.equal((await f.invoke(message(1))).data.deduplicated, true);
});
test('SMTP DATA connection loss is ambiguous and automatic repeated calls never send again', async () => {
  let sends = 0; const f = fixture({}, { createTransport() { return { async sendMail() { sends++; const e = new Error('contains secret recipient details'); e.code = 'ECONNECTION'; e.command = 'DATA'; throw e; }, close() {} }; } });
  const a = await f.invoke(message(1)); assert.equal(a.status, 409); assert.equal(a.data.error, 'mail_delivery_ambiguous'); f.advance(1000000); assert.equal((await f.invoke(message(1))).data.error, 'mail_delivery_ambiguous'); assert.equal(sends, 1); assert.ok(!JSON.stringify(a).includes('secret recipient'));
});
test('SMTP success with failed receipt commit returns uncertainty and cannot retransmit after lease', async () => {
  let sends = 0, f; f = fixture({}, { createTransport() { return { async sendMail(mail) { sends++; f.failNextPut(); return { accepted: [mail.to], rejected: [] }; }, close() {} }; } });
  const result = await f.invoke(message(1)); assert.equal(result.status, 503); assert.equal(result.data.success, false); assert.equal(result.data.error, 'mail_delivery_ambiguous');
  assert.equal((await f.invoke(message(1))).data.error, 'mail_delivery_pending'); f.advance(90001); assert.equal((await f.invoke(message(1))).data.error, 'mail_delivery_ambiguous'); assert.equal(sends, 1);
});
test('proven SMTP pre-DATA failure retries with bounded backoff and ends at five attempts', async () => {
  let sends = 0; const f = fixture({}, { createTransport() { return { async sendMail() { sends++; const e = new Error('synthetic refusal'); e.code = 'EAUTH'; e.command = 'AUTH'; throw e; }, close() {} }; } });
  for (let attempt = 1; attempt <= 5; attempt++) { const result = await f.invoke(message(1)); assert.equal(result.status, 503); assert.equal(result.data.error, 'mail_not_accepted'); f.advance(Number(result.headers['Retry-After']) * 1000 + 1); }
  assert.equal((await f.invoke(message(1))).data.error, 'mail_attempts_exhausted'); assert.equal(sends, 5);
});
test('weak ETags block delivery before SMTP; mail readiness is independent of missing PG', async () => {
  const f = fixture({ PRICE_ALERT_PORTONE_API_SECRET: '' }); assert.equal((await f.invoke({ action: 'status' })).data.mailReady, true); assert.equal((await f.invoke({ action: 'status' })).data.paymentReady, false);
  await f.invoke(message(1)); f.setWeakEtag(); const result = await f.invoke(message(2)); assert.equal(result.status, 503); assert.equal(f.smtpCalls.length, 1);
});
test('pre-register uses only ph payment IDs, fixed amount, KRW, own namespace and stable provider idempotency', async () => {
  const f = fixture(); for (const changes of [{ paymentId: 'oypa_existingoriginalpayment123' }, { totalAmount: 1 }, { idempotencyKey: 'arbitrary' }]) assert.equal((await f.invoke({ ...prereg(1), ...changes })).status, 400);
  assert.equal(f.providerCalls.length, 0); const first = await f.invoke(prereg(1)); assert.equal(first.status, 200); assert.equal((await f.invoke(prereg(1))).data.deduplicated, true); assert.equal(f.providerCalls.length, 1);
  const call = f.providerCalls[0]; assert.equal(call.url, 'https://api.portone.io/payments/' + paymentId(1) + '/pre-register'); assert.deepEqual(JSON.parse(call.options.body), { storeId: env.PRICE_ALERT_PORTONE_STORE_ID, totalAmount: 50000, currency: 'KRW' }); assert.equal(call.options.headers['Idempotency-Key'], JSON.stringify(prereg(1).idempotencyKey));
});
test('authoritative payment GET returns essential fields while stripping PII/card/receipt data', async () => {
  const f = fixture({}, { async fetch(url) { return url.endsWith('/pre-register') ? new Response(null, { status: 204 }) : Response.json(rawPayment(1)); } });
  assert.equal((await f.invoke({ action: 'payment', paymentId: paymentId(1) })).status, 404); await f.invoke(prereg(1));
  const result = await f.invoke({ action: 'payment', paymentId: paymentId(1) }); assert.equal(result.status, 200); assert.equal(result.data.payment.amount.total, 50000); assert.equal(result.data.payment.amount.cancelled, 0); assert.equal(result.data.payment.method.provider, 'KAKAOPAY');
  for (const value of ['private-customer', 'sensitive-card', 'private.example', 'customer', 'receiptUrl', env.PRICE_ALERT_PORTONE_API_SECRET]) assert.ok(!JSON.stringify(result.data).includes(value));
});
test('amount/store/channel/test/provider mismatches and missing cancellation amount never become a valid paid contract', async () => {
  let changes = {}; const f = fixture({}, { async fetch(url) { return url.endsWith('/pre-register') ? new Response(null, { status: 204 }) : Response.json(rawPayment(1, changes)); } }); await f.invoke(prereg(1));
  for (const patch of [{ amount: { total: 1, cancelled: 0 } }, { storeId: 'store-otherstore' }, { channel: { key: 'channel-key-other', type: 'LIVE' } }, { channel: { key: env.PRICE_ALERT_PORTONE_CHANNEL_KEY, type: 'TEST' } }, { method: { type: 'PaymentMethodEasyPay', provider: 'OTHER' } }]) { changes = patch; assert.equal((await f.invoke({ action: 'payment', paymentId: paymentId(1) })).data.error, 'provider_contract_mismatch'); }
  changes = { amount: { total: 50000 } }; const missing = await f.invoke({ action: 'payment', paymentId: paymentId(1) }); assert.equal(missing.data.payment.amount.cancelled, null);
  changes = { status: 'PAY_PENDING', amount: {} }; const pending = await f.invoke({ action: 'payment', paymentId: paymentId(1) }); assert.equal(pending.status, 200); assert.equal(pending.data.payment.status, 'PAY_PENDING');
});
