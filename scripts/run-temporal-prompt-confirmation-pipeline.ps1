[CmdletBinding()]
param(
    [int]$PollSeconds = 30,
    [int]$EndpointPort = 8773,
    [string]$Image = "hammer-overlay-temporal-ir-qwen35:cuda12.8"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$trainingLauncher = Join-Path $PSScriptRoot "start-temporal-ir-training-container.ps1"
$serverLauncher = Join-Path $PSScriptRoot "start-temporal-peft-server-container.ps1"
$boundaryRunner = Join-Path $PSScriptRoot "run-temporal-evaluation-boundary.ps1"
$summarizer = Join-Path $PSScriptRoot "summarize-temporal-prompt-confirmation.ps1"
$dataset = "api/reports/temporal-ml/temporal-ir-prompt-ablation-v1.jsonl"
$datasetSha256 = "248b332842762d954ea1e3ce7f565048b89446b3eeffb5d9ba6d2d358ab0e1cc"
$evalInput = "api/reports/temporal-ml/temporal-prompt-ablation-v1-eval-input.jsonl"
$evalInputSha256 = "7d8597c8d12e7180baea7454beb529a26ecbb3fc252080eb7d9798e75e92e5f4"
$seeds = @(3407, 1337, 20260804)
$newSeeds = @(1337, 20260804)
$presets = @("minimal", "detailed")
$expectedEvalRows = 186

function Get-AdapterName([string]$Preset, [int]$Seed) {
    if ($Seed -eq 3407) {
        return "qwen35-08b-prompt-ablation-v1-$Preset"
    }
    return "qwen35-08b-prompt-confirm-v1-$Preset-seed-$Seed"
}

function Get-AdapterPath([string]$Preset, [int]$Seed) {
    return "ml/temporal-ir/outputs/$(Get-AdapterName $Preset $Seed)"
}

function Get-TrainingContainer([string]$Preset, [int]$Seed) {
    return "temporal-ir-$(Get-AdapterName $Preset $Seed)"
}

function Test-ContainerRunning([string]$Name) {
    $match = & docker ps --filter "name=^/${Name}$" --format "{{.Names}}"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not query Docker for $Name."
    }
    return $match -eq $Name
}

function Assert-TrainingSummary([string]$Preset, [int]$Seed) {
    $summaryPath = Join-Path $repoRoot "$(Get-AdapterPath $Preset $Seed)\temporal_ir_run_summary.json"
    if (-not (Test-Path -LiteralPath $summaryPath -PathType Leaf)) {
        throw "Training summary not found: $summaryPath"
    }
    $summary = Get-Content -LiteralPath $summaryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($summary.instructionPreset -ne $Preset -or $summary.seed -ne $Seed) {
        throw "Adapter preset/seed mismatch in $summaryPath."
    }
    if ($summary.datasetSha256 -ne $datasetSha256 -or $summary.promptFormat -ne "chat" -or $summary.loadIn4Bit -ne $false) {
        throw "Adapter controls mismatch in $summaryPath."
    }
}

