# Offline only: load function definitions, never the runner's entry point.
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'verify-installed-updater-smoke.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($runner, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($definition.Extent.Text))
}
function Check($Condition, $Message) { if (-not $Condition) { throw $Message } }
$repo = Split-Path $PSScriptRoot
$trayId = [regex]::Match([IO.File]::ReadAllText((Join-Path $repo 'src-tauri/src/lib.rs')), 'const TRAY_ID: &str = "([^"]+)";')
$config = Get-Content -Raw -LiteralPath (Join-Path $repo 'src-tauri/tauri.conf.json') | ConvertFrom-Json
Check ($trayId.Success -and $config.app.trayIcon.id -eq $trayId.Groups[1].Value) 'Configured tray id must match the Rust TRAY_ID used by its menu.'
Check ([bool](Get-Command Save-SmokeCheckpoint -ErrorAction SilentlyContinue)) 'Missing durable diagnostic checkpoint helper.'
$freshnessFunction = ${function:Get-ArtifactFreshness}
$processEvidenceFunction = ${function:Get-SmokeProcessEvidence}
$writeReportFunction = ${function:Write-Report}

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('updater-diagnostics-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$Output = $fixture
$WorkDir = $fixture
$Identifier = 'fixture-updater-diagnostics'
$ParserPort = 8858
$ManifestPort = 8859
$ArtifactDir = Join-Path $fixture 'artifacts'
New-Item -ItemType Directory -Path $ArtifactDir | Out-Null
$script:checks = New-Object Collections.ArrayList
$script:requestLog = $null
function Get-SmokeProcessEvidence {
    [ordered]@{ pid = 123; owner = 'fixture'; integrity = 'unknown'; profilePath = $fixture; resolvedLogPath = $null;
        nativeCapture = [pscustomobject]@{ LogPaths = @($actualLog); StandardError = [pscustomobject]@{ Kind = 'file'; Path = $actualStderr }; Errors = @() } }
}
function Get-SmokeLog { 'fixture log: no installer was started' }
function Get-SmokeAppProcess { $script:fixtureProcess }
function Get-SmokeNativeCapture { [pscustomobject]@{ LogPaths = @(); StandardError = [pscustomobject]@{ Kind = 'absent'; Path = $null }; Errors = @() } }
function Get-InstalledVersion { '0.0.2' }
function Get-ProcessIntegrityLevel { 'unknown' }
function Get-ListenerPids { @() }
function Get-SidecarHealth { [pscustomobject]@{ Body = [pscustomobject]@{ appVersion = '0.0.2' } } }
function Save-ProcessIntegrity($Report, $SidecarPids) { $Report.relaunchedIntegrity = 'unknown'; $Report.elevated = $null }
function Get-RealAppPids { @(321) }
function Assert-NoSmokeRunning { }
function Stop-ManifestServer { }
function Reset-SmokeData { }
function Get-ArtifactFreshness { [pscustomobject]@{ BuiltFrom = 'frozen-app'; Head = 'runner-head'; RunnerScriptSha256 = 'fixture-sha'; RunnerDirty = $true } }
$script:autoCalls = 0
$script:trayCalls = 0
$script:cleanupCalls = 0
$script:checkpointSeenDuringCleanup = $false
function Invoke-AutoLeg($Report) { $script:autoCalls++; throw 'injected final assertion failure' }
function Invoke-TrayLeg($Report) { $script:trayCalls++; throw 'later leg must not run' }
function Remove-SmokeInstall {
    $script:cleanupCalls++
    if ($script:cleanupCalls -eq 2) {
        $saved = Get-Content -Raw -LiteralPath (Join-Path $Output 'updater-smoke-auto.json') | ConvertFrom-Json
        $script:checkpointSeenDuringCleanup = $saved.incomplete -and $saved.stage -eq 'before-cleanup' -and $saved.error -eq 'injected final assertion failure'
        throw 'injected cleanup failure'
    }
}
$Legs = @('auto', 'tray')
$ViaRunAs = $true
$AllowStaleArtifacts = $false
$fixtureLogs = Join-Path $fixture "AppData\Local\$Identifier\logs"
New-Item -ItemType Directory -Path $fixtureLogs -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $fixtureLogs 'fixture.log'), 'owner-profile fixture log')
$actualLog = Join-Path $fixture 'actual-process.log'
$actualStderr = Join-Path $fixture 'actual-process-stderr.log'
[IO.File]::WriteAllText($actualLog, 'actual process fixture log')
[IO.File]::WriteAllText($actualStderr, 'actual process fixture stderr')
Invoke-ElevatedLegs
$saved = Get-Content -Raw -LiteralPath (Join-Path $Output 'updater-smoke-auto.json') | ConvertFrom-Json
Check $script:checkpointSeenDuringCleanup 'No durable failure checkpoint existed before cleanup.'
Check ($saved.status -eq 'failed' -and -not $saved.incomplete) 'Cleanup failure lost the finalized failed report.'
Check ($saved.cleanupError -match 'injected cleanup failure') 'Cleanup failure was not recorded.'
Check ($script:autoCalls -eq 1 -and $script:trayCalls -eq 0 -and $script:failed -eq 1) 'Runner did not stop after the first failed leg.'
Check ($saved.processEvidence.integrity -eq 'unknown' -and $null -eq $saved.elevated) 'Unknown token values were changed into assertions.'
Check ($saved.newMsisBuiltFrom -eq 'frozen-app' -and $saved.runnerCommit -eq 'runner-head') 'Runner and application provenance were conflated.'
Check ((Get-Content -Raw -LiteralPath (Join-Path $Output 'updater-smoke-auto-before-cleanup.log')) -match 'fixture log') 'Durable log snapshot is missing.'
Check ($saved.logFiles.Count -eq 1 -and (Get-Content -Raw -LiteralPath $saved.logFiles[0].snapshot) -eq 'owner-profile fixture log') 'Owner-profile file snapshot is missing.'
Check ($null -eq $saved.processEvidence.resolvedLogPath) 'An inferred log path was claimed as resolved.'
Check ($saved.openLogFiles.Count -eq 1 -and $saved.openLogFiles[0].source -eq 'process-open-handle' -and (Get-Content -Raw -LiteralPath $saved.openLogFiles[0].snapshot) -eq 'actual process fixture log') 'Observed process log was not separately preserved.'
Check ($saved.stderrCapture.kind -eq 'file' -and (Get-Content -Raw -LiteralPath $saved.stderrCapture.snapshot) -eq 'actual process fixture stderr') 'Observed stderr was not separately preserved.'
Check (Test-Path -LiteralPath (Join-Path $Output 'updater-smoke-auto-before-cleanup.json')) 'Stage checkpoint was not retained independently of the final report.'

