[CmdletBinding()]
param(
  [string]$RepoRoot,
  [switch]$CheckOnly,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Join-Path $PSScriptRoot '..' }
$TaskPath = '\'
$LegacyTaskName = 'OY Refresh Cookie Every 4 Hours'
$RefreshTaskName = 'OY Refresh Cookie Daily'
$HealthTaskName = 'OY Login Health Every 15 Minutes'
$TaskNamespace = 'http://schemas.microsoft.com/windows/2004/02/mit/task'
$CurrentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$CurrentUser = $CurrentIdentity.Name
$CurrentUserSid = $CurrentIdentity.User.Value

function Get-TaskChild {
  param([System.Xml.XmlElement]$Parent, [string]$Name)
  if (-not $Parent) { return $null }
  return $Parent.SelectSingleNode("*[local-name()='$Name']")
}

function Set-TaskText {
  param([System.Xml.XmlElement]$Parent, [string]$Name, [string]$Value)
  $child = Get-TaskChild $Parent $Name
  if (-not $child) {
    $child = $Parent.OwnerDocument.CreateElement($Name, $TaskNamespace)
    [void]$Parent.AppendChild($child)
  }
  $child.InnerText = $Value
}

function Get-OyTask {
  param([string]$Name)
  return Get-ScheduledTask -TaskName $Name -TaskPath $TaskPath -ErrorAction SilentlyContinue
}

function Test-TaskEnabled {
  param([System.Xml.XmlElement]$Parent)
  $enabled = Get-TaskChild $Parent 'Enabled'
  # Task Scheduler omits this XML element when its schema default is true.
  return -not $enabled -or $enabled.InnerText -eq 'true'
}

function Test-CurrentTaskUser {
  param([string]$UserId)
  if ([string]::IsNullOrWhiteSpace($UserId)) { return $false }
  if ($UserId -eq $CurrentUserSid) { return $true }
  try {
    $account = [Security.Principal.NTAccount]::new($UserId)
    return $account.Translate([Security.Principal.SecurityIdentifier]).Value -eq $CurrentUserSid
  } catch { return $false }
}

function Get-ActionArguments {
  param([string]$Wrapper, [string]$Kind)
  # -File receives a literal quoted path; no shell expansion or -Command is used.
  $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Wrapper + '"'
  if ($Kind -eq 'refresh') { $arguments += ' -NoInteractiveLogin' }
  return $arguments
}

