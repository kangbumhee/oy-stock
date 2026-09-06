const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const isWindows = process.platform === 'win32';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oy-refresh-lock-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.auth'));
  const { acquireRefreshLock } = await import('../scripts/lib/oy-refresh-lock.mjs');
  return { root, acquireRefreshLock, filename: path.join(root, '.auth/oy-cookie-refresh.lock') };
}

test('active owner returns busy75 and release is idempotent', async t => {
  const { root, acquireRefreshLock, filename } = await fixture(t);
  const release = await acquireRefreshLock(root);
  t.after(release);
  await assert.rejects(acquireRefreshLock(root), { code: 'OY_REFRESH_BUSY', exitCode: 75 });
  await release(); await release();
  assert.equal(fs.existsSync(filename), false);
});

test('POSIX known dead process lock is recovered after crash', { skip: isWindows }, async t => {
  const { root, acquireRefreshLock, filename } = await fixture(t);
  fs.writeFileSync(filename, JSON.stringify({ pid: 9999999 }));
  const release = await acquireRefreshLock(root, { isAlive: () => false });
  assert.equal(JSON.parse(fs.readFileSync(filename)).pid, process.pid);
  await release();
});

test('POSIX previous boot can be recovered even if pid is now reused', { skip: isWindows }, async t => {
  const { root, acquireRefreshLock, filename } = await fixture(t);
  fs.writeFileSync(filename, JSON.stringify({ pid: 123, bootAt: 100000 }));
  const release = await acquireRefreshLock(root, { isAlive: () => true, bootAt: 200000 });
  await release();
});

test('POSIX unknown settings lock is never deleted', { skip: isWindows }, async t => {
  const { root, acquireRefreshLock, filename } = await fixture(t);
  fs.writeFileSync(filename, '');
  await assert.rejects(acquireRefreshLock(root, { isAlive: () => false }), { code: 'OY_REFRESH_BUSY' });
  assert.equal(fs.readFileSync(filename, 'utf8'), '');
});

test('POSIX release never deletes a replacement lock with same process id', { skip: isWindows }, async t => {
  const { root, acquireRefreshLock, filename } = await fixture(t);
  const release = await acquireRefreshLock(root);
  fs.writeFileSync(filename, JSON.stringify({ pid: process.pid, owner: 'replacement' }));
  await release();
  assert.equal(JSON.parse(fs.readFileSync(filename)).owner, 'replacement');
});

test('Windows ignores stale empty metadata and recovery files without deleting either', { skip: !isWindows }, async t => {
  const { root, acquireRefreshLock, filename } = await fixture(t);
  fs.writeFileSync(filename, '');
  fs.writeFileSync(filename + '.recovery', 'unknown-owner');
  const release = await acquireRefreshLock(root);
  t.after(release);
  await release();
  assert.equal(fs.readFileSync(filename, 'utf8'), '');
  assert.equal(fs.readFileSync(filename + '.recovery', 'utf8'), 'unknown-owner');
});

test('Windows canonical paths contend while health-state and refresh scopes stay independent', { skip: !isWindows }, async t => {
  const { root, acquireRefreshLock } = await fixture(t);
  const refresh = await acquireRefreshLock(root);
  t.after(refresh);
  await assert.rejects(acquireRefreshLock(path.join(root.toUpperCase(), '.')), { code: 'OY_REFRESH_BUSY' });
  const health = await acquireRefreshLock(root, { scope: 'health-state' });
  t.after(health);
  await assert.rejects(acquireRefreshLock(root, { scope: 'health-state' }), { code: 'OY_REFRESH_BUSY' });
  await health(); await refresh();
  await assert.rejects(acquireRefreshLock(root, { scope: 'unknown' }), { code: 'OY_REFRESH_LOCK_FAILED' });
});

function childReady(child, expected) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('fixture child timed out')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture child exited ${code}`)); });
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.includes(expected)) { clearTimeout(timer); resolve(); }
    });
  });
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => { child.once('close', resolve); child.kill(); });
}

test('Windows killing the owning Node process closes holder stdin and frees the mutex', { skip: !isWindows }, async t => {
  const { root, acquireRefreshLock } = await fixture(t);
  const moduleUrl = pathToFileURL(path.join(__dirname, '../scripts/lib/oy-refresh-lock.mjs')).href;
  const program = `import { acquireRefreshLock } from ${JSON.stringify(moduleUrl)}; await acquireRefreshLock(process.argv[1]); console.log('FIXTURE_HELD'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, root], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => stopChild(child));
  await childReady(child, 'FIXTURE_HELD');
  await assert.rejects(acquireRefreshLock(root), { code: 'OY_REFRESH_BUSY' });
  await stopChild(child);
  const release = await acquireRefreshLock(root);
  t.after(release);
  await release();
});

test('Windows abrupt mutex-holder termination is recovered without a stale recovery marker', { skip: !isWindows }, async t => {
  const { root, acquireRefreshLock } = await fixture(t);
  const helper = path.join(__dirname, '../scripts/oy-refresh-mutex.ps1');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-AuthDirectory', path.join(root, '.auth')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => stopChild(child));
  child.stdin.on('error', () => {});
  await childReady(child, 'OY_MUTEX_ACQUIRED');
  await stopChild(child);
  const release = await acquireRefreshLock(root);
  t.after(release);
  await release();
  assert.deepEqual(fs.readdirSync(path.join(root, '.auth')), []);
});

test('Windows vault Setup owns the same mutex and process termination releases it before writing credentials', { skip: !isWindows }, async t => {
  const { root, acquireRefreshLock } = await fixture(t);
  const vaultScript = path.join(__dirname, '../scripts/oy-login-secrets.ps1');
  const command = `
$fixture = [Console]::In.ReadLine() | ConvertFrom-Json
function global:Read-Host {
  param($Prompt, [switch]$AsSecureString)
  [Console]::Out.WriteLine('VAULT_FIXTURE_HELD')
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
  throw 'FIXTURE_STOP'
}
& $fixture.script -Action Setup -VaultPath $fixture.vault
`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => stopChild(child));
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({ script: vaultScript, vault: path.join(root, '.auth', 'oy-login-secrets.json') }) + '\n');
  await childReady(child, 'VAULT_FIXTURE_HELD');
  await assert.rejects(acquireRefreshLock(root), { code: 'OY_REFRESH_BUSY' });
  await stopChild(child);
  const release = await acquireRefreshLock(root);
  t.after(release);
  await release();
  assert.deepEqual(fs.readdirSync(path.join(root, '.auth')), []);
});
