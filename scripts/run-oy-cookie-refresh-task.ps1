param()

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

Push-Location $RepoRoot
try {
  Write-Log "Starting OliveYoung cookie refresh task"
  Write-Log "StartedAt=$StartedAt"

  $output = & npm run refresh:oy-cookie:chrome 2>&1
  $exitCode = $LASTEXITCODE
  foreach ($line in $output) {
    Write-Log $line
  }

  if ($exitCode -ne 0) {
    Write-Log "Task failed with exit code $exitCode"
    exit $exitCode
  }

  Write-Log 'Task completed successfully'
} catch {
  Write-Log "Task error: $($_.Exception.Message)"
  exit 1
} finally {
  Pop-Location
}
