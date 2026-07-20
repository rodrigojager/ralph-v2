#requires -Version 7.0

# Invoke with `pwsh -File`; the final `exit` intentionally forwards Bun's code to automation.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
  [ValidateNotNullOrEmpty()]
  [string[]] $BunArguments,

  [string] $WorkingDirectory = (Get-Location).Path,

  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string] $LogName = 'ralph-v2-bun',

  [ValidateSet('Idle', 'BelowNormal', 'Normal')]
  [string] $Priority = 'BelowNormal'
)

$ErrorActionPreference = 'Stop'
$resolvedWorkingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path
if (-not (Test-Path -LiteralPath $resolvedWorkingDirectory -PathType Container)) {
  throw "Working directory is not a directory: $resolvedWorkingDirectory"
}

$bun = (Get-Command bun -ErrorAction Stop).Source
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$prefix = Join-Path ([IO.Path]::GetTempPath()) "$LogName-$stamp-$PID"
$stdoutPath = "$prefix.stdout.log"
$stderrPath = "$prefix.stderr.log"

$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $bun
$startInfo.WorkingDirectory = $resolvedWorkingDirectory
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
foreach ($argument in $BunArguments) {
  [void] $startInfo.ArgumentList.Add($argument)
}

$stdoutFile = [IO.File]::Open($stdoutPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$stderrFile = [IO.File]::Open($stderrPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$process = [Diagnostics.Process]::new()
$process.StartInfo = $startInfo

try {
  if (-not $process.Start()) {
    throw 'Bun did not start'
  }
  $process.StandardInput.Close()
  try {
    $process.PriorityClass = [Diagnostics.ProcessPriorityClass]::$Priority
  }
  catch {
    Write-Warning "Could not set Bun priority to ${Priority}: $($_.Exception.Message)"
  }

  $stdoutCopy = $process.StandardOutput.BaseStream.CopyToAsync($stdoutFile)
  $stderrCopy = $process.StandardError.BaseStream.CopyToAsync($stderrFile)
  $process.WaitForExit()
  [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]] @($stdoutCopy, $stderrCopy))
  $exitCode = $process.ExitCode
}
finally {
  $stdoutFile.Dispose()
  $stderrFile.Dispose()
  $process.Dispose()
}

Write-Output "EXIT_CODE=$exitCode"
Write-Output "STDOUT_LOG=$stdoutPath"
Write-Output "STDERR_LOG=$stderrPath"
exit $exitCode
