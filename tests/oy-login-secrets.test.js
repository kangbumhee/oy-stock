const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const modulePath = pathToFileURL(path.join(__dirname, '..', 'scripts', 'lib', 'oy-login-secrets.mjs'));
const scriptPath = path.join(__dirname, '..', 'scripts', 'oy-login-secrets.ps1');
const isWindows = process.platform === 'win32';


test('default vault path works through relative -File on Windows without explicit VaultPath', { skip: !isWindows }, async t => {
  const { repoRoot } = await fixture(t);
  await fs.mkdir(path.join(repoRoot, 'scripts'));
  await fs.copyFile(scriptPath, path.join(repoRoot, 'scripts', 'oy-login-secrets.ps1'));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'scripts/oy-login-secrets.ps1', '-Action', 'Status'], {
    cwd: repoRoot, windowsHide: true, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { configured: false, captchaConfigured: false, captchaEnabled: false });
});
const FAKE = { username: 'fake-test-account', password: '  fake-test-password  ', captchaApiKey: 'fake-captcha-key', captchaEnabled: true };

test('default Setup vault path supports Korean spaces and an unrelated working directory', { skip: !isWindows }, async t => {
  const { repoRoot: containerRoot } = await fixture(t);
  const repoRoot = path.join(containerRoot, '한글 공백 저장소');
  const scriptsDirectory = path.join(repoRoot, 'scripts');
  await fs.mkdir(scriptsDirectory, { recursive: true });
  const copiedScript = path.join(scriptsDirectory, 'oy-login-secrets.ps1');
  await fs.copyFile(scriptPath, copiedScript);
  await fs.copyFile(path.join(path.dirname(scriptPath), 'oy-refresh-mutex.ps1'), path.join(scriptsDirectory, 'oy-refresh-mutex.ps1'));
  const command = `
$fixture = [Console]::In.ReadToEnd() | ConvertFrom-Json
$global:fakeAnswers = [Collections.Generic.Queue[string]]::new()
foreach ($value in $fixture.answers) { $global:fakeAnswers.Enqueue([string]$value) }
function global:Read-Host {
  param([string]$Prompt, [switch]$AsSecureString)
  $value = $global:fakeAnswers.Dequeue()
  if ($AsSecureString) {
    $secure = [Security.SecureString]::new()
    foreach ($character in $value.ToCharArray()) { $secure.AppendChar($character) }
    return $secure
  }
  return $value
}
& $env:OY_TEST_VAULT_SCRIPT -Action Setup
`;
  const saved = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: containerRoot,
    input: JSON.stringify({ answers: [FAKE.username, FAKE.password, FAKE.captchaApiKey, 'y'] }),
    env: {
      ...process.env, OY_TEST_VAULT_SCRIPT: copiedScript, OY_LOGIN_SECRETS_INTERNAL_READ: '',
      OLIVEYOUNG_2CAPTCHA_ENABLED: '', KOREA_TOP_2CAPTCHA_ENABLED: '',
    },
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.equal(saved.status, 0, saved.stderr);
  assert.deepEqual(JSON.parse(saved.stdout), { configured: true, captchaConfigured: true, captchaEnabled: true });
  assert.deepEqual(await fs.readdir(path.join(repoRoot, '.auth')), ['oy-login-secrets.json']);
  assert.deepEqual(await fs.readdir(path.join(containerRoot, '.auth')), []);
  const { loadLoginSecrets } = await import(modulePath);
  assert.deepEqual(await loadLoginSecrets({ repoRoot, env: {} }), { ...FAKE, source: 'saved', configured: true });
});

async function fixture(t) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oy-login-vault-test-'));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  const auth = path.join(repoRoot, '.auth');
  await fs.mkdir(auth);
  return { repoRoot, auth, vault: path.join(auth, 'oy-login-secrets.json') };
}

function ps(action, vault, extra = {}) {
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath, '-Action', action, '-VaultPath', vault], {
    env: { ...process.env, OY_LOGIN_SECRETS_INTERNAL_READ: '', OLIVEYOUNG_2CAPTCHA_ENABLED: '', KOREA_TOP_2CAPTCHA_ENABLED: '', ...extra },
    encoding: 'utf8', windowsHide: true,
  });
}

