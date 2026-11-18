# Fixture-only reset diagnostics. Remove-Item is intercepted; retained smoke evidence is never touched.
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'verify-installed-updater-smoke.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($runner, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    if ($definition.Name -in @('Reset-SmokeData','Get-SmokeLog','Assert-True')) { . ([scriptblock]::Create($definition.Extent.Text)) }
}
function Check($Condition, $Message) { if (-not $Condition) { throw $Message } }
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('updater-reset-test-' + [guid]::NewGuid().ToString('N'))
$Identifier = 'fixture-updater-reset'
$savedLocal = $env:LOCALAPPDATA
$savedRoaming = $env:APPDATA
try {
    $env:LOCALAPPDATA = Join-Path $fixture 'local'
    $env:APPDATA = Join-Path $fixture 'roaming'
    $localRoot = Join-Path $env:LOCALAPPDATA $Identifier
    $roamingRoot = Join-Path $env:APPDATA $Identifier
    New-Item -ItemType Directory -Path (Join-Path $localRoot 'logs'),$roamingRoot -Force | Out-Null
    $fixtureLog = Join-Path $localRoot 'logs/fixture.log'
    [IO.File]::WriteAllText($fixtureLog, 'retained fixture log')
    $script:checks = $null
    $script:removeTargets = @()
    function Remove-Item {
        [CmdletBinding()]
        param([string]$LiteralPath, [switch]$Recurse, [switch]$Force)
        $script:removeTargets += $LiteralPath
        Write-Error -Message 'fixture access denied' -ErrorId FixtureAccessDenied -Category PermissionDenied -TargetObject $LiteralPath
    }
    $report = [ordered]@{}
    $failure = $null
    try { Reset-SmokeData $report } catch { $failure = $_.Exception.Message }
    Check ($failure -eq 'Smoke log directory is empty before the leg.') 'Empty-log guard was suppressed or changed.'
    Check (@($report.resetErrors).Count -eq 2) 'Reset discarded exact removal errors.'
    foreach ($errorDetail in $report.resetErrors) {
        Check ($errorDetail.message -match 'fixture access denied' -and $errorDetail.errorId -match 'FixtureAccessDenied' -and $errorDetail.category -eq 'PermissionDenied') 'Reset error fields are missing.'
        Check ($errorDetail.target -in @($localRoot,$roamingRoot)) 'Reset error target escaped the two smoke roots.'
    }
    Check (@($report.resetRoots).Count -eq 2) 'Reset root evidence is missing.'
    Check (@($script:removeTargets).Count -eq 2 -and $script:removeTargets[0] -eq $localRoot -and $script:removeTargets[1] -eq $roamingRoot) 'Deletion scope was broadened.'
    Check ((Get-Content -Raw -LiteralPath $fixtureLog) -eq 'retained fixture log') 'Fixture evidence was deleted.'
    # A silent no-op must still fail the empty-log guard without inventing an IO error.
    function Remove-Item { [CmdletBinding()]param([string]$LiteralPath,[switch]$Recurse,[switch]$Force) }
    $report = [ordered]@{}
    $failure = $null
    try { Reset-SmokeData $report } catch { $failure = $_.Exception.Message }
    Check ($failure -eq 'Smoke log directory is empty before the leg.' -and @($report.resetErrors).Count -eq 0) 'Stale content bypassed the guard or produced fabricated errors.'

    foreach ($mode in @('denied','noop')) {
        $Identifier = "fixture-updater-reset-nonlog-$mode"
        $stateLocal = Join-Path $env:LOCALAPPDATA $Identifier
        $stateRoaming = Join-Path $env:APPDATA $Identifier
        New-Item -ItemType Directory -Path $stateLocal,$stateRoaming | Out-Null
        [IO.File]::WriteAllText((Join-Path $stateLocal 'updater.json'), '{"install_attempted":"fixture"}')
        [IO.File]::WriteAllText((Join-Path $stateRoaming 'settings.json'), '{"fixture":true}')
        function Remove-Item {
            [CmdletBinding()]
            param([string]$LiteralPath,[switch]$Recurse,[switch]$Force)
            if ($mode -eq 'denied') { Write-Error -Message 'fixture nonlog access denied' -ErrorId FixtureStateDenied -Category PermissionDenied -TargetObject $LiteralPath }
        }
        $report = [ordered]@{}
        $failure = $null
        $legReached = $false
        try { Reset-SmokeData $report; $legReached = $true } catch { $failure = $_.Exception.Message }
        Check (-not $legReached -and $failure) "Dirty non-log baseline reached the leg marker for $mode reset."
        Check (@($report.resetRoots | Where-Object existsAfter).Count -eq 2) "$mode reset lost remaining-root evidence."
        if ($mode -eq 'denied') {
            Check ($failure -eq 'Smoke data reset completed without removal errors.' -and @($report.resetErrors).Count -eq 2) 'Denied non-log reset was not stopped by its errors.'
        } else {
            Check ($failure -eq 'Smoke data roots are absent before the leg.' -and @($report.resetErrors).Count -eq 0) 'Silent non-log reset was not stopped by remaining roots.'
        }
        Check ((Test-Path -LiteralPath (Join-Path $stateLocal 'updater.json')) -and (Test-Path -LiteralPath (Join-Path $stateRoaming 'settings.json'))) 'Non-log fixture evidence was deleted.'
    }
    $Identifier = 'fixture-updater-reset-absent'
    $report = [ordered]@{}
    Reset-SmokeData $report
    Check (@($report.resetErrors).Count -eq 0 -and @($report.resetRoots | Where-Object existsAfter).Count -eq 0) 'An already absent baseline failed reset.'
    Write-Host "PASS: exact errors retained, two-root scope unchanged, original log guard preserved, non-log errors/remaining roots fail closed, absent baseline passes. Fixtures: $fixture"
} finally {
    $env:LOCALAPPDATA = $savedLocal
    $env:APPDATA = $savedRoaming
}
