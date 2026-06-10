[CmdletBinding()]
param(
    [int]$Port = 8857,
    [string]$CanaryText = 'first tuesday of July',
    [string]$TimeZone = 'America/New_York',
    [int]$ExpectedEpoch = 1783440000,
    [switch]$SkipCanary
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$tauriConfigPath = Join-Path $repoRoot 'src-tauri\tauri.conf.json'
$tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
$appIdentifier = $tauriConfig.identifier
if ([string]::IsNullOrWhiteSpace($appIdentifier)) {
    throw "Tauri identifier is missing from $tauriConfigPath."
}

$node24 = 'C:\ProgramData\nvm\v24.15.0'
if (Test-Path -LiteralPath $node24) {
    $env:PATH = "$node24;$env:PATH"
}

function Test-HttpHealth([string]$Url) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Stop-Listener([int]$LocalPort) {
    $listeners = @(Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        Write-Host "Stopping listener process $($listener.OwningProcess) on port $LocalPort."
        Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}

function Stop-RepoReleaseOverlay([string]$OverlayPath) {
    $overlayProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -eq $OverlayPath
    })

    foreach ($process in $overlayProcesses) {
        Write-Host "Stopping repo release overlay process $($process.ProcessId)."
        Stop-Process -Id $process.ProcessId -Force
    }
}

function Wait-Healthy([string]$HealthUrl) {
    for ($attempt = 1; $attempt -le 80; $attempt++) {
        if (Test-HttpHealth $HealthUrl) {
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Parser API did not become healthy at $HealthUrl."
}

function Wait-KeyFile([string]$KeyPath) {
    for ($attempt = 1; $attempt -le 80; $attempt++) {
        if (Test-Path -LiteralPath $KeyPath) {
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Parser API key file was not created at $KeyPath."
}

Write-Host 'Building API dist...'
& npm.cmd --prefix api run build
if ($LASTEXITCODE -ne 0) {
    throw "API build failed with exit code $LASTEXITCODE."
}

$overlayPath = Join-Path $repoRoot 'src-tauri\target\release\hammer-overlay.exe'
if (-not (Test-Path -LiteralPath $overlayPath)) {
    throw "Release overlay executable is missing at $overlayPath. Run npm run tauri:build first, or use npm run dev:desktop for live development."
}

Stop-RepoReleaseOverlay -OverlayPath $overlayPath
Stop-Listener -LocalPort $Port

Write-Host 'Starting release overlay minimized so it supervises a fresh parser child...'
Start-Process -FilePath $overlayPath -ArgumentList '--minimized' -WorkingDirectory $repoRoot

$healthUrl = "http://127.0.0.1:$Port/health"
Wait-Healthy -HealthUrl $healthUrl

if ($SkipCanary) {
    Write-Host "Parser API is healthy at $healthUrl."
    exit 0
}

$keyPath = Join-Path (Join-Path $env:APPDATA $appIdentifier) 'time-parser-api-key'
Wait-KeyFile -KeyPath $keyPath
$apiKey = (Get-Content -LiteralPath $keyPath -Raw).Trim()
$body = @{ text = $CanaryText; tz = $TimeZone } | ConvertTo-Json -Compress
$response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/parse" -Method Post -Headers @{
    'x-api-key' = $apiKey
    'x-api-version' = '1'
    'content-type' = 'application/json'
} -Body $body -TimeoutSec 45

if ($response.epoch -ne $ExpectedEpoch) {
    throw "Canary parse returned epoch $($response.epoch), expected $ExpectedEpoch."
}

Write-Host "Parser API reload verified: '$CanaryText' -> epoch $($response.epoch), method $($response.method)."
