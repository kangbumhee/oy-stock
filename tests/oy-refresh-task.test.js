const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const installer = path.join(repoRoot, 'scripts', 'install-oy-cookie-refresh-task.ps1');
const source = fs.readFileSync(installer, 'utf8');
const LEGACY = 'OY Refresh Cookie Every 4 Hours';
const DAILY = 'OY Refresh Cookie Daily';
const HEALTH = 'OY Login Health Every 15 Minutes';

function psLiteral(value) { return `'${value.replace(/'/g, "''")}'`; }
const oldTriggers = [0, 4, 8, 12, 16, 20].map(hour => `<CalendarTrigger><StartBoundary>2026-08-24T${String(hour).padStart(2, '0')}:10:00+09:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>`).join('');
const fixtureXml = `<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>fixture</Description><URI>\\${LEGACY}</URI></RegistrationInfo><Principals><Principal id="Author"><UserId>fixture-old-user</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals><Settings><Priority>7</Priority><Hidden>false</Hidden></Settings><Triggers>${oldTriggers}</Triggers><Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>-File &quot;C:\\old\\run-oy-cookie-refresh-task.ps1&quot;</Arguments><WorkingDirectory>C:\\old</WorkingDirectory></Exec><Exec><Command>fixture-unused-helper.exe</Command></Exec></Actions></Task>`;

function runMocked({ flags = '', twice = false, verificationFailure = false, unknownAction = false } = {}) {
  const xml = unknownAction ? fixtureXml.replace('run-oy-cookie-refresh-task.ps1', 'unknown-action.ps1') : fixtureXml;
  const command = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$global:tasks = @{}
$global:taskStates = @{}
$global:operations = New-Object System.Collections.Generic.List[string]
$global:tasks[${psLiteral(LEGACY)}] = ${psLiteral(xml)}
$global:taskStates[${psLiteral(LEGACY)}] = 'Ready'
function Get-ScheduledTask {
  param($TaskName, $TaskPath, $ErrorAction)
  if ($global:tasks.ContainsKey($TaskName)) { return [pscustomobject]@{ TaskName = $TaskName; State = $global:taskStates[$TaskName] } }
}
function Export-ScheduledTask {
  param($TaskName, $TaskPath)
  if (-not $global:tasks.ContainsKey($TaskName)) { throw 'MOCK_TASK_MISSING' }
  return $global:tasks[$TaskName]
}
function Register-ScheduledTask {
  param($TaskName, $TaskPath, $Xml, [switch]$Force)
  $global:operations.Add('register:' + $TaskName)
  $global:tasks[$TaskName] = $Xml
  $global:taskStates[$TaskName] = 'Ready'
  ${verificationFailure ? `if ($TaskName -eq ${psLiteral(HEALTH)}) { $global:taskStates[$TaskName] = 'Disabled' }` : ''}
}
function Disable-ScheduledTask {
  param($TaskName, $TaskPath)
  $global:operations.Add('disable:' + $TaskName)
  $global:taskStates[$TaskName] = 'Disabled'
}
function Start-ScheduledTask { throw 'FORBIDDEN_START' }
function Unregister-ScheduledTask { throw 'FORBIDDEN_DELETE' }
function Test-Path {
  param($LiteralPath, $PathType)
  if ($LiteralPath -like '*run-oy-login-health-task.ps1') { return $true }
  return Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath -PathType $PathType
}
$errorCode = $null
$reports = @()
try {
  $reports += ((& ${psLiteral(installer)} -RepoRoot ${psLiteral(repoRoot)} ${flags}) | ConvertFrom-Json)
  ${twice ? `$reports += ((& ${psLiteral(installer)} -RepoRoot ${psLiteral(repoRoot)} ${flags}) | ConvertFrom-Json)` : ''}
} catch { $errorCode = $_.Exception.Message }
[pscustomobject]@{ reports = @($reports); operations = @($global:operations); errorCode = $errorCode; definitions = $global:tasks; states = $global:taskStates } | ConvertTo-Json -Depth 10 -Compress
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}

