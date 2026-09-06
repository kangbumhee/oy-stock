[CmdletBinding()]
param(
  [ValidateSet('Setup', 'Status', 'Clear', 'Read')]
  [string]$Action = 'Setup',
  [string]$VaultPath
)

# PowerShell 5 may evaluate parameter defaults before PSScriptRoot is available.
if ([string]::IsNullOrWhiteSpace($VaultPath)) {
  $VaultPath = Join-Path $PSScriptRoot '..\.auth\oy-login-secrets.json'
}

# Never pass credentials in command-line arguments or persist plaintext JSON.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$script:KnownErrors = @(
  'OY_LOGIN_VAULT_WINDOWS_ONLY', 'OY_LOGIN_VAULT_INVALID_PATH',
  'OY_LOGIN_VAULT_LOCKED', 'OY_LOGIN_VAULT_INVALID',
  'OY_LOGIN_VAULT_DECRYPT_FAILED', 'OY_LOGIN_VAULT_READ_INTERNAL_ONLY',
  'OY_LOGIN_CREDENTIALS_INVALID', 'OY_LOGIN_CAPTCHA_KEY_INVALID',
  'OY_LOGIN_VAULT_OPERATION_FAILED'
)

function Assert-Record($Record) {
  if ($null -eq $Record -or $Record.username -isnot [string] -or
      $Record.password -isnot [string] -or $Record.captchaApiKey -isnot [string] -or
      $Record.captchaEnabled -isnot [bool]) {
    throw 'OY_LOGIN_VAULT_INVALID'
  }
  if ([string]::IsNullOrWhiteSpace($Record.username) -or $Record.username -match '[\x00\r\n]' -or
      $Record.password.Length -eq 0 -or $Record.password -match '[\x00\r\n]') {
    throw 'OY_LOGIN_CREDENTIALS_INVALID'
  }
  if ($Record.captchaApiKey -match '[\x00\r\n]' -or $Record.captchaApiKey.Trim().Length -gt 512) {
    throw 'OY_LOGIN_CAPTCHA_KEY_INVALID'
  }
  $Record.username = $Record.username.Trim()
  $Record.captchaApiKey = $Record.captchaApiKey.Trim()
  $Record.captchaEnabled = [bool]($Record.captchaEnabled -and $Record.captchaApiKey.Length -gt 0)
  return $Record
}

function ConvertFrom-SecretInput([Security.SecureString]$Value) {
  $pointer = [IntPtr]::Zero
  try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    if ($null -ne $Value) { $Value.Dispose() }
  }
}

function Set-PrivateFileAcl([string]$Path) {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  # The newly created file already belongs to this user. Changing its owner
  # would also require WRITE_OWNER, which ordinary project folders do not grant.
  # Persist only the private access rules; keep ownership unchanged.
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid, [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  )
  $acl.AddAccessRule($rule)
  if ('SetAccessControl' -in [IO.File].GetMethods().Name) {
    [IO.File]::SetAccessControl($Path, $acl)
  } else {
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($Path), $acl)
  }
}

function Read-Vault([string]$Path) {
  if (-not [IO.File]::Exists($Path)) {
    if ([IO.Directory]::Exists($Path)) { throw 'OY_LOGIN_VAULT_INVALID' }
    return $null
  }
  $bytes = $null
  try {
    $file = [IO.FileInfo]::new($Path)
    if ($file.Length -gt 65536 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'OY_LOGIN_VAULT_INVALID'
    }
    try { $envelope = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json }
    catch { throw 'OY_LOGIN_VAULT_INVALID' }
    if ($envelope.version -ne 1 -or $envelope.ciphertext -isnot [string] -or
        [string]::IsNullOrEmpty($envelope.ciphertext) -or @($envelope.PSObject.Properties).Count -ne 2) {
      throw 'OY_LOGIN_VAULT_INVALID'
    }
    try {
      $encrypted = [Convert]::FromBase64String($envelope.ciphertext)
      $bytes = [Security.Cryptography.ProtectedData]::Unprotect(
        $encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
      )
    } catch { throw 'OY_LOGIN_VAULT_DECRYPT_FAILED' }
    try { $record = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json }
    catch { throw 'OY_LOGIN_VAULT_INVALID' }
    return (Assert-Record $record)
  } finally {
    if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
  }
}

