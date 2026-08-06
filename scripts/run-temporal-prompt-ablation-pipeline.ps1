[CmdletBinding()]
param(
    [int]$PollSeconds = 30,

    [switch]$SkipPredictionsAndScoring
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$trainingLauncher = Join-Path $PSScriptRoot "start-temporal-ir-training-container.ps1"
$matrixRunner = Join-Path $PSScriptRoot "run-temporal-prompt-ablation.ps1"
$matrixSummarizer = Join-Path $PSScriptRoot "summarize-temporal-prompt-ablation.ps1"
$expectedDatasetSha256 = "248b332842762d954ea1e3ce7f565048b89446b3eeffb5d9ba6d2d358ab0e1cc"
$presets = @("none", "minimal", "detailed")

function Get-AdapterName([string]$Preset) {
    return "qwen35-08b-prompt-ablation-v1-$Preset"
}

function Get-ContainerName([string]$Preset) {
    return "temporal-ir-$(Get-AdapterName $Preset)"
}

function Get-SummaryPath([string]$Preset) {
    $adapterName = Get-AdapterName $Preset
    return Join-Path $repoRoot "ml\temporal-ir\outputs\$adapterName\temporal_ir_run_summary.json"
}

function Test-ContainerRunning([string]$Preset) {
    $containerName = Get-ContainerName $Preset
    $match = & docker ps --filter "name=^/${containerName}$" --format "{{.Names}}"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not query Docker while waiting for $containerName."
    }
    return $match -eq $containerName
}

function Assert-CompletedSummary([string]$Preset) {
    $summaryPath = Get-SummaryPath $Preset
    $summary = Get-Content -LiteralPath $summaryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($summary.instructionPreset -ne $Preset) {
        throw "Completed $Preset adapter reports instruction preset $($summary.instructionPreset)."
    }
    if ($summary.datasetSha256 -ne $expectedDatasetSha256 -or $summary.seed -ne 3407) {
        throw "Completed $Preset adapter does not match the ablation dataset hash and seed."
    }
}

foreach ($preset in $presets) {
    $adapterName = Get-AdapterName $preset
    $summaryPath = Get-SummaryPath $preset
    if (-not (Test-Path -LiteralPath $summaryPath -PathType Leaf)) {
        if (-not (Test-ContainerRunning $preset)) {
            Write-Output "Starting training cell: $preset"
            & $trainingLauncher `
                -AdapterName $adapterName `
                -InstructionPreset $preset `
                -Dataset "api/reports/temporal-ml/temporal-ir-prompt-ablation-v1.jsonl" `
                -ExpectedDatasetSha256 $expectedDatasetSha256 `
                -Seed 3407 `
                -Epochs 3 `
                -MaxSeqLength 4096 `
                -PromptFormat chat `
                -NoLoadIn4Bit
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to launch training cell $preset."
            }
        } else {
            Write-Output "Training cell already running: $preset"
        }

        while (-not (Test-Path -LiteralPath $summaryPath -PathType Leaf)) {
            Start-Sleep -Seconds $PollSeconds
            # Training writes the summary immediately before its --rm container
            # exits. Recheck the completion marker after sleeping so a normal
            # exit cannot be mistaken for a failed run.
            if (Test-Path -LiteralPath $summaryPath -PathType Leaf) {
                break
            }
            if (-not (Test-ContainerRunning $preset)) {
                throw "Training cell $preset exited without writing its run summary. Check its container training log."
            }
        }
    } else {
        Write-Output "Training cell already complete: $preset"
    }
    Assert-CompletedSummary $preset
    Write-Output "Verified training cell: $preset"
}

if (-not $SkipPredictionsAndScoring) {
    Write-Output "Starting nine-cell inference and executor scoring."
    & $matrixRunner -Stage All
    if ($LASTEXITCODE -ne 0) {
        throw "Prompt-ablation inference or scoring failed."
    }
    & $matrixSummarizer
}

Write-Output "Temporal prompt ablation pipeline complete."
