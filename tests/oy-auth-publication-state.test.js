const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const TEST_BASE = process.env.OY_TEST_TEMP_ROOT || (process.platform === 'win32'
  ? 'D:\\CodexTemp\\oy-auth-publication-tests' : '/tmp/oy-auth-publication-tests');

async function fixture(t, dispatch) {
  fs.mkdirSync(TEST_BASE, { recursive: true });
  const root = fs.mkdtempSync(path.join(TEST_BASE, 'publication-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(TEST_BASE) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const api = await import('../scripts/lib/oy-auth-publication-state.mjs');
  const filename = path.join(root, '.auth', 'oy-auth-publication.json');
  let time = Date.parse('2026-10-27T00:00:00.000Z');
  const now = () => time;
  const expectedExpiry = time / 1000 + 86400;
  const expectedFingerprint = 'a'.repeat(64);
  const calls = [];
  const start = () => api.startAuthPublication({ repoRoot: root, expectedExpiry, expectedFingerprint,
    env: { GITHUB_REPOSITORY: 'owner/repo', OY_REFRESH_COOKIE: 'DO_NOT_PERSIST_COOKIE', OY_LINKAGE_JWT: 'DO_NOT_PERSIST_JWT' }, now,
    runProcess: async (file, args) => {
      calls.push({ file, args });
      if (dispatch) return dispatch({ file, args, filename });
      return { stdout: 'https://github.com/owner/repo/actions/runs/123\n' };
    } });
  const run = record => ({ id: 123, display_title: `OY auth publication ${record.requestId}`, status: 'completed', conclusion: 'success' });
  const payload = { jwtValid: true, jwtExpSeconds: expectedExpiry, authFingerprint: expectedFingerprint };
  const inspect = (record, { remote = run(record), body = payload, runProcess, fetchImpl } = {}) => api.inspectAuthPublication({
    repoRoot: root, now, runProcess: runProcess || (async () => ({ stdout: JSON.stringify(remote) })),
    fetchImpl: fetchImpl || (async () => ({ ok: true, json: async () => body })),
  });
  return { ...api, root, filename, now, expectedExpiry, expectedFingerprint, calls, start, run, payload, inspect,
    advance: ms => { time += ms; } };
}

test('request is durable before dispatch and contains no cookie/JWT/credentials', async t => {
  const f = await fixture(t, ({ args, filename }) => {
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(saved.runId, null);
    assert.ok(args.includes(`requestId=${saved.requestId}`));
    assert.ok(args.includes('deployVercel=true'));
    return { stdout: 'https://github.com/owner/repo/actions/runs/123' };
  });
  const record = await f.start();
  assert.equal(record.runId, 123);
  const raw = fs.readFileSync(f.filename, 'utf8');
  assert.ok(Buffer.byteLength(raw) < 4096);
  assert.equal(raw.includes('DO_NOT_PERSIST'), false);
  assert.deepEqual(Object.keys(record).sort(), ['version', 'requestId', 'requestedAt', 'repository', 'workflow', 'runId', 'expectedExpiry', 'expectedFingerprint'].sort());
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.filename).mode & 0o777, 0o600);
});

test('14 minute GitHub queue remains pending then exact successful publication clears state', async t => {
  const f = await fixture(t);
  const record = await f.start();
  f.advance(14 * 60 * 1000);
  let fetches = 0;
  const queued = await f.inspect(record, { remote: { ...f.run(record), status: 'queued', conclusion: null },
    fetchImpl: async () => { fetches++; throw new Error('must not fetch queued run'); } });
  assert.equal(queued.status, 'pending');
  assert.equal(fetches, 0);
  assert.equal(fs.existsSync(f.filename), true);
  f.advance(3 * 60 * 1000);
  assert.deepEqual(await f.inspect(record), { status: 'published', runId: 123 });
  assert.equal(fs.existsSync(f.filename), false);
  assert.deepEqual(await f.inspect(record), { status: 'none' });
});

test('completed workflow cannot accept a different fingerprint with matching expiry', async t => {
  const f = await fixture(t); const record = await f.start();
  assert.equal((await f.inspect(record, { body: { ...f.payload, authFingerprint: 'b'.repeat(64) } })).status, 'pending');
  assert.equal(fs.existsSync(f.filename), true);
});

