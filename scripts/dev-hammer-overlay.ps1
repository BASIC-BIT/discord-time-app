[CmdletBinding()]
param(
    [int]$ApiPort = 8858,
    [string]$ApiKey = $(if ($env:HAMMEROVERLAY_DEV_API_KEY) { $env:HAMMEROVERLAY_DEV_API_KEY } else { 'DEV_STATIC_KEY_123' }),
    [switch]$KeepReleaseOverlay
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
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

function Stop-ProcessTree([int]$ProcessId) {
    if ($ProcessId -le 0) {
        return
    }
    & taskkill.exe /PID $ProcessId /T /F | Out-Null
}

function Stop-RepoReleaseOverlay {
    if ($KeepReleaseOverlay) {
        return
    }

    $overlayPath = Join-Path $repoRoot 'src-tauri\target\release\hammer-overlay.exe'
    $overlayProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -eq $overlayPath
    })

    foreach ($process in $overlayProcesses) {
        Write-Host "Stopping repo release overlay process $($process.ProcessId) so Tauri dev can own the single-instance lock."
        Stop-Process -Id $process.ProcessId -Force
    }
}

function Assert-PortFree([int]$Port) {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        throw "Port $Port is already in use by process $($listener.OwningProcess). Pass -ApiPort with a free port or stop that process."
    }
}

function Set-ScopedEnv([hashtable]$Previous, [string]$Name, [string]$Value) {
    $Previous[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

function Restore-ScopedEnv([hashtable]$Previous) {
    foreach ($name in $Previous.Keys) {
        [Environment]::SetEnvironmentVariable($name, $Previous[$name], 'Process')
    }
}

Stop-RepoReleaseOverlay
Assert-PortFree -Port $ApiPort

$reportsDir = Join-Path $repoRoot 'api\reports\local-dev'
New-Item -ItemType Directory -Path $reportsDir -Force | Out-Null
$apiDbPath = Join-Path $reportsDir 'temporal-api-dev.db'

$previousEnv = @{}
$apiProcess = $null
$exitCode = 0

try {
    Set-ScopedEnv $previousEnv 'PORT' ([string]$ApiPort)
    Set-ScopedEnv $previousEnv 'STATIC_API_KEY' $ApiKey
    Set-ScopedEnv $previousEnv 'DB_PATH' $apiDbPath
    Set-ScopedEnv $previousEnv 'NODE_ENV' 'development'
    Set-ScopedEnv $previousEnv 'VITE_API_BASE_URL' "http://127.0.0.1:$ApiPort"
    Set-ScopedEnv $previousEnv 'VITE_API_KEY' $ApiKey
    Set-ScopedEnv $previousEnv 'HAMMEROVERLAY_DISABLE_SUPERVISED_API' '1'

    Write-Host "Starting API dev watcher on http://127.0.0.1:$ApiPort ..."
    $apiProcess = Start-Process -FilePath 'npm.cmd' -ArgumentList @('--prefix', 'api', 'run', 'dev') -WorkingDirectory $repoRoot -PassThru -NoNewWindow

    $healthUrl = "http://127.0.0.1:$ApiPort/health"
    $healthy = $false
    for ($attempt = 1; $attempt -le 80; $attempt++) {
        if ($apiProcess.HasExited) {
            throw "API dev watcher exited early with code $($apiProcess.ExitCode)."
        }
        if (Test-HttpHealth $healthUrl) {
            $healthy = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $healthy) {
        throw "API dev watcher did not become healthy at $healthUrl."
    }

    Write-Host "API dev watcher is healthy. Starting Tauri dev with VITE_API_BASE_URL=$healthUrl ..."
    & npm.cmd run tauri -- dev
    $exitCode = if ($LASTEXITCODE -eq $null) { 0 } else { $LASTEXITCODE }
} finally {
    if ($apiProcess -and -not $apiProcess.HasExited) {
        Write-Host "Stopping API dev watcher process tree $($apiProcess.Id)."
        Stop-ProcessTree -ProcessId $apiProcess.Id
    }
    Restore-ScopedEnv $previousEnv
}

exit $exitCode
