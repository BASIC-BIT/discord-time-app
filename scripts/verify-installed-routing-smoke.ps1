[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$StopProductionForManualSmoke,
    [string]$MsiPath = "",
    [string]$ExpectedMsiSha256 = "A17729BBB753DC1B46E72F6A768A82B9438BED859BD348E4C0D5CFF761C42937",
    [string]$ExpectedInstalledExeSha256 = "08506D5F24080FCF5F0A5A91B6E30AB3C0EF9DD96873DCED4E501DDBFE7C1685",
    [string]$InstallRoot = "C:\Program Files\HammerOverlay Routing Smoke",
    [string]$ApiBaseUrl = "http://127.0.0.1:8858",
    [int]$ExpectedApiPort = 8858,
    [string]$ModelBaseUrl = "http://127.0.0.1:8771/v1",
    [string]$ExpectedModel = "qwen-temporal-ir-qwen35-08b-bf16-chat-clock-choice-v19-prefix-ambiguity-balanced",
    [string]$ReportSchema = "discord-reference-v19-installed-routing-smoke-v1",
    [string]$VerificationLabel = "routing-smoke",
    [string]$Output = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($MsiPath)) {
    $MsiPath = Join-Path $PSScriptRoot "..\src-tauri\target\release\bundle\msi\HammerOverlay Routing Smoke_0.1.0_x64_en-US.msi"
}
if ([string]::IsNullOrWhiteSpace($Output)) {
    $Output = Join-Path $PSScriptRoot "..\api\reports\temporal-ml\discord-reference-v19-installed-routing-smoke.json"
}
$expectedEndpoint = $ModelBaseUrl.TrimEnd("/")
$expectedApiBase = $ApiBaseUrl.TrimEnd("/")
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$resolvedMsi = (Resolve-Path $MsiPath).Path

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )
    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Equal {
    param(
        $Actual,
        $Expected,
        [string]$Message
    )
    if ($Actual -ne $Expected) {
        throw "$Message Expected '$Expected'; got '$Actual'."
    }
}

function Get-JsonResponse {
    param(
        [string]$Uri,
        [string]$Method = "GET",
        [hashtable]$Headers = @{},
        $Body,
        [int]$TimeoutSec = 30
    )

    $invoke = @{
        Uri = $Uri
        Method = $Method
        Headers = $Headers
        UseBasicParsing = $true
        TimeoutSec = $TimeoutSec
    }
    if ($null -ne $Body) {
        $invoke.ContentType = "application/json"
        $invoke.Body = $Body | ConvertTo-Json -Depth 12 -Compress
    }

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $response = Invoke-WebRequest @invoke
        $stopwatch.Stop()
        return [pscustomobject]@{
            StatusCode = [int]$response.StatusCode
            Body = $response.Content | ConvertFrom-Json
            DurationMs = [int]$stopwatch.ElapsedMilliseconds
        }
    } catch {
        $stopwatch.Stop()
        $statusCode = 0
        $content = $_.ErrorDetails.Message
        if ($null -ne $_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
            if ([string]::IsNullOrWhiteSpace($content)) {
                $stream = $_.Exception.Response.GetResponseStream()
                if ($null -ne $stream) {
                    $reader = New-Object System.IO.StreamReader($stream)
                    try {
                        $content = $reader.ReadToEnd()
                    } finally {
                        $reader.Dispose()
                    }
                }
            }
        }
        $parsed = if ([string]::IsNullOrWhiteSpace($content)) {
            [pscustomobject]@{ error = $_.Exception.Message }
        } else {
            try {
                $content | ConvertFrom-Json
            } catch {
                [pscustomobject]@{ error = $content }
            }
        }
        return [pscustomobject]@{
            StatusCode = $statusCode
            Body = $parsed
            DurationMs = [int]$stopwatch.ElapsedMilliseconds
        }
    }
}

function Invoke-Parse {
    param(
        [string]$Text,
        [string]$RequestId = ([guid]::NewGuid().ToString())
    )
    Get-JsonResponse `
        -Uri "$expectedApiBase/parse" `
        -Method "POST" `
        -Headers $script:apiHeaders `
        -Body @{
            requestId = $RequestId
            text = $Text
            tz = "America/New_York"
            now = "2026-05-24T12:00:00Z"
        }
}