test('installer contains no start/delete/password/autologon actions and parseable PowerShell', { skip: process.platform !== 'win32' }, () => {
  assert.doesNotMatch(source, /\b(?:Start-ScheduledTask|Unregister-ScheduledTask|Set-ItemProperty)\b/);
  assert.doesNotMatch(source, /Register-ScheduledTask[^\r\n]*-(?:Password|User)\b/);
  const check = `$tokens = $null; $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(${psLiteral(installer)}, [ref]$tokens, [ref]$errors); @($errors | ForEach-Object { $_.Message }) | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(check, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.trim() || result.stdout.trim() === '[]', result.stdout);
});

test('CheckOnly and DryRun inspect and plan without any scheduler mutation', { skip: process.platform !== 'win32' }, () => {
  for (const flags of ['-CheckOnly', '-DryRun']) {
    const result = runMocked({ flags });
    assert.equal(result.errorCode, null);
    assert.deepEqual(result.operations, []);
    assert.equal(result.states[LEGACY], 'Ready');
    const report = result.reports[0];
    assert.equal(report.changed, false);
    assert.equal(report.disableLegacyAfterVerification, true);
    assert.equal(report.windowsPasswordStored, false);
    assert.equal(report.tasks.length, 2);
    for (const task of report.tasks) {
      assert.equal(task.planned.startup, true);
      assert.equal(task.planned.periodic, true);
      assert.equal(task.planned.hidden, true);
      assert.equal(task.planned.currentUserOnly, true);
      assert.equal(task.planned.settingsReady, true);
      assert.ok(task.wrapper.startsWith(repoRoot));
    }
    assert.match(report.tasks[0].arguments, /-File ".*run-oy-cookie-refresh-task\.ps1" -NoInteractiveLogin$/);
    assert.match(report.tasks[1].arguments, /-File ".*run-oy-login-health-task\.ps1"$/);
  }
});

test('migration verifies both replacements before disabling recoverable old task', { skip: process.platform !== 'win32' }, () => {
  const result = runMocked();
  assert.equal(result.errorCode, null);
  assert.deepEqual(result.operations, [`register:${DAILY}`, `register:${HEALTH}`, `disable:${LEGACY}`]);
  assert.equal(result.states[LEGACY], 'Disabled');
  assert.equal(result.definitions[LEGACY], fixtureXml);
  assert.equal(result.reports[0].dailyRefresh, true);
  assert.equal(result.reports[0].healthEvery15Minutes, true);
  assert.equal(result.reports[0].started, false);
  assert.match(result.definitions[DAILY], /<Priority>7<\/Priority>/);
  assert.match(result.definitions[DAILY], /<Hidden>false<\/Hidden>/);
  assert.match(result.definitions[DAILY], /fixture-unused-helper\.exe/);
  assert.equal((result.definitions[DAILY].match(/<CalendarTrigger>/g) || []).length, 1);
  assert.match(result.definitions[DAILY], /T00:10:00<\/StartBoundary>/);
  assert.doesNotMatch(result.definitions[DAILY], /T(?:04|08|12|16|20):10:00/);
  assert.match(result.definitions[DAILY], /<Delay>PT1M<\/Delay>/);
  assert.match(result.definitions[HEALTH], /<Interval>PT15M<\/Interval>/);
  assert.doesNotMatch(result.definitions[HEALTH], /<Duration>/);
  assert.match(result.definitions[HEALTH], /<Delay>PT2M<\/Delay>/);
});

test('reinstall keeps exactly two replacement tasks and one periodic plus one logon trigger each', { skip: process.platform !== 'win32' }, () => {
  const result = runMocked({ twice: true });
  assert.equal(result.errorCode, null);
  assert.equal(result.reports.length, 2);
  assert.deepEqual(Object.keys(result.definitions).sort(), [LEGACY, DAILY, HEALTH].sort());
  for (const name of [DAILY, HEALTH]) {
    assert.equal((result.definitions[name].match(/<LogonTrigger\b/g) || []).length, 1);
    assert.equal((result.definitions[name].match(/<(?:CalendarTrigger|TimeTrigger)>/g) || []).length, 1);
    assert.match(result.definitions[name], /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  }
});

test('failed replacement verification leaves legacy task enabled', { skip: process.platform !== 'win32' }, () => {
  const result = runMocked({ verificationFailure: true });
  assert.equal(result.errorCode, 'TASK_VERIFICATION_FAILED');
  assert.ok(!result.operations.includes(`disable:${LEGACY}`));
  assert.equal(result.states[LEGACY], 'Ready');
  assert.equal(result.states[DAILY], 'Disabled');
  assert.equal(result.states[HEALTH], 'Disabled');
});

test('unrecognized existing action is never overwritten or registered', { skip: process.platform !== 'win32' }, () => {
  const result = runMocked({ unknownAction: true });
  assert.equal(result.errorCode, 'TASK_ACTION_NOT_RECOGNIZED');
  assert.deepEqual(result.operations, []);
});
