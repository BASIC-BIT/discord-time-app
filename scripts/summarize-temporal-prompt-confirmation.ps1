[CmdletBinding()]
param(
    [string]$Output = "api/reports/temporal-ml/prompt-confirm-v1-summary.md"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$seeds = @(3407, 1337, 20260804)
$presets = @("minimal", "detailed")

function Get-Percentile([double[]]$Values, [double]$Percentile) {
    $sorted = @($Values | Sort-Object)
    if ($sorted.Count -eq 0) { return $null }
    return [Math]::Round($sorted[[Math]::Max(0, [Math]::Ceiling($Percentile * $sorted.Count) - 1)], 0)
}

function Get-RawSlug([string]$Preset, [int]$Seed) {
    if ($Seed -eq 3407) { return "prompt-ablation-v1-$Preset-train-$Preset-infer" }
    return "prompt-confirm-v1-$Preset-seed-$Seed"
}

$rawCells = @()
foreach ($seed in $seeds) {
    foreach ($preset in $presets) {
        $slug = Get-RawSlug $preset $seed
        $reportPath = Join-Path $repoRoot "api\reports\temporal-ml\$slug-eval.json"
        $predictionPath = Join-Path $repoRoot "api\reports\temporal-ml\$slug-predictions.jsonl"
        $report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $predictions = @(Get-Content -LiteralPath $predictionPath -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
        $required = @($report.results | Where-Object { $_.runner -eq "trained_plan" -and $_.required })
        $requiredFailures = @($required | Where-Object { -not $_.passed })
        $unsafe = @($requiredFailures | Where-Object {
            $_.PSObject.Properties["mismatch"] -and $_.mismatch -eq "expected status needs_clarification, got resolved"
        })
        $formatOnly = @($requiredFailures | Where-Object {
            $_.PSObject.Properties["mismatch"] -and $_.mismatch -match "^expected format [0-9]+, got [0-9]+$"
        })
        $durations = [double[]]@($predictions | ForEach-Object { $_.predictionDurationMs })
        $rawCells += [pscustomobject]@{
            Preset = $preset
            Seed = $seed
            Passed = @($required | Where-Object { $_.passed }).Count
            Total = $required.Count
            UnsafeResolves = $unsafe.Count
            FormatOnlyFailures = $formatOnly.Count
            P50Ms = Get-Percentile $durations 0.50
            P95Ms = Get-Percentile $durations 0.95
        }
    }
}

$routedSpecs = @(
    [pscustomobject]@{ Label = "shipping-time-range-2687"; Preset = "minimal"; Seed = "shipping" },
    [pscustomobject]@{ Label = "current-v9"; Preset = "minimal"; Seed = "v9" }
)
foreach ($seed in $seeds) {
    foreach ($preset in $presets) {
        $routedSpecs += [pscustomobject]@{ Label = "$preset-seed-$seed"; Preset = $preset; Seed = $seed }
    }
}

$routedCells = @()
foreach ($spec in $routedSpecs) {
    $path = Join-Path $repoRoot "api\reports\temporal-ml\prompt-confirm-v1-$($spec.Label)-routed-eval.json"
    $report = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    $routed = @($report.results | Where-Object { $_.runner -eq "routed_endpoint" -and $_.required })
    $direct = @($report.results | Where-Object { $_.runner -eq "endpoint_plan" -and $_.required })
    $routedDurations = [double[]]@($routed | ForEach-Object { $_.durationMs })
    $modelOwned = @($routed | Where-Object { $_.routeOwnership -eq "model" })
    $routedCells += [pscustomobject]@{
        Label = $spec.Label
        Preset = $spec.Preset
        Seed = $spec.Seed
        RoutedPassed = @($routed | Where-Object { $_.passed }).Count
        RoutedTotal = $routed.Count
        ModelOwnedPassed = @($modelOwned | Where-Object { $_.passed }).Count
        ModelOwnedTotal = $modelOwned.Count
        DirectPassed = @($direct | Where-Object { $_.passed }).Count
        DirectTotal = $direct.Count
        P50Ms = Get-Percentile $routedDurations 0.50
        P95Ms = Get-Percentile $routedDurations 0.95
    }
}

$lines = @(
    "# Temporal Prompt Confirmation Results",
    "",
    "Generated: $([DateTimeOffset]::Now.ToString('o'))",
    "",
    "## Raw matched-prompt cells",
    "",
    "| Preset | Seed | Required | Unsafe resolves | Format-only failures | p50 ms | p95 ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"
)
foreach ($cell in $rawCells) {
    $lines += "| $($cell.Preset) | $($cell.Seed) | $($cell.Passed)/$($cell.Total) | $($cell.UnsafeResolves) | $($cell.FormatOnlyFailures) | $($cell.P50Ms) | $($cell.P95Ms) |"
}

$lines += @("", "## Production-routed cells", "", "| Candidate | Preset | Seed | Routed required | Model-owned | Direct endpoint | p50 ms | p95 ms |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |")
foreach ($cell in $routedCells) {
    $lines += "| $($cell.Label) | $($cell.Preset) | $($cell.Seed) | $($cell.RoutedPassed)/$($cell.RoutedTotal) | $($cell.ModelOwnedPassed)/$($cell.ModelOwnedTotal) | $($cell.DirectPassed)/$($cell.DirectTotal) | $($cell.P50Ms) | $($cell.P95Ms) |"
}

$lines += @("", "## Matched-prompt aggregate", "")
foreach ($preset in $presets) {
    $cells = @($rawCells | Where-Object { $_.Preset -eq $preset })
    $scores = @($cells.Passed)
    $p95s = @($cells.P95Ms)
    $lines += "- ${preset}: mean required accuracy $([Math]::Round((($scores | Measure-Object -Average).Average), 2))/184; range $(($scores | Measure-Object -Minimum).Minimum)-$(($scores | Measure-Object -Maximum).Maximum); mean p95 $([Math]::Round((($p95s | Measure-Object -Average).Average), 0)) ms; unsafe resolves $(($cells.UnsafeResolves | Measure-Object -Sum).Sum)."
}

$outputPath = if ([System.IO.Path]::IsPathRooted($Output)) { $Output } else { Join-Path $repoRoot $Output }
$lines -join "`n" | Set-Content -LiteralPath $outputPath -Encoding UTF8
[pscustomobject]@{ RawCells = $rawCells; RoutedCells = $routedCells } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath ([System.IO.Path]::ChangeExtension($outputPath, ".json")) -Encoding UTF8
Write-Output "Wrote prompt confirmation summary to $outputPath"
