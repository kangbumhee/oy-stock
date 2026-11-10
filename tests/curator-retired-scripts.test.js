const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const retiredNodeScripts = [
  'generate-curator-links.mjs',
  'collect-curator-backfill.mjs',
  'merge-curator-links.mjs',
  'refresh-oy-linkage.mjs',
  'refresh-oy-cookie.mjs',
  'refresh-oy-cookie-from-profile.mjs',
  'check-oy-login.mjs',
  'verify-oy-publication.mjs',
  'send-oy-login-alert.mjs',
];

for (const filename of retiredNodeScripts) {
  test(`retired ${filename} cannot generate, authenticate, publish, or send alerts`, () => {
    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts', filename), '--setup', '--cloud-run', '--check-only',
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'CURATOR_FEATURE_REMOVED');
  });
}

for (const filename of [
  'install-oy-cookie-refresh-task.ps1',
  'run-oy-cookie-refresh-task.ps1',
  'run-oy-login-health-task.ps1',
  'refresh-oy-cookie-from-chrome.ps1',
]) {
  test(`retired ${filename} does not start a browser or scheduled task`, { skip: process.platform !== 'win32' }, () => {
    const script = path.join(root, 'scripts', filename).replace(/'/g, "''");
    const code = `
function node { throw 'FORBIDDEN_NODE' }
function npm.cmd { throw 'FORBIDDEN_NPM' }
function Start-Process { throw 'FORBIDDEN_PROCESS' }
function Start-ScheduledTask { throw 'FORBIDDEN_TASK_START' }
function Register-ScheduledTask { throw 'FORBIDDEN_TASK_REGISTER' }
function Invoke-RestMethod { throw 'FORBIDDEN_NETWORK' }
& '${script}'
exit $LASTEXITCODE
`;
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64'),
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'CURATOR_FEATURE_REMOVED');
  });
}

test('removed curator data and npm entry points cannot re-enable generation', () => {
  assert.equal(fs.existsSync(path.join(root, 'public/data/curator-links.json')), false);
  const pkg = require('../package.json');
  for (const name of [
    'setup:oy-cookie-profile', 'refresh:oy-cookie:chrome', 'setup:oy-login-secrets',
    'status:oy-login-secrets', 'install:oy-login-task', 'check:oy-login',
  ]) assert.equal(pkg.scripts[name], undefined);
  assert.equal(pkg.scripts.start, 'node server/server.mjs');
  assert.equal(pkg.scripts['collect:hidden-stock'], 'node scripts/collect-hidden-stock.mjs');
});

test('future blog product links use the ordinary official product page', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/build-blog-pages.js'), 'utf8');
  assert.match(source, /https:\/\/www\.oliveyoung\.co\.kr\/store\/goods\/getGoodsDetail\.do\?goodsNo=\$\{encodeURIComponent\(post\.goodsNo\)\}/);
  assert.doesNotMatch(source, /curator-redirect|curatorHref|affiliateActivityId|oy\.run/);
});
