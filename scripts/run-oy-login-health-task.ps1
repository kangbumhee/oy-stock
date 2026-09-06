param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).ProviderPath
$LogDirectory = Join-Path $RepoRoot '.ai\logs'
[IO.Directory]::CreateDirectory($LogDirectory) | Out-Null
$LogFile = Join-Path $LogDirectory 'oy-login-health-task.log'

function Write-HealthLog([string]$Message) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz') + '] ' + $Message
  [IO.File]::AppendAllText($LogFile, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  Write-Host $line
}

Push-Location $RepoRoot
try {
  $env:OY_HEADLESS = '1'
  $env:OY_UNATTENDED = '1'
  $ErrorActionPreference = 'Continue'
  $result = & node (Join-Path $PSScriptRoot 'check-oy-login.mjs') 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  # The Node wrapper emits sanitized state only. Do not forward unexpected subprocess output.
  foreach ($line in $result) {
    try {
      $state = [string]$line | ConvertFrom-Json
      if ($state.status -in @('healthy', 'reconnect_required', 'check_failed', 'busy') -and
          $state.notification -in @('not_needed', 'sent', 'already_sent', 'pending', 'dispatch_failed')) {
        Write-HealthLog ('Status=' + $state.status + '; Notification=' + $state.notification)
      }
    } catch { }
  }
  if ($exitCode -eq 75) { Write-HealthLog 'Skipped: refresh or another health report is running'; exit 0 }
  if ($exitCode -eq 0) { exit 0 }
  if ($exitCode -eq 42) { Write-HealthLog 'Reconnect required'; exit 42 }
  Write-HealthLog 'Health check or alert dispatch failed'
  exit 1
} catch {
  Write-HealthLog 'Health task failed'
  exit 1
} finally { Pop-Location }
