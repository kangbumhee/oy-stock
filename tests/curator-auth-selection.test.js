const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const handler = require('../api/oliveyoung/landing-proxy.js');

const AUTH_NAMES = [
  'OY_REFRESH_COOKIE', 'OY_CURATOR_COOKIE', 'OY_SESSION_ID', 'OY_LINKAGE_STRING',
  'OY_LINKAGE_JWT', 'OLIVEYOUNG_LINKAGE_STRING', 'OLIVEYOUNG_LINKAGE_JWT'
];

function token(subject, expiresIn) {
  const payload = { sub: subject, exp: Math.floor(Date.now() / 1000) + expiresIn };
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test-signature`;
}

function linkage(jwt) {
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from('cjone_g4de7353f1'), null);
  return Buffer.concat([cipher.update(jwt, 'utf8'), cipher.final()]).toString('hex');
}

function cookie(jwt, session) {
  return `OYSESSIONID=${session}; linkageString=${linkage(jwt)}`;
}

async function withEnvironment(values, operation) {
  const saved = Object.fromEntries(AUTH_NAMES.map(name => [name, process.env[name]]));
  const previousFetch = global.fetch;
  try {
    for (const name of AUTH_NAMES) {
      if (values[name] == null) delete process.env[name];
      else process.env[name] = values[name];
    }
    return await operation();
  } finally {
    global.fetch = previousFetch;
    for (const name of AUTH_NAMES) {
      if (saved[name] == null) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

async function invoke(method, body) {
  let responseBody;
  const res = {
    statusCode: 200,
    setHeader() {},
    end(value) { responseBody = JSON.parse(value); }
  };
  await handler({ method, query: { check: '1' }, body }, res);
  return { status: res.statusCode, body: responseBody };
}

test('canonical refresh cookie wins over a longer-lived account and sends its matching session', async () => {
  const currentJwt = token('current-test-account', 3600);
  const olderJwt = token('previous-test-account', 86400);
  const currentCookie = cookie(currentJwt, 'current-session');
  await withEnvironment({
    OY_REFRESH_COOKIE: currentCookie,
    OY_CURATOR_COOKIE: cookie(olderJwt, 'previous-session'),
    OLIVEYOUNG_LINKAGE_JWT: olderJwt
  }, async () => {
    const check = await invoke('GET');
    assert.equal(check.body.jwtSource, 'OY_REFRESH_COOKIE');
    assert.deepEqual(check.body.candidateSources, ['OY_REFRESH_COOKIE']);
    assert.equal(check.body.authFingerprint, crypto.createHash('sha256').update(currentJwt).digest('hex'));
    assert.equal(check.body.sub, undefined);
    assert.equal(JSON.stringify(check.body).includes(currentJwt), false);
    let calls = 0;
    global.fetch = async (url, options) => {
      calls++;
      assert.equal(options.headers.authorization, currentJwt);
      assert.equal(options.headers.Cookie, currentCookie);
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: {
        affiliateActivityId: 'current-activity', affiliatePartnerId: 'current-partner'
      } }) };
    };
    const result = await invoke('POST', { goodsNo: 'A000000171423' });
    assert.equal(result.status, 200);
    assert.equal(result.body.affiliateActivityId, 'current-activity');
    assert.equal(calls, 1);
  });
});

test('expired or malformed canonical authentication cannot fall back to a valid previous account', async () => {
  const previousJwt = token('previous-test-account', 86400);
  const expiredJwt = token('current-test-account', -10);
  for (const canonical of [cookie(expiredJwt, 'current-session'), 'OYSESSIONID=current-session; linkageString=not-hex']) {
    await withEnvironment({ OY_REFRESH_COOKIE: canonical, OLIVEYOUNG_LINKAGE_JWT: previousJwt }, async () => {
      global.fetch = async () => { throw new Error('unexpected upstream request'); };
      const check = await invoke('GET');
      assert.equal(check.body.jwtValid, false);
      assert.notEqual(check.body.authFingerprint, crypto.createHash('sha256').update(previousJwt).digest('hex'));
      const result = await invoke('POST', { goodsNo: 'A000000171423' });
      assert.equal(result.status, 503);
      assert.equal(result.body.error, 'missing_or_invalid_linkage');
    });
  }
});

test('legacy direct JWT does not borrow another candidate account session', async () => {
  const selectedJwt = token('selected-test-account', 86400);
  await withEnvironment({
    OY_CURATOR_COOKIE: cookie(token('other-test-account', 3600), 'other-session'),
    OLIVEYOUNG_LINKAGE_JWT: selectedJwt
  }, async () => {
    global.fetch = async (url, options) => {
      assert.equal(options.headers.authorization, selectedJwt);
      assert.equal(options.headers.Cookie, undefined);
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { affiliateActivityId: 'activity' } }) };
    };
    assert.equal((await invoke('POST', { goodsNo: 'A000000171423' })).status, 200);
  });
});

test('batch generator keeps canonical account selection even when a legacy alias expires later', async () => {
  const { collectAuthCandidates, selectAuthCandidate } = await import('../scripts/generate-curator-links.mjs');
  const previousJwt = token('previous-test-account', 86400);
  for (const expiresIn of [3600, -10]) {
    const currentJwt = token('current-test-account', expiresIn);
    const currentCookie = cookie(currentJwt, 'current-session');
    await withEnvironment({ OY_REFRESH_COOKIE: currentCookie, OLIVEYOUNG_LINKAGE_JWT: previousJwt }, async () => {
      const candidates = collectAuthCandidates();
      assert.equal(candidates.length, 1);
      const selected = selectAuthCandidate(candidates);
      assert.equal(selected.jwt, currentJwt);
      assert.equal(selected.cookieHeader, currentCookie);
      assert.equal(selected.expired, expiresIn < 0);
    });
  }
  await withEnvironment({ OY_REFRESH_COOKIE: 'OYSESSIONID=current-session', OLIVEYOUNG_LINKAGE_JWT: previousJwt }, async () => {
    assert.equal(selectAuthCandidate(collectAuthCandidates()), null);
  });
});