function Get-TaskSummary {
  param([System.Xml.XmlDocument]$Document, [ValidateSet('refresh', 'health')][string]$Kind, [string]$State = 'Unknown')
  $task = $Document.DocumentElement
  $triggers = Get-TaskChild $task 'Triggers'
  $logons = @($triggers.ChildNodes | Where-Object { $_.LocalName -eq 'LogonTrigger' })
  $periodicTriggers = @($triggers.ChildNodes | Where-Object { $_.LocalName -in @('CalendarTrigger', 'TimeTrigger') })
  $startup = $false
  if ($logons.Count -eq 1) {
    $startup = (Test-CurrentTaskUser (Get-TaskChild $logons[0] 'UserId').InnerText) -and
      (Get-TaskChild $logons[0] 'Delay').InnerText -eq $(if ($Kind -eq 'refresh') { 'PT1M' } else { 'PT2M' }) -and
      (Test-TaskEnabled $logons[0])
  }
  $periodic = $false
  if ($periodicTriggers.Count -eq 1) {
    $periodicTrigger = $periodicTriggers[0]
    $enabled = Test-TaskEnabled $periodicTrigger
    if ($Kind -eq 'refresh') {
      $schedule = Get-TaskChild $periodicTrigger 'ScheduleByDay'
      $periodic = $enabled -and $periodicTrigger.LocalName -eq 'CalendarTrigger' -and
        (Get-TaskChild $periodicTrigger 'StartBoundary').InnerText -match 'T00:10:00(?:$|[+\-Z])' -and
        (Get-TaskChild $schedule 'DaysInterval').InnerText -eq '1' -and
        -not (Get-TaskChild $periodicTrigger 'Repetition')
    } else {
      $repeat = Get-TaskChild $periodicTrigger 'Repetition'
      $periodic = $enabled -and $periodicTrigger.LocalName -eq 'TimeTrigger' -and
        (Get-TaskChild $repeat 'Interval').InnerText -eq 'PT15M' -and
        -not (Get-TaskChild $repeat 'Duration')
    }
  }
  $actions = Get-TaskChild $task 'Actions'
  $wrapperName = if ($Kind -eq 'refresh') { 'run-oy-cookie-refresh-task.ps1' } else { 'run-oy-login-health-task.ps1' }
  $wrapper = Join-Path $ResolvedRepoRoot ('scripts\' + $wrapperName)
  $expectedArguments = Get-ActionArguments $wrapper $Kind
  $matchingActions = @($actions.ChildNodes | Where-Object {
    $_.LocalName -eq 'Exec' -and (Get-TaskChild $_ 'Arguments').InnerText -like ('*' + $wrapperName + '*')
  })
  $hidden = $false
  $actionMatches = $false
  if ($matchingActions.Count -eq 1) {
    $arguments = (Get-TaskChild $matchingActions[0] 'Arguments').InnerText
    $hidden = $arguments -match '(?i)(?:^|\s)-WindowStyle\s+Hidden(?:\s|$)'
    $actionMatches = $arguments -eq $expectedArguments -and
      (Get-TaskChild $matchingActions[0] 'Command').InnerText -eq $PowerShellExe -and
      (Get-TaskChild $matchingActions[0] 'WorkingDirectory').InnerText -eq $ResolvedRepoRoot
  }
  $principal = (Get-TaskChild $task 'Principals').SelectSingleNode('*[local-name()="Principal"]')
  $runLevel = Get-TaskChild $principal 'RunLevel'
  # LeastPrivilege is also omitted by Export-ScheduledTask after registration.
  $currentUserOnly = (Test-CurrentTaskUser (Get-TaskChild $principal 'UserId').InnerText) -and
    (Get-TaskChild $principal 'LogonType').InnerText -eq 'InteractiveToken' -and
    (-not $runLevel -or $runLevel.InnerText -eq 'LeastPrivilege')
  $settings = Get-TaskChild $task 'Settings'
  $restart = Get-TaskChild $settings 'RestartOnFailure'
  $settingsReady = (Get-TaskChild $settings 'StartWhenAvailable').InnerText -eq 'true' -and
    (Get-TaskChild $settings 'MultipleInstancesPolicy').InnerText -eq 'IgnoreNew' -and
    (Get-TaskChild $settings 'ExecutionTimeLimit').InnerText -eq $(if ($Kind -eq 'refresh') { 'PT20M' } else { 'PT10M' }) -and
    (Get-TaskChild $settings 'DisallowStartIfOnBatteries').InnerText -eq 'false' -and
    (Get-TaskChild $settings 'StopIfGoingOnBatteries').InnerText -eq 'false' -and
    (Get-TaskChild $restart 'Count').InnerText -eq '2' -and
    (Get-TaskChild $restart 'Interval').InnerText -eq 'PT10M'
  return [pscustomobject]@{
    startup = [bool]$startup; periodic = [bool]$periodic; hidden = [bool]$hidden
    actionMatches = [bool]$actionMatches; currentUserOnly = [bool]$currentUserOnly
    settingsReady = [bool]$settingsReady
    ready = (($State -in @('Ready', 'Running')) -and (Test-TaskEnabled $settings))
  }
}

function New-OyTaskPlan {
  param([string]$Name, [ValidateSet('refresh', 'health')][string]$Kind, $Existing, $Fallback)
  $source = if ($Existing) { $Existing } else { $Fallback }
  if ($source) {
    [xml]$document = Export-ScheduledTask -TaskName $source.TaskName -TaskPath $TaskPath
    $document = $document.CloneNode($true)
  } else {
    [xml]$document = '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo/><Principals><Principal id="Author"/></Principals><Settings/><Triggers/><Actions Context="Author"/></Task>'
  }
  $previousXml = if ($Existing) { $document.OuterXml } else { $null }
  $task = $document.DocumentElement
  $registration = Get-TaskChild $task 'RegistrationInfo'
  Set-TaskText $registration 'URI' ($TaskPath + $Name)
  Set-TaskText $registration 'Description' $(if ($Kind -eq 'refresh') {
    'Refresh OliveYoung cookies once daily at 00:10 and after Windows login. No interactive login window.'
  } else { 'Check OliveYoung login every 15 minutes and email on confirmed session expiry; no login submission.' })

  # The user explicitly replaced the old schedule. Keep other task fields, but
  # rebuild its dedicated schedule so four-hour triggers cannot remain active.
  $triggers = Get-TaskChild $task 'Triggers'
  $triggers.RemoveAll()
  if ($Kind -eq 'refresh') {
    $periodic = $document.CreateElement('CalendarTrigger', $TaskNamespace)
    $dailyStart = (Get-Date).Date.AddMinutes(10)
    if ($dailyStart -le (Get-Date)) { $dailyStart = $dailyStart.AddDays(1) }
    Set-TaskText $periodic 'StartBoundary' ($dailyStart.ToString('yyyy-MM-ddTHH:mm:ss'))
    Set-TaskText $periodic 'Enabled' 'true'
    $daily = $document.CreateElement('ScheduleByDay', $TaskNamespace)
    Set-TaskText $daily 'DaysInterval' '1'
    [void]$periodic.AppendChild($daily)
  } else {
    $periodic = $document.CreateElement('TimeTrigger', $TaskNamespace)
    Set-TaskText $periodic 'StartBoundary' ((Get-Date).AddMinutes(15).ToString('yyyy-MM-ddTHH:mm:ss'))
    Set-TaskText $periodic 'Enabled' 'true'
    $repetition = $document.CreateElement('Repetition', $TaskNamespace)
    Set-TaskText $repetition 'Interval' 'PT15M'
    Set-TaskText $repetition 'StopAtDurationEnd' 'false'
    [void]$periodic.AppendChild($repetition)
  }
  [void]$triggers.AppendChild($periodic)
  $startup = $document.CreateElement('LogonTrigger', $TaskNamespace)
  $startup.SetAttribute('id', 'OYAtLogOn')
  Set-TaskText $startup 'Enabled' 'true'
  Set-TaskText $startup 'UserId' $CurrentUserSid
  Set-TaskText $startup 'Delay' $(if ($Kind -eq 'refresh') { 'PT1M' } else { 'PT2M' })
  [void]$triggers.AppendChild($startup)

  $principals = Get-TaskChild $task 'Principals'
  $principal = $principals.SelectSingleNode('*[local-name()="Principal"]')
  if (-not $principal -or @($principals.ChildNodes).Count -ne 1) { throw 'UNEXPECTED_TASK_PRINCIPALS' }
  $group = Get-TaskChild $principal 'GroupId'
  if ($group) { [void]$principal.RemoveChild($group) }
  Set-TaskText $principal 'UserId' $CurrentUserSid
  Set-TaskText $principal 'LogonType' 'InteractiveToken'
  Set-TaskText $principal 'RunLevel' 'LeastPrivilege'
  $settings = Get-TaskChild $task 'Settings'
  Set-TaskText $settings 'StartWhenAvailable' 'true'
  Set-TaskText $settings 'MultipleInstancesPolicy' 'IgnoreNew'
  Set-TaskText $settings 'ExecutionTimeLimit' $(if ($Kind -eq 'refresh') { 'PT20M' } else { 'PT10M' })
  Set-TaskText $settings 'DisallowStartIfOnBatteries' 'false'
  Set-TaskText $settings 'StopIfGoingOnBatteries' 'false'
  Set-TaskText $settings 'Enabled' 'true'
  $restart = Get-TaskChild $settings 'RestartOnFailure'
  if (-not $restart) {
    $restart = $document.CreateElement('RestartOnFailure', $TaskNamespace)
    [void]$settings.AppendChild($restart)
  }
  Set-TaskText $restart 'Count' '2'
  Set-TaskText $restart 'Interval' 'PT10M'

  $wrapperName = if ($Kind -eq 'refresh') { 'run-oy-cookie-refresh-task.ps1' } else { 'run-oy-login-health-task.ps1' }
  $wrapper = Join-Path $ResolvedRepoRoot ('scripts\' + $wrapperName)
  $actions = Get-TaskChild $task 'Actions'
  $matching = @($actions.ChildNodes | Where-Object {
    $_.LocalName -eq 'Exec' -and (Get-TaskChild $_ 'Arguments').InnerText -like ('*' + $wrapperName + '*')
  })
  if ($matching.Count) {
    $action = $matching[0]
    foreach ($duplicate in @($matching | Select-Object -Skip 1)) { [void]$actions.RemoveChild($duplicate) }
  } elseif (-not $source) {
    $action = $document.CreateElement('Exec', $TaskNamespace)
    [void]$actions.AppendChild($action)
  } else { throw 'TASK_ACTION_NOT_RECOGNIZED' }
  Set-TaskText $action 'Command' $PowerShellExe
  Set-TaskText $action 'Arguments' (Get-ActionArguments $wrapper $Kind)
  Set-TaskText $action 'WorkingDirectory' $ResolvedRepoRoot
  return [pscustomobject]@{ name = $Name; kind = $Kind; xml = $document; wrapper = $wrapper; previousXml = $previousXml }
}

$resolved = Resolve-Path -LiteralPath $RepoRoot
if ($resolved.Provider.Name -ne 'FileSystem' -or -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Container)) { throw 'INVALID_REPO_ROOT' }
$ResolvedRepoRoot = $resolved.ProviderPath.TrimEnd('\')
if ($ResolvedRepoRoot -match '[\x00\r\n"]') { throw 'INVALID_REPO_ROOT' }
if (-not (Test-Path -LiteralPath (Join-Path $ResolvedRepoRoot 'package.json') -PathType Leaf)) { throw 'REFRESH_WORKSPACE_NOT_FOUND' }
$PowerShellExe = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $PowerShellExe -PathType Leaf)) { throw 'WINDOWS_POWERSHELL_NOT_FOUND' }
$legacy = Get-OyTask $LegacyTaskName
$refresh = Get-OyTask $RefreshTaskName
$health = Get-OyTask $HealthTaskName
$plans = @(
  (New-OyTaskPlan $RefreshTaskName 'refresh' $refresh $legacy),
  (New-OyTaskPlan $HealthTaskName 'health' $health $null)
)
$missingWrappers = @($plans | Where-Object { -not (Test-Path -LiteralPath $_.wrapper -PathType Leaf) } | ForEach-Object { $_.wrapper })

