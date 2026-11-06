# Exercise the actual handoff body with ordinary fixture children, never RunAs or a smoke leg.
$ErrorActionPreference = 'Stop'
$runnerScriptPath = Join-Path $PSScriptRoot 'verify-installed-updater-smoke.ps1'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($runnerScriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
function Check($Condition, $Message) { if (-not $Condition) { throw $Message } }
$statements = $ast.EndBlock.Statements
$handoff = @($statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] -and $_.Body.Extent.Text -match '\$childArgs =' })
Check ($handoff.Count -eq 1) 'Could not identify the actual parent handoff.'
$handoffBody = $handoff[0].Body.Extent.Text
$handoffBody = [scriptblock]::Create($handoffBody.Substring(1, $handoffBody.Length - 2))
$modeGuard = @($statements | Where-Object { $_.Extent.Text.StartsWith('if ($ApplicationCommit -and -not $SkipBuild)') })
$elevatedBranch = @($statements | Where-Object { $_.Extent.Text.StartsWith('if ($Elevated)') })
Check ($modeGuard.Count -eq 1 -and $elevatedBranch.Count -eq 1) 'Could not identify frozen-mode guard and child preflight.'
$preflight = @($elevatedBranch[0].Clauses[0].Item2.Statements | Where-Object { $_.Extent.Text -in @('$null = Get-ArtifactFreshness', 'Assert-FreshSmokeEvidence') })
Check ($preflight.Count -eq 2) 'Actual elevated preflight changed; update this fixture explicitly.'
$legSetup = @($statements | Where-Object { $_.Extent.Text.StartsWith('$Legs =') })
$definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false) | Where-Object { $_.Name -in @('Get-TreeState','Get-ArtifactFreshness','Assert-FreshSmokeEvidence','Assert-True') })
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('updater-handoff-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$stubPath = Join-Path $fixture 'preflight-child.ps1'
$childScript = $ast.ParamBlock.Extent.Text + "`n" + @'
$ErrorActionPreference = 'Stop'
'@
$childScript += "`n" + '$repoRoot = ' + "'$($repoRoot.Replace("'", "''"))'"
$childScript += "`n" + '$runnerScriptPath = ' + "'$($runnerScriptPath.Replace("'", "''"))'"
$childScript += "`n" + '$ArtifactDir = Join-Path $WorkDir ''artifacts''; $script:checks = $null' + "`n"
$childScript += ($legSetup.Extent.Text -join "`n") + "`n"
$childScript += ($definitions.Extent.Text -join "`n") + "`n"
$childScript += '[Console]::Error.WriteLine(''fixture harmless stderr'')' + "`n"
$childScript += $modeGuard[0].Extent.Text + "`n"
$childScript += 'if (-not $Elevated) { throw ''Missing child mode'' }' + "`n"
# Only the real guard and read-only preflight are included, not the smoke entry point.
$childScript += ($preflight.Extent.Text -join "`n") + "`n" + @'
$bound = [ordered]@{ stage='child-preflight'; SkipBuild=[bool]$SkipBuild; Elevated=[bool]$Elevated; ViaRunAs=[bool]$ViaRunAs; ApplicationCommit=$ApplicationCommit; Leg=$Leg; ManifestPort=$ManifestPort; OldCommit=$OldCommit; Output=$Output; WorkDir=$WorkDir; AllowStaleArtifacts=[bool]$AllowStaleArtifacts }
[IO.File]::WriteAllText((Join-Path $WorkDir 'child-preflight.json'), ($bound | ConvertTo-Json))
'@
[IO.File]::WriteAllText($stubPath, $childScript)
$nativePowerShell = (Get-Command powershell.exe -CommandType Application).Source

function Start-Process($FilePath, $Verb, [switch]$Wait, [switch]$PassThru, $WindowStyle, $ArgumentList) {
    Check ($FilePath -eq 'powershell.exe' -and $Verb -eq 'RunAs' -and $Wait -and $PassThru) 'Unexpected production RunAs contract.'
    $originalFileArg = '-File "' + $runnerScriptPath + '"'
    Check ($ArgumentList.Contains($originalFileArg)) 'Parent did not reference the reviewed runner.'
    # Replace only the -File target. All switches/quoting are from the production body.
    $fixtureArguments = $ArgumentList.Replace($originalFileArg, ('-File "' + $stubPath + '"'))
    $child = New-Object Diagnostics.Process
    $child.StartInfo.FileName = $nativePowerShell
    $child.StartInfo.Arguments = $fixtureArguments
    $child.StartInfo.UseShellExecute = $false
    $child.StartInfo.CreateNoWindow = $true
    $child.StartInfo.RedirectStandardError = $true
    Check ($child.Start()) 'Could not start ordinary preflight fixture.'
    Check ($child.WaitForExit(10000)) 'Preflight fixture exceeded ten seconds; no process was terminated.'
    $script:childError = $child.StandardError.ReadToEnd()
    $result = [pscustomobject]@{ ExitCode = $child.ExitCode }
    $child.Dispose()
    return $result
}
function powershell.exe {
    $forwarded = @($args)
    $fileIndex = [Array]::IndexOf($forwarded, '-File')
    Check ($fileIndex -ge 0 -and $forwarded[$fileIndex + 1] -eq $runnerScriptPath) 'Unexpected direct-child File target.'
    $forwarded[$fileIndex + 1] = $stubPath
    if ($script:omitSkipBuild) { $forwarded = @($forwarded | Where-Object { $_ -ne '-SkipBuild' }) }
    $previousErrorAction = $ErrorActionPreference
    try {
        # Windows PowerShell can wrap native stderr as errors even when the child exits zero.
        $ErrorActionPreference = 'Continue'
        & $nativePowerShell @forwarded 2> (Join-Path $fixture 'direct-child-error.txt')
        $childExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousErrorAction }
    $script:childError = Get-Content -Raw -LiteralPath (Join-Path $fixture 'direct-child-error.txt')
    Set-Variable -Name LASTEXITCODE -Scope 1 -Value $childExit
}

foreach ($isAdmin in @($false, $true)) {
    $caseName = if ($isAdmin) { 'already-admin' } else { 'runas' }
    $WorkDir = Join-Path $fixture $caseName
    New-Item -ItemType Directory -Path (Join-Path $WorkDir 'artifacts') -Force | Out-Null
    $ApplicationCommit = 'f3fd60975b718b4d8fb22193166de603789ad136'
    [IO.File]::WriteAllText((Join-Path $WorkDir 'artifacts/new.commit'), $ApplicationCommit)
    $Output = Join-Path $WorkDir 'unused-output'
    $Leg = 'auto'
    $Legs = @('auto')
    $ManifestPort = 18859
    $OldCommit = 'df68d0d'
    $SkipBuild = $true
    $KeepArtifacts = $true
    $AllowStaleArtifacts = $isAdmin
    $freshness = [pscustomobject]@{ ApplicationCommit = $ApplicationCommit }
    $script:childError = ''
    . $handoffBody
    Check ($exitCode -eq 0) "$caseName child did not reach preflight: $script:childError"
    Check ($script:childError -match 'fixture harmless stderr') "$caseName child stderr was not preserved."
    $bound = Get-Content -Raw -LiteralPath (Join-Path $WorkDir 'child-preflight.json') | ConvertFrom-Json
    Check ($bound.stage -eq 'child-preflight' -and $bound.SkipBuild -and $bound.Elevated) "$caseName lost frozen child mode."
    Check ($bound.ViaRunAs -eq (-not $isAdmin)) "$caseName has incorrect RunAs provenance."
    foreach ($field in @('ApplicationCommit','Leg','ManifestPort','OldCommit','Output','WorkDir','AllowStaleArtifacts')) {
        Check ($bound.$field -eq (Get-Variable -Name $field -ValueOnly)) "$caseName lost $field."
    }
}
$WorkDir = Join-Path $fixture 'nonzero-child'
New-Item -ItemType Directory -Path (Join-Path $WorkDir 'artifacts') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $WorkDir 'artifacts/new.commit'), $ApplicationCommit)
$Output = Join-Path $WorkDir 'unused-output'
$script:omitSkipBuild = $true
. $handoffBody
Check ($exitCode -ne 0 -and $script:childError -match 'use -SkipBuild') 'Actual nonzero guard failure was hidden.'
Check (-not (Test-Path -LiteralPath (Join-Path $WorkDir 'child-preflight.json'))) 'Guard-rejected child reached preflight.'
Write-Host "PASS: actual RunAs/direct handoff bodies reach the real frozen-artifact preflight in ordinary children; all required mode/path/provenance flags preserved. Fixtures: $fixture"