function Write-Vault([string]$Path, $Record) {
  $bytes = $null
  $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  try {
    $valid = Assert-Record $Record
    $bytes = [Text.Encoding]::UTF8.GetBytes(($valid | ConvertTo-Json -Compress))
    $encrypted = [Security.Cryptography.ProtectedData]::Protect(
      $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $envelope = [ordered]@{ version = 1; ciphertext = [Convert]::ToBase64String($encrypted) }
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stream.Dispose()
    Set-PrivateFileAcl $temporary
    [IO.File]::WriteAllText($temporary, ($envelope | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($Path)) {
      if (([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint)) { throw 'OY_LOGIN_VAULT_INVALID' }
      # Windows PowerShell otherwise coerces $null to an invalid empty backup path.
      [IO.File]::Replace($temporary, $Path, [NullString]::Value)
    } else {
      [IO.File]::Move($temporary, $Path)
    }
    Set-PrivateFileAcl $Path
  } finally {
    if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
}

function Write-Status($Record) {
  $hasRecord = $null -ne $Record
  $hasKey = $hasRecord -and -not [string]::IsNullOrEmpty($Record.captchaApiKey)
  $disabled = @('0', 'false', 'no', 'off', 'disabled')
  $envDisabled = $disabled -contains ([string]$env:OLIVEYOUNG_2CAPTCHA_ENABLED).Trim().ToLowerInvariant()
  $envDisabled = $envDisabled -or ($disabled -contains ([string]$env:KOREA_TOP_2CAPTCHA_ENABLED).Trim().ToLowerInvariant())
  [ordered]@{
    configured = [bool]$hasRecord
    captchaConfigured = [bool]$hasKey
    captchaEnabled = [bool]($hasKey -and $Record.captchaEnabled -and -not $envDisabled)
  } | ConvertTo-Json -Compress
}

$refreshMutex = $null
try {
  if ($env:OS -ne 'Windows_NT') { throw 'OY_LOGIN_VAULT_WINDOWS_ONLY' }
  Add-Type -AssemblyName System.Security
  try { $resolvedVault = [IO.Path]::GetFullPath($VaultPath) }
  catch { throw 'OY_LOGIN_VAULT_INVALID_PATH' }
  $directory = [IO.Path]::GetDirectoryName($resolvedVault)
  if ([string]::IsNullOrEmpty($directory)) { throw 'OY_LOGIN_VAULT_INVALID_PATH' }
  if ($Action -in @('Setup', 'Clear')) {
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    try {
      . (Join-Path $PSScriptRoot 'oy-refresh-mutex.ps1') -Mode Library
      $refreshMutex = Enter-OyRefreshMutex $directory 'refresh'
    } catch { throw 'OY_LOGIN_VAULT_LOCKED' }
  }
  switch ($Action) {
    'Setup' {
      $username = Read-Host 'OliveYoung username'
      $password = ConvertFrom-SecretInput (Read-Host 'OliveYoung password (hidden)' -AsSecureString)
      $captchaApiKey = ConvertFrom-SecretInput (Read-Host 'Optional 2Captcha API key (hidden; Enter to skip)' -AsSecureString)
      $enable = $false
      if (-not [string]::IsNullOrWhiteSpace($captchaApiKey)) {
        $answer = Read-Host 'Enable paid 2Captcha tasks for automatic login? [y/N]'
        $enable = $answer.Trim().ToLowerInvariant() -in @('y', 'yes')
      }
      $record = [PSCustomObject]@{
        username = $username; password = $password
        captchaApiKey = $captchaApiKey; captchaEnabled = $enable
      }
      Write-Vault $resolvedVault $record
      Write-Status (Assert-Record $record)
    }
    'Status' { Write-Status (Read-Vault $resolvedVault) }
    'Clear' {
      if ([IO.File]::Exists($resolvedVault)) { [IO.File]::Delete($resolvedVault) }
      elseif ([IO.Directory]::Exists($resolvedVault)) { throw 'OY_LOGIN_VAULT_INVALID' }
      Write-Status $null
    }
    'Read' {
      if ($env:OY_LOGIN_SECRETS_INTERNAL_READ -ne '1') { throw 'OY_LOGIN_VAULT_READ_INTERNAL_ONLY' }
      $record = Read-Vault $resolvedVault
      if ($null -eq $record) { 'null' } else { $record | ConvertTo-Json -Compress }
    }
  }
} catch {
  $code = $_.Exception.Message
  if ($script:KnownErrors -notcontains $code) { $code = 'OY_LOGIN_VAULT_OPERATION_FAILED' }
  [Console]::Error.WriteLine($code)
  exit 1
} finally {
  if ($null -ne $refreshMutex) {
    try { $refreshMutex.ReleaseMutex() } finally { $refreshMutex.Dispose() }
  }
}
