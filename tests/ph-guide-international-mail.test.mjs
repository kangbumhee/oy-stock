import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, message, SITE_ORIGIN } from './helpers/relay-fixture.mjs';
import { buildInternationalMail, renderInternationalMail } from '../lib/ph-guide-international-mail.mjs';
import { buildTransactionalMail, makeServiceUrl } from '../lib/ph-guide-mail.mjs';

const LEGACY_ORIGIN = 'https://ph-pro-guide.kbhjjan100.chatgpt.site';
const SUPPORT = 'https://wa.me/qr/ZLYDDZ6W77XTG1';
function international(n, kind = 'verify', origin = SITE_ORIGIN, changes = {}) {
  const built = buildInternationalMail({ kind, publicUrl: origin, token: 'synthetic-token.signature', unsubscribeToken: 'synthetic-unsubscribe.signature', expiryDate: '2026-11-22', ...changes });
  return { ...message(n), subject: built.subject, text: built.text };
}

test('all four exact English subjects deliver the source English HTML and their signed purpose-specific links', async () => {
  const f = fixture(); let n = 0;
  for (const kind of ['verify', 'checkout', 'reminder', 'guide']) {
    const input = international(++n, kind);
    const result = await f.invoke(input);
    assert.equal(result.status, 200, kind);
    const mail = f.smtpCalls.at(-1).mail;
    assert.deepEqual({ subject: mail.subject, text: mail.text, html: mail.html }, renderInternationalMail(input.subject, input.text, SITE_ORIGIN));
    assert.ok(mail.html.includes('<html lang="en">'));
    assert.ok(mail.html.includes('href="' + SUPPORT + '"'));
    assert.ok(mail.html.includes('/en/unsubscribe?token=synthetic-unsubscribe.signature'));
    assert.ok(!mail.html.includes('19,500'));
    assert.equal(mail.disableFileAccess, true);
    assert.equal(mail.disableUrlAccess, true);
    assert.equal((await f.invoke(input)).data.deduplicated, true);
  }
  assert.equal(f.smtpCalls.length, 4);
});

test('English guide preserves each real instruction, Windows transport branch and 30-day/one-hour terms', async () => {
  for (const connectionTransport of ['pending', 'http-direct', 'wss-tunnel']) {
    const f = fixture();
    const input = international(1, 'guide', SITE_ORIGIN, { connectionTransport });
    assert.equal((await f.invoke(input)).status, 200);
    const mail = f.smtpCalls[0].mail;
    assert.equal(mail.text, input.text);
    for (const step of ['1. Preparation:', '2. Connection', '3. Start:', '4. Windows:', '5. Authentication:', '6. ChatGPT:', '7. Billing:', '8. Payment:', '9. Finish:']) assert.ok(mail.text.includes(step), step);
    for (const phrase of ['30 days from payment', 'one-hour session starts now', 'accurate billing country, address and tax information', 'only pay OpenAI', 'restore your original Windows proxy settings']) assert.ok(mail.text.includes(phrase), phrase);
    assert.equal(mail.text.includes('run START.cmd'), connectionTransport === 'wss-tunnel');
    assert.equal(mail.html, renderInternationalMail(input.subject, input.text, SITE_ORIGIN).html);
  }
});

test('English rendering follows either approved link origin across configuration migration and rejects mixed origins', async () => {
  for (const configured of [SITE_ORIGIN, LEGACY_ORIGIN]) for (const linked of [SITE_ORIGIN, LEGACY_ORIGIN]) {
    const f = fixture({ PH_GUIDE_SITE_ORIGIN: configured });
    const input = international(1, 'guide', linked);
    assert.equal((await f.invoke(input)).status, 200);
    assert.equal(f.smtpCalls[0].mail.html, renderInternationalMail(input.subject, input.text, linked).html);
  }
  const f = fixture();
  const mixed = { ...international(1), text: international(1).text.replace(SITE_ORIGIN + '/en/unsubscribe', LEGACY_ORIGIN + '/en/unsubscribe') };
  assert.equal((await f.invoke(mixed)).data.error, 'invalid_mail_link');
  assert.equal(f.smtpCalls.length, 0);
});

test('English signed links require the subject route, exactly one safe token and canonical approved HTTPS URL', async () => {
  const input = international(1), action = SITE_ORIGIN + '/en/verify?token=synthetic-token.signature';
  const invalid = [
    SITE_ORIGIN + '/verify?token=a', SITE_ORIGIN + '/en/checkout?token=a', SITE_ORIGIN + '/en/guide?token=a',
    SITE_ORIGIN + '/en/verify', SITE_ORIGIN + '/en/verify?token=', SITE_ORIGIN + '/en/verify?token=a&token=b',
    SITE_ORIGIN + '/en/verify?token=a&redirect=https%3A%2F%2Fevil.example', SITE_ORIGIN + '/en/verify?other=a',
    SITE_ORIGIN + '/en/verify?token=a#fragment', SITE_ORIGIN + '/en/verify?token=abc%0Adef',
    SITE_ORIGIN + '/en/verify?token=abc%2Fdef', SITE_ORIGIN + '/en/verify?token=' + 'a'.repeat(2049),
    SITE_ORIGIN + '/en/verify/?token=a', SITE_ORIGIN + '/en/admin/../verify?token=a',
    'https://user:pass@olivestock.co.kr/en/verify?token=a', 'https://olivestock.co.kr:443/en/verify?token=a',
    'https://olivestock.co.kr:444/en/verify?token=a', 'http://olivestock.co.kr/en/verify?token=a',
    'https://www.olivestock.co.kr/en/verify?token=a', 'https://olivestock.co.kr.evil.example/en/verify?token=a',
    SITE_ORIGIN + '/en/unsubscribe?token=a',
  ];
  for (let n = 0; n < invalid.length; n++) {
    const f = fixture();
    const result = await f.invoke({ ...input, text: input.text.replace(action, invalid[n]) });
    assert.equal(result.status, 400, invalid[n]);
    assert.equal(result.data.error, 'invalid_mail_link', invalid[n]);
    assert.equal(f.smtpCalls.length, 0);
  }
});