test('an old but valid deployed token cannot clear the pending request', async t => {
  const f = await fixture(t); const record = await f.start();
  const result = await f.inspect(record, { body: { ...f.payload, jwtExpSeconds: f.expectedExpiry - 300 } });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'publication_not_confirmed');
  assert.equal(fs.existsSync(f.filename), true);
});

test('completed failure is failed even when the public token is valid', async t => {
  const f = await fixture(t); const record = await f.start();
  const result = await f.inspect(record, { remote: { ...f.run(record), conclusion: 'failure' },
    fetchImpl: async () => { throw new Error('must not inspect failed run public token'); } });
  assert.deepEqual(result, { status: 'failed', reason: 'publication_workflow_failed', runId: 123 });
});

test('cancelled workflow is a real failure', async t => {
  const f = await fixture(t); const record = await f.start();
  assert.equal((await f.inspect(record, { remote: { ...f.run(record), conclusion: 'cancelled' } })).status, 'failed');
});

test('publication pending is bounded to 90 minutes even when GitHub is unavailable', async t => {
  const f = await fixture(t); const record = await f.start();
  f.advance(90 * 60 * 1000);
  const result = await f.inspect(record, { runProcess: async () => { throw new Error('outage'); } });
  assert.deepEqual(result, { status: 'failed', reason: 'publication_timeout', runId: 123 });
});

test('PC resuming two hours later can accept completed success with the exact still-valid public token', async t => {
  const f = await fixture(t); const record = await f.start();
  f.advance(2 * 60 * 60 * 1000);
  assert.deepEqual(await f.inspect(record), { status: 'published', runId: 123 });
  assert.equal(fs.existsSync(f.filename), false);
});

test('two hours late queued workflow still fails the bounded pending budget', async t => {
  const f = await fixture(t); const record = await f.start();
  f.advance(2 * 60 * 60 * 1000);
  const result = await f.inspect(record, { remote: { ...f.run(record), status: 'queued', conclusion: null } });
  assert.deepEqual(result, { status: 'failed', reason: 'publication_timeout', runId: 123 });
  assert.equal(fs.existsSync(f.filename), true);
});

test('two hours late completed workflow with a different fingerprint still fails the budget', async t => {
  const f = await fixture(t); const record = await f.start();
  f.advance(2 * 60 * 60 * 1000);
  const result = await f.inspect(record, { body: { ...f.payload, authFingerprint: 'b'.repeat(64) } });
  assert.deepEqual(result, { status: 'failed', reason: 'publication_timeout', runId: 123 });
  assert.equal(fs.existsSync(f.filename), true);
});

test('near expired expected token fails rather than extending pending indefinitely', async t => {
  const f = await fixture(t); const record = await f.start();
  record.expectedExpiry = f.now() / 1000 + 59;
  fs.writeFileSync(f.filename, JSON.stringify(record));
  assert.equal((await f.inspect(record)).reason, 'publication_token_expired');
});

test('a stored run ID must still have the exact request title', async t => {
  const f = await fixture(t); const record = await f.start();
  const result = await f.inspect(record, { remote: { ...f.run(record), display_title: 'unrelated latest refresh' },
    fetchImpl: async () => { throw new Error('unrelated run must not verify'); } });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'workflow_not_matched');
  assert.equal(fs.existsSync(f.filename), true);
});

test('missing ID is resolved only by exact title, never latest run', async t => {
  const f = await fixture(t, () => ({ stdout: '' })); const record = await f.start();
  assert.equal(record.runId, null);
  const seen = [];
  const result = await f.inspect(record, { runProcess: async (_file, args) => {
    seen.push(args);
    return { stdout: JSON.stringify(args[0] === 'run' ? [
      { databaseId: 999, displayTitle: 'latest but unrelated' },
      { databaseId: 123, displayTitle: `OY auth publication ${record.requestId}` },
    ] : f.run(record)) };
  } });
  assert.equal(result.status, 'published');
  assert.ok(seen[1][1].endsWith('/123'));
});

test('ambiguous dispatch retains durable request and does not dispatch again on restart', async t => {
  const f = await fixture(t, () => { throw new Error('connection dropped after server accepted'); });
  const first = await f.start();
  const second = await f.start();
  assert.equal(second.requestId, first.requestId);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.inspect(first, { runProcess: async () => { throw new Error('offline'); } })).status, 'pending');
  assert.equal(f.calls.length, 1);
});

