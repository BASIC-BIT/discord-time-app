[CmdletBinding()]
param(
    [string]$Distro = "Ubuntu-24.04",
    [string]$BaseModel = "Qwen/Qwen3.5-0.8B",
    [string]$AdapterPath = "ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-noisy-input-2584-lora",
    [string]$ModelName = "qwen-temporal-ir-qwen35-bf16-chat-noisy-input-2584",
    [int]$Port = 8765,
    [int]$MaxNewTokens = 512,
    [string]$Image = "hammer-overlay-temporal-ir-qwen35:cuda12.8",
    [string]$ContainerName = "",
    [switch]$SkipPrewarm,
    [switch]$Status,
    [switch]$Stop,
    [int]$StartupTimeoutSeconds = 360,
    [int]$PrewarmTimeoutSeconds = 180,
    [int]$Tail = 80
)

$ErrorActionPreference = "Stop"

function Stop-LegacyWslTemporalPeftServers {
    if ($Port -ne 8765) {
        return
    }
    $wsl = Get-Command "wsl.exe" -ErrorAction SilentlyContinue
    if ($null -eq $wsl) {
        return
    }
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & wsl.exe -d $Distro -- bash -lc "pkill -f '[s]erve_peft_openai.py' || true" | Out-Null
    $ErrorActionPreference = $previousErrorActionPreference
}

$containerLauncher = Join-Path $PSScriptRoot "start-temporal-peft-server-container.ps1"
$invokeArgs = @{
    BaseModel = $BaseModel
    AdapterPath = $AdapterPath
    ModelName = $ModelName
    Port = $Port
    MaxNewTokens = $MaxNewTokens
    Image = $Image
    PromptFormat = "chat"
    NoLoadIn4Bit = $true
    StartupTimeoutSeconds = $StartupTimeoutSeconds
    PrewarmTimeoutSeconds = $PrewarmTimeoutSeconds
    Tail = $Tail
}

if ($ContainerName.Trim().Length -gt 0) {
    $invokeArgs.ContainerName = $ContainerName
}
if ($SkipPrewarm) {
    $invokeArgs.SkipPrewarm = $true
}
if ($Status) {
    $invokeArgs.Status = $true
}
if ($Stop) {
    $invokeArgs.Stop = $true
}

if (-not $Status -and -not $Stop) {
    Stop-LegacyWslTemporalPeftServers
}

& $containerLauncher @invokeArgs