$script:fixtureProcess = [pscustomobject]@{ ProcessId = 123; ParentProcessId = 45; ExecutablePath = 'fixture.exe' }
function Invoke-CimMethod($InputObject, $MethodName, $OperationTimeoutSec) {
    if ($MethodName -eq 'GetOwner') { return [pscustomobject]@{ ReturnValue = 0; Domain = 'FIXTURE'; User = 'owner' } }
    [pscustomobject]@{ ReturnValue = 0; Sid = 'S-1-5-21-123' }
}
function Get-CimInstance($ClassName, $Filter, $OperationTimeoutSec) { [pscustomobject]@{ LocalPath = $fixture } }
$ownerEvidence = & $processEvidenceFunction
Check ($ownerEvidence.owner -eq 'FIXTURE\owner' -and $ownerEvidence.profilePath -eq $fixture -and $ownerEvidence.parentPid -eq 45) 'Process owner/profile evidence is incorrect.'
function Invoke-CimMethod { throw 'fixture access denied' }
$unknownOwner = & $processEvidenceFunction
Check ($unknownOwner.owner -eq 'unknown' -and $null -eq $unknownOwner.profilePath -and $unknownOwner.ownerQueryError -match 'access denied') 'Unavailable owner evidence was not kept unknown.'
$script:fixtureProcess = $null

# Report IO must not bypass cleanup or let a successful body hide diagnostic failure.
foreach ($failureStage in @('before-cleanup', 'complete', 'all')) {
    $Output = Join-Path $fixture "write-failure-$failureStage"
    $script:cleanupCalls = 0
    $script:serverCleanupCalls = 0
    $script:autoCalls = 0
    $script:trayCalls = 0
    $script:lastReport = $null
    function Invoke-AutoLeg($Report) { $script:autoCalls++ }
    function Invoke-TrayLeg($Report) { $script:trayCalls++ }
    function Remove-SmokeInstall { $script:cleanupCalls++ }
    function Stop-ManifestServer { $script:serverCleanupCalls++ }
    function Write-Report($LegName, $Fields) {
        $script:lastReport = $Fields
        if ($failureStage -eq 'all' -or $Fields.stage -eq $failureStage) { throw "injected $failureStage checkpoint write failure" }
        & $writeReportFunction $LegName $Fields
    }
    $unexpected = $null
    try { $warnings = @(Invoke-ElevatedLegs 3>&1) } catch { $unexpected = $_.Exception.Message }
    Check ($script:cleanupCalls -eq 2 -and $script:serverCleanupCalls -eq 1) "Checkpoint failure skipped cleanup at $failureStage. Escaped error: $unexpected"
    Check (-not $unexpected -and $script:failed -eq 1 -and $script:trayCalls -eq 0) "Checkpoint failure escaped or continued to another leg at $failureStage."
    Check ($script:lastReport.status -eq 'failed' -and $script:lastReport.diagnosticError -match 'checkpoint write failure') "Diagnostic failure was lost or reported as pass at $failureStage."
    Check (($warnings | Out-String) -match 'checkpoint write failure') "Persistent report IO failure has no console evidence at $failureStage."
    if ($failureStage -eq 'before-cleanup') {
        $failedWriteReport = Get-Content -Raw -LiteralPath (Join-Path $Output 'updater-smoke-auto.json') | ConvertFrom-Json
        Check ($failedWriteReport.status -eq 'failed' -and $failedWriteReport.diagnosticError -match 'checkpoint write failure') 'Recoverable write failure was not saved in the final report.'
    }
}
. ([scriptblock]::Create('function Write-Report {' + $writeReportFunction.ToString() + '}'))
function Stop-ManifestServer { }

