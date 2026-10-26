const test = require('node:test');
const assert = require('node:assert/strict');

test('publication waits for refreshed token, rejecting stale, malformed, and unavailable deployments', async () => {
  const { waitForPublishedAuth } = await import('../scripts/verify-oy-publication.mjs');
  let time = Date.parse('2026-09-07T00:00:00Z');
  const exp = time / 1000 + 86400;
  const payloads = [null, { jwtValid: false }, { jwtValid: true, jwtExpSeconds: exp - 1000 },
    { jwtValid: true, jwtExpSeconds: String(exp) }, { jwtValid: true, jwtExpSeconds: exp }];
  let calls = 0;
  const result = await waitForPublishedAuth(exp, { now: () => time, sleep: async ms => { time += ms; },
    fetchImpl: async (url, options) => {
      assert.match(url, /landing-proxy\?check=1$/);
      assert.equal(options.body, undefined);
      assert.equal(options.redirect, 'error');
      const payload = payloads[calls++];
      return { ok: payload !== null, json: async () => payload };
    } });
  assert.equal(calls, 5);
  assert.equal(result.published, true);
});

test('publication fails closed on timeout or invalid token without leaking response secrets', async () => {
  const { waitForPublishedAuth } = await import('../scripts/verify-oy-publication.mjs');
  let time = 1000000;
  const options = { now: () => time, timeoutMs: 30000, sleep: async ms => { time += ms; },
    fetchImpl: async () => { throw new Error('private-cookie-value'); } };
  await assert.rejects(waitForPublishedAuth(null, options), { message: 'OY_PUBLICATION_TOKEN_INVALID' });
  await assert.rejects(waitForPublishedAuth(100000, options), { message: 'OY_PUBLICATION_NOT_CONFIRMED' });
});

test('publication requires the exact new authentication fingerprint on the member domain', async () => {
  const { waitForPublishedAuth } = await import('../scripts/verify-oy-publication.mjs');
  let time = Date.parse('2026-10-26T00:00:00Z');
  const exp = time / 1000 + 86400;
  let calls = 0;
  await waitForPublishedAuth(exp, {
    expectedFingerprint: 'new-token-fingerprint', now: () => time,
    sleep: async ms => { time += ms; },
    fetchImpl: async url => {
      assert.equal(new URL(url).host, 'oy-stock.vercel.app');
      calls++;
      return { ok: true, json: async () => ({ jwtValid: true,
        jwtExpSeconds: calls === 1 ? exp + 86400 : exp,
        authFingerprint: calls < 3 ? 'old-token-fingerprint' : 'new-token-fingerprint' }) };
    }
  });
  assert.equal(calls, 3);
});
