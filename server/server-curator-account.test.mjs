import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

process.env.OY_SERVER_DISABLE_START = '1';
const {
  clearCuratorSession, curatorAuth, curatorAuthFingerprint, ensureCuratorSession,
  generateCuratorLink, getCuratorLinkCache, setCuratorLinkCache
} = await import('./server.mjs');

const AUTH_NAMES = [
  'OY_REFRESH_COOKIE', 'OY_CURATOR_COOKIE', 'OY_SESSION_ID', 'OY_LINKAGE_STRING',
  'OY_LINKAGE_JWT', 'OLIVEYOUNG_LINKAGE_STRING', 'OLIVEYOUNG_LINKAGE_JWT',
  'OLIVEYOUNG_AFFILIATE_REGISTER_ID'
];
const GOODS = 'A000000171423';

function token(subject, expiresIn = 3600) {
  const payload = { sub: subject, exp: Math.floor(Date.now() / 1000) + expiresIn };
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture-signature`;
}

function cookie(jwt, session = 'fixture-session') {
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from('cjone_g4de7353f1'), null);
  const hex = Buffer.concat([cipher.update(jwt, 'utf8'), cipher.final()]).toString('hex');
  return `OYSESSIONID=${session}; linkageString=${hex}`;
}

async function withEnvironment(values, operation) {
  const saved = Object.fromEntries(AUTH_NAMES.map(name => [name, process.env[name]]));
  try {
    for (const name of AUTH_NAMES) {
      if (values[name] == null) delete process.env[name];
      else process.env[name] = values[name];
    }
    await operation();
  } finally {
    await clearCuratorSession();
    for (const name of AUTH_NAMES) {
      if (saved[name] == null) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test('Cloud Run selects only the canonical account and partitions cached links by account and partner', async () => {
  const currentJwt = token('current-account');
  const currentCookie = cookie(currentJwt, 'current-session');
  await withEnvironment({
    OY_REFRESH_COOKIE: currentCookie,
    OY_CURATOR_COOKIE: cookie(token('previous-account', 86400), 'previous-session'),
    OLIVEYOUNG_LINKAGE_JWT: token('previous-account', 86400),
    OLIVEYOUNG_AFFILIATE_REGISTER_ID: 'current-partner'
  }, async () => {
    const current = curatorAuth();
    assert.equal(current.jwt, currentJwt);
    assert.equal(current.cookieHeader, currentCookie);
    const valid = { affiliateActivityId: 'current-activity', affiliatePartnerId: 'current-partner' };
    setCuratorLinkCache(GOODS, valid);
    assert.deepEqual(getCuratorLinkCache(GOODS), valid);

    process.env.OY_REFRESH_COOKIE = cookie(token('next-account'), 'next-session');
    assert.equal(getCuratorLinkCache(GOODS), null);
    assert.equal(getCuratorLinkCache(GOODS, current), null, 'queued old-account work must not read its previous cache');
    assert.notEqual(curatorAuthFingerprint(current), curatorAuthFingerprint(curatorAuth()));
    process.env.OY_REFRESH_COOKIE = currentCookie;
    process.env.OLIVEYOUNG_AFFILIATE_REGISTER_ID = 'different-partner';
    assert.equal(getCuratorLinkCache(GOODS), null);

    setCuratorLinkCache(GOODS, valid);
    assert.equal(getCuratorLinkCache(GOODS), null, 'wrong-partner link must not be saved');
    process.env.OY_REFRESH_COOKIE = cookie(token('expired-current', -10));
    assert.equal(curatorAuth(), null, 'valid previous aliases must not replace expired canonical auth');
    process.env.OY_REFRESH_COOKIE = 'OYSESSIONID=invalid-canonical';
    assert.equal(curatorAuth(), null, 'malformed canonical auth fails closed');
  });
});

test('Cloud Run recreates browser sessions on account change and rejects wrong-partner or unattributed links before shortening', async t => {
  const firstCookie = cookie(token('session-account-one'), 'session-one');
  const secondCookie = cookie(token('session-account-two'), 'session-two');
  const opened = [];
  let upstreamPartner = 'unexpected-partner';
  let activity = 'fixture-activity';
  let shortenCalls = 0;
  const previousFetch = global.fetch;
  t.mock.method(chromium, 'launch', async () => {
    if (opened.length) {
      assert.equal(opened.at(-1).closed, true, 'retired browser must close before replacement launch');
      assert.equal(opened.at(-1).contextClosed, true, 'retired context must close before replacement launch');
    }
    const record = { cookies: [], closed: false, contextClosed: false, pageClosed: false };
    opened.push(record);
    const fixturePage = {
      async close() { record.pageClosed = true; },
      async goto() {},
      locator() { return { innerText: async () => '' }; },
      async evaluate(fn, arg) { return arg === undefined ? 'fixture title' : fn(arg); }
    };
    return {
      async close() {
        await new Promise(resolve => setTimeout(resolve, 10));
        record.closed = true;
      },
      async newContext() {
        return {
          async addCookies(cookies) { record.cookies.push(...cookies); },
          async newPage() { return fixturePage; },
          async close() {
            await new Promise(resolve => setTimeout(resolve, 10));
            record.contextClosed = true;
          }
        };
      }
    };
  });
  global.fetch = async (url, options) => {
    if (String(url).includes('/activities/landing')) {
      assert.equal(options.headers.authorization, curatorAuth().jwt);
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: {
        affiliateActivityId: activity, affiliatePartnerId: upstreamPartner
      } }) };
    }
    assert.match(String(url), /\/shorten\/v2\/verified$/);
    const [body] = JSON.parse(options.body);
    assert.equal(body.registerId, 'expected-partner');
    assert.match(body.originalUrl, /utm_content=OY_fixture-activity/);
    shortenCalls++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ shortenedUrl: 'https://oy.run/fixture' }] }) };
  };
  try {
    await withEnvironment({ OY_REFRESH_COOKIE: firstCookie, OLIVEYOUNG_AFFILIATE_REGISTER_ID: 'expected-partner' }, async () => {
      const first = curatorAuth();
      await ensureCuratorSession(first);
      await ensureCuratorSession(first);
      assert.equal(opened.length, 1);
      assert.equal(opened[0].cookies.find(row => row.name === 'OYSESSIONID').value, 'session-one');

      process.env.OY_REFRESH_COOKIE = secondCookie;
      const second = curatorAuth();
      await ensureCuratorSession(second);
      assert.equal(opened.length, 2);
      assert.equal(opened[0].closed, true);
      assert.equal(opened[0].pageClosed, true);
      assert.equal(opened[1].closed, false, 'retired cleanup must leave replacement open');
      assert.equal(opened[1].cookies.find(row => row.name === 'OYSESSIONID').value, 'session-two');
      await assert.rejects(ensureCuratorSession(first), { message: 'curator_auth_changed' });

      assert.equal((await generateCuratorLink(GOODS)).error, 'curator_partner_mismatch');
      assert.equal(shortenCalls, 0);
      activity = '';
      assert.equal((await generateCuratorLink(GOODS)).error, 'missing_affiliate_activity_id');
      assert.equal(shortenCalls, 0);
      activity = 'fixture-activity';
      upstreamPartner = 'expected-partner';
      const generated = await generateCuratorLink(GOODS);
      assert.equal(generated.success, true);
      assert.equal(generated.affiliatePartnerId, 'expected-partner');
      assert.equal(shortenCalls, 1);
      assert.equal((await generateCuratorLink(GOODS)).cacheHit, true);
      assert.equal(shortenCalls, 1);
    });
  } finally {
    global.fetch = previousFetch;
  }
});
