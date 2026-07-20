#requires -Version 7.0

<#
.SYNOPSIS
Runs the S10.09 Ralph v1/v2 coexistence and migration rollback drill.

.DESCRIPTION
The drill accepts two explicit executable files and never builds either checkout. Every command runs
with redirected streams, CreateNoWindow and Hidden window style. Workspaces live below a unique temp
root containing spaces and Unicode. Evidence is persisted outside both workspaces. No source checkout
or legacy workspace file is removed by the v2 command.

This script is a harness, not evidence by itself. S10.09 remains open until a report produced by a
real invocation is reviewed.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $LegacyBinary,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $NextBinary,

  [string] $EvidenceDirectory = (Join-Path ([IO.Path]::GetTempPath()) 'ralph-v2-s10.09-evidence'),

  [switch] $KeepWorkspace
)

$ErrorActionPreference = 'Stop'

function Resolve-ExecutableFile([string] $Path, [string] $Label) {
  $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
  $item = Get-Item -LiteralPath $resolved -Force
  if (-not $item.PSIsContainer -and -not $item.LinkType) {
    return $resolved
  }
  throw "$Label must be one explicit regular, non-linked executable file: $resolved"
}

function Get-Sha256([string] $Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TreeSha256([string] $Root) {
  $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
  $entries = [Collections.Generic.List[string]]::new()
  Get-ChildItem -LiteralPath $resolvedRoot -File -Recurse -Force |
    Sort-Object FullName |
    ForEach-Object {
      $relative = [IO.Path]::GetRelativePath($resolvedRoot, $_.FullName).Replace('\', '/')
      $entries.Add("$relative`0$(Get-Sha256 $_.FullName)")
    }
  $payload = [Text.Encoding]::UTF8.GetBytes(($entries -join "`n"))
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([Convert]::ToHexString($algorithm.ComputeHash($payload))).ToLowerInvariant()
  }
  finally {
    $algorithm.Dispose()
  }
}

function New-IsolatedEnvironment([string] $Root, [bool] $IncludeRalphConfig) {
  $homeRoot = Join-Path $Root 'home'
  $tempDirectory = Join-Path $Root 'temp'
  $appData = Join-Path $homeRoot 'AppData\Roaming'
  $localAppData = Join-Path $homeRoot 'AppData\Local'
  $xdgConfig = Join-Path $homeRoot '.config'
  $ralphConfig = Join-Path $Root 'ralph-config'
  @($homeRoot, $tempDirectory, $appData, $localAppData, $xdgConfig, $ralphConfig) |
    ForEach-Object { [IO.Directory]::CreateDirectory($_) | Out-Null }
  $environment = @{
    HOME = $homeRoot
    USERPROFILE = $homeRoot
    APPDATA = $appData
    LOCALAPPDATA = $localAppData
    XDG_CONFIG_HOME = $xdgConfig
    TEMP = $tempDirectory
    TMP = $tempDirectory
    TMPDIR = $tempDirectory
    CI = '1'
    NO_COLOR = '1'
    RALPH_API_KEY = 's10-migration-secret-canary'
  }
  if ($IncludeRalphConfig) {
    $environment.RALPH_CONFIG_HOME = $ralphConfig
  }
  return $environment
}

$legacy = Resolve-ExecutableFile $LegacyBinary 'LegacyBinary'
$next = Resolve-ExecutableFile $NextBinary 'NextBinary'
if ([StringComparer]::OrdinalIgnoreCase.Equals($legacy, $next)) {
  throw 'LegacyBinary and NextBinary must be distinct explicit files.'
}

$evidenceRoot = [IO.Path]::GetFullPath($EvidenceDirectory)
[IO.Directory]::CreateDirectory($evidenceRoot) | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$drillId = "s10.09-$stamp-$([Guid]::NewGuid().ToString('N'))"
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$drillRoot = Join-Path $tempRoot "ralph v2 S10.09 ünicode $drillId"
$legacyRoot = Join-Path $drillRoot 'legacy workspace v1'
$nextRoot = Join-Path $drillRoot 'novo workspace v2'
$nextAliasRoot = Join-Path $drillRoot 'alias setup workspace v2'
$legacyEnvironmentRoot = Join-Path $drillRoot 'environment e config somente v1'
$nextEnvironmentRoot = Join-Path $drillRoot 'environment e config somente v2'
$legacyConfigRoot = Join-Path $legacyEnvironmentRoot 'ralph-config'
$nextConfigRoot = Join-Path $nextEnvironmentRoot 'ralph-config'
$destinationSentinel = Join-Path $nextRoot 'sentinel-unrelated.txt'
$rollbackSentinel = Join-Path (Join-Path $nextRoot '.ralph') 'post-migration-sentinel.txt'
$reportPath = Join-Path $evidenceRoot "$drillId.json"
$invocations = [Collections.Generic.List[object]]::new()
$assertions = [ordered] @{}
$succeeded = $false
$failure = $null

function Invoke-DrillCommand {
  param(
    [Parameter(Mandatory = $true)] [string] $Role,
    [Parameter(Mandatory = $true)] [string] $Executable,
    [Parameter(Mandatory = $true)] [string[]] $Arguments,
    [Parameter(Mandatory = $true)] [string] $WorkingDirectory,
    [hashtable] $EnvironmentOverrides = @{}
  )

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Executable
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $safeInheritedKeys = @(
    'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'SystemDrive',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM'
  )
  $startInfo.Environment.Clear()
  foreach ($key in $safeInheritedKeys) {
    $value = [Environment]::GetEnvironmentVariable($key)
    if (-not [String]::IsNullOrEmpty($value)) {
      $startInfo.Environment[$key] = $value
    }
  }
  foreach ($argument in $Arguments) {
    [void] $startInfo.ArgumentList.Add($argument)
  }
  foreach ($entry in $EnvironmentOverrides.GetEnumerator()) {
    $startInfo.Environment[$entry.Key] = [string] $entry.Value
  }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $startedAt = [DateTimeOffset]::UtcNow
  try {
    if (-not $process.Start()) {
      throw "Failed to start $Role executable"
    }
    $process.StandardInput.Close()
    try {
      $process.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal
    }
    catch {
      # Priority is advisory; hidden/no-window process creation is the focus-safety contract.
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($stdout.Contains('s10-migration-secret-canary') -or $stderr.Contains('s10-migration-secret-canary')) {
      throw "$Role command exposed the isolated credential canary"
    }
    $record = [ordered] @{
      role = $Role
      executable = $Executable
      arguments = $Arguments
      workingDirectory = $WorkingDirectory
      startedAt = $startedAt.ToString('O')
      durationMs = [Math]::Round(([DateTimeOffset]::UtcNow - $startedAt).TotalMilliseconds)
      exitCode = $process.ExitCode
      stdout = $stdout
      stderr = $stderr
    }
    $invocations.Add($record)
    if ($process.ExitCode -ne 0) {
      throw "$Role command failed with exit code $($process.ExitCode): $($Arguments -join ' ')"
    }
    return $record
  }
  finally {
    $process.Dispose()
  }
}

try {
  [IO.Directory]::CreateDirectory($legacyRoot) | Out-Null
  [IO.Directory]::CreateDirectory($nextRoot) | Out-Null
  [IO.Directory]::CreateDirectory($nextAliasRoot) | Out-Null
  $legacyEnvironment = New-IsolatedEnvironment $legacyEnvironmentRoot $false
  $nextEnvironment = New-IsolatedEnvironment $nextEnvironmentRoot $true
  [IO.File]::WriteAllText($destinationSentinel, "unrelated destination sentinel`n")
  $sentinelBefore = Get-Sha256 $destinationSentinel
  $legacyBinaryBefore = Get-Sha256 $legacy
  $nextBinaryBefore = Get-Sha256 $next

  Invoke-DrillCommand 'legacy' $legacy @('--version') $drillRoot $legacyEnvironment | Out-Null
  Invoke-DrillCommand 'legacy' $legacy @('--help') $drillRoot $legacyEnvironment | Out-Null
  Invoke-DrillCommand 'next' $next @('version', '--format', 'human', '--no-color') $drillRoot $nextEnvironment | Out-Null
  Invoke-DrillCommand 'next' $next @('help', '--format', 'human', '--no-color') $drillRoot $nextEnvironment | Out-Null
  Invoke-DrillCommand 'legacy' $legacy @('init') $legacyRoot $legacyEnvironment | Out-Null
  Invoke-DrillCommand 'legacy' $legacy @('setup') $legacyRoot $legacyEnvironment | Out-Null
  Invoke-DrillCommand 'legacy' $legacy @('config', 'list') $legacyRoot $legacyEnvironment | Out-Null
  Invoke-DrillCommand 'legacy' $legacy @('status', '--json') $legacyRoot $legacyEnvironment | Out-Null
  $sourceBaseline = Get-TreeSha256 $legacyRoot
  $legacyConfigBaseline = Get-TreeSha256 $legacyEnvironmentRoot

  Invoke-DrillCommand 'next' $next @(
    'setup', '--workspace', $nextAliasRoot, '--format', 'json', '--no-color'
  ) $drillRoot $nextEnvironment | Out-Null
  Invoke-DrillCommand 'next' $next @(
    'migrate', 'inspect', $legacyRoot, '--format', 'json', '--no-color'
  ) $drillRoot $nextEnvironment | Out-Null
  $sourceAfterInspect = Get-TreeSha256 $legacyRoot
  if ($sourceAfterInspect -ne $sourceBaseline) {
    throw 'migrate inspect changed the legacy workspace tree hash.'
  }

  $apply = Invoke-DrillCommand 'next' $next @(
    'migrate', 'apply', $legacyRoot, '--destination', $nextRoot, '--format', 'json', '--no-color'
  ) $drillRoot $nextEnvironment
  $applyJson = $apply.stdout | ConvertFrom-Json -Depth 100
  $manifestPath = [string] $applyJson.data.rollbackManifest
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "migrate apply did not produce its reported rollback manifest: $manifestPath"
  }
  if ((Get-Sha256 $destinationSentinel) -ne $sentinelBefore) {
    throw 'migrate apply changed the unrelated destination sentinel.'
  }
  if ((Get-TreeSha256 $legacyRoot) -ne $sourceBaseline) {
    throw 'migrate apply changed the legacy workspace tree hash.'
  }
  [IO.File]::WriteAllText($rollbackSentinel, "post-migration unrelated sentinel`n")
  $rollbackSentinelBefore = Get-Sha256 $rollbackSentinel

  Invoke-DrillCommand 'next' $next @(
    'status', '--workspace', $nextRoot, '--format', 'json', '--no-color'
  ) $drillRoot $nextEnvironment | Out-Null
  Invoke-DrillCommand 'next' $next @(
    'config', 'list', '--workspace', $nextRoot, '--format', 'json', '--no-color'
  ) $drillRoot $nextEnvironment | Out-Null

  $preview = Invoke-DrillCommand 'next' $next @(
    'migrate', 'rollback', $manifestPath, '--dry-run', '--format', 'json', '--no-color'
  ) $drillRoot $nextEnvironment
  $previewJson = $preview.stdout | ConvertFrom-Json -Depth 100
  $planHash = [string] $previewJson.data.planHash
  if ($planHash -notmatch '^[a-f0-9]{64}$') {
    throw 'migrate rollback preview did not return a lowercase SHA-256 planHash.'
  }
  Invoke-DrillCommand 'next' $next @(
    'migrate', 'rollback', $manifestPath, '--confirm-plan-hash', $planHash,
    '--format', 'json', '--no-color'
  ) $drillRoot $nextEnvironment | Out-Null

  $sourceAfterRollback = Get-TreeSha256 $legacyRoot
  $legacyBinaryAfter = Get-Sha256 $legacy
  $nextBinaryAfter = Get-Sha256 $next
  $assertions.sourceInspectReadOnly = $sourceAfterInspect -eq $sourceBaseline
  $assertions.sourcePreservedAfterRollback = $sourceAfterRollback -eq $sourceBaseline
  $assertions.destinationSentinelPreserved =
    (Test-Path -LiteralPath $destinationSentinel -PathType Leaf) -and
    ((Get-Sha256 $destinationSentinel) -eq $sentinelBefore)
  $assertions.postMigrationSentinelPreserved =
    (Test-Path -LiteralPath $rollbackSentinel -PathType Leaf) -and
    ((Get-Sha256 $rollbackSentinel) -eq $rollbackSentinelBefore)
  $assertions.rollbackManifestRemoved = -not (Test-Path -LiteralPath $manifestPath)
  $assertions.legacyBinaryImmutable = $legacyBinaryAfter -eq $legacyBinaryBefore
  $assertions.nextBinaryImmutable = $nextBinaryAfter -eq $nextBinaryBefore
  $assertions.workspaceRootsSeparated =
    -not $legacyRoot.StartsWith("$nextRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase) -and
    -not $nextRoot.StartsWith("$legacyRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)
  $assertions.configRootsSeparated =
    -not [StringComparer]::OrdinalIgnoreCase.Equals($legacyConfigRoot, $nextConfigRoot) -and
    -not $nextConfigRoot.StartsWith("$legacyRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase) -and
    -not $nextConfigRoot.StartsWith("$nextRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)
  $assertions.legacyEnvironmentImmutableDuringNext =
    (Get-TreeSha256 $legacyEnvironmentRoot) -eq $legacyConfigBaseline
  foreach ($entry in $assertions.GetEnumerator()) {
    if (-not $entry.Value) {
      throw "Drill assertion failed: $($entry.Key)"
    }
  }
  $succeeded = $true
}
catch {
  $failure = $_.Exception.ToString()
  throw
}
finally {
  $report = [ordered] @{
    schemaVersion = 1
    drillId = $drillId
    status = if ($succeeded) { 'passed' } else { 'failed' }
    createdAt = [DateTimeOffset]::UtcNow.ToString('O')
    legacyBinary = $legacy
    nextBinary = $next
    legacyBinarySha256 = if (Test-Path -LiteralPath $legacy) { Get-Sha256 $legacy } else { $null }
    nextBinarySha256 = if (Test-Path -LiteralPath $next) { Get-Sha256 $next } else { $null }
    drillRoot = $drillRoot
    legacyRoot = $legacyRoot
    nextRoot = $nextRoot
    nextAliasRoot = $nextAliasRoot
    legacyEnvironmentRoot = $legacyEnvironmentRoot
    nextEnvironmentRoot = $nextEnvironmentRoot
    legacyConfigRoot = $legacyConfigRoot
    nextConfigRoot = $nextConfigRoot
    destinationSentinel = $destinationSentinel
    rollbackSentinel = $rollbackSentinel
    assertions = $assertions
    invocations = $invocations
    failure = $failure
    cleanupRequested = -not $KeepWorkspace
  }
  [IO.File]::WriteAllText(
    $reportPath,
    (($report | ConvertTo-Json -Depth 100) + "`n"),
    [Text.UTF8Encoding]::new($false)
  )
  Write-Output "STATUS=$($report.status)"
  Write-Output "EVIDENCE=$reportPath"
  Write-Output "DRILL_ROOT=$drillRoot"

  if ($succeeded -and -not $KeepWorkspace -and (Test-Path -LiteralPath $drillRoot)) {
    $resolvedDrillRoot = (Resolve-Path -LiteralPath $drillRoot).Path
    $relativeToTemp = [IO.Path]::GetRelativePath($tempRoot, $resolvedDrillRoot)
    if (
      $relativeToTemp -eq '..' -or
      $relativeToTemp.StartsWith("..$([IO.Path]::DirectorySeparatorChar)") -or
      -not ([IO.Path]::GetFileName($resolvedDrillRoot)).StartsWith('ralph v2 S10.09 ünicode ')
    ) {
      throw "Refusing cleanup outside the exact S10.09 temp root: $resolvedDrillRoot"
    }
    Remove-Item -LiteralPath $resolvedDrillRoot -Recurse -Force
  }
}
