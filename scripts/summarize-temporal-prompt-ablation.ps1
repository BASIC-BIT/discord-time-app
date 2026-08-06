[CmdletBinding()]
param(
    [string]$Output = "api/reports/temporal-ml/prompt-ablation-v1-summary.md"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$presets = @("none", "minimal", "detailed")

function Get-Percentile([double[]]$Values, [double]$Percentile) {
    if ($Values.Count -eq 0) {
        return $null
    }
    $sorted = @($Values | Sort-Object)
    $index = [Math]::Ceiling($Percentile * $sorted.Count) - 1
    return [Math]::Round($sorted[[Math]::Max(0, $index)], 0)
}

$cells = @()
foreach ($trainingPreset in $presets) {
    foreach ($inferencePreset in $presets) {
        $slug = "prompt-ablation-v1-$trainingPreset-train-$inferencePreset-infer"
        $reportPath = Join-Path $repoRoot "api\reports\temporal-ml\$slug-eval.json"
        $predictionPath = Join-Path $repoRoot "api\reports\temporal-ml\$slug-predictions.jsonl"
        if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
            throw "Ablation report not found: $reportPath"
        }
        if (-not (Test-Path -LiteralPath $predictionPath -PathType Leaf)) {
            throw "Ablation predictions not found: $predictionPath"
        }
        $report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $predictions = @(Get-Content -LiteralPath $predictionPath -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
        $results = @($report.results | Where-Object { $_.runner -eq "trained_plan" })
        $required = @($results | Where-Object { $_.required })
        $requiredFailures = @($required | Where-Object { -not $_.passed })
        $allFailures = @($results | Where-Object { -not $_.passed })
        $durations = [double[]]@($predictions | ForEach-Object { $_.predictionDurationMs })
        $parseFailures = @($allFailures | Where-Object {
            $detail = "$(if ($_.PSObject.Properties['mismatch']) { $_.mismatch }) $(if ($_.PSObject.Properties['error']) { $_.error })"
            $detail -match "(?i)parse|json|schema|invalid plan|normaliz"
        })
        $wrongResolvedRequired = @($requiredFailures | Where-Object {
            $_.PSObject.Properties["status"] -and $_.status -eq "resolved"
        })
        $formatOnlyResolved = @($wrongResolvedRequired | Where-Object {
            $_.PSObject.Properties["mismatch"] -and $_.mismatch -match "^expected format [0-9]+, got [0-9]+$"
        })
        $unsafeResolved = @($wrongResolvedRequired | Where-Object {
            $_.PSObject.Properties["mismatch"] -and $_.mismatch -eq "expected status needs_clarification, got resolved"
        })
        $failureFamilies = @(
            $allFailures |
                Group-Object category |
                Sort-Object -Property @{ Expression = "Count"; Descending = $true }, @{ Expression = "Name"; Descending = $false } |
                ForEach-Object { "$($_.Name)=$($_.Count)" }
        )
        $cells += [pscustomobject]@{
            TrainingPreset = $trainingPreset
            InferencePreset = $inferencePreset
            RequiredPassed = @($required | Where-Object { $_.passed }).Count
            RequiredTotal = $required.Count
            AllPassed = @($results | Where-Object { $_.passed }).Count
            AllTotal = $results.Count
            ResolvedFailures = $wrongResolvedRequired.Count
            FormatOnlyResolvedFailures = $formatOnlyResolved.Count
            UnsafeResolvedFailures = $unsafeResolved.Count
            ParseFailures = $parseFailures.Count
            P50DurationMs = Get-Percentile $durations 0.50
            P95DurationMs = Get-Percentile $durations 0.95
            MaxDurationMs = if ($durations.Count -eq 0) { $null } else { [Math]::Round(($durations | Measure-Object -Maximum).Maximum, 0) }
            FailureFamilies = $failureFamilies
            RequiredFailureIds = @($requiredFailures | ForEach-Object { $_.caseId })
        }
    }
}

$lines = @(
    "# Temporal Plan-IR Prompt Ablation Results",
    "",
    "Generated: $([DateTimeOffset]::Now.ToString('o'))",
    "",
    "| Training | Inference | Required | All cases | Resolved failures | Format-only | Unsafe resolves | Parse/schema failures | p50 ms | p95 ms | max ms |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
)
foreach ($cell in $cells) {
    $lines += "| $($cell.TrainingPreset) | $($cell.InferencePreset) | $($cell.RequiredPassed)/$($cell.RequiredTotal) | $($cell.AllPassed)/$($cell.AllTotal) | $($cell.ResolvedFailures) | $($cell.FormatOnlyResolvedFailures) | $($cell.UnsafeResolvedFailures) | $($cell.ParseFailures) | $($cell.P50DurationMs) | $($cell.P95DurationMs) | $($cell.MaxDurationMs) |"
}

$lines += ""
$lines += "## Failure detail"
foreach ($cell in $cells) {
    $lines += ""
    $lines += "### train=$($cell.TrainingPreset), infer=$($cell.InferencePreset)"
    $lines += ""
    $lines += "- Families: $(if ($cell.FailureFamilies.Count -eq 0) { 'none' } else { $cell.FailureFamilies -join ', ' })"
    $lines += "- Required failure IDs: $(if ($cell.RequiredFailureIds.Count -eq 0) { 'none' } else { $cell.RequiredFailureIds -join ', ' })"
}

$outputPath = if ([System.IO.Path]::IsPathRooted($Output)) { $Output } else { Join-Path $repoRoot $Output }
$outputDir = Split-Path -Parent $outputPath
if (-not (Test-Path -LiteralPath $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir | Out-Null
}
$lines -join "`n" | Set-Content -LiteralPath $outputPath -Encoding UTF8
$cells | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath ([System.IO.Path]::ChangeExtension($outputPath, ".json")) -Encoding UTF8
Write-Output "Wrote prompt-ablation summary to $outputPath"