function setup(vault, record = FAKE, engine = 'powershell.exe', targetScript = scriptPath) {
  // Stub only Read-Host in a disposable child process. No test-only write path exists in the vault.
  const command = `
$fixture = [Console]::In.ReadToEnd() | ConvertFrom-Json
$global:fakeAnswers = [Collections.Generic.Queue[string]]::new()
foreach ($value in $fixture.answers) { $global:fakeAnswers.Enqueue([string]$value) }
function global:Read-Host {
  param([string]$Prompt, [switch]$AsSecureString)
  $value = $global:fakeAnswers.Dequeue()
  if ($AsSecureString) {
    $secure = [Security.SecureString]::new()
    foreach ($character in $value.ToCharArray()) { $secure.AppendChar($character) }
    return $secure
  }
  return $value
}
& $fixture.script -Action Setup -VaultPath $fixture.vault
`;
  return spawnSync(engine, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    input: JSON.stringify({ script: targetScript, vault, answers: [record.username, record.password, record.captchaApiKey, record.captchaEnabled ? 'y' : 'n'] }),
    env: { ...process.env, OLIVEYOUNG_2CAPTCHA_ENABLED: '', KOREA_TOP_2CAPTCHA_ENABLED: '' },
    encoding: 'utf8', windowsHide: true,
  });
}

test('vault saves and replaces with inherited Modify rights without changing ownership', { skip: !isWindows }, async t => {
  const { repoRoot, auth, vault } = await fixture(t);
  const permissionFixture = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
  $sid, [Security.AccessControl.FileSystemRights]::Modify,
  [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
  [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow
))
[IO.Directory]::SetAccessControl($env:OY_TEST_AUTH_DIRECTORY, $acl)
$actual = [IO.Directory]::GetAccessControl($env:OY_TEST_AUTH_DIRECTORY)
$rules = @($actual.Access)
[ordered]@{
  ownerIsCurrentUser = $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value
  protected = $actual.AreAccessRulesProtected
  ruleCount = $rules.Count
  grantsWriteOwner = [bool]($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::TakeOwnership)
  grantsChangePermissions = [bool]($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::ChangePermissions)
} | ConvertTo-Json -Compress
`], { env: { ...process.env, OY_TEST_AUTH_DIRECTORY: auth }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(permissionFixture.status, 0, permissionFixture.stderr);
  assert.deepEqual(JSON.parse(permissionFixture.stdout), {
    ownerIsCurrentUser: true, protected: true, ruleCount: 1, grantsWriteOwner: false, grantsChangePermissions: false,
  });

  // Reintroduce the former ownership reset only in a disposable copy to prove
  // this permission fixture catches the production failure before testing its fix.
  const oldScripts = path.join(repoRoot, 'old-behavior');
  await fs.mkdir(oldScripts);
  const oldScript = path.join(oldScripts, 'oy-login-secrets.ps1');
  const source = await fs.readFile(scriptPath, 'utf8');
  const aclMarker = '$acl.SetAccessRuleProtection($true, $false)';
  assert.equal(source.includes(aclMarker), true);
  await fs.writeFile(oldScript, source.replace(aclMarker, `${aclMarker}\n  $acl.SetOwner($sid)`));
  await fs.copyFile(path.join(path.dirname(scriptPath), 'oy-refresh-mutex.ps1'), path.join(oldScripts, 'oy-refresh-mutex.ps1'));
  const previous = setup(vault, FAKE, 'powershell.exe', oldScript);
  assert.notEqual(previous.status, 0);
  assert.equal(previous.stderr.trim(), 'OY_LOGIN_VAULT_OPERATION_FAILED');
  assert.deepEqual(await fs.readdir(auth), []);

  const saved = setup(vault);
  assert.equal(saved.status, 0, saved.stderr);
  assert.deepEqual(JSON.parse(saved.stdout), { configured: true, captchaConfigured: true, captchaEnabled: true });
  const encrypted = await fs.readFile(vault, 'utf8');
  for (const value of Object.values(FAKE).filter(value => typeof value === 'string')) assert.equal(encrypted.includes(value), false);
  const replacementRecord = { ...FAKE, password: 'replacement-fake-password' };
  const replacement = setup(vault, replacementRecord);
  assert.equal(replacement.status, 0, replacement.stderr);
  const { loadLoginSecrets } = await import(modulePath);
  assert.deepEqual(await loadLoginSecrets({ repoRoot, env: {} }), { ...replacementRecord, source: 'saved', configured: true });
  const status = ps('Status', vault);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), { configured: true, captchaConfigured: true, captchaEnabled: true });
  const finalAcl = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [IO.File]::GetAccessControl($env:OY_TEST_VAULT)
$directoryAcl = [IO.Directory]::GetAccessControl($env:OY_TEST_AUTH_DIRECTORY)
[ordered]@{
  ownerUnchanged = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $directoryAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  ownerIsCurrentUser = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value
  private = [bool]($acl.AreAccessRulesProtected -and @($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value }).Count -eq 0)
} | ConvertTo-Json -Compress
`], { env: { ...process.env, OY_TEST_AUTH_DIRECTORY: auth, OY_TEST_VAULT: vault }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(finalAcl.status, 0, finalAcl.stderr);
  assert.deepEqual(JSON.parse(finalAcl.stdout), { ownerUnchanged: true, ownerIsCurrentUser: true, private: true });
});

