param(
  [switch]$CheckOnly,
  [switch]$NoDispatch
)

$ErrorActionPreference = 'Stop'

$DashboardUrl = 'https://m.oliveyoung.co.kr/m/mtn/affiliate/dashboard'
$AesKey = [System.Text.Encoding]::UTF8.GetBytes('cjone_g4de7353f1')
$WaitMs = if ($env:OY_DASHBOARD_WAIT_MS) { [int]$env:OY_DASHBOARD_WAIT_MS } else { 8000 }
$DebugLogDir = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) '.ai\logs'
New-Item -ItemType Directory -Force -Path $DebugLogDir | Out-Null
$DebugLogFile = Join-Path $DebugLogDir 'oy-cookie-refresh-debug.log'

function Write-Info($Message) {
  $line = "[INFO] $Message"
  Write-Host $line
  Add-Content -LiteralPath $DebugLogFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')] $line"
}

function Get-RepoArgs {
  $repo = ''
  if ($env:GITHUB_REPO) { $repo = $env:GITHUB_REPO.Trim() }
  elseif ($env:GITHUB_REPOSITORY) { $repo = $env:GITHUB_REPOSITORY.Trim() }
  else {
    try {
      $remote = (& git config --get remote.origin.url 2>$null).Trim()
      if ($remote -match 'github\.com[:/](?<owner>[^/]+)/(?<repo>[^/.]+)(?:\.git)?$') {
        $repo = "$($Matches.owner)/$($Matches.repo)"
      }
    } catch {
      $repo = ''
    }
  }

  if ($repo) { return @('--repo', $repo) }
  return @()
}

function Get-DevToolsEndpoint {
  if ($env:CHROME_CDP_ENDPOINT) { return $env:CHROME_CDP_ENDPOINT.Trim() }

  $userDataDir = $env:CHROME_USER_DATA_DIR
  if (-not $userDataDir) {
    $userDataDir = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
  }

  $portFile = $env:CHROME_DEVTOOLS_ACTIVE_PORT_FILE
  if (-not $portFile) {
    $portFile = Join-Path $userDataDir 'DevToolsActivePort'
  }

  if (-not (Test-Path -LiteralPath $portFile)) {
    throw "Chrome DevToolsActivePort file not found: $portFile"
  }

  $lines = Get-Content -LiteralPath $portFile
  if ($lines.Count -lt 2) {
    throw "Invalid DevToolsActivePort file: $portFile"
  }

  return "ws://127.0.0.1:$($lines[0])$($lines[1])"
}

function Connect-Cdp($Endpoint) {
  $lastError = $null
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    $ws = [System.Net.WebSockets.ClientWebSocket]::new()
    $ws.Options.AddSubProtocol('v10.chrome.devtools')
    $cts = [System.Threading.CancellationTokenSource]::new(30000)
    try {
      $ws.ConnectAsync([Uri]::new($Endpoint), $cts.Token).GetAwaiter().GetResult() | Out-Null
      return $ws
    } catch {
      $lastError = $_.Exception.Message
      try { $ws.Abort() } catch {}
      if ($attempt -lt 5) {
        Start-Sleep -Seconds 3
      }
    }
  }

  throw "Chrome CDP connect failed after retries: $lastError"
}

function Receive-CdpText($Ws, $Token) {
  $buffer = New-Object byte[] 1048576
  $sb = [System.Text.StringBuilder]::new()
  do {
    $res = $Ws.ReceiveAsync([ArraySegment[byte]]::new($buffer), $Token).GetAwaiter().GetResult()
    [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $res.Count))
  } until ($res.EndOfMessage)
  return $sb.ToString()
}

$script:CdpId = 0
function Send-Cdp($Ws, [string]$Method, $Params = $null, [string]$SessionId = $null) {
  $script:CdpId++
  $msg = [ordered]@{ id = $script:CdpId; method = $Method }
  if ($null -ne $Params) { $msg.params = $Params }
  if ($SessionId) { $msg.sessionId = $SessionId }

  $json = $msg | ConvertTo-Json -Depth 20 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $cts = [System.Threading.CancellationTokenSource]::new(30000)
  $Ws.SendAsync(
    [ArraySegment[byte]]::new($bytes),
    [System.Net.WebSockets.WebSocketMessageType]::Text,
    $true,
    $cts.Token
  ).GetAwaiter().GetResult() | Out-Null

  while ($true) {
    $text = Receive-CdpText $Ws $cts.Token
    $obj = $text | ConvertFrom-Json
    if ($obj.id -eq $script:CdpId) {
      if ($obj.error) {
        throw "$Method failed: $($obj.error.message)"
      }
      return $obj
    }
  }
}

