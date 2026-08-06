[CmdletBinding()]
param(
    [string]$EndpointBaseUrl = "http://127.0.0.1:8771/v1",
    [string]$Model = "qwen-temporal-ir-qwen35-08b-bf16-chat-presentation-v11",
    [string]$Output = "reports/temporal-ml/discord-reference-v11-presentation-evaluation-boundary.json",
    [string]$BaselineReport = "",

    [ValidateSet("minimal", "detailed")]
    [string]$InstructionPreset = "minimal",

    [int]$EndpointTimeoutMs = 30000
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$apiRoot = Join-Path $repoRoot "api"
$modelsUrl = "$($EndpointBaseUrl.TrimEnd('/'))/models"

try {
    $models = Invoke-RestMethod -Uri $modelsUrl -TimeoutSec 10
} catch {
    throw "Temporal endpoint is not healthy at $modelsUrl. $($_.Exception.Message)"
}

$servedModels = @($models.data | ForEach-Object { $_.id })
if ($servedModels -notcontains $Model) {
    throw "Temporal endpoint model mismatch. Expected '$Model'; served: $($servedModels -join ', ')"
}

$env:TEMPORAL_EVAL_BASELINES = "routed-endpoint,endpoint-plan"
$env:TEMPORAL_EVAL_ENDPOINT_BASE_URL = $EndpointBaseUrl
$env:TEMPORAL_EVAL_ENDPOINT_MODEL = $Model
$env:TEMPORAL_EVAL_ENDPOINT_API = "chat"
$env:TEMPORAL_EVAL_ENDPOINT_PROMPT_FORMAT = "chat"
$env:TEMPORAL_EVAL_ENDPOINT_INSTRUCTION_PRESET = $InstructionPreset
$env:TEMPORAL_EVAL_ENDPOINT_TIMEOUT_MS = $EndpointTimeoutMs.ToString()
$env:TEMPORAL_EVAL_BOUNDARY = "true"
$env:TEMPORAL_EVAL_DEPLOYMENT_MODE = "local"
$env:TEMPORAL_EVAL_BLOCKING_RUNNERS = ""
$env:TEMPORAL_EVAL_OUTPUT = $Output
if ($BaselineReport.Trim() -ne "") {
    $env:TEMPORAL_EVAL_BASELINE_REPORT = $BaselineReport
} else {
    Remove-Item Env:TEMPORAL_EVAL_BASELINE_REPORT -ErrorAction SilentlyContinue
}

Push-Location $apiRoot
try {
    & npm run eval:temporal:boundary
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