test('empty vault uses environment credentials, preserves password whitespace and supports key aliases', async (t) => {
  const { repoRoot } = await fixture(t);
  const { loadLoginSecrets } = await import(modulePath);
  assert.deepEqual(await loadLoginSecrets({ repoRoot, env: {} }), {
    username: '', password: '', captchaApiKey: '', captchaEnabled: false, source: 'none', configured: false,
  });
  for (const name of ['TWOCAPTCHA_API_KEY', 'TWO_CAPTCHA_API_KEY']) {
    const actual = await loadLoginSecrets({ repoRoot, env: { OY_USERNAME: ' user ', OY_PASSWORD: ' pass ', [name]: ' key ' } });
    assert.deepEqual(actual, { username: 'user', password: ' pass ', captchaApiKey: 'key', captchaEnabled: true, source: 'environment', configured: true });
  }
});

test('all disable flags turn off configured CAPTCHA keys', async (t) => {
  const { repoRoot } = await fixture(t);
  const { loadLoginSecrets } = await import(modulePath);
  for (const name of ['OLIVEYOUNG_2CAPTCHA_ENABLED', 'KOREA_TOP_2CAPTCHA_ENABLED']) {
    for (const value of ['0', 'false', 'no', 'off', 'disabled', ' FALSE ']) {
      const actual = await loadLoginSecrets({ repoRoot, env: { TWOCAPTCHA_API_KEY: 'fake-key', [name]: value } });
      assert.equal(actual.captchaEnabled, false);
      assert.equal(actual.captchaApiKey, 'fake-key');
    }
  }
});

test('invalid credentials and keys fail with sanitized codes', async (t) => {
  const { repoRoot } = await fixture(t);
  const { loadLoginSecrets } = await import(modulePath);
  for (const env of [
    { OY_USERNAME: 'fake-user' }, { OY_PASSWORD: 'fake-pass' },
    { OY_USERNAME: 'fake\nuser', OY_PASSWORD: 'fake-pass' },
    { OY_USERNAME: 'fake-user', OY_PASSWORD: 'fake\0pass' },
    { TWOCAPTCHA_API_KEY: 'k'.repeat(513) }, { TWOCAPTCHA_API_KEY: 'fake\rkey' },
  ]) {
    await assert.rejects(loadLoginSecrets({ repoRoot, env }), (error) => /^OY_LOGIN_[A-Z_]+$/.test(error.message)
      && !error.message.includes('fake') && error.stdout === undefined && error.stderr === undefined);
  }
});

test('unreadable/corrupt stored record never falls back to environment', async (t) => {
  const { repoRoot, vault } = await fixture(t);
  await fs.writeFile(vault, JSON.stringify({ version: 1, ciphertext: 'fake-invalid-ciphertext' }));
  const { loadLoginSecrets } = await import(modulePath);
  await assert.rejects(loadLoginSecrets({ repoRoot, env: { OY_USERNAME: 'fallback', OY_PASSWORD: 'fallback' } }),
    { code: isWindows ? 'OY_LOGIN_VAULT_DECRYPT_FAILED' : 'OY_LOGIN_VAULT_WINDOWS_ONLY' });
});

