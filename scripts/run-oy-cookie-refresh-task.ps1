param(
  [switch]$NoDispatch,
  [switch]$NoInteractiveLogin,
  [switch]$InteractiveLogin
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$LogDir = Join-Path $RepoRoot '.ai\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$LogFile = Join-Path $LogDir 'oy-cookie-refresh-task.log'
$StartedAt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'

function Write-Log($Message) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')] $Message"
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
  Write-Host $line
}

function Invoke-RefreshCommand {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Refresh', 'Setup')]
    [string]$Mode
  )

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Mode -eq 'Setup') {
      $env:OY_HEADLESS = '0'
      Write-Log 'BrowserMode=headed-for-manual-login'
      $commandOutput = & npm.cmd run setup:oy-cookie-profile 2>&1
    } else {
      $env:OY_HEADLESS = '1'
      Write-Log 'BrowserMode=headless'
      $commandOutput = & npm.cmd run refresh:oy-cookie:chrome 2>&1
    }

    $commandExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  foreach ($line in $commandOutput) {
    Write-Log $line
  }

  return $commandExitCode
}

Push-Location $RepoRoot
try {
  Write-Log "Starting OliveYoung cookie refresh task"
  $env:OY_UNATTENDED = '1'
  Write-Log "StartedAt=$StartedAt"

  $PlaywrightPackage = Join-Path $RepoRoot 'node_modules\playwright\package.json'
  if (-not (Test-Path -LiteralPath $PlaywrightPackage)) {
    Write-Log 'Playwright dependency missing; restoring npm dependencies'
    $installOutput = & npm.cmd ci --no-audit --no-fund 2>&1
    $installExitCode = $LASTEXITCODE
    foreach ($line in $installOutput) {
      Write-Log $line
    }

    if ($installExitCode -ne 0) {
      Write-Log "Dependency restore failed with exit code $installExitCode"
      exit $installExitCode
    }
  }

  if ($NoDispatch) {
    $env:OY_SKIP_WORKFLOW_DISPATCH = '1'
    Write-Log 'WorkflowDispatch=skipped-for-validation'
  }

  $HumanLoginRequiredExitCode = 42
  $exitCode = Invoke-RefreshCommand -Mode Refresh

  if ($exitCode -eq $HumanLoginRequiredExitCode -and $InteractiveLogin -and -not $NoInteractiveLogin) {
    Write-Log 'HumanLoginRequired=true; opening the dedicated visible login window'
    $setupExitCode = Invoke-RefreshCommand -Mode Setup
    if ($setupExitCode -ne 0) {
      Write-Log "Interactive login did not complete successfully (exit code $setupExitCode)"
      exit $setupExitCode
    }

    Write-Log 'Interactive login completed; resuming cookie refresh'
    $exitCode = Invoke-RefreshCommand -Mode Refresh
  }

  if ($exitCode -ne 0) {
    if ($exitCode -eq 75) {
      Write-Log 'Another refresh/settings operation is active; skipping this run'
      exit 0
    }
    if (-not $NoDispatch) {
      & node scripts/check-oy-login.mjs --refresh-failed $exitCode
    }
    Write-Log "Task failed with exit code $exitCode"
    exit $exitCode
  }

  # Workflow dispatch is not publication success. The next health check confirms
  # both local and published authentication before clearing an outage marker.
  Write-Log 'Task completed successfully'
} catch {
  Write-Log 'Task error: COOKIE_REFRESH_TASK_FAILED'
  if (-not $NoDispatch) {
    & node scripts/check-oy-login.mjs --refresh-failed 1
  }
  exit 1
} finally {
  Pop-Location
}