function Assert-Resolved {
    param(
        [string]$Id,
        [string]$Text,
        [long]$Epoch,
        [int]$Format,
        [string]$MethodPattern = ".*"
    )
    $result = Invoke-Parse -Text $Text
    Assert-Equal $result.StatusCode 200 "$Id should resolve."
    Assert-Equal ([long]$result.Body.epoch) $Epoch "$Id epoch mismatch."
    Assert-Equal ([int]$result.Body.suggestedFormatIndex) $Format "$Id format mismatch."
    Assert-True ([string]$result.Body.method -match $MethodPattern) "$Id method '$($result.Body.method)' did not match '$MethodPattern'."
    $script:probeResults.Add([pscustomobject]@{
        id = $Id
        text = $Text
        passed = $true
        statusCode = $result.StatusCode
        epoch = [long]$result.Body.epoch
        suggestedFormatIndex = [int]$result.Body.suggestedFormatIndex
        method = [string]$result.Body.method
        durationMs = $result.DurationMs
    })
    return $result
}

function Assert-Clarification {
    param(
        [string]$Id,
        [string]$Text,
        [long[]]$ExpectedEpochs = @()
    )
    $result = Invoke-Parse -Text $Text
    Assert-Equal $result.StatusCode 400 "$Id should return HTTP 400."
    Assert-Equal ([string]$result.Body.error) "needs_clarification" "$Id should request clarification."
    if ($ExpectedEpochs.Count -gt 0) {
        $actualEpochs = @($result.Body.alternatives | ForEach-Object { [long]$_.epoch } | Sort-Object)
        $expectedSorted = @($ExpectedEpochs | Sort-Object)
        Assert-Equal $actualEpochs.Count $expectedSorted.Count "$Id alternative count mismatch."
        for ($index = 0; $index -lt $expectedSorted.Count; $index++) {
            Assert-Equal $actualEpochs[$index] $expectedSorted[$index] "$Id alternative epoch mismatch at index $index."
        }
    }
    $script:probeResults.Add([pscustomobject]@{
        id = $Id
        text = $Text
        passed = $true
        statusCode = $result.StatusCode
        status = "needs_clarification"
        durationMs = $result.DurationMs
    })
}

function Stop-ExactProcess {
    param(
        [string]$Name,
        [string]$ExpectedPath
    )
    $normalizedExpected = [System.IO.Path]::GetFullPath($ExpectedPath)
    foreach ($process in @(Get-Process -Name $Name -ErrorAction SilentlyContinue)) {
        $processPath = $null
        try {
            $processPath = $process.Path
        } catch {
            continue
        }
        if (
            -not [string]::IsNullOrWhiteSpace($processPath) -and
            [System.IO.Path]::GetFullPath($processPath) -eq $normalizedExpected
        ) {
            Stop-Process -Id $process.Id -Force
            Wait-Process -Id $process.Id -Timeout 10 -ErrorAction SilentlyContinue
        }
    }
}

$productionExe = "C:\Program Files\HammerOverlay\hammer-overlay.exe"
if ($Install) {
    $productionProcessesBeforeInstall = @(Get-Process -Name "hammer-overlay" -ErrorAction SilentlyContinue | Where-Object {
        try {
            [System.IO.Path]::GetFullPath($_.Path) -eq [System.IO.Path]::GetFullPath($productionExe)
        } catch {
            $false
        }
    })
    if ($productionProcessesBeforeInstall.Count -gt 0 -and -not $StopProductionForManualSmoke) {
        throw "Production HammerOverlay is running. Close it or rerun with -StopProductionForManualSmoke before installing the candidate MSI."
    }
    if ($StopProductionForManualSmoke) {
        Stop-ExactProcess -Name "hammer-overlay" -ExpectedPath $productionExe
    }
}

$msiHash = (Get-FileHash $resolvedMsi -Algorithm SHA256).Hash
Assert-Equal $msiHash $ExpectedMsiSha256 "MSI hash mismatch."

if ($Install) {
    $installLog = Join-Path $env:TEMP "hammer-routing-smoke-install-current.log"
    $arguments = "/i `"$resolvedMsi`" /qn /norestart /l*v `"$installLog`""
    $installer = Start-Process `
        -FilePath "msiexec.exe" `
        -ArgumentList $arguments `
        -Verb RunAs `
        -WindowStyle Hidden `
        -Wait `
        -PassThru
    Assert-Equal $installer.ExitCode 0 "MSI installation failed. See $installLog."
}

