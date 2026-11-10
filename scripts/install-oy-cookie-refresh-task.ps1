[CmdletBinding()]
param([string]$RepoRoot, [switch]$CheckOnly, [switch]$DryRun)

# Retired: do not open browsers, install tasks, refresh credentials, or send alerts.
[Console]::Error.WriteLine('CURATOR_FEATURE_REMOVED')
exit 1
