const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const NOW = 2_000_000_000_000;
const PARTNER = '11111111111111111111111111111111';
const AUTH_KEYS = [
  'OY_REFRESH_COOKIE', 'OY_CURATOR_COOKIE', 'OY_SESSION_ID', 'OY_LINKAGE_STRING',
  'OY_LINKAGE_JWT', 'OLIVEYOUNG_LINKAGE_STRING', 'OLIVEYOUNG_LINKAGE_JWT'
];

function fixture(payload = { exp: NOW / 1000 + 3600, sub: 'new-fake-account' }) {
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'fake-signature'].join('.');
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from('cjone_g4de7353f1'), null);
  const hex = Buffer.concat([cipher.update(jwt), cipher.final()]).toString('hex');
  const cookie = `OYSESSIONID=fake-new-session; linkageString=${hex}; extra=comma,tilde~caret^`;
  return { jwt, hex, cookie };
}

async function load() { return import('../scripts/refresh-oy-linkage.mjs'); }

test('publishes every auth alias from the canonical cookie despite newer old-account aliases', async () => {
  const { buildAuthPublicationEnv } = await load();
  const fresh = fixture();
  const old = fixture({ exp: NOW / 1000 + 86400, sub: 'old-fake-account' });
  const values = buildAuthPublicationEnv({
    OY_REFRESH_COOKIE: fresh.cookie, OY_CURATOR_COOKIE: old.cookie,
    OY_SESSION_ID: 'old-fake-session', OY_LINKAGE_STRING: old.hex,
    OY_LINKAGE_JWT: old.jwt, OLIVEYOUNG_LINKAGE_STRING: old.hex,
    OLIVEYOUNG_LINKAGE_JWT: old.jwt, OLIVEYOUNG_AFFILIATE_REGISTER_ID: PARTNER
  }, { now: NOW });
  assert.deepEqual(values, {
    OY_REFRESH_COOKIE: fresh.cookie, OY_CURATOR_COOKIE: fresh.cookie,
    OY_SESSION_ID: 'fake-new-session', OY_LINKAGE_STRING: fresh.hex,
    OY_LINKAGE_JWT: fresh.jwt, OLIVEYOUNG_LINKAGE_STRING: fresh.hex,
    OLIVEYOUNG_LINKAGE_JWT: fresh.jwt, OLIVEYOUNG_AFFILIATE_REGISTER_ID: PARTNER
  });
  assert.deepEqual(Object.keys(buildAuthPublicationEnv({ OY_REFRESH_COOKIE: fresh.cookie }, { now: NOW })), AUTH_KEYS);
});

test('rejects missing or malformed canonical sessions without falling back to old aliases', async () => {
  const { buildAuthPublicationEnv } = await load();
  const good = fixture();
  for (const cookie of [undefined, '', 'OYSESSIONID=only-session',
    `linkageString=${good.hex}`, 'OYSESSIONID=one; linkageString=not-hex',
    `OYSESSIONID=one; OYSESSIONID=two; linkageString=${good.hex}`,
    `${good.cookie}; linkageString=${good.hex}`, `${good.cookie}\r\nInjected=1`]) {
    assert.throws(() => buildAuthPublicationEnv({
      OY_REFRESH_COOKIE: cookie, OY_CURATOR_COOKIE: good.cookie,
      OY_SESSION_ID: 'old', OY_LINKAGE_STRING: good.hex
    }, { now: NOW }), /^Error: OY_AUTH_(COOKIE|LINKAGE)_INVALID$/);
  }
  for (const payload of [{ exp: NOW / 1000 - 1 }, { exp: String(NOW / 1000 + 3600) }, { sub: 'missing-exp' }]) {
    assert.throws(() => buildAuthPublicationEnv({ OY_REFRESH_COOKIE: fixture(payload).cookie }, { now: NOW }),
      { message: 'OY_AUTH_TOKEN_INVALID' });
  }
  assert.throws(() => buildAuthPublicationEnv({ OY_REFRESH_COOKIE: good.cookie,
    OLIVEYOUNG_AFFILIATE_REGISTER_ID: 'invalid-partner' }, { now: NOW }), { message: 'OY_AUTH_PARTNER_INVALID' });
});