test('DPAPI vault lifecycle encrypts values, restricts ACL and prefers saved configuration', { skip: !isWindows }, async (t) => {
  const { repoRoot, vault, auth } = await fixture(t);
  const saved = setup(vault);
  assert.equal(saved.status, 0, saved.stderr);
  assert.deepEqual(JSON.parse(saved.stdout), { configured: true, captchaConfigured: true, captchaEnabled: true });
  const encrypted = await fs.readFile(vault, 'utf8');
  const envelope = JSON.parse(encrypted);
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'version']);
  for (const value of Object.values(FAKE).filter((value) => typeof value === 'string')) assert.equal(encrypted.includes(value), false);
  const { loadLoginSecrets } = await import(modulePath);
  assert.deepEqual(await loadLoginSecrets({ repoRoot, env: { OY_USERNAME: 'wrong', OY_PASSWORD: 'wrong', TWOCAPTCHA_API_KEY: 'wrong' } }),
    { ...FAKE, source: 'saved', configured: true });
  const acl = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$a=[IO.File]::GetAccessControl($env:OY_TEST_VAULT); $s=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; [bool]($a.AreAccessRulesProtected -and @($a.Access | Where-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $s}).Count -eq 0)'],
  { env: { ...process.env, OY_TEST_VAULT: vault }, encoding: 'utf8', windowsHide: true });
  assert.equal(acl.status, 0, acl.stderr);
  assert.equal(acl.stdout.trim(), 'True');
  assert.deepEqual(JSON.parse(ps('Status', vault).stdout), { configured: true, captchaConfigured: true, captchaEnabled: true });
  const disallowed = ps('Read', vault);
  assert.notEqual(disallowed.status, 0);
  assert.equal(disallowed.stderr.trim(), 'OY_LOGIN_VAULT_READ_INTERNAL_ONLY');
  const replacement = setup(vault, { ...FAKE, captchaApiKey: '', captchaEnabled: false });
  assert.equal(replacement.status, 0, replacement.stderr);
  const replaced = await loadLoginSecrets({ repoRoot, env: { TWOCAPTCHA_API_KEY: 'ignored' } });
  assert.equal(replaced.captchaApiKey, '');
  assert.equal(replaced.captchaEnabled, false);
  assert.deepEqual(await fs.readdir(auth), ['oy-login-secrets.json']);
  const cleared = ps('Clear', vault);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual(JSON.parse(cleared.stdout), { configured: false, captchaConfigured: false, captchaEnabled: false });
  assert.deepEqual(await fs.readdir(auth), []);
});

test('running refresh lock blocks save and clear without changing ciphertext', { skip: !isWindows }, async (t) => {
  const { repoRoot, vault, auth } = await fixture(t);
  assert.equal(setup(vault).status, 0);
  const before = await fs.readFile(vault, 'utf8');
  const lock = path.join(auth, 'oy-cookie-refresh.lock');
  await fs.writeFile(lock, 'fake-refresh-lock');
  const { acquireRefreshLock } = await import('../scripts/lib/oy-refresh-lock.mjs');
  const release = await acquireRefreshLock(repoRoot);
  t.after(release);
  for (const result of [setup(vault), ps('Clear', vault)]) {
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr.trim(), 'OY_LOGIN_VAULT_LOCKED');
    assert.equal(result.stdout.trim(), '');
  }
  assert.equal(await fs.readFile(vault, 'utf8'), before);
  assert.equal(await fs.readFile(lock, 'utf8'), 'fake-refresh-lock');
  await release();
  assert.equal(ps('Clear', vault).status, 0);
  assert.equal(await fs.readFile(lock, 'utf8'), 'fake-refresh-lock');
});

test('invalid Setup never overwrites a valid vault and never prints inputs', { skip: !isWindows }, async (t) => {
  const { vault } = await fixture(t);
  assert.equal(setup(vault).status, 0);
  const before = await fs.readFile(vault, 'utf8');
  for (const change of [{ password: 'bad\npassword' }, { username: '' }, { captchaApiKey: 'k'.repeat(513) }, { captchaApiKey: 'bad\0key' }]) {
    const actual = setup(vault, { ...FAKE, ...change });
    assert.notEqual(actual.status, 0);
    assert.match(actual.stderr.trim(), /^OY_LOGIN_(CREDENTIALS_INVALID|CAPTCHA_KEY_INVALID)$/);
    assert.equal(actual.stdout.trim(), '');
    assert.equal(await fs.readFile(vault, 'utf8'), before);
  }
});

test('PowerShell 7 Setup/Status uses the same DPAPI vault when installed', { skip: !isWindows }, async (t) => {
  const available = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', windowsHide: true });
  if (available.error?.code === 'ENOENT') return t.skip('PowerShell 7 not installed');
  assert.equal(available.status, 0, available.stderr);
  const { repoRoot, vault } = await fixture(t);
  const result = setup(vault, { ...FAKE, captchaEnabled: false }, 'pwsh.exe');
  assert.equal(result.status, 0, result.stderr);
  const { loadLoginSecrets } = await import(modulePath);
  const read = await loadLoginSecrets({ repoRoot, env: { OLIVEYOUNG_2CAPTCHA_ENABLED: 'true' } });
  assert.equal(read.source, 'saved');
  assert.equal(read.password, FAKE.password);
  assert.equal(read.captchaApiKey, FAKE.captchaApiKey);
  assert.equal(read.captchaEnabled, false);
  const status = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', scriptPath, '-Action', 'Status', '-VaultPath', vault], { encoding: 'utf8', windowsHide: true });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), { configured: true, captchaConfigured: true, captchaEnabled: false });
});
