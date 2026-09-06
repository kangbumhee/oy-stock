[CmdletBinding()]
param(
  [ValidateSet('Hold', 'Library')][string]$Mode = 'Hold',
  [string]$AuthDirectory,
  [ValidateSet('refresh', 'health-state')][string]$Scope = 'refresh'
)

# Shared by Node's hidden holder and the interactive vault command. Kernel
# ownership disappears after a crash/reboot; no stale lock file is reclaimed.
function Get-OyRefreshMutexName {
  param([string]$Directory, [ValidateSet('refresh', 'health-state')][string]$MutexScope = 'refresh')
  if ([string]::IsNullOrWhiteSpace($Directory)) { throw 'OY_REFRESH_LOCK_FAILED' }
  $canonical = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/').ToUpperInvariant()
  $digest = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($MutexScope + "`n" + $canonical)
    $hash = [BitConverter]::ToString($digest.ComputeHash($bytes)).Replace('-', '')
    return 'Global\OliveYoungCookie.' + $hash
  } finally { $digest.Dispose() }
}

function Enter-OyRefreshMutex {
  param([string]$Directory, [ValidateSet('refresh', 'health-state')][string]$MutexScope = 'refresh')
  $mutex = $null
  try {
    $name = Get-OyRefreshMutexName $Directory $MutexScope
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = [Security.AccessControl.MutexSecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($sid)
    $security.AddAccessRule([Security.AccessControl.MutexAccessRule]::new(
      $sid, [Security.AccessControl.MutexRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow
    ))
    $created = $false
    if ($PSVersionTable.PSEdition -eq 'Core') {
      Add-Type -AssemblyName System.Threading.AccessControl
      $mutex = [Threading.MutexAcl]::Create($false, $name, [ref]$created, $security)
    } else {
      $mutex = [Threading.Mutex]::new($false, $name, [ref]$created, $security)
    }
    $owned = $false
    try { $owned = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { throw 'OY_REFRESH_BUSY' }
    return $mutex
  } catch {
    if ($null -ne $mutex) { $mutex.Dispose() }
    if ($_.Exception.Message -eq 'OY_REFRESH_BUSY') { throw 'OY_REFRESH_BUSY' }
    throw 'OY_REFRESH_LOCK_FAILED'
  }
}

if ($Mode -eq 'Library') { return }
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$held = $null
try {
  $held = Enter-OyRefreshMutex $AuthDirectory $Scope
  [Console]::Out.WriteLine('OY_MUTEX_ACQUIRED')
  [Console]::Out.Flush()
  # EOF occurs on release or when the owning Node process exits/is killed.
  [void][Console]::In.ReadToEnd()
} catch {
  $code = if ($_.Exception.Message -eq 'OY_REFRESH_BUSY') { 'OY_REFRESH_BUSY' } else { 'OY_REFRESH_LOCK_FAILED' }
  [Console]::Error.WriteLine($code)
  if ($code -eq 'OY_REFRESH_BUSY') { exit 75 } else { exit 1 }
} finally {
  if ($null -ne $held) {
    try { $held.ReleaseMutex() } finally { $held.Dispose() }
  }
}