test('only the exact WhatsApp QR support link is accepted, and English allowance cannot widen Korean links', async () => {
  const input = international(1);
  for (const link of [SUPPORT + '?x=1', SUPPORT + '#x', SUPPORT + '/', 'https://wa.me/qr/OTHER', 'https://wa.me/123456', 'http://wa.me/qr/ZLYDDZ6W77XTG1', 'https://wa.me.evil.example/qr/ZLYDDZ6W77XTG1', 'https://user:pass@wa.me/qr/ZLYDDZ6W77XTG1']) {
    const f = fixture();
    assert.equal((await f.invoke({ ...input, text: input.text.replace(SUPPORT, link) })).data.error, 'invalid_mail_link', link);
    assert.equal(f.smtpCalls.length, 0);
  }
  for (const subject of ['[PH 연결 가이드] 이메일 확인', '[Pro Route] 이메일 확인']) {
    for (const link of [SUPPORT, SITE_ORIGIN + '/en/verify?token=a']) {
      const f = fixture();
      assert.equal((await f.invoke({ ...message(1), subject, text: '이메일 확인 링크입니다.\n' + link })).data.error, 'invalid_mail_link');
      assert.equal(f.smtpCalls.length, 0);
    }
  }
});

test('unrecognized Pro Route subjects, header injection, arbitrary HTML payloads and external links still fail closed', async () => {
  const input = international(1);
  const cases = [
    { subject: '[Pro Route] arbitrary campaign' }, { subject: '[Pro Route] Verify your email\r\nBcc:attacker@example.invalid' },
    { subject: '[Pro Route] Verify your email ' }, { html: '<img src="https://evil.example">' },
    { text: input.text + '\nhttps://evil.example/en/verify?token=a' },
    { text: input.text + '\nmailto:attacker@example.invalid' }, { text: input.text + '\njavascript:alert(1)' },
    { text: input.text + '\nwww.evil.example' }, { text: input.text + '\nftp://evil.example' },
    { text: input.text + '\n' + SITE_ORIGIN + '/en/unsubscribe?token=b&x=c' },
  ];
  for (const change of cases) {
    const f = fixture();
    assert.equal((await f.invoke({ ...input, ...change })).status, 400, JSON.stringify(change));
    assert.equal(f.smtpCalls.length, 0);
  }
  const f = fixture();
  const escaped = { ...input, text: input.text + '\n\n<img src=x onerror=alert(1)>' };
  assert.equal((await f.invoke(escaped)).status, 200);
  assert.ok(!f.smtpCalls[0].mail.html.includes('<img'));
  assert.ok(f.smtpCalls[0].mail.html.includes('&lt;img'));
});

test('current exact Korean Pro Route subjects retain the Korean renderer and generated content', async () => {
  const f = fixture(); let n = 0;
  for (const kind of ['verify', 'checkout', 'expiry-reminder', 'paid-guide', 'promotion-guide']) {
    const path = kind === 'verify' ? '/verify' : ['checkout', 'expiry-reminder'].includes(kind) ? '/checkout' : '/guide';
    const built = buildTransactionalMail({ kind, publicUrl: SITE_ORIGIN, actionUrl: makeServiceUrl(SITE_ORIGIN, path, 'synthetic-token'), expiryDate: '2026-11-22', connectionTransport: 'pending' });
    const input = { ...message(++n), subject: built.subject, text: built.text };
    assert.equal((await f.invoke(input)).status, 200, kind);
    const mail = f.smtpCalls.at(-1).mail;
    assert.ok(mail.html.includes('<html lang="ko">'));
    assert.equal(mail.text, built.text);
    assert.equal(mail.html, built.html);
  }
  assert.equal(f.smtpCalls.length, 5);
});

test('English delivery keeps encrypted records, original event hashes, deduplication and one concurrent SMTP lease', async () => {
  const f = fixture(); const input = international(1, 'guide');
  const results = await Promise.all([f.invoke(input), f.invoke(input), f.invoke(input)]);
  assert.ok(results.some(result => result.status === 200));
  assert.equal(f.smtpCalls.length, 1);
  assert.equal((await f.invoke(input)).data.deduplicated, true);
  assert.equal((await f.invoke({ ...input, text: input.text + '\nChanged body' })).data.error, 'mail_event_mismatch');
  for (const write of f.writes) for (const sensitive of [input.to, input.text, input.subject, 'synthetic-token.signature', 'synthetic-unsubscribe.signature']) assert.ok(!write.value.includes(sensitive));
});

test('English SMTP DATA uncertainty cannot be retried as a second delivery', async () => {
  let sends = 0;
  const f = fixture({}, { createTransport() { return { async sendMail() { sends++; const error = new Error('synthetic SMTP DATA timeout'); error.code = 'ETIMEDOUT'; error.command = 'DATA'; throw error; }, close() {} }; } });
  const input = international(1, 'checkout');
  assert.equal((await f.invoke(input)).data.error, 'mail_delivery_ambiguous');
  f.advance(1000000);
  assert.equal((await f.invoke(input)).data.error, 'mail_delivery_ambiguous');
  assert.equal(sends, 1);
});