$Output = Join-Path $fixture 'success-reports'
function Remove-SmokeInstall { }
function Invoke-AutoLeg($Report) { $script:autoCalls++ }
function Invoke-TrayLeg($Report) { $script:trayCalls++ }
Invoke-ElevatedLegs
$passedAuto = Get-Content -Raw -LiteralPath (Join-Path $Output 'updater-smoke-auto.json') | ConvertFrom-Json
$passedTray = Get-Content -Raw -LiteralPath (Join-Path $Output 'updater-smoke-tray.json') | ConvertFrom-Json
Check ($script:failed -eq 0 -and $passedAuto.status -eq 'passed' -and $passedTray.status -eq 'passed') 'Successful legs failed to continue and finalize.'
Check (-not $passedAuto.incomplete -and -not $passedTray.incomplete) 'Passing reports were left incomplete.'

$validLog = $actualLog
$validStderr = $actualStderr
$actualLog = Join-Path $fixture 'missing-process.log'
$captureFailure = [ordered]@{ leg='capture-log-failure'; status='running'; incomplete=$true }
Save-SmokeCheckpoint $captureFailure 'fixture'
Check ($captureFailure.openLogFiles[0].error -and $captureFailure.diagnosticError) 'Open-log read failure was not preserved.'
Check ((Get-Content -Raw -LiteralPath $captureFailure.stderrCapture.snapshot) -eq 'actual process fixture stderr') 'A log read failure skipped stderr capture.'
$actualLog = $validLog
$actualStderr = Join-Path $fixture 'missing-stderr.log'
$captureFailure = [ordered]@{ leg='capture-stderr-failure'; status='running'; incomplete=$true }
Save-SmokeCheckpoint $captureFailure 'fixture'
Check ($captureFailure.stderrCapture.error -and $captureFailure.diagnosticError -and -not $captureFailure.stderrCapture.snapshot) 'stderr read failure was lost or marked captured.'
Check ((Get-Content -Raw -LiteralPath $captureFailure.openLogFiles[0].snapshot) -eq 'actual process fixture log') 'A stderr read failure lost the open-log snapshot.'
$actualStderr = $validStderr

# Execute the same self-contained response function embedded in the server child.
. ([scriptblock]::Create('function Send-SmokeResponse {' + ${function:Send-SmokeResponse}.ToString() + '}'))
$serveDir = Join-Path $fixture 'serve'
New-Item -ItemType Directory -Path $serveDir | Out-Null
[IO.File]::WriteAllText((Join-Path $serveDir 'latest.json'), '{"version":"0.0.2"}')
$responseLog = Join-Path $fixture 'responses.jsonl'
function New-FixtureContext($Stream) {
    $response = [pscustomobject]@{ StatusCode = 0; ContentType = ''; ContentLength64 = 0; OutputStream = $Stream }
    $response | Add-Member ScriptMethod Close { }
    [pscustomobject]@{ Request = [pscustomobject]@{ Url = [uri]'http://127.0.0.1:8859/latest.json'; HttpMethod = 'GET' }; Response = $response }
}
$memoryStream = New-Object IO.MemoryStream
Send-SmokeResponse (New-FixtureContext $memoryStream) @('latest.json') $serveDir $responseLog
$entries = @(Get-Content -LiteralPath $responseLog | ForEach-Object { $_ | ConvertFrom-Json })
Check ($entries.Count -eq 2 -and $entries[0].event -eq 'request' -and $entries[1].event -eq 'response') 'Request and response evidence are not distinct.'
Check ($entries[1].completed -and $entries[1].attemptedStatus -eq 200 -and $entries[1].bytesWritten -eq $memoryStream.Length) 'Successful response evidence is incorrect.'
$memoryStream.Dispose()
$brokenStream = [pscustomobject]@{}
$brokenStream | Add-Member ScriptMethod Write { param($Bytes, $Offset, $Count) throw 'injected write failure' }
Send-SmokeResponse (New-FixtureContext $brokenStream) @('latest.json') $serveDir $responseLog
$lastResponse = Get-Content -LiteralPath $responseLog -Tail 1 | ConvertFrom-Json
Check (-not $lastResponse.completed -and $lastResponse.error -match 'injected write failure') 'Interrupted response was reported as successful.'
$notFoundContext = New-FixtureContext (New-Object IO.MemoryStream)
$notFoundContext.Request.Url = [uri]'http://127.0.0.1:8859/unexpected?private=value'
Send-SmokeResponse $notFoundContext @('latest.json') $serveDir $responseLog
$notFound = Get-Content -LiteralPath $responseLog -Tail 1 | ConvertFrom-Json
Check ($notFound.attemptedStatus -eq 404 -and $notFound.completed -and $notFound.path -eq 'unrecognized') 'Unknown request was served or query details were logged.'
$notFoundContext.Response.OutputStream.Dispose()