$installedExe = Join-Path $InstallRoot "hammer-overlay.exe"
$installedEntrypoint = Join-Path $InstallRoot "api\dist\index.js"
$installedNode = Join-Path $InstallRoot "api\bin\node.exe"
$releaseExe = Join-Path $repoRoot "src-tauri\target\release\hammer-overlay.exe"
$stagedEntrypoint = Join-Path $repoRoot "src-tauri\sidecars\hammer-overlay-api\dist\index.js"
$stagedNode = Join-Path $repoRoot "src-tauri\sidecars\hammer-overlay-api\bin\node.exe"

foreach ($requiredPath in @(
    $installedExe,
    $installedEntrypoint,
    $installedNode,
    $releaseExe,
    $stagedEntrypoint,
    $stagedNode
)) {
    Assert-True (Test-Path -LiteralPath $requiredPath -PathType Leaf) "Required installed-build evidence is missing: $requiredPath"
}

$artifactHashes = [ordered]@{
    msi = $msiHash
    installedExecutable = (Get-FileHash $installedExe -Algorithm SHA256).Hash
    releaseExecutable = (Get-FileHash $releaseExe -Algorithm SHA256).Hash
    installedEntrypoint = (Get-FileHash $installedEntrypoint -Algorithm SHA256).Hash
    stagedEntrypoint = (Get-FileHash $stagedEntrypoint -Algorithm SHA256).Hash
    installedNode = (Get-FileHash $installedNode -Algorithm SHA256).Hash
    stagedNode = (Get-FileHash $stagedNode -Algorithm SHA256).Hash
}
$expectedInstalledExecutable = if ([string]::IsNullOrWhiteSpace($ExpectedInstalledExeSha256)) {
    $artifactHashes.releaseExecutable
} else {
    $ExpectedInstalledExeSha256.ToUpperInvariant()
}
$artifactHashes.expectedInstalledExecutable = $expectedInstalledExecutable
Assert-Equal $artifactHashes.installedExecutable $expectedInstalledExecutable "Installed executable does not match the expected MSI payload."
Assert-Equal $artifactHashes.installedEntrypoint $artifactHashes.stagedEntrypoint "Installed API entrypoint is not the current staged sidecar."
Assert-Equal $artifactHashes.installedNode $artifactHashes.stagedNode "Installed Node runtime is not the current staged sidecar runtime."

$models = Get-JsonResponse -Uri "$expectedEndpoint/models" -TimeoutSec 10
Assert-Equal $models.StatusCode 200 "Local model endpoint is unavailable."
$servedModels = @($models.Body.data | ForEach-Object { $_.id })
Assert-True ($servedModels -contains $ExpectedModel) "Expected model '$ExpectedModel' is not served by $expectedEndpoint."

$productionProcesses = @(Get-Process -Name "hammer-overlay" -ErrorAction SilentlyContinue | Where-Object {
    try {
        [System.IO.Path]::GetFullPath($_.Path) -eq [System.IO.Path]::GetFullPath($productionExe)
    } catch {
        $false
    }
})
if ($productionProcesses.Count -gt 0 -and -not $StopProductionForManualSmoke) {
    throw "Production HammerOverlay is running and competes for Ctrl+Shift+H. Close it or rerun with -StopProductionForManualSmoke before treating this as a manual overlay proof."
}
if ($StopProductionForManualSmoke) {
    Stop-ExactProcess -Name "hammer-overlay" -ExpectedPath $productionExe
}

Stop-ExactProcess -Name "hammer-overlay" -ExpectedPath $installedExe
Stop-ExactProcess -Name "node" -ExpectedPath $installedNode

