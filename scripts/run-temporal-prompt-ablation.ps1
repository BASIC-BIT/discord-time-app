[CmdletBinding()]
param(
    [ValidateSet("All", "Predict", "Score")]
    [string]$Stage = "All",

    [string]$Image = "hammer-overlay-temporal-ir-qwen35:cuda12.8",

    [string]$DatasetSha256 = "248b332842762d954ea1e3ce7f565048b89446b3eeffb5d9ba6d2d358ab0e1cc",

    [string]$EvalInputSha256 = "7d8597c8d12e7180baea7454beb529a26ecbb3fc252080eb7d9798e75e92e5f4"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$dataset = Join-Path $repoRoot "api\reports\temporal-ml\temporal-ir-prompt-ablation-v1.jsonl"
$evalInput = Join-Path $repoRoot "api\reports\temporal-ml\temporal-prompt-ablation-v1-eval-input.jsonl"
$reportDir = Join-Path $repoRoot "api\reports\temporal-ml"
$presets = @("none", "minimal", "detailed")

function Assert-FileHash([string]$Path, [string]$ExpectedSha256) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required ablation artifact not found: $Path"
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
        throw "SHA-256 mismatch for ${Path}: expected $ExpectedSha256, got $actual"
    }
}

function Get-AdapterName([string]$TrainingPreset) {
    return "qwen35-08b-prompt-ablation-v1-$TrainingPreset"
}

function Assert-AdapterProvenance([string]$TrainingPreset) {
    $adapterName = Get-AdapterName $TrainingPreset
    $summaryPath = Join-Path $repoRoot "ml\temporal-ir\outputs\$adapterName\temporal_ir_run_summary.json"
    if (-not (Test-Path -LiteralPath $summaryPath -PathType Leaf)) {
        throw "Completed adapter summary not found: $summaryPath"
    }
    $summary = Get-Content -LiteralPath $summaryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($summary.instructionPreset -ne $TrainingPreset) {
        throw "Adapter $adapterName was trained with preset $($summary.instructionPreset), expected $TrainingPreset."
    }
    if ($summary.datasetSha256 -ne $DatasetSha256) {
        throw "Adapter $adapterName dataset hash does not match this experiment."
    }
    if ($summary.seed -ne 3407 -or $summary.promptFormat -ne "chat" -or $summary.loadIn4Bit -ne $false) {
        throw "Adapter $adapterName does not match the fixed seed/chat/BF16 controls."
    }
}

function Test-CompletePredictionFile([string]$Path, [string]$TrainingPreset, [string]$InferencePreset, [int]$ExpectedRows) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    try {
        $rows = @(Get-Content -LiteralPath $Path -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
    } catch {
        return $false
    }
    if ($rows.Count -ne $ExpectedRows) {
        return $false
    }
    $adapterName = Get-AdapterName $TrainingPreset
    $caseIds = @($rows | ForEach-Object { $_.caseId })
    if (@($caseIds | Sort-Object -Unique).Count -ne $ExpectedRows) {
        return $false
    }
    return @($rows | Where-Object {
        $_.instructionPreset -ne $InferencePreset `
            -or $_.inputSha256 -ne $EvalInputSha256 `
            -or $_.model -notlike "*$adapterName"
    }).Count -eq 0
}

function Test-CompleteEvalReport([string]$Path, [string]$ExpectedModel, [int]$ExpectedRows) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    try {
        $report = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $false
    }
    $results = @($report.results | Where-Object { $_.runner -eq "trained_plan" -and $_.model -eq $ExpectedModel })
    return $results.Count -eq $ExpectedRows
}

Assert-FileHash $dataset $DatasetSha256
Assert-FileHash $evalInput $EvalInputSha256
$presets | ForEach-Object { Assert-AdapterProvenance $_ }
$expectedEvalRows = @(Get-Content -LiteralPath $evalInput -Encoding UTF8).Count

