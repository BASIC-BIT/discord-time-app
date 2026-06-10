[CmdletBinding()]
param(
    [string]$BaseModel = "Qwen/Qwen3.5-0.8B",
    [string]$AdapterPath = "ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-minimal-lora",
    [string]$ModelName = "qwen-temporal-ir-qwen35-4bit",
    [int]$Port = 8767,
    [int]$MaxNewTokens = 512,
    [string]$Image = "hammer-overlay-temporal-ir-qwen35:cuda12.8",
    [string]$ContainerName = "",
    [ValidateSet("custom", "chat")]
    [string]$PromptFormat = "custom",
    [switch]$EnableThinking,
    [switch]$NoLoadIn4Bit,
    [switch]$SkipPrewarm,
    [switch]$Status,
    [switch]$Stop,
    [int]$StartupTimeoutSeconds = 360,
    [int]$PrewarmTimeoutSeconds = 120,
    [int]$Tail = 80
)

$ErrorActionPreference = "Stop"

function Assert-NoSingleQuote([string]$Name, [string]$Value) {
    if ($Value.Contains("'")) {
        throw "$Name must not contain a single quote for shell quoting."
    }
}

Assert-NoSingleQuote "BaseModel" $BaseModel
Assert-NoSingleQuote "AdapterPath" $AdapterPath
Assert-NoSingleQuote "ModelName" $ModelName
Assert-NoSingleQuote "Image" $Image

if ($Status -and $Stop) {
    throw "Use either -Status or -Stop, not both."
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$slug = $ModelName -replace "[^A-Za-z0-9_.-]", "-"
if ($ContainerName.Trim().Length -eq 0) {
    $ContainerName = "temporal-ir-peft-$slug-$Port"
}

$baseUrl = "http://127.0.0.1:$Port/v1"
$modelsUrl = "$baseUrl/models"

function Test-TemporalPeftServer {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $modelsUrl -TimeoutSec 2
        if ($response.StatusCode -ne 200) {
            return $false
        }
        $body = $response.Content | ConvertFrom-Json
        return @($body.data | ForEach-Object { $_.id }) -contains $ModelName
    }
    catch {
        return $false
    }
}

function Invoke-TemporalPeftPrewarm {
    $inputJson = "{""referenceInstant"": ""2026-05-24T12:00:00Z"", ""text"": ""tomorrow"", ""timeZone"": ""America/New_York""}"
    $instruction = "Translate the temporal user input into compact Temporal Plan-IR JSON. Return JSON only."

    if ($PromptFormat -eq "chat") {
        $content = "$instruction`n`nInput:`n$inputJson"
        $body = @{
            model = $ModelName
            messages = @(@{ role = "user"; content = $content })
            max_tokens = [Math]::Min($MaxNewTokens, 128)
            temperature = 0
        } | ConvertTo-Json -Depth 5 -Compress
        $route = "$baseUrl/chat/completions"
    } else {
        $prompt = "### Instruction:`n$instruction`n`n### Input:`n$inputJson`n`n### Response:`n"
        $body = @{
            model = $ModelName
            prompt = $prompt
            max_tokens = [Math]::Min($MaxNewTokens, 128)
            temperature = 0
        } | ConvertTo-Json -Compress
        $route = "$baseUrl/completions"
    }

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $response = Invoke-WebRequest -UseBasicParsing -Uri $route -Method Post -ContentType "application/json" -Body $body -TimeoutSec $PrewarmTimeoutSeconds
    $stopwatch.Stop()
    if ($response.StatusCode -ne 200) {
        throw "Prewarm request failed with HTTP $($response.StatusCode)."
    }
    "Prewarm completed in $($stopwatch.ElapsedMilliseconds)ms."
}

function Write-ContainerLogs([int]$Lines) {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $logs = & docker logs --tail $Lines $ContainerName 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($exitCode -eq 0) {
        $logs
    }
}

if ($Status) {
    docker ps -a --filter "name=$ContainerName" --format "table {{.Names}}`t{{.Status}}`t{{.Image}}"
    if (Test-TemporalPeftServer) {
        "Temporal PEFT server is reachable at $baseUrl."
    } else {
        "Temporal PEFT server is not reachable at $baseUrl."
    }
    Write-ContainerLogs $Tail
    exit 0
}

if ($Stop) {
    docker rm -f $ContainerName
    exit 0
}

if (Test-TemporalPeftServer) {
    "Temporal PEFT server is already running at $baseUrl."
    if (-not $SkipPrewarm) {
        Invoke-TemporalPeftPrewarm
    }
    exit 0
}

$existing = docker ps -a --filter "name=$ContainerName" --format "{{.Names}}"
if ($existing -eq $ContainerName) {
    docker rm -f $ContainerName | Out-Null
}

$repoMount = "${repoRoot}:/workspace"
$dockerArgs = @(
    "run",
    "-d",
    "--rm",
    "--name", $ContainerName,
    "--gpus", "all",
    "--workdir", "/workspace",
    "--publish", "127.0.0.1:$($Port):$($Port)",
    "--volume", $repoMount,
    "--volume", "temporal-ir-hf-cache:/cache/huggingface",
    "--volume", "temporal-ir-uv-cache:/cache/uv",
    "--env", "HF_HOME=/cache/huggingface",
    "--env", "XDG_CACHE_HOME=/cache",
    "--env", "UV_CACHE_DIR=/cache/uv",
    "--env", "PYTHONIOENCODING=utf-8",
    "--env", "TERM=dumb",
    "--env", "NO_COLOR=1",
    "--env", "TQDM_DISABLE=1",
    "--env", "HF_HUB_DISABLE_PROGRESS_BARS=1",
    $Image,
    "python", "ml/temporal-ir/serve_peft_openai.py",
    "--base-model", $BaseModel,
    "--adapter", $AdapterPath,
    "--host", "0.0.0.0",
    "--port", $Port,
    "--model-name", $ModelName,
    "--max-new-tokens", $MaxNewTokens,
    "--prompt-format", $PromptFormat
)
if ($EnableThinking) {
    $dockerArgs += "--enable-thinking"
}
if ($NoLoadIn4Bit) {
    $dockerArgs += "--no-load-in-4bit"
}

docker @dockerArgs

$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
do {
    Start-Sleep -Seconds 5
    if (Test-TemporalPeftServer) {
        "Temporal PEFT server is ready at $baseUrl."
        if (-not $SkipPrewarm) {
            Invoke-TemporalPeftPrewarm
        }
        exit 0
    }
} while ((Get-Date) -lt $deadline)

Write-ContainerLogs $Tail
throw "Timed out waiting for Temporal PEFT server on $baseUrl."