$apiKey = "routing-smoke-$([guid]::NewGuid().ToString('N'))"
$launchEnvironment = [ordered]@{
    HAMMEROVERLAY_API_KEY = $apiKey
    TEMPORAL_FEATURE_PLAN_IR = "true"
    TEMPORAL_FEATURE_DISCORD_REFERENCE_ROUTING = "true"
    TEMPORAL_FEATURE_DISCORD_REFERENCE_SHADOW = "false"
    TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL = $expectedEndpoint
    TEMPORAL_PLAN_IR_ENDPOINT_MODEL = $ExpectedModel
    TEMPORAL_PLAN_IR_ENDPOINT_INSTRUCTION_PRESET = "minimal"
    TEMPORAL_PLAN_IR_ENDPOINT_API = "chat"
    TEMPORAL_PLAN_IR_ENDPOINT_PROMPT_FORMAT = "chat"
    TEMPORAL_PLAN_IR_ENDPOINT_MAX_TOKENS = "512"
    TEMPORAL_PLAN_IR_ENDPOINT_TIMEOUT_MS = "15000"
}
$previousLaunchEnvironment = @{}
try {
    foreach ($entry in $launchEnvironment.GetEnumerator()) {
        $previousLaunchEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, "Process")
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
    }
    $appProcess = Start-Process -FilePath $installedExe -WorkingDirectory $InstallRoot -PassThru
} finally {
    foreach ($entry in $launchEnvironment.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable(
            $entry.Key,
            $previousLaunchEnvironment[$entry.Key],
            "Process"
        )
    }
}

$health = $null
$healthDeadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
while ([DateTimeOffset]::UtcNow -lt $healthDeadline) {
    $candidateHealth = Get-JsonResponse -Uri "$expectedApiBase/health" -TimeoutSec 2
    if ($candidateHealth.StatusCode -eq 200) {
        $health = $candidateHealth.Body
        break
    }
    Start-Sleep -Milliseconds 250
}
Assert-True ($null -ne $health) "Installed parser sidecar did not become healthy at $expectedApiBase/health."

Assert-Equal ([string]$health.status) "healthy" "Installed API health status mismatch."
Assert-Equal ([int]$health.config.PORT) $ExpectedApiPort "Installed parser port mismatch."
Assert-Equal ([bool]$health.config.TEMPORAL_FEATURE_PLAN_IR) $true "Installed Plan-IR flag mismatch."
Assert-Equal ([bool]$health.config.TEMPORAL_FEATURE_DISCORD_REFERENCE_ROUTING) $true "Installed Discord-reference routing flag mismatch."
Assert-Equal ([bool]$health.config.TEMPORAL_FEATURE_DISCORD_REFERENCE_SHADOW) $false "Installed Discord-reference shadow flag mismatch."
Assert-Equal ([string]$health.config.TEMPORAL_PLAN_IR_ENDPOINT_BASE_URL) $expectedEndpoint "Installed model endpoint mismatch."
Assert-Equal ([string]$health.config.TEMPORAL_PLAN_IR_ENDPOINT_MODEL) $ExpectedModel "Installed model identity mismatch."
Assert-Equal ([string]$health.config.TEMPORAL_PLAN_IR_ENDPOINT_API) "chat" "Installed endpoint API mode mismatch."
Assert-Equal ([string]$health.config.TEMPORAL_PLAN_IR_ENDPOINT_PROMPT_FORMAT) "chat" "Installed prompt format mismatch."

$appProcess.Refresh()
Assert-True (-not $appProcess.HasExited) "Installed routing-smoke desktop exited before verification."
Assert-Equal ([System.IO.Path]::GetFullPath($appProcess.Path)) ([System.IO.Path]::GetFullPath($installedExe)) "Desktop process path mismatch."

$sidecarProcess = @(Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    try {
        [System.IO.Path]::GetFullPath($_.Path) -eq [System.IO.Path]::GetFullPath($installedNode)
    } catch {
        $false
    }
}) | Select-Object -First 1
Assert-True ($null -ne $sidecarProcess) "Could not prove the sidecar process uses the installed Node runtime."

$script:apiHeaders = @{
    "x-api-key" = $apiKey
    "x-api-version" = "1"
}
$script:probeResults = [System.Collections.Generic.List[object]]::new()
$modelDurations = [System.Collections.Generic.List[int]]::new()

$null = Assert-Resolved `
    -Id "standalone-reference" `
    -Text "<t:1785643200:F>" `
    -Epoch 1785643200 `
    -Format 5 `
    -MethodPattern "discord|deterministic|chrono"

$modelDurations.Add((Assert-Resolved `
    -Id "day-at-noon" `
    -Text "<t:1785643200:t> day at 12 pm" `
    -Epoch 1785686400 `
    -Format 4 `
    -MethodPattern "agent\+plan").DurationMs)