function ConvertFrom-Hex($Hex) {
  $clean = ($Hex -replace '\s+', '').Trim()
  if ($clean.Length % 2 -ne 0) { throw 'Invalid hex length' }
  $bytes = New-Object byte[] ($clean.Length / 2)
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    $bytes[$i] = [Convert]::ToByte($clean.Substring($i * 2, 2), 16)
  }
  return $bytes
}

function ConvertFrom-Base64UrlJson($Base64Url) {
  $b64 = $Base64Url.Replace('-', '+').Replace('_', '/')
  while ($b64.Length % 4 -ne 0) { $b64 += '=' }
  $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
  return $json | ConvertFrom-Json
}

function Get-LinkageJwtExpiry($LinkageHex) {
  try {
    $encrypted = ConvertFrom-Hex $LinkageHex
    $aes = [System.Security.Cryptography.Aes]::Create()
    $aes.Mode = [System.Security.Cryptography.CipherMode]::ECB
    $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
    $aes.Key = $AesKey
    $decryptor = $aes.CreateDecryptor()
    $plainBytes = $decryptor.TransformFinalBlock($encrypted, 0, $encrypted.Length)
    $jwt = [System.Text.Encoding]::UTF8.GetString($plainBytes).Trim()
    $parts = $jwt.Split('.')
    if ($parts.Count -lt 2) { return $null }
    $payload = ConvertFrom-Base64UrlJson $parts[1]
    if ($null -eq $payload.exp) { return $null }
    return [int64]$payload.exp
  } catch {
    return $null
  }
}

function Read-OliveYoungCookiesFromChrome {
  $endpoint = Get-DevToolsEndpoint
  $ws = Connect-Cdp $endpoint
  $targetId = $null

  try {
    $target = Send-Cdp $ws 'Target.createTarget' @{ url = 'about:blank' }
    $targetId = $target.result.targetId
    $attached = Send-Cdp $ws 'Target.attachToTarget' @{ targetId = $targetId; flatten = $true }
    $sessionId = $attached.result.sessionId

    Send-Cdp $ws 'Page.enable' @{} $sessionId | Out-Null
    Send-Cdp $ws 'Runtime.enable' @{} $sessionId | Out-Null
    Send-Cdp $ws 'Network.enable' @{} $sessionId | Out-Null
    Send-Cdp $ws 'Page.navigate' @{ url = $DashboardUrl } $sessionId | Out-Null
    Start-Sleep -Milliseconds $WaitMs

    $pageEval = Send-Cdp $ws 'Runtime.evaluate' @{
      expression = 'JSON.stringify({href:location.href,title:document.title,text:(document.body&&document.body.innerText||"").replace(/\s+/g," ").slice(0,220)})'
      returnByValue = $true
    } $sessionId
    $pageInfo = $pageEval.result.result.value | ConvertFrom-Json

    $cookieRes = Send-Cdp $ws 'Network.getCookies' @{ urls = @($DashboardUrl) } $sessionId
    $cookies = @($cookieRes.result.cookies)

    Send-Cdp $ws 'Target.closeTarget' @{ targetId = $targetId } | Out-Null
    $targetId = $null

    return @{
      PageInfo = $pageInfo
      Cookies = $cookies
    }
  } finally {
    if ($targetId) {
      try { Send-Cdp $ws 'Target.closeTarget' @{ targetId = $targetId } | Out-Null } catch {}
    }
    if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      $ws.Abort()
    }
  }
}

function Select-OliveYoungCookies($Cookies) {
  $selected = @($Cookies | Where-Object {
    $domain = ([string]$_.domain).TrimStart('.')
    $domain -match 'oliveyoung\.co\.kr$' -and ($_.name -eq 'linkageString' -or ([string]$_.name).StartsWith('OY'))
  })

  $byName = @{}
  foreach ($cookie in $selected) {
    $domain = ([string]$cookie.domain).TrimStart('.')
    if (-not $byName.ContainsKey($cookie.name) -or $domain -eq 'm.oliveyoung.co.kr') {
      $byName[$cookie.name] = $cookie
    }
  }

  return @($byName.Values)
}