function Wait-ForTraining([string]$Preset, [int]$Seed) {
    $adapterName = Get-AdapterName $Preset $Seed
    $summaryPath = Join-Path $repoRoot "$(Get-AdapterPath $Preset $Seed)\temporal_ir_run_summary.json"
    $containerName = Get-TrainingContainer $Preset $Seed
    if (-not (Test-Path -LiteralPath $summaryPath -PathType Leaf)) {
        if (-not (Test-ContainerRunning $containerName)) {
            Write-Output "Starting training: preset=$Preset seed=$Seed"
            & $trainingLauncher `
                -AdapterName $adapterName `
                -InstructionPreset $Preset `
                -Dataset $dataset `
                -ExpectedDatasetSha256 $datasetSha256 `
                -Seed $Seed `
                -Epochs 3 `
                -MaxSeqLength 4096 `
                -PromptFormat chat `
                -NoLoadIn4Bit
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to start training for preset=$Preset seed=$Seed."
            }
        } else {
            Write-Output "Training already running: preset=$Preset seed=$Seed"
        }
        while (-not (Test-Path -LiteralPath $summaryPath -PathType Leaf)) {
            Start-Sleep -Seconds $PollSeconds
            if (Test-Path -LiteralPath $summaryPath -PathType Leaf) {
                break
            }
            if (-not (Test-ContainerRunning $containerName)) {
                throw "Training exited without a summary: preset=$Preset seed=$Seed"
            }
        }
    }
    Assert-TrainingSummary $Preset $Seed
    Write-Output "Verified training: preset=$Preset seed=$Seed"
}

function Get-RawSlug([string]$Preset, [int]$Seed) {
    if ($Seed -eq 3407) {
        return "prompt-ablation-v1-$Preset-train-$Preset-infer"
    }
    return "prompt-confirm-v1-$Preset-seed-$Seed"
}

function Test-Predictions([string]$Path, [string]$Preset, [string]$AdapterName) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    try {
        $rows = @(Get-Content -LiteralPath $Path -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
    } catch {
        return $false
    }
    if ($rows.Count -ne $expectedEvalRows -or @($rows.caseId | Sort-Object -Unique).Count -ne $expectedEvalRows) {
        return $false
    }
    return @($rows | Where-Object {
        $_.instructionPreset -ne $Preset -or $_.inputSha256 -ne $evalInputSha256 -or $_.model -notlike "*$AdapterName"
    }).Count -eq 0
}

function Test-RawEval([string]$Path, [string]$Model) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    try {
        $report = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $false
    }
    return @($report.results | Where-Object { $_.runner -eq "trained_plan" -and $_.model -eq $Model }).Count -eq $expectedEvalRows
}

function Ensure-RawEvaluation([string]$Preset, [int]$Seed) {
    $adapterName = Get-AdapterName $Preset $Seed
    $adapterPath = Get-AdapterPath $Preset $Seed
    $slug = Get-RawSlug $Preset $Seed
    $predictionRelative = "api/reports/temporal-ml/$slug-predictions.jsonl"
    $predictionPath = Join-Path $repoRoot ($predictionRelative -replace "/", "\")
    if (-not (Test-Predictions $predictionPath $Preset $adapterName)) {
        Write-Output "Predicting raw cell: preset=$Preset seed=$Seed"
        $dockerArgs = @(
            "run", "--rm", "--gpus", "all",
            "--workdir", "/workspace",
            "--volume", "${repoRoot}:/workspace",
            "--volume", "temporal-ir-hf-cache:/cache/huggingface",
            "--volume", "temporal-ir-uv-cache:/cache/uv",
            $Image,
            "python", "-u", "ml/temporal-ir/predict_unsloth.py",
            "--model", $adapterPath,
            "--input", $evalInput,
            "--output", $predictionRelative,
            "--instruction-preset", $Preset,
            "--prompt-format", "chat",
            "--max-seq-length", "4096",
            "--max-new-tokens", "512",
            "--no-load-in-4bit"
        )
        & docker @dockerArgs
        if ($LASTEXITCODE -ne 0) {
            throw "Prediction failed: preset=$Preset seed=$Seed"
        }
    } else {
        Write-Output "Verified raw predictions: preset=$Preset seed=$Seed"
    }

    $reportPath = Join-Path $repoRoot "api\reports\temporal-ml\$slug-eval.json"
    if (-not (Test-RawEval $reportPath $slug)) {
        Write-Output "Scoring raw cell: preset=$Preset seed=$Seed"
        $previous = @{
            Baselines = $env:TEMPORAL_EVAL_BASELINES
            Model = $env:TEMPORAL_EVAL_TRAINED_PLAN_MODEL
            Predictions = $env:TEMPORAL_EVAL_TRAINED_PLAN_PREDICTIONS
            Output = $env:TEMPORAL_EVAL_OUTPUT
        }
        try {
            $env:TEMPORAL_EVAL_BASELINES = "trained-plan"
            $env:TEMPORAL_EVAL_TRAINED_PLAN_MODEL = $slug
            $env:TEMPORAL_EVAL_TRAINED_PLAN_PREDICTIONS = "reports/temporal-ml/$slug-predictions.jsonl"
            $env:TEMPORAL_EVAL_OUTPUT = "reports/temporal-ml/$slug-eval.json"
            & npm --prefix api run eval:temporal
            if ($LASTEXITCODE -ne 0) {
                throw "Raw scoring failed: preset=$Preset seed=$Seed"
            }
        } finally {
            $env:TEMPORAL_EVAL_BASELINES = $previous.Baselines
            $env:TEMPORAL_EVAL_TRAINED_PLAN_MODEL = $previous.Model
            $env:TEMPORAL_EVAL_TRAINED_PLAN_PREDICTIONS = $previous.Predictions
            $env:TEMPORAL_EVAL_OUTPUT = $previous.Output
        }
    } else {
        Write-Output "Verified raw eval: preset=$Preset seed=$Seed"
    }
}

function Test-RoutedEval([string]$Path, [string]$Model) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    try {
        $report = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $false
    }
    $routed = @($report.results | Where-Object { $_.runner -eq "routed_endpoint" -and $_.model -eq $Model })
    $direct = @($report.results | Where-Object { $_.runner -eq "endpoint_plan" -and $_.model -eq $Model })
    return $routed.Count -eq $expectedEvalRows -and $direct.Count -eq $expectedEvalRows
}

function Ensure-RoutedEvaluation([string]$Label, [string]$AdapterPath, [string]$Preset, [string]$BaselineReport) {
    $model = "prompt-confirm-v1-$Label"
    $outputRelative = "reports/temporal-ml/prompt-confirm-v1-$Label-routed-eval.json"
    $outputPath = Join-Path $repoRoot "api\$outputRelative"
    if (Test-RoutedEval $outputPath $model) {
        Write-Output "Verified routed eval: $Label"
        return
    }

    $containerName = "temporal-prompt-confirm-server-$EndpointPort"
    Write-Output "Serving routed candidate: $Label"
    & $serverLauncher `
        -AdapterPath $AdapterPath `
        -ModelName $model `
        -Port $EndpointPort `
        -ContainerName $containerName `
        -PromptFormat chat `
        -InstructionPreset $Preset `
        -NoLoadIn4Bit
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to start routed candidate: $Label"
    }
    try {
        $boundaryArgs = @{
            EndpointBaseUrl = "http://127.0.0.1:$EndpointPort/v1"
            Model = $model
            Output = $outputRelative
            InstructionPreset = $Preset
            EndpointTimeoutMs = 60000
        }
        if ($BaselineReport.Trim().Length -gt 0) {
            $boundaryArgs.BaselineReport = $BaselineReport
        }
        & $boundaryRunner @boundaryArgs
        $boundaryExitCode = $LASTEXITCODE
        if ($boundaryExitCode -ne 0 -and -not (Test-RoutedEval $outputPath $model)) {
            throw "Routed evaluation failed: $Label"
        }
        if ($boundaryExitCode -ne 0) {
            Write-Output "Routed candidate completed but did not pass its promotion boundary: $Label"
        }
    } finally {
        & docker rm -f $containerName 2>$null | Out-Null
    }
}

$datasetPath = Join-Path $repoRoot ($dataset -replace "/", "\")
$evalInputPath = Join-Path $repoRoot ($evalInput -replace "/", "\")
if ((Get-FileHash -LiteralPath $datasetPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $datasetSha256) {
    throw "Confirmation dataset hash mismatch."
}
if ((Get-FileHash -LiteralPath $evalInputPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $evalInputSha256) {
    throw "Confirmation eval-input hash mismatch."
}

foreach ($seed in $newSeeds) {
    foreach ($preset in $presets) {
        Wait-ForTraining $preset $seed
    }
}

foreach ($seed in $seeds) {
    foreach ($preset in $presets) {
        Assert-TrainingSummary $preset $seed
        Ensure-RawEvaluation $preset $seed
    }
}

$shippingAdapter = "ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-time-range-2687-lora"
Ensure-RoutedEvaluation "shipping-time-range-2687" $shippingAdapter "minimal" ""

$v9Adapter = "ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-discord-reference-v9-lora"
Ensure-RoutedEvaluation "current-v9" $v9Adapter "minimal" ""
$baseline = "reports/temporal-ml/prompt-confirm-v1-current-v9-routed-eval.json"
foreach ($seed in $seeds) {
    foreach ($preset in $presets) {
        Ensure-RoutedEvaluation "$preset-seed-$seed" (Get-AdapterPath $preset $seed) $preset $baseline
    }
}

& $summarizer
Write-Output "Temporal prompt confirmation pipeline complete."