# Provenance checks use a new local fixture repository, with no real MSI or baseline writes.
. ([scriptblock]::Create('function Get-ArtifactFreshness {' + $freshnessFunction.ToString() + '}'))
$repoRoot = Join-Path $fixture 'repository'
New-Item -ItemType Directory -Path (Join-Path $repoRoot 'src') -Force | Out-Null
$appFile = Join-Path $repoRoot 'src/application.txt'
[IO.File]::WriteAllText($appFile, 'frozen application')
git -C $repoRoot init --quiet
git -C $repoRoot add src/application.txt
git -C $repoRoot -c commit.gpgsign=false -c core.hooksPath="$fixture/no-hooks" -c user.name=Fixture -c user.email=fixture@example.invalid commit --quiet -m 'fixture application'
if ($LASTEXITCODE -ne 0) { throw 'Could not create local fixture application commit.' }
$ApplicationCommit = git -C $repoRoot rev-parse HEAD
[IO.File]::WriteAllText((Join-Path $repoRoot 'runner.txt'), 'different runner')
git -C $repoRoot add runner.txt
git -C $repoRoot -c commit.gpgsign=false -c core.hooksPath="$fixture/no-hooks" -c user.name=Fixture -c user.email=fixture@example.invalid commit --quiet -m 'fixture runner'
if ($LASTEXITCODE -ne 0) { throw 'Could not create local fixture runner commit.' }
$runnerScriptPath = $runner
[IO.File]::WriteAllText((Join-Path $ArtifactDir 'new.commit'), $ApplicationCommit)
$provenance = Get-ArtifactFreshness
Check ($provenance.BuiltFrom -eq $ApplicationCommit -and $provenance.Head -ne $ApplicationCommit) 'Distinct runner/frozen application commits were rejected or conflated.'
$AllowStaleArtifacts = $true
[IO.File]::WriteAllText((Join-Path $ArtifactDir 'new.commit'), 'wrong-artifact')
$rejected = $false
try { Get-ArtifactFreshness | Out-Null } catch { $rejected = $_.Exception.Message -match 'Artifacts do not match ApplicationCommit' }
Check $rejected 'AllowStaleArtifacts waived explicit application provenance.'
[IO.File]::WriteAllText((Join-Path $ArtifactDir 'new.commit'), $ApplicationCommit)
[IO.File]::WriteAllText($appFile, 'changed application')
$rejected = $false
try { Get-ArtifactFreshness | Out-Null } catch { $rejected = $_.Exception.Message -match 'Application source differs' }
Check $rejected 'Changed application source qualified against frozen artifacts.'
$rejected = $false
try { Assert-FreshSmokeEvidence } catch { $rejected = $_.Exception.Message -match 'new Output directory' }
Check $rejected 'An existing report could be overwritten.'
$Output = Join-Path $fixture 'unused-output'
[IO.File]::WriteAllText((Join-Path $WorkDir 'manifest-requests.log'), 'preserved requests')
$rejected = $false
try { Assert-FreshSmokeEvidence } catch { $rejected = $_.Exception.Message -match 'preserve the earlier manifest log' }
Check $rejected 'An existing manifest log could be overwritten.'
Write-Host "PASS: durable failure, cleanup evidence, stop-on-failure, UNKNOWN values, separate provenance and response outcomes. Fixtures: $fixture"