function Update-GitHubSecretFromStdin($Name, $Value) {
  Write-Info "Updating GitHub Secret '$Name'"
  $ghArgs = @('secret', 'set', $Name) + (Get-RepoArgs)
  Write-Info "gh args: $($ghArgs -join ' ')"
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($tmp, $Value, $utf8NoBom)
    Write-Info 'Secret value written to temporary stdin file'
    $quotedArgs = ($ghArgs | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
    $quotedTmp = '"' + ($tmp -replace '"', '\"') + '"'
    Write-Info 'Running gh secret set'
    $output = cmd /c "gh $quotedArgs < $quotedTmp" 2>&1
    Write-Info 'gh secret set returned'
    if ($LASTEXITCODE -ne 0) {
      throw "gh secret set failed: $output"
    }
  } finally {
    if (Test-Path -LiteralPath $tmp) {
      Remove-Item -LiteralPath $tmp -Force
    }
  }
  Write-Info "GitHub Secret '$Name' updated (value hidden)"
}

function Invoke-RefreshWorkflow {
  $workflow = if ($env:OY_REFRESH_WORKFLOW) { $env:OY_REFRESH_WORKFLOW.Trim() } else { 'refresh-oy-linkage.yml' }
  $args = @('workflow', 'run', $workflow) + (Get-RepoArgs)
  Write-Info "Dispatching workflow '$workflow'"
  & gh @args | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "gh workflow run failed: $workflow" }

  Start-Sleep -Seconds 3
  Write-Info "GitHub workflow '$workflow' dispatched"
  try {
    $listArgs = @(
      'run', 'list',
      '--workflow', $workflow,
      '--limit', '1',
      '--json', 'databaseId,status,conclusion,url,createdAt'
    ) + (Get-RepoArgs)
    $latest = & gh @listArgs
    if ($latest) { Write-Info "latest run: $latest" }
  } catch {
    Write-Info 'workflow dispatched; latest run lookup skipped'
  }
}

try {
  $read = Read-OliveYoungCookiesFromChrome
  $pageInfo = $read.PageInfo
  $selected = Select-OliveYoungCookies $read.Cookies
  $linkage = @($selected | Where-Object { $_.name -eq 'linkageString' } | Select-Object -First 1)
  $oySession = @($selected | Where-Object { $_.name -eq 'OYSESSIONID' } | Select-Object -First 1)
  $names = @($selected | Select-Object -ExpandProperty name -Unique | Sort-Object)
  $rawCookie = ($selected | ForEach-Object { "$($_.name)=$($_.value)" }) -join '; '
  $exp = if ($linkage) { Get-LinkageJwtExpiry $linkage.value } else { $null }

  Write-Info "dashboard url: $($pageInfo.href)"
  Write-Info "dashboard title: $($pageInfo.title)"
  Write-Info "logged-in preview: $($pageInfo.text)"
  Write-Info "OliveYoung cookie names: $($names -join ', ')"
  Write-Info "linkageString: $(if ($linkage) { 'present' } else { 'missing' })"
  Write-Info "OYSESSIONID: $(if ($oySession) { 'present' } else { 'missing' })"
  if ($exp) {
    $expIso = [DateTimeOffset]::FromUnixTimeSeconds($exp).UtcDateTime.ToString('o')
    Write-Info "linkage JWT exp: $expIso"
    if ($exp -le [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) {
      throw 'linkageString JWT is expired'
    }
  } else {
    Write-Info 'linkage JWT exp: unknown'
  }

  if (-not $linkage -or -not $oySession -or -not $rawCookie) {
    throw 'Logged-in Chrome did not expose required OliveYoung cookies'
  }

  if ($CheckOnly) {
    Write-Info 'check-only mode: required cookies are available; no secrets updated'
    exit 0
  }

  Update-GitHubSecretFromStdin 'OY_REFRESH_COOKIE' $rawCookie

  if ($NoDispatch -or $env:OY_SKIP_WORKFLOW_DISPATCH -eq '1') {
    Write-Info 'workflow dispatch skipped'
    exit 0
  }

  Invoke-RefreshWorkflow
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