$modelDurations.Add((Assert-Resolved `
    -Id "held-out-date-noon" `
    -Text "keep <t:1785643200:t>'s date and use noon" `
    -Epoch 1785686400 `
    -Format 4 `
    -MethodPattern "agent\+plan").DurationMs)

$modelDurations.Add((Assert-Resolved `
    -Id "same-day-prefix-clock" `
    -Text "6:30pm on the same day as <t:1785643200:t>" `
    -Epoch 1785709800 `
    -Format 4 `
    -MethodPattern "agent\+plan").DurationMs)

$modelDurations.Add((Assert-Resolved `
    -Id "day-earlier-typo" `
    -Text "<t:1785643200:t> 1 day ebefore" `
    -Epoch 1785556800 `
    -Format 4 `
    -MethodPattern "agent\+plan").DurationMs)

$null = Assert-Resolved `
    -Id "long-copied-prose" `
    -Text "The community launch event starts at <t:1785643200:t>; bring a friend, enter through the north lobby, and keep this entire copied announcement for context." `
    -Epoch 1785643200 `
    -Format 2

Assert-Clarification `
    -Id "ambiguous-bare-noon" `
    -Text "<t:1785643200:t> day at 12"

Assert-Clarification `
    -Id "typo-shift-clock-ambiguous" `
    -Text "<t:1785643200:t> 1 day ebefore at 2" `
    -ExpectedEpochs @(1785564000, 1785607200)

$modelDurations.Add((Assert-Resolved `
    -Id "typo-shift-clock-explicit" `
    -Text "<t:1785643200:t> 1 day ebefore at 2 pm" `
    -Epoch 1785607200 `
    -Format 4 `
    -MethodPattern "agent\+plan").DurationMs)

$modelDurations.Add((Assert-Resolved `
    -Id "midnight-presentation" `
    -Text "<t:1785643200:t> that day at midnight" `
    -Epoch 1785643200 `
    -Format 4 `
    -MethodPattern "agent\+plan").DurationMs)

$range = Invoke-Parse -Text "<t:1785643200:t> to <t:1785646800:F>"
Assert-Equal $range.StatusCode 200 "Exact range should resolve."
Assert-Equal ([string]$range.Body.kind) "time_range" "Exact range kind mismatch."
Assert-Equal ([long]$range.Body.range.start.epoch) 1785643200 "Exact range start mismatch."
Assert-Equal ([long]$range.Body.range.end.epoch) 1785646800 "Exact range end mismatch."
Assert-Equal ([int]$range.Body.range.start.suggestedFormatIndex) 2 "Exact range start style mismatch."
Assert-Equal ([int]$range.Body.range.end.suggestedFormatIndex) 5 "Exact range end style mismatch."
$script:probeResults.Add([pscustomobject]@{
    id = "exact-range"
    text = "<t:1785643200:t> to <t:1785646800:F>"
    passed = $true
    statusCode = $range.StatusCode
    kind = [string]$range.Body.kind
    startEpoch = [long]$range.Body.range.start.epoch
    endEpoch = [long]$range.Body.range.end.epoch
    method = [string]$range.Body.method
    durationMs = $range.DurationMs
})

$negative = Invoke-Parse -Text "-1"
Assert-Equal $negative.StatusCode 400 "Negative epoch should fail."
Assert-True ([string]$negative.Body.error -ne "needs_clarification") "Negative epoch must not be mistaken for a bare-hour clarification."
$script:probeResults.Add([pscustomobject]@{
    id = "negative-epoch-rejected"
    text = "-1"
    passed = $true
    statusCode = $negative.StatusCode
    status = "failed"
    durationMs = $negative.DurationMs
})

Add-Type -AssemblyName System.Net.Http
$cancelRequestId = "installed-cancel-$([guid]::NewGuid().ToString('N'))"
$client = New-Object System.Net.Http.HttpClient
$cancelOutcome = $null
try {
    $request = New-Object System.Net.Http.HttpRequestMessage(
        [System.Net.Http.HttpMethod]::Post,
        "$expectedApiBase/parse"
    )
    $request.Headers.Add("x-api-key", $apiKey)
    $request.Headers.Add("x-api-version", "1")
    $cancelBody = @{
        requestId = $cancelRequestId
        text = "<t:1785643200:t> roughly an hour later"
        tz = "America/New_York"
        now = "2026-05-24T12:00:00Z"
    } | ConvertTo-Json -Compress
    $request.Content = New-Object System.Net.Http.StringContent(
        $cancelBody,
        [System.Text.Encoding]::UTF8,
        "application/json"
    )
    $parseTask = $client.SendAsync($request)

    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 25
        $cancel = Get-JsonResponse `
            -Uri "$expectedApiBase/parse/cancel" `
            -Method "POST" `
            -Headers $script:apiHeaders `
            -Body @{ requestId = $cancelRequestId }
        if ($cancel.StatusCode -eq 200 -and [bool]$cancel.Body.cancelled) {
            $cancelOutcome = $cancel
            break
        }
        if ($parseTask.IsCompleted) {
            break
        }
    }
    Assert-True ($null -ne $cancelOutcome) "Installed backend did not acknowledge active-request cancellation."
    $parseResponse = $parseTask.GetAwaiter().GetResult()
    $parseResponseBody = $parseResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
    Assert-Equal ([int]$parseResponse.StatusCode) 499 "Cancelled parse should return HTTP 499."
    Assert-Equal ([string]$parseResponseBody.error) "cancelled" "Cancelled parse response mismatch."
    $script:probeResults.Add([pscustomobject]@{
        id = "active-request-cancellation"
        text = "<t:1785643200:t> roughly an hour later"
        passed = $true
        cancellationDelivered = $true
        statusCode = [int]$parseResponse.StatusCode
        status = [string]$parseResponseBody.error
    })
} finally {
    $client.Dispose()
}

$sortedModelDurations = @($modelDurations | Sort-Object)
$p95Index = [Math]::Max(0, [Math]::Ceiling($sortedModelDurations.Count * 0.95) - 1)
$installedModelP95Ms = [int]$sortedModelDurations[$p95Index]
Assert-True ($installedModelP95Ms -le 5000) "Installed warmed model-path p95 ${installedModelP95Ms}ms exceeds the 5000ms product target."

$report = [ordered]@{
    schema = $ReportSchema
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    passed = $true
    artifact = [ordered]@{
        msiPath = $resolvedMsi
        installRoot = $InstallRoot
        hashes = $artifactHashes
    }
    processes = [ordered]@{
        productionStoppedForManualSmoke = [bool]$StopProductionForManualSmoke
        desktopPid = $appProcess.Id
        desktopPath = $appProcess.Path
        sidecarPid = $sidecarProcess.Id
        sidecarPath = $sidecarProcess.Path
    }
    health = $health
    modelEndpoint = [ordered]@{
        baseUrl = $expectedEndpoint
        model = $ExpectedModel
        servedModels = $servedModels
    }
    latency = [ordered]@{
        targetMs = 5000
        warmedModelPathDurationsMs = $sortedModelDurations
        warmedModelPathP95Ms = $installedModelP95Ms
        passed = $true
    }
    cancellation = [ordered]@{
        delivered = $true
        responseStatus = 499
        passed = $true
    }
    probes = $script:probeResults
    manualOverlayRequired = @(
        "<t:1785643200:t>",
        "<t:1785643200:t> 1 day later",
        "<t:1785643200:t> 1 day earlier",
        "<t:1785643200:t> 1 day ebefore",
        "<t:1785643200:t> 1 day ebefore at 2",
        "<t:1785643200:t> 1 day ebefore at 2 pm",
        "<t:1785643200:t> that day at midnight",
        "<t:1785643200:t> day at 12 pm",
        "<t:1785643200:t> day at 12",
        "The event starts at <t:1785643200:t>; copied context follows."
    )
}

$outputDirectory = Split-Path -Parent $Output
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Output -Encoding UTF8

Write-Host "Installed $VerificationLabel verification PASS."
Write-Host "Desktop: $($appProcess.Path) (PID $($appProcess.Id))"
Write-Host "Sidecar: $($sidecarProcess.Path) (PID $($sidecarProcess.Id))"
Write-Host "Model: $ExpectedModel"
Write-Host "Warmed model-path p95: ${installedModelP95Ms}ms"
Write-Host "Report: $Output"
Write-Host ""
Write-Host "Manual overlay check remains. Press Ctrl+Shift+H and try:"
foreach ($manualCase in $report.manualOverlayRequired) {
    Write-Host "  $manualCase"
}