test('CAS clear cannot delete a newer request', async t => {
  const f = await fixture(t); const record = await f.start();
  const replacement = { ...record, requestId: randomUUID(), runId: 456 };
  fs.writeFileSync(f.filename, JSON.stringify(replacement));
  assert.equal(await f.clearAuthPublication(f.root, record.requestId), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.filename, 'utf8')), replacement);
});

test('replacement during remote verification is not cleared or reported published', async t => {
  const f = await fixture(t); const record = await f.start();
  const replacement = { ...record, requestId: randomUUID(), runId: 456 };
  const result = await f.inspect(record, { fetchImpl: async () => {
    fs.writeFileSync(f.filename, JSON.stringify(replacement));
    return { ok: true, json: async () => f.payload };
  } });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'publication_request_replaced');
  assert.equal(JSON.parse(fs.readFileSync(f.filename, 'utf8')).requestId, replacement.requestId);
});

test('malformed or extra state fields fail safely without exposing contents', async t => {
  const f = await fixture(t); const record = await f.start();
  fs.writeFileSync(f.filename, JSON.stringify({ ...record, cookie: 'DO_NOT_EXPOSE' }));
  const result = await f.inspect(record);
  assert.deepEqual(result, { status: 'failed', reason: 'publication_state_invalid' });
  assert.equal(JSON.stringify(result).includes('DO_NOT_EXPOSE'), false);
  fs.writeFileSync(f.filename, '{not json');
  assert.equal((await f.inspect(record)).status, 'failed');
});

test('oversized state fails and is not deleted', async t => {
  const f = await fixture(t); const record = await f.start();
  fs.writeFileSync(f.filename, ' '.repeat(4097));
  assert.equal((await f.inspect(record)).status, 'failed');
  assert.equal(fs.existsSync(f.filename), true);
});

test('symlinked auth directory is rejected without following private state', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'other'); fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(f.root, '.auth'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await f.inspect({}), { status: 'failed', reason: 'publication_state_invalid' });
  await assert.rejects(f.start(), { code: 'OY_AUTH_PUBLICATION_STATE_INVALID' });
});

test('invalid repository or expected token is rejected before dispatch', async t => {
  const f = await fixture(t);
  await assert.rejects(f.startAuthPublication({ repoRoot: f.root, expectedExpiry: f.expectedExpiry,
    expectedFingerprint: f.expectedFingerprint, env: { GITHUB_REPOSITORY: '../unsafe' }, now: f.now }), { code: 'OY_AUTH_PUBLICATION_REPOSITORY_INVALID' });
  await assert.rejects(f.startAuthPublication({ repoRoot: f.root, expectedExpiry: 1,
    expectedFingerprint: f.expectedFingerprint, env: { GITHUB_REPOSITORY: 'owner/repo' }, now: f.now }), { code: 'OY_AUTH_PUBLICATION_EXPECTATION_INVALID' });
});

test('existing workflow basename override is preserved and invalid paths are rejected', async t => {
  const f = await fixture(t);
  const seen = [];
  const record = await f.startAuthPublication({ repoRoot: f.root, expectedExpiry: f.expectedExpiry,
    expectedFingerprint: f.expectedFingerprint, env: { GITHUB_REPOSITORY: 'owner/repo', OY_REFRESH_WORKFLOW: 'refresh-custom.yaml' },
    now: f.now, runProcess: async (_file, args) => { seen.push(args); return { stdout: '' }; } });
  assert.equal(record.workflow, 'refresh-custom.yaml');
  assert.equal(seen[0][2], 'refresh-custom.yaml');
  await f.inspect(record, { runProcess: async (_file, args) => {
    assert.equal(args[3], 'refresh-custom.yaml');
    return { stdout: '[]' };
  } });
  await assert.rejects(f.startAuthPublication({ repoRoot: f.root, expectedExpiry: f.expectedExpiry,
    expectedFingerprint: f.expectedFingerprint, env: { GITHUB_REPOSITORY: 'owner/repo', OY_REFRESH_WORKFLOW: '../other.yml' },
    now: f.now }), { code: 'OY_AUTH_PUBLICATION_WORKFLOW_INVALID' });
});