if ($CheckOnly -or $DryRun) {
  [pscustomobject]@{
    mode = 'check-only'; changed = $false; repoRoot = $ResolvedRepoRoot
    windowsPasswordStored = $false; missingWrappers = $missingWrappers
    disableLegacyAfterVerification = [bool]$legacy
    legacyTaskName = $LegacyTaskName; legacyState = $(if ($legacy) { [string]$legacy.State } else { 'Absent' })
    tasks = @($plans | ForEach-Object { [pscustomobject]@{
      name = $_.name; kind = $_.kind; wrapper = $_.wrapper
      executable = $PowerShellExe; arguments = Get-ActionArguments $_.wrapper $_.kind
      schedule = $(if ($_.kind -eq 'refresh') { 'Daily 00:10; current-user logon + 1 minute' } else { 'Every 15 minutes; current-user logon + 2 minutes' })
      planned = Get-TaskSummary $_.xml $_.kind
    } })
  } | ConvertTo-Json -Depth 6
  return
}
if ($missingWrappers.Count) { throw 'TASK_WRAPPER_NOT_FOUND' }

$verifiedTasks = @()
$attemptedPlans = @()
try {
  foreach ($plan in $plans) {
    $attemptedPlans += $plan
    # No password argument: InteractiveToken uses the signed-in user's profile/DPAPI.
    Register-ScheduledTask -TaskName $plan.name -TaskPath $TaskPath -Xml $plan.xml.OuterXml -Force | Out-Null
    $installed = Get-OyTask $plan.name
    [xml]$installedXml = Export-ScheduledTask -TaskName $plan.name -TaskPath $TaskPath
    $verified = Get-TaskSummary $installedXml $plan.kind ([string]$installed.State)
    if (-not ($verified.startup -and $verified.periodic -and $verified.hidden -and $verified.actionMatches -and
        $verified.currentUserOnly -and $verified.settingsReady -and $verified.ready)) { throw 'TASK_VERIFICATION_FAILED' }
    $verifiedTasks += [pscustomobject]@{ name = $plan.name; status = $verified }
  }
} catch {
  $installationError = $_
  $rollbackFailed = $false
  # A partial migration must not leave a second active refresh schedule behind.
  foreach ($attempted in $attemptedPlans) {
    try {
      if ($attempted.previousXml) {
        Register-ScheduledTask -TaskName $attempted.name -TaskPath $TaskPath -Xml $attempted.previousXml -Force | Out-Null
      } elseif (Get-OyTask $attempted.name) {
        Disable-ScheduledTask -TaskName $attempted.name -TaskPath $TaskPath | Out-Null
      }
    } catch { $rollbackFailed = $true }
  }
  if ($rollbackFailed) { throw 'TASK_INSTALL_FAILED_ROLLBACK_INCOMPLETE' }
  throw $installationError
}
# Disable only after BOTH replacements verify. The old definition is recoverable.
$legacyDisabled = $false
if ($legacy) {
  Disable-ScheduledTask -TaskName $LegacyTaskName -TaskPath $TaskPath | Out-Null
  $legacyDisabled = [string](Get-OyTask $LegacyTaskName).State -eq 'Disabled'
  if (-not $legacyDisabled) { throw 'LEGACY_TASK_DISABLE_FAILED' }
}
[pscustomobject]@{
  mode = 'installed'; repoRoot = $ResolvedRepoRoot; dailyRefresh = $true; healthEvery15Minutes = $true
  legacyDisabled = $legacyDisabled; windowsPasswordStored = $false; started = $false
  tasks = $verifiedTasks
} | ConvertTo-Json -Depth 5