test('Vercel updates all old aliases and duplicate scopes while creating a missing partner setting', async () => {
  const { buildAuthPublicationEnv, publishVercelAuth } = await load();
  const values = buildAuthPublicationEnv({ OY_REFRESH_COOKIE: fixture().cookie,
    OLIVEYOUNG_AFFILIATE_REGISTER_ID: PARTNER }, { now: NOW });
  const records = AUTH_KEYS.map((key, index) => ({ id: `record-${index}`, key, target: ['production'] }));
  records.push({ id: 'duplicate-preview', key: 'OY_LINKAGE_JWT', target: ['preview'] });
  records.push({ id: 'unrelated', key: 'KEEP_OTHER_ENV', target: ['production'] });
  const updates = [];
  const logs = [];
  await publishVercelAuth(values, { token: 'fake-api-token', projectId: 'fake-project' }, {
    log: line => logs.push(line),
    fetchImpl: async (url, options = {}) => {
      if (!options.method) return { ok: true, json: async () => ({ envs: records }) };
      const body = JSON.parse(options.body);
      if (options.method === 'PATCH') {
        const id = url.split('/').pop();
        const record = records.find(row => row.id === id);
        assert.notEqual(record.key, 'KEEP_OTHER_ENV');
        assert.equal(body.value, values[record.key]);
        updates.push(record.key);
      } else {
        assert.equal(options.method, 'POST');
        assert.deepEqual(body, [{ key: 'OLIVEYOUNG_AFFILIATE_REGISTER_ID', value: PARTNER,
          type: 'encrypted', target: ['production'] }]);
        updates.push(body[0].key);
      }
      return { ok: true };
    }
  });
  for (const key of Object.keys(values)) assert.ok(updates.includes(key));
  assert.equal(updates.filter(key => key === 'OY_LINKAGE_JWT').length, 2);
  for (const value of Object.values(values)) assert.ok(!logs.join('\n').includes(value));
});

test('Vercel respects an explicit target filter and does not create or patch unrelated variables', async () => {
  const { buildAuthPublicationEnv, publishVercelAuth } = await load();
  const values = buildAuthPublicationEnv({ OY_REFRESH_COOKIE: fixture().cookie }, { now: NOW });
  const created = [];
  await publishVercelAuth(values, { token: 'fake-token', projectId: 'fake-project', targets: ['production'] }, {
    log: () => {}, fetchImpl: async (url, options = {}) => {
      if (!options.method) return { ok: true, json: async () => ({ envs: [
        { id: 'preview-only', key: 'OY_REFRESH_COOKIE', target: ['preview'] }
      ] }) };
      assert.equal(options.method, 'POST');
      const [record] = JSON.parse(options.body);
      assert.deepEqual(record.target, ['production']);
      created.push(record.key);
      return { ok: true };
    }
  });
  assert.deepEqual(created, AUTH_KEYS);
});

test('Vercel failures never forward provider response bodies or network errors containing secrets', async () => {
  const { publishVercelAuth } = await load();
  let bodyReads = 0;
  await assert.rejects(publishVercelAuth({ OY_REFRESH_COOKIE: 'fake-private-cookie' },
    { token: 'fake-token', projectId: 'fake-project' }, { log: () => {}, fetchImpl: async () => ({
      ok: false, status: 400, text: async () => { bodyReads += 1; return 'fake-private-cookie'; }
    }) }), { message: 'OY_AUTH_VERCEL_PUBLICATION_FAILED' });
  assert.equal(bodyReads, 0);
  await assert.rejects(publishVercelAuth({ OY_REFRESH_COOKIE: 'fake-private-cookie' },
    { token: 'fake-token', projectId: 'fake-project' }, { log: () => {}, fetchImpl: async () => {
      throw new Error('provider echoed fake-private-cookie');
    } }), { message: 'OY_AUTH_VERCEL_PUBLICATION_FAILED' });
});

test('Cloud Run passes an identical lossless update map through a private flags file and cleans it up', async () => {
  const { buildAuthPublicationEnv, publishCloudRunAuth } = await load();
  const values = buildAuthPublicationEnv({ OY_REFRESH_COOKIE: fixture().cookie,
    OLIVEYOUNG_AFFILIATE_REGISTER_ID: PARTNER }, { now: NOW });
  let flagsPath;
  await publishCloudRunAuth(values, { projectId: 'fake-project' }, {
    runCommand: async (command, args, options) => {
      assert.equal(command, 'gcloud');
      flagsPath = args[args.indexOf('--flags-file') + 1];
      assert.deepEqual(JSON.parse(await fs.readFile(flagsPath, 'utf8')), { '--update-env-vars': values });
      assert.ok(!args.includes('--env-vars-file'));
      for (const value of Object.values(values)) assert.ok(!args.join(' ').includes(value));
      assert.equal(options.env.CLOUDSDK_CORE_DISABLE_FILE_LOGGING, '1');
      if (process.platform !== 'win32') assert.equal((await fs.stat(flagsPath)).mode & 0o777, 0o600);
      return { stdout: '', stderr: '' };
    }
  });
  await assert.rejects(fs.stat(flagsPath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.dirname(flagsPath)), { code: 'ENOENT' });
});

test('Cloud Run removes the flags file and suppresses subprocess output after failure', async () => {
  const { buildAuthPublicationEnv, publishCloudRunAuth } = await load();
  const values = buildAuthPublicationEnv({ OY_REFRESH_COOKIE: fixture().cookie }, { now: NOW });
  let flagsPath;
  await assert.rejects(publishCloudRunAuth(values, { projectId: 'fake-project' }, {
    runCommand: async (command, args) => {
      flagsPath = args[args.indexOf('--flags-file') + 1];
      throw Object.assign(new Error('fake-cookie-leak'), { stdout: values.OY_REFRESH_COOKIE, stderr: values.OY_LINKAGE_JWT });
    }
  }), { message: 'OY_AUTH_CLOUD_RUN_PUBLICATION_FAILED' });
  await assert.rejects(fs.stat(path.dirname(flagsPath)), { code: 'ENOENT' });
});
