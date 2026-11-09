# Ordinary finite fixture process only. No app, MSI, elevation or process termination.
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'updater-process-capture.cs'
if (-not (Test-Path -LiteralPath $source)) { throw 'Missing native log/stderr destination capture.' }
Add-Type -Path $source
function Check($Condition,$Message) { if (-not $Condition) { throw $Message } }
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('updater-capture-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$childScript = @'
param([string]$Fixture)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class FixtureStderr { [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n); [DllImport("kernel32.dll")] public static extern bool SetStdHandle(int n, IntPtr h); }'
$share = [IO.FileShare]'ReadWrite, Delete'
$log = New-Object IO.FileStream((Join-Path $Fixture 'actual-app.log'),[IO.FileMode]::Create,[IO.FileAccess]::Write,$share)
$err = New-Object IO.FileStream((Join-Path $Fixture 'actual-stderr.log'),[IO.FileMode]::Create,[IO.FileAccess]::Write,$share)
$previous = [FixtureStderr]::GetStdHandle(-12)
try {
    if (-not [FixtureStderr]::SetStdHandle(-12,$err.SafeFileHandle.DangerousGetHandle())) { throw 'Fixture SetStdHandle failed.' }
    $bytes = [Text.Encoding]::UTF8.GetBytes('fixture logger output')
    $log.Write($bytes,0,$bytes.Length); $log.Flush()
    $stderr = [Console]::OpenStandardError()
    $bytes = [Text.Encoding]::UTF8.GetBytes('fixture stderr marker')
    $stderr.Write($bytes,0,$bytes.Length); $stderr.Flush()
    [IO.File]::WriteAllText((Join-Path $Fixture 'ready'),'ready')
    $deadline = (Get-Date).AddSeconds(15)
    while (-not (Test-Path -LiteralPath (Join-Path $Fixture 'release')) -and (Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath (Join-Path $Fixture 'clear-stderr')) {
            [FixtureStderr]::SetStdHandle(-12,[IntPtr]::Zero) | Out-Null
            [IO.File]::WriteAllText((Join-Path $Fixture 'stderr-cleared'),'ready')
        }
        Start-Sleep -Milliseconds 20
    }
} finally { [FixtureStderr]::SetStdHandle(-12,$previous) | Out-Null; $log.Dispose(); $err.Dispose() }
'@
$childPath = Join-Path $fixture 'child.ps1'
[IO.File]::WriteAllText($childPath,$childScript)
$child = New-Object Diagnostics.Process
$child.StartInfo.FileName = (Get-Command powershell.exe -CommandType Application).Source
$child.StartInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$childPath`" -Fixture `"$fixture`""
$child.StartInfo.UseShellExecute = $false
$child.StartInfo.CreateNoWindow = $true
$child.StartInfo.RedirectStandardError = $true
Check ($child.Start()) 'Fixture child did not start.'
try {
    $deadline = (Get-Date).AddSeconds(5)
    while (-not (Test-Path -LiteralPath (Join-Path $fixture 'ready')) -and -not $child.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 20 }
    Check (Test-Path -LiteralPath (Join-Path $fixture 'ready')) 'Fixture did not open its log/stderr files.'
    $capture = [UpdaterProcessCapture]::Inspect($child.Id)
    Check ($capture.Errors.Count -eq 0) ("Native capture failed: " + ($capture.Errors -join '; '))
    Check ($capture.LogPaths -contains (Join-Path $fixture 'actual-app.log')) 'Did not resolve actual process-owned log handle.'
    Check ($capture.StandardError.Kind -eq 'file' -and $capture.StandardError.Path -eq (Join-Path $fixture 'actual-stderr.log')) 'Did not resolve actual native stderr file handle.'
    Check ($capture.LogPaths -notcontains $capture.StandardError.Path) 'stderr was mislabeled as an application log.'
    Check ((Get-Content -Raw -LiteralPath $capture.StandardError.Path) -eq 'fixture stderr marker') 'Actual stderr content did not reach its observed destination.'
    $runnerScriptPath = Join-Path $PSScriptRoot 'verify-installed-updater-smoke.ps1'
    $tokens = $null; $errors = $null
    $runnerAst = [Management.Automation.Language.Parser]::ParseFile($runnerScriptPath,[ref]$tokens,[ref]$errors)
    foreach ($definition in $runnerAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] },$false)) {
        if ($definition.Name -in @('Get-SmokeProcessEvidence','Get-SmokeNativeCapture')) { . ([scriptblock]::Create($definition.Extent.Text)) }
    }
    function Get-SmokeAppProcess { [pscustomobject]@{ ProcessId=$child.Id; ParentProcessId=0; ExecutablePath='fixture' } }
    function Get-ProcessIntegrityLevel { 'unknown' }
    function Invoke-CimMethod { throw 'fixture owner metadata unavailable' }
    $observed = Get-SmokeProcessEvidence
    Check ($observed.resolvedLogPath -eq (Join-Path $fixture 'actual-app.log')) 'Runner did not preserve the actual open log path.'
    Check ($observed.nativeCapture.StandardError.Path -eq (Join-Path $fixture 'actual-stderr.log')) 'Runner lost native stderr evidence when owner metadata was unavailable.'
    [IO.File]::WriteAllText((Join-Path $fixture 'clear-stderr'),'clear')
    $deadline = (Get-Date).AddSeconds(3)
    while (-not (Test-Path -LiteralPath (Join-Path $fixture 'stderr-cleared')) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 20 }
    $capture = [UpdaterProcessCapture]::Inspect($child.Id)
    Check ($capture.StandardError.Kind -eq 'absent' -and -not $capture.StandardError.Path) 'Missing stderr handle was invented as captured output.'
} finally {
    [IO.File]::WriteAllText((Join-Path $fixture 'release'),'release')
    Check ($child.WaitForExit(20000)) 'Finite fixture did not exit; no process was terminated.'
}
Check ($child.ExitCode -eq 0) ($child.StandardError.ReadToEnd())
$child.Dispose()
$runner = Join-Path $PSScriptRoot 'verify-installed-updater-smoke.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($runner,[ref]$tokens,[ref]$errors)
Check (-not $errors.Count) 'Runner syntax is invalid.'
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] },$false)) {
    if ($definition.Name -eq 'Start-SmokeApp') { . ([scriptblock]::Create($definition.Extent.Text)) }
}
$Output = $fixture; $Exe = 'fixture-not-an-executable'; $InstallRoot = $fixture
$script:launchOutput = @(); $script:smokeAppPids = @()
function Start-Process($FilePath,$WorkingDirectory,[switch]$PassThru,$RedirectStandardError) {
    Check ($FilePath -eq $Exe -and $WorkingDirectory -eq $fixture -and $PassThru) 'Launch contract changed.'
    Check ($RedirectStandardError.EndsWith('.stderr.log')) 'Launch stderr was not redirected.'
    [pscustomobject]@{ Id = 123 }
}
$null = Start-SmokeApp
Check ($script:launchOutput.Count -eq 1 -and $script:launchOutput[0].pid -eq 123) 'Redirected stream provenance is missing.'
Write-Host "PASS: real x64 Windows log handle, stderr file/content, absent stderr; finite non-elevated fixture. Fixtures: $fixture"
