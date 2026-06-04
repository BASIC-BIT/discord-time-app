[CmdletBinding(DefaultParameterSetName = "Start")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Start")]
    [Parameter(Mandatory = $true, ParameterSetName = "Status")]
    [string]$AdapterName,

    [Parameter(ParameterSetName = "Start")]
    [string]$BaseModel = "Qwen/Qwen3.5-0.8B",

    [Parameter(ParameterSetName = "Start")]
    [string]$InstructionPreset = "minimal",

    [Parameter(ParameterSetName = "Start")]
    [string]$Dataset = "",

    [Parameter(ParameterSetName = "Start")]
    [double]$Epochs = 0,

    [Parameter(ParameterSetName = "Start")]
    [int]$TrainLimit = 0,

    [Parameter(ParameterSetName = "Start")]
    [int]$MaxSeqLength = 0,

    [Parameter(ParameterSetName = "Start")]
    [ValidateSet("custom", "chat")]
    [string]$PromptFormat = "custom",

    [Parameter(ParameterSetName = "Start")]
    [switch]$NoLoadIn4Bit,

    [Parameter(ParameterSetName = "Start")]
    [switch]$SkipMixCheck,

    [Parameter(ParameterSetName = "Start")]
    [switch]$BuildImage,

    [Parameter(ParameterSetName = "Status")]
    [switch]$Status,

    [Parameter(ParameterSetName = "Status")]
    [int]$Tail = 40,

    [string]$Image = "hammer-overlay-temporal-ir-qwen35:cuda12.8",
    [string]$ContainerPrefix = "temporal-ir"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-NoSingleQuote([string]$Name, [string]$Value) {
    if ($Value.Contains("'")) {
        throw "$Name must not contain a single quote for shell quoting."
    }
}

Assert-NoSingleQuote "AdapterName" $AdapterName
Assert-NoSingleQuote "BaseModel" $BaseModel
Assert-NoSingleQuote "InstructionPreset" $InstructionPreset
Assert-NoSingleQuote "Dataset" $Dataset
Assert-NoSingleQuote "PromptFormat" $PromptFormat

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$reportDir = Join-Path $repoRoot "api\reports\temporal-ml"
if (-not (Test-Path -LiteralPath $reportDir)) {
    New-Item -ItemType Directory -Path $reportDir | Out-Null
}

$slug = $AdapterName -replace "[^A-Za-z0-9_.-]", "-"
$containerName = "$ContainerPrefix-$slug"
$logPath = Join-Path $reportDir "container-train-$slug.log"

if ($Status) {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $dockerStatus = & docker ps -a --filter "name=$containerName" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" 2>&1
    $dockerStatusExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($dockerStatusExitCode -eq 0) {
        $dockerStatus
    } else {
        "Docker status unavailable: $dockerStatus"
    }
    if (Test-Path -LiteralPath $logPath) {
        Get-Content -LiteralPath $logPath -Encoding UTF8 -Tail $Tail
    } elseif ($dockerStatusExitCode -eq 0) {
        & docker logs --tail $Tail $containerName 2>$null
    }
    exit 0
}

if ($BuildImage) {
    docker build -f (Join-Path $repoRoot "docker\temporal-ir-qwen35.Dockerfile") -t $Image $repoRoot
}

$existing = docker ps -a --filter "name=$containerName" --format "{{.Names}}"
if ($existing -eq $containerName) {
    throw "Container $containerName already exists. Remove it with: docker rm -f $containerName"
}

$repoMount = "${repoRoot}:/workspace"
$hfCacheVolume = "temporal-ir-hf-cache:/cache/huggingface"
$uvCacheVolume = "temporal-ir-uv-cache:/cache/uv"
$envArgs = @(
    "TEMPORAL_IR_BASE_MODEL=$BaseModel",
    "TEMPORAL_IR_OUTPUT_DIR=ml/temporal-ir/outputs/$AdapterName",
    "TEMPORAL_IR_INSTRUCTION_PRESET=$InstructionPreset",
    "TEMPORAL_IR_PROMPT_FORMAT=$PromptFormat",
    "PYTHONIOENCODING=utf-8",
    "TERM=dumb",
    "NO_COLOR=1",
    "TQDM_DISABLE=1",
    "HF_HUB_DISABLE_PROGRESS_BARS=1"
)
if ($Dataset.Trim().Length -gt 0) {
    $envArgs += "TEMPORAL_IR_DATASET=$Dataset"
}
if ($Epochs -gt 0) {
    $envArgs += "TEMPORAL_IR_EPOCHS=$Epochs"
}
if ($TrainLimit -gt 0) {
    $envArgs += "TEMPORAL_IR_TRAIN_LIMIT=$TrainLimit"
}
if ($MaxSeqLength -gt 0) {
    $envArgs += "TEMPORAL_IR_MAX_SEQ_LENGTH=$MaxSeqLength"
}
if ($SkipMixCheck) {
    $envArgs += "TEMPORAL_IR_SKIP_MIX_CHECK=1"
}
if ($NoLoadIn4Bit) {
    $envArgs += "TEMPORAL_IR_NO_LOAD_IN_4BIT=1"
}

$envFlags = @()
foreach ($entry in $envArgs) {
    $envFlags += @("--env", $entry)
}

$dockerArgs = @(
    "run",
    "-d",
    "--rm",
    "--name", $containerName,
    "--gpus", "all",
    "--workdir", "/workspace",
    "--volume", $repoMount,
    "--volume", $hfCacheVolume,
    "--volume", $uvCacheVolume
)
$dockerArgs += $envFlags
$dockerArgs += @($Image, "bash", "-lc", "python -u ml/temporal-ir/train_unsloth.py 2>&1 | tee 'api/reports/temporal-ml/container-train-$slug.log'")

docker @dockerArgs
"Container: $containerName"
"Log: $logPath"
