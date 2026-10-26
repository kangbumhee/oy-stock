const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const base = process.env.OY_TEST_TEMP_ROOT || (process.platform === 'win32'
  ? 'D:/CodexTemp/oy-refresh-queue-20261027' : os.tmpdir());
function quoted(value) { return `'${value.replace(/'/g, "''")}'`; }

function runWrapper(t, { daily, exitCode }) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'wrapper-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(base) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const scripts = path.join(root, 'scripts');
  const dependencies = path.join(root, 'node_modules/playwright');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(dependencies, { recursive: true });
  fs.writeFileSync(path.join(dependencies, 'package.json'), '{}');
  const name = daily ? 'run-oy-cookie-refresh-task.ps1' : 'run-oy-login-health-task.ps1';
  const wrapper = path.join(scripts, name);
  fs.copyFileSync(path.join(__dirname, '../scripts', name), wrapper);
  const code = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function npm.cmd { $global:LASTEXITCODE = ${exitCode}; Write-Output '[INFO] OY_PUBLICATION_PENDING' }
function node {
  ${daily ? "throw 'FORBIDDEN_EMAIL_OR_HEALTH_CALL'" : `
  $global:LASTEXITCODE = ${exitCode}
  Write-Output '${JSON.stringify({ exitCode, status: exitCode === 76 ? 'publication_pending' : 'check_failed', notification: 'not_needed' })}'`}
}
& ${quoted(wrapper)} ${daily ? '-NoInteractiveLogin' : ''}
exit $LASTEXITCODE
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(code, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...process.env, TEMP: base, TMP: base },
  });
  assert.equal(result.error, undefined);
  const log = fs.readFileSync(path.join(root, '.ai/logs', daily
    ? 'oy-cookie-refresh-task.log' : 'oy-login-health-task.log'), 'utf8');
  return { ...result, log };
}

test('daily pending publication exits cleanly without triggering a failure email', { skip: process.platform !== 'win32' }, t => {
  const result = runWrapper(t, { daily: true, exitCode: 76 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /PublicationPending=true/);
  assert.doesNotMatch(result.log, /Task failed|Task completed successfully|Task error/);
  assert.doesNotMatch(result.stderr, /FORBIDDEN/);
});

test('periodic pending publication remains deferred rather than a scheduler failure', { skip: process.platform !== 'win32' }, t => {
  const result = runWrapper(t, { daily: false, exitCode: 76 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /Status=publication_pending/);
  assert.match(result.log, /confirmation continues on the next check/);
  assert.doesNotMatch(result.log, /Health check or alert dispatch failed/);
});

test('periodic real failures still return a scheduler failure', { skip: process.platform !== 'win32' }, t => {
  const result = runWrapper(t, { daily: false, exitCode: 1 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.log, /Health check or alert dispatch failed/);
  assert.doesNotMatch(result.log, /confirmation continues on the next check/);
});
