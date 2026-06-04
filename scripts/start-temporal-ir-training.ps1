[CmdletBinding(DefaultParameterSetName = "Start")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Start")]
    [Parameter(Mandatory = $true, ParameterSetName = "Status")]
    [string]$AdapterName,

    [Parameter(ParameterSetName = "Start")]
    [string]$InstructionPreset = "minimal",

    [Parameter(ParameterSetName = "Start")]
    [string]$BaseModel = "",

    [Parameter(ParameterSetName = "Start")]
    [string]$Dataset = "",

    [Parameter(ParameterSetName = "Status")]
    [switch]$Status,

    [Parameter(ParameterSetName = "Status")]
    [int]$Tail = 40,

    [string]$Distro = "Ubuntu-24.04",
    [string]$WslRepoPath = "/mnt/d/bench/discord-time-app-src"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-NoSingleQuote([string]$Name, [string]$Value) {
    if ($Value.Contains("'")) {
        throw "$Name must not contain a single quote for WSL shell quoting."
    }
}

Assert-NoSingleQuote "AdapterName" $AdapterName
Assert-NoSingleQuote "InstructionPreset" $InstructionPreset
Assert-NoSingleQuote "BaseModel" $BaseModel
Assert-NoSingleQuote "Dataset" $Dataset
Assert-NoSingleQuote "WslRepoPath" $WslRepoPath

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$reportDir = Join-Path $repoRoot "api\reports\temporal-ml"
if (-not (Test-Path -LiteralPath $reportDir)) {
    New-Item -ItemType Directory -Path $reportDir | Out-Null
}

$slug = $AdapterName -replace "[^A-Za-z0-9_.-]", "-"
$scriptName = "train-$slug.sh"
$logName = "train-$slug.log"
$pidName = "train-$slug.pid"
$scriptPath = Join-Path $reportDir $scriptName
$logPath = Join-Path $reportDir $logName
$pidPath = Join-Path $reportDir $pidName
$wslReportDir = "$WslRepoPath/api/reports/temporal-ml"
$wslScriptPath = "$wslReportDir/$scriptName"
$wslLogPath = "$wslReportDir/$logName"
$wslPidPath = "$wslReportDir/$pidName"

if ($Status) {
    if (-not (Test-Path -LiteralPath $pidPath)) {
        "No PID file found: $pidPath"
        if (Test-Path -LiteralPath $logPath) {
            & wsl.exe -d $Distro --cd $WslRepoPath -- bash -lc "tail -n $Tail '$wslLogPath' 2>/dev/null || true"
        }
        exit 0
    }

    $processIdText = (Get-Content -LiteralPath $pidPath -TotalCount 1).Trim()
    if ($processIdText.Length -eq 0) {
        "PID file is empty: $pidPath"
        exit 1
    }

    & wsl.exe -d $Distro --cd $WslRepoPath -- bash -lc "if [ -d /proc/$processIdText ]; then ps -p $processIdText -o pid,ppid,etime,cmd; else echo 'process $processIdText is not running'; fi; tail -n $Tail '$wslLogPath' 2>/dev/null || true"
    exit $LASTEXITCODE
}

$envLines = @(
    "export TEMPORAL_IR_OUTPUT_DIR='ml/temporal-ir/outputs/$AdapterName'",
    "export TEMPORAL_IR_INSTRUCTION_PRESET='$InstructionPreset'"
)
if ($BaseModel.Trim().Length -gt 0) {
    $envLines += "export TEMPORAL_IR_BASE_MODEL='$BaseModel'"
}
if ($Dataset.Trim().Length -gt 0) {
    $envLines += "export TEMPORAL_IR_DATASET='$Dataset'"
}

$bashScript = @"
#!/usr/bin/env bash
set -euo pipefail
cd '$WslRepoPath'
source .venv-temporal-ir/bin/activate
$($envLines -join "`n")
exec python -u ml/temporal-ir/train_unsloth.py
"@

Set-Content -LiteralPath $scriptPath -Value $bashScript -Encoding UTF8
if (Test-Path -LiteralPath $pidPath) {
    Remove-Item -LiteralPath $pidPath -Force
}

$launchCommand = "chmod +x '$wslScriptPath' && nohup '$wslScriptPath' > '$wslLogPath' 2>&1 < /dev/null & echo `$! > '$wslPidPath' && sleep 1 && ps -p `$(cat '$wslPidPath') -o pid,etime,cmd"
& wsl.exe -d $Distro --cd $WslRepoPath -- bash -lc $launchCommand
"Log: $logPath"
"PID: $pidPath"