if ($Stage -eq "All" -or $Stage -eq "Predict") {
    foreach ($trainingPreset in $presets) {
        $adapterName = Get-AdapterName $trainingPreset
        foreach ($inferencePreset in $presets) {
            $predictionRelative = "api/reports/temporal-ml/prompt-ablation-v1-$trainingPreset-train-$inferencePreset-infer-predictions.jsonl"
            $predictionPath = Join-Path $repoRoot ($predictionRelative -replace "/", "\")
            if (Test-CompletePredictionFile $predictionPath $trainingPreset $inferencePreset $expectedEvalRows) {
                Write-Output "Skipping verified predictions: train=$trainingPreset infer=$inferencePreset"
                continue
            }
            $dockerArgs = @(
                "run", "--rm", "--gpus", "all",
                "--workdir", "/workspace",
                "--volume", "${repoRoot}:/workspace",
                "--volume", "temporal-ir-hf-cache:/cache/huggingface",
                "--volume", "temporal-ir-uv-cache:/cache/uv",
                $Image,
                "python", "-u", "ml/temporal-ir/predict_unsloth.py",
                "--model", "ml/temporal-ir/outputs/$adapterName",
                "--input", "api/reports/temporal-ml/temporal-prompt-ablation-v1-eval-input.jsonl",
                "--output", $predictionRelative,
                "--instruction-preset", $inferencePreset,
                "--prompt-format", "chat",
                "--max-seq-length", "4096",
                "--max-new-tokens", "512",
                "--no-load-in-4bit"
            )
            & docker @dockerArgs
            if ($LASTEXITCODE -ne 0) {
                throw "Prediction failed for train=$trainingPreset infer=$inferencePreset."
            }
        }
    }
}

if ($Stage -eq "All" -or $Stage -eq "Score") {
    foreach ($trainingPreset in $presets) {
        foreach ($inferencePreset in $presets) {
            $slug = "prompt-ablation-v1-$trainingPreset-train-$inferencePreset-infer"
            $predictionRelative = "reports/temporal-ml/$slug-predictions.jsonl"
            $predictionPath = Join-Path $repoRoot "api\$predictionRelative"
            if (-not (Test-Path -LiteralPath $predictionPath -PathType Leaf)) {
                throw "Prediction file not found: $predictionPath"
            }
            $reportPath = Join-Path $repoRoot "api\reports\temporal-ml\$slug-eval.json"
            if (Test-CompleteEvalReport $reportPath $slug $expectedEvalRows) {
                Write-Output "Skipping verified eval report: train=$trainingPreset infer=$inferencePreset"
                continue
            }

            $previous = @{
                Baselines = $env:TEMPORAL_EVAL_BASELINES
                Model = $env:TEMPORAL_EVAL_TRAINED_PLAN_MODEL
                Predictions = $env:TEMPORAL_EVAL_TRAINED_PLAN_PREDICTIONS
                Output = $env:TEMPORAL_EVAL_OUTPUT
            }
            try {
                $env:TEMPORAL_EVAL_BASELINES = "trained-plan"
                $env:TEMPORAL_EVAL_TRAINED_PLAN_MODEL = $slug
                $env:TEMPORAL_EVAL_TRAINED_PLAN_PREDICTIONS = $predictionRelative
                $env:TEMPORAL_EVAL_OUTPUT = "reports/temporal-ml/$slug-eval.json"
                & npm --prefix api run eval:temporal
                if ($LASTEXITCODE -ne 0) {
                    throw "Scoring failed for train=$trainingPreset infer=$inferencePreset."
                }
            } finally {
                $env:TEMPORAL_EVAL_BASELINES = $previous.Baselines
                $env:TEMPORAL_EVAL_TRAINED_PLAN_MODEL = $previous.Model
                $env:TEMPORAL_EVAL_TRAINED_PLAN_PREDICTIONS = $previous.Predictions
                $env:TEMPORAL_EVAL_OUTPUT = $previous.Output
            }
        }
    }
}
