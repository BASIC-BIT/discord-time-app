<#
.SYNOPSIS
Proves the auto-updater on installed MSIs, signed with a throwaway key.

.DESCRIPTION
Run from a normal (non-elevated) PowerShell:
    powershell -ExecutionPolicy Bypass -File scripts\verify-installed-updater-smoke.ps1 -Leg all

The non-elevated run builds the smoke MSIs (minutes; builds never run as admin), then
re-launches this script elevated with one UAC prompt. The elevated run installs the
per-machine "HammerOverlay Updater Smoke" product, launches it so the app's own
msiexec /passive inherits elevation, and writes one JSON report per leg plus a run log
into the reports directory. Every smoke build uses the routing-smoke feature (parser port
8858, its own single-instance id), so the real HammerOverlay (port 8857) is never touched.

Legs:
  auto    0.0.1 auto-installs 0.0.2 on launch; also proves an unreachable endpoint
          leaves the app running with a logged check failure.
  tray    with HAMMER_SMOKE_OVERLAY_VISIBLE=1 the update is deferred to the tray;
          the next plain launch installs it.
  oldhop  0.0.1 built from -OldCommit (old updater) hops to 0.0.2 with its sidecar
          orphaned; the new app must replace the stale sidecar.
  click   needs an operator: with the overlay visible the update is offered in the tray,
          the operator clicks 'Restart to update 0.0.2' within 180 s, and the app comes
          back as 0.0.2. Never part of all.

.PARAMETER Leg           all (auto, tray, oldhop), or a comma-separated list of auto, tray, oldhop, click
                         (e.g. auto,tray), run in that order. Only the listed legs' reports are replaced.
.PARAMETER ManifestPort  Port of the local manifest server (also baked into the smoke builds).
.PARAMETER OldCommit     Commit for the oldhop 0.0.1 build. Defaults to df68d0d, the last
                         main before the auto-updater; do not point it at code that has it.
.PARAMETER Output        Reports directory. Default: api\reports\temporal-ml (git-ignored).
.PARAMETER WorkDir       Scratch directory for the key, configs, old-code worktree and MSIs.
.PARAMETER SkipBuild     Reuse the MSIs already in <WorkDir>\artifacts.
.PARAMETER KeepArtifacts Keep <WorkDir>\artifacts after the run (for -SkipBuild reruns).
.PARAMETER Elevated      Internal: set on the elevated re-launch.
.PARAMETER ViaRunAs      Internal: the elevated run came from the RunAs relaunch (recorded in the reports).
#>
[CmdletBinding()]
param(
    [ValidatePattern('^(all|(auto|tray|oldhop|click)(,(auto|tray|oldhop|click))*)$')][string]$Leg = 'all',
    [int]$ManifestPort = 8859,
    [string]$OldCommit = 'df68d0d',
    [string]$Output = '',
    [string]$WorkDir = (Join-Path $env:TEMP 'hammer-updater-smoke'),
    [switch]$SkipBuild,
    [switch]$KeepArtifacts,
    [switch]$Elevated,
    [switch]$ViaRunAs
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($Output)) {
    $Output = Join-Path $repoRoot 'api\reports\temporal-ml'
}
$ProductName = 'HammerOverlay Updater Smoke'
$Identifier = 'com.hammer-overlay.updater-smoke'
$InstallRoot = Join-Path $env:ProgramFiles $ProductName
$RoutingSmokeRoot = Join-Path $env:ProgramFiles 'HammerOverlay Routing Smoke'
$RealRoot = Join-Path $env:ProgramFiles 'HammerOverlay'
$Exe = Join-Path $InstallRoot 'hammer-overlay.exe'
$ParserPort = 8858
$ArtifactDir = Join-Path $WorkDir 'artifacts'
$Legs = if ($Leg -eq 'all') { @('auto', 'tray', 'oldhop') } else { @($Leg -split ',' | Select-Object -Unique) }
$script:checks = $null

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if ($null -ne $script:checks) { $null = $script:checks.Add([ordered]@{ check = $Message; passed = $Condition }) }
    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param($Actual, $Expected, [string]$Message)
    $ok = $Actual -eq $Expected
    if ($null -ne $script:checks) {
        $null = $script:checks.Add([ordered]@{ check = $Message; passed = $ok; expected = "$Expected"; actual = "$Actual" })
    }
    if (-not $ok) { throw "$Message Expected '$Expected'; got '$Actual'." }
}

function Get-JsonResponse {
    param([string]$Uri, [int]$TimeoutSec = 5)
    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSec
        return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Body = $response.Content | ConvertFrom-Json }
    } catch {
        $status = 0
        if ($null -ne $_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        return [pscustomobject]@{ StatusCode = $status; Body = [pscustomobject]@{ error = $_.Exception.Message } }
    }
}

function Wait-Until {
    param([scriptblock]$Condition, [int]$TimeoutSec, [int]$IntervalMs = 1000)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        # Keep the log archive current: a rotation between reads would lose lines.
        $null = Get-SmokeLog
        if (& $Condition) { return $true }
        Start-Sleep -Milliseconds $IntervalMs
    }
    return [bool](& $Condition)
}

function Write-Utf8 {
    param([string]$Path, [string]$Text)
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

# ---------------------------------------------------------------- build (not elevated)

function New-SmokeKey {
    $keyPath = Join-Path $WorkDir 'smoke.key'
    $password = [guid]::NewGuid().ToString('N')
    Push-Location $repoRoot
    try {
        & npx tauri signer generate -w $keyPath -p $password --ci -f | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "tauri signer generate failed ($LASTEXITCODE)." }
    } finally { Pop-Location }
    # Throwaway key only: the real release key is never read.
    $env:TAURI_SIGNING_PRIVATE_KEY = $keyPath
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $password
    return [pscustomobject]@{ KeyPath = $keyPath; PublicKey = (Get-Content -Raw "$keyPath.pub").Trim() }
}

function Build-SmokeMsi {
    param([string]$Version, [string]$Features, [string]$SourceRoot, [string]$Name, [string]$PublicKey, [switch]$NoUpdaterArtifacts)
    $config = Get-Content -Raw (Join-Path $repoRoot 'src-tauri\tauri.updater-smoke.conf.json') | ConvertFrom-Json
    $config.version = $Version
    # A build that is only ever installed directly needs no signature, hence no private key.
    if ($NoUpdaterArtifacts) { $config.bundle.createUpdaterArtifacts = $false }
    $config.plugins.updater.pubkey = $PublicKey
    $config.plugins.updater.endpoints = @("http://127.0.0.1:$ManifestPort/latest.json")
    $configPath = Join-Path $WorkDir "tauri.updater-smoke.$Name.conf.json"
    Write-Utf8 $configPath ($config | ConvertTo-Json -Depth 10)

    # Mirror release.yml: the Cargo version is what the sidecar reports as appVersion.
    $cargoToml = Join-Path $SourceRoot 'src-tauri\Cargo.toml'
    $cargoLock = Join-Path $SourceRoot 'src-tauri\Cargo.lock'
    $originalToml = [IO.File]::ReadAllText($cargoToml)
    $originalLock = [IO.File]::ReadAllText($cargoLock)
    $patched = ([regex]'(?m)^version = "[^"]*"').Replace($originalToml, "version = `"$Version`"", 1)
    [IO.File]::WriteAllText($cargoToml, $patched)
    Push-Location $SourceRoot
    try {
        Write-Host "Building $Name ($Version, features $Features) in $SourceRoot"
        & npx tauri build --config $configPath --features $Features | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "tauri build for $Name failed ($LASTEXITCODE)." }
    } finally {
        Pop-Location
        [IO.File]::WriteAllText($cargoToml, $originalToml)
        [IO.File]::WriteAllText($cargoLock, $originalLock)
    }
    $targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $SourceRoot 'src-tauri\target' }
    $msi = Join-Path $targetDir "release\bundle\msi\${ProductName}_${Version}_x64_en-US.msi"
    Assert-True (Test-Path -LiteralPath $msi) "Build produced $msi"
    Copy-Item -LiteralPath $msi (Join-Path $ArtifactDir "$Name.msi") -Force
    if (-not $NoUpdaterArtifacts) {
        Assert-True (Test-Path -LiteralPath "$msi.sig") "Build produced $msi.sig"
        Copy-Item -LiteralPath "$msi.sig" (Join-Path $ArtifactDir "$Name.msi.sig") -Force
    }
}

# Builds only what is missing from <WorkDir>\artifacts, so an interrupted run resumes.
# The new-code MSIs share one throwaway key: if either is missing, both are rebuilt with a
# fresh key. The old-code MSI is never served, so it is built unsigned against the saved
# public key.
function Invoke-Builds {
    New-Item -ItemType Directory -Force $ArtifactDir | Out-Null
    $newNames = @('new-0.0.2')
    if (@($Legs | Where-Object { $_ -in 'auto', 'tray', 'click' }).Count -gt 0) { $newNames = @('new-0.0.1', 'new-0.0.2') }
    $pubPath = Join-Path $WorkDir 'smoke.pub'
    $missingNew = @($newNames | Where-Object { -not (Test-Path (Join-Path $ArtifactDir "$_.msi.sig")) })
    $needOld = ($Legs -contains 'oldhop') -and -not (Test-Path (Join-Path $ArtifactDir 'old-0.0.1.msi'))
    $oldTree = Join-Path $WorkDir 'old'
    $key = $null
    try {
        if ($missingNew.Count -gt 0) {
            $key = New-SmokeKey
            Write-Utf8 $pubPath $key.PublicKey
            Remove-Item -Path (Join-Path $ArtifactDir 'new-*') -Force -ErrorAction SilentlyContinue
            foreach ($name in $newNames) {
                Build-SmokeMsi -Version $name.Substring(4) -Features 'routing-smoke,updater-smoke' -SourceRoot $repoRoot -Name $name -PublicKey $key.PublicKey
            }
        }
        if ($needOld) {
            Assert-True (Test-Path $pubPath) "Saved smoke public key $pubPath exists."
            $head = if (Test-Path $oldTree) { git -C $oldTree rev-parse HEAD } else { '' }
            if ($head -ne (git -C $repoRoot rev-parse $OldCommit)) {
                if (Test-Path $oldTree) { git -C $repoRoot worktree remove --force $oldTree }
                git -C $repoRoot worktree add --detach $oldTree $OldCommit | Out-Host
                if ($LASTEXITCODE -ne 0) { throw "git worktree add $OldCommit failed." }
            }
            Push-Location $oldTree
            try {
                & npm ci | Out-Host
                if ($LASTEXITCODE -ne 0) { throw 'npm ci (old tree) failed.' }
                & npm --prefix api ci | Out-Host
                if ($LASTEXITCODE -ne 0) { throw 'npm --prefix api ci (old tree) failed.' }
            } finally { Pop-Location }
            # Share the compiled dependencies; the bundle lands under this target dir.
            $env:CARGO_TARGET_DIR = Join-Path $repoRoot 'src-tauri\target'
            try {
                Build-SmokeMsi -Version '0.0.1' -Features 'routing-smoke' -SourceRoot $oldTree -Name 'old-0.0.1' -PublicKey (Get-Content -Raw $pubPath).Trim() -NoUpdaterArtifacts
            } finally { Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue }
        }
    } finally {
        Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
        # The private key is never kept; a later build that needs one makes a fresh key.
        if ($key) { Remove-Item -LiteralPath $key.KeyPath, "$($key.KeyPath).pub" -Force -ErrorAction SilentlyContinue }
        if (Test-Path $oldTree) { git -C $repoRoot worktree remove --force $oldTree }
        Get-ChildItem $WorkDir -Filter 'tauri.updater-smoke.*.conf.json' | Remove-Item -Force
    }
}

# ---------------------------------------------------------------- smoke helpers (elevated)

function Get-ProcessesUnder {
    param([string]$Root, [string]$Name = '')
    $prefix = $Root.TrimEnd('\') + '\'
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and
        ($Name -eq '' -or $_.Name -eq $Name)
    })
}

function Get-RealAppPids {
    @(Get-ProcessesUnder $RealRoot 'hammer-overlay.exe' | ForEach-Object { [int]$_.ProcessId } | Sort-Object)
}

function Get-SmokeAppProcess { Get-ProcessesUnder $InstallRoot 'hammer-overlay.exe' | Select-Object -First 1 }

function Stop-SmokeApp {
    param([switch]$KeepSidecar)
    $targets = @(Get-ProcessesUnder $InstallRoot 'hammer-overlay.exe')
    if (-not $KeepSidecar) { $targets += @(Get-ProcessesUnder $InstallRoot 'node.exe') }
    foreach ($p in $targets) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $p.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
    }
}

function Start-SmokeApp {
    param([hashtable]$ExtraEnv = @{})
    $saved = @{}
    foreach ($k in $ExtraEnv.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $ExtraEnv[$k]) }
    try {
        return Start-Process -FilePath $Exe -WorkingDirectory $InstallRoot -PassThru
    } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    }
}

function Get-InstalledVersion {
    # The exe can vanish for a moment while msiexec replaces it.
    try { (Get-Item -LiteralPath $Exe).VersionInfo.ProductVersion } catch { $null }
}

function Get-SidecarHealth { Get-JsonResponse "http://127.0.0.1:$ParserPort/health" }

function Get-ListenerPids {
    param([int]$Port)
    # RemotePort 0 rather than -State Listen: some Windows 11 builds report listeners as State 0.
    @(Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
        Where-Object { ($_.State -eq 'Listen' -or $_.RemotePort -eq 0) -and $_.OwningProcess -ne 0 } |
        Select-Object -ExpandProperty OwningProcess -Unique)
}

# tauri-plugin-log truncates its file at 40 KB (KeepOne) and logs at TRACE, so a download
# can wipe earlier lines. Every read keeps what it saw before a truncation.
$script:logArchive = ''
$script:logLast = ''
function Get-SmokeLog {
    $dir = Join-Path $env:LOCALAPPDATA "$Identifier\logs"
    $current = ''
    if (Test-Path $dir) {
        # The app holds the file open for writing, so open it with full sharing.
        try {
            $current = (Get-ChildItem $dir -Filter '*.log' -ErrorAction Stop | Sort-Object LastWriteTime | ForEach-Object {
                $stream = New-Object IO.FileStream($_.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete')
                try { (New-Object IO.StreamReader($stream)).ReadToEnd() } finally { $stream.Dispose() }
            }) -join "`n"
        } catch {
            # Mid-rotation (file gone or reopened): keep what we have and read again next time.
            return $script:logArchive + $script:logLast
        }
    }
    if ($script:logLast -and -not $current.StartsWith($script:logLast)) { $script:logArchive += $script:logLast + "`n" }
    $script:logLast = $current
    $script:logArchive + $current
}

function Find-LogLine {
    param([string]$Text)
    (Get-SmokeLog) -split "`r?`n" | Where-Object { $_.Contains($Text) } | Select-Object -First 1
}

function Install-SmokeMsi {
    param([string]$Msi)
    $log = Join-Path $WorkDir ("install-" + [IO.Path]::GetFileNameWithoutExtension($Msi) + '.log')
    # 1618: another install (e.g. a winget upgrade) holds the Windows Installer; wait up to 10 min.
    $deadline = (Get-Date).AddMinutes(10)
    do {
        $p = Start-Process msiexec.exe -ArgumentList "/i `"$Msi`" /qn /norestart /l*v `"$log`"" -PassThru
        $null = $p.Handle
        $p.WaitForExit()
        if ($p.ExitCode -ne 1618) { break }
        Write-Host 'Another installation is in progress (1618); retrying in 15 s.'
        Start-Sleep -Seconds 15
    } while ((Get-Date) -lt $deadline)
    Assert-Equal $p.ExitCode 0 "msiexec /i $(Split-Path $Msi -Leaf) /qn exit code."
}

function Remove-SmokeInstall {
    Stop-SmokeApp
    $keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    $codes = @(Get-ChildItem $keys -ErrorAction SilentlyContinue | Get-ItemProperty |
        Where-Object { $_.DisplayName -eq $ProductName -and $_.PSChildName -like '{*}' } | Select-Object -ExpandProperty PSChildName)
    foreach ($code in $codes) {
        $p = Start-Process msiexec.exe -ArgumentList "/x $code /qn /norestart" -PassThru
        $null = $p.Handle
        $p.WaitForExit()
        if ($p.ExitCode -notin 0, 1605, 3010) { throw "Uninstall of $code failed ($($p.ExitCode))." }
    }
}

function Reset-SmokeData {
    # Logs, updater.json (the install-attempt marker) and settings of the smoke identifier only.
    foreach ($dir in (Join-Path $env:LOCALAPPDATA $Identifier), (Join-Path $env:APPDATA $Identifier)) {
        if (Test-Path $dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
    }
    $script:logArchive = ''
    $script:logLast = ''
    Assert-True ((Get-SmokeLog) -eq '') 'Smoke log directory is empty before the leg.'
}

function Start-ManifestServer {
    param([string]$Msi, [string]$Sig, [string]$Version)
    $serveDir = Join-Path $WorkDir 'serve'
    New-Item -ItemType Directory -Force $serveDir | Out-Null
    $msiName = Split-Path $Msi -Leaf
    Copy-Item -LiteralPath $Msi (Join-Path $serveDir $msiName) -Force
    $manifest = [ordered]@{
        version = $Version
        pub_date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        platforms = [ordered]@{
            'windows-x86_64' = [ordered]@{
                signature = (Get-Content -Raw -LiteralPath $Sig).Trim()
                url = "http://127.0.0.1:$ManifestPort/$msiName"
            }
        }
    }
    Write-Utf8 (Join-Path $serveDir 'latest.json') ($manifest | ConvertTo-Json -Depth 5)
    $script:requestLog = Join-Path $WorkDir 'manifest-requests.log'
    Set-Content -LiteralPath $script:requestLog -Value $null
    # A separate process, so stopping it never waits on a blocked GetContext().
    $server = @"
`$ErrorActionPreference = 'Stop'
`$allowed = @('latest.json', '$msiName')
`$listener = New-Object System.Net.HttpListener
`$listener.Prefixes.Add('http://127.0.0.1:$ManifestPort/')
`$listener.Start()
while (`$true) {
    `$ctx = `$listener.GetContext()
    try {
    `$name = [Uri]::UnescapeDataString(`$ctx.Request.Url.AbsolutePath.TrimStart('/'))
    Add-Content -LiteralPath '$($script:requestLog)' -Value ("{0} {1} /{2} Accept={3}" -f (Get-Date -Format o), `$ctx.Request.HttpMethod, `$name, `$ctx.Request.Headers['Accept'])
    if (`$allowed -contains `$name) {
        `$bytes = [IO.File]::ReadAllBytes((Join-Path '$serveDir' `$name))
        `$ctx.Response.StatusCode = 200
        `$ctx.Response.ContentType = if (`$name -eq 'latest.json') { 'application/json' } else { 'application/octet-stream' }
        `$ctx.Response.ContentLength64 = `$bytes.Length
        `$ctx.Response.OutputStream.Write(`$bytes, 0, `$bytes.Length)
    } else {
        `$ctx.Response.StatusCode = 404
    }
    } catch {
        try { `$ctx.Response.StatusCode = 500 } catch { }
    } finally {
        try { `$ctx.Response.Close() } catch { }
    }
}
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($server))
    $script:serverProcess = Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $up = Wait-Until { (Get-JsonResponse "http://127.0.0.1:$ManifestPort/latest.json").StatusCode -eq 200 } 20
    Assert-True $up "Manifest server answers on port $ManifestPort."
}

function Stop-ManifestServer {
    if ($script:serverProcess) {
        Stop-Process -Id $script:serverProcess.Id -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $script:serverProcess.Id -Timeout 10 -ErrorAction SilentlyContinue
        $script:serverProcess = $null
    }
    Remove-Item -LiteralPath (Join-Path $WorkDir 'serve') -Recurse -Force -ErrorAction SilentlyContinue
}

function Get-ServedRequests {
    # Plain strings: Get-Content's provider note properties make ConvertTo-Json explode.
    if ($script:requestLog -and (Test-Path $script:requestLog)) { [string[]]@([IO.File]::ReadAllLines($script:requestLog) | Where-Object { $_ }) } else { @() }
}

function Write-Report {
    param([string]$LegName, [System.Collections.IDictionary]$Fields)
    New-Item -ItemType Directory -Force $Output | Out-Null
    $path = Join-Path $Output "updater-smoke-$LegName.json"
    Write-Utf8 $path ($Fields | ConvertTo-Json -Depth 10)
    Write-Host "Report: $path"
}

function Assert-NoSmokeRunning {
    Assert-True (@(Get-ProcessesUnder $RoutingSmokeRoot).Count -eq 0) "No process from $RoutingSmokeRoot is running (shares port $ParserPort and the single-instance id)."
    Assert-True (@(Get-ProcessesUnder $InstallRoot).Count -eq 0) "No process from $InstallRoot is running."
    Assert-True (@(Get-ListenerPids $ParserPort).Count -eq 0) "Port $ParserPort is free."
    Assert-True (@(Get-ListenerPids $ManifestPort).Count -eq 0) "Port $ManifestPort is free."
}

# Launches the installed 0.0.1 with the 0.0.2 manifest served and expects it to install
# 0.0.2 itself and come back as 0.0.2 with exactly one 0.0.2 sidecar.
function Test-AutoInstallOnLaunch {
    param([System.Collections.IDictionary]$Report)
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $original = Start-SmokeApp
    $script:installerCommand = $null
    $flipped = Wait-Until {
        if (-not $script:installerCommand) {
            $m = Get-CimInstance Win32_Process -Filter "Name='msiexec.exe'" | Where-Object { $_.CommandLine -match 'AUTOLAUNCHAPP' } | Select-Object -First 1
            if ($m) { $script:installerCommand = $m.CommandLine }
        }
        $now = Get-SmokeAppProcess
        $original.HasExited -and (Get-InstalledVersion) -eq '0.0.2' -and $now -and $now.ProcessId -ne $original.Id
    } 600
    $Report.elapsedSecondsLaunchToRelaunched = [math]::Round($stopwatch.Elapsed.TotalSeconds, 1)
    $Report.appInstallerCommandLine = $script:installerCommand
    Assert-True $flipped 'Within 600 s the original process exited, 0.0.2 is installed and the app is running again.'
    $relaunched = Get-SmokeAppProcess
    $Report.relaunchedPid = [int]$relaunched.ProcessId
    $Report.relaunchedPath = $relaunched.ExecutablePath
    Assert-Equal $relaunched.ExecutablePath $Exe 'Relaunched process runs from the install path.'
    $Report.installingLogLine = Find-LogLine 'Installing update 0.0.2 on launch'
    Assert-True ([bool]$Report.installingLogLine) "Log has 'Installing update 0.0.2 on launch'."
    $healthy = Wait-Until { (Get-SidecarHealth).Body.appVersion -eq '0.0.2' } 60
    $health = Get-SidecarHealth
    $Report.sidecarHealth = $health.Body
    Assert-True $healthy 'Sidecar /health reports appVersion 0.0.2.'
    $listeners = @(Get-ListenerPids $ParserPort)
    $Report.parserListenerPids = $listeners
    Assert-Equal $listeners.Count 1 "Exactly one listener on port $ParserPort."
    $upToDate = Wait-Until { [bool](Find-LogLine 'Up to date (0.0.2)') } 60
    $Report.upToDateLogLine = Find-LogLine 'Up to date (0.0.2)'
    Assert-True $upToDate 'Relaunched 0.0.2 checks again and reports up to date (no install loop).'
    $Report.versionFlipSeconds = $Report.elapsedSecondsLaunchToRelaunched
}

# ---------------------------------------------------------------- legs

function Invoke-AutoLeg {
    param([System.Collections.IDictionary]$Report)
    Install-SmokeMsi (Join-Path $ArtifactDir 'new-0.0.1.msi')
    Assert-Equal (Get-InstalledVersion) '0.0.1' 'Installed version before the update.'

    # Unreachable endpoint: nothing listens on the manifest port yet.
    $p = Start-SmokeApp
    $null = Wait-Until { $false } 30
    Assert-True (-not $p.HasExited) 'App keeps running when the update endpoint is unreachable.'
    $Report.unreachableLogLine = Find-LogLine 'Update check failed'
    Assert-True ([bool]$Report.unreachableLogLine) "Log has 'Update check failed' for the unreachable endpoint."
    $Report.unreachableEndpoint = 'passed'
    Stop-SmokeApp

    Start-ManifestServer (Join-Path $ArtifactDir 'new-0.0.2.msi') (Join-Path $ArtifactDir 'new-0.0.2.msi.sig') '0.0.2'
    Test-AutoInstallOnLaunch $Report
}

function Invoke-TrayLeg {
    param([System.Collections.IDictionary]$Report)
    Install-SmokeMsi (Join-Path $ArtifactDir 'new-0.0.1.msi')
    Start-ManifestServer (Join-Path $ArtifactDir 'new-0.0.2.msi') (Join-Path $ArtifactDir 'new-0.0.2.msi.sig') '0.0.2'
    $p = Start-SmokeApp -ExtraEnv @{ HAMMER_SMOKE_OVERLAY_VISIBLE = '1' }
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $ready = Wait-Until { [bool](Find-LogLine 'Update 0.0.2 ready; restart to update') } 120
    $Report.secondsToReady = [math]::Round($stopwatch.Elapsed.TotalSeconds, 1)
    $Report.readyLogLine = Find-LogLine 'Update 0.0.2 ready; restart to update'
    Assert-True $ready "Log has 'Update 0.0.2 ready; restart to update' within 120 s."
    $null = Wait-Until { $false } 5
    Assert-True (-not $p.HasExited) 'App is still running with the update deferred.'
    Assert-Equal (Get-InstalledVersion) '0.0.1' 'Installed version stays 0.0.1 while deferred.'
    Assert-True (-not (Find-LogLine 'Installing update 0.0.2')) 'No install was started while the overlay was visible.'
    $marker = Join-Path $env:APPDATA "$Identifier\updater.json"
    Assert-True (-not ((Test-Path $marker) -and ((Get-Content -Raw $marker) -match 'install_attempted'))) 'No install-attempt marker was written.'
    Stop-SmokeApp

    $Report.nextLaunch = [ordered]@{}
    Test-AutoInstallOnLaunch $Report.nextLaunch
}

function Invoke-OldHopLeg {
    param([System.Collections.IDictionary]$Report)
    $Report.oldCommit = $OldCommit
    Install-SmokeMsi (Join-Path $ArtifactDir 'old-0.0.1.msi')
    Assert-Equal (Get-InstalledVersion) '0.0.1' 'Old 0.0.1 installed.'
    $null = Start-SmokeApp
    $up = Wait-Until { (Get-SidecarHealth).StatusCode -eq 200 } 90
    Assert-True $up "Old sidecar answers on port $ParserPort."
    $oldHealth = (Get-SidecarHealth).Body
    $Report.oldSidecarHealth = $oldHealth
    Assert-True ($null -eq $oldHealth.PSObject.Properties['appVersion']) 'Old sidecar /health has no appVersion.'
    $oldSidecarPids = @(Get-ListenerPids $ParserPort)
    $Report.oldSidecarPids = $oldSidecarPids
    Assert-True ($oldSidecarPids.Count -ge 1) "Old sidecar owns a listener on port $ParserPort."

    # The old client's install: msiexec /passive, then the app dies without stopping its sidecar.
    $msiLog = Join-Path $WorkDir 'install-oldhop-0.0.2.log'
    $msi = Start-Process msiexec.exe -ArgumentList "/i `"$(Join-Path $ArtifactDir 'new-0.0.2.msi')`" /passive /norestart /l*v `"$msiLog`"" -PassThru
    $null = $msi.Handle
    Stop-SmokeApp -KeepSidecar
    $Report.oldSidecarOrphaned = [bool](Get-Process -Id $oldSidecarPids[0] -ErrorAction SilentlyContinue)
    if (-not $msi.WaitForExit(600000)) { Stop-Process -Id $msi.Id -Force; throw 'msiexec /passive did not finish within 600 s.' }
    $Report.msiexecExitCode = $msi.ExitCode
    # Restart Manager may close the orphan itself under /passive; record which case happened.
    $oldAlive = [bool](Get-Process -Id $oldSidecarPids[0] -ErrorAction SilentlyContinue)
    $Report.oldSidecarAliveAfterInstall = $oldAlive
    if ($msi.ExitCode -eq 3010) { $Report.finding = 'msiexec returned 3010 (reboot required): files in use by the orphaned sidecar were scheduled for replacement.' }
    Assert-True ($msi.ExitCode -in 0, 3010) "msiexec /passive exit code is 0 or 3010 (got $($msi.ExitCode))."
    Assert-Equal (Get-InstalledVersion) '0.0.2' 'Installed version after the hop.'

    $null = Start-SmokeApp
    $healthy = Wait-Until { (Get-SidecarHealth).Body.appVersion -eq '0.0.2' } 90
    $Report.sidecarHealth = (Get-SidecarHealth).Body
    Assert-True $healthy 'Sidecar /health reports appVersion 0.0.2 after the hop.'
    $listeners = @(Get-ListenerPids $ParserPort)
    $Report.parserListenerPids = $listeners
    Assert-Equal $listeners.Count 1 "Exactly one listener on port $ParserPort."
    Assert-True ($listeners[0] -notin $oldSidecarPids) 'The listener is not the orphaned old sidecar.'
    $nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($InstallRoot + '\', [StringComparison]::OrdinalIgnoreCase)) -or
        ($_.CommandLine -and $_.CommandLine.IndexOf($InstallRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
    $Report.installPathNodes = @($nodes | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; commandLine = $_.CommandLine } })
    Assert-True ($nodes.Count -eq 1 -and [int]$nodes[0].ProcessId -eq [int]$listeners[0]) 'The only node.exe from the install path is the new sidecar.'
    $Report.restartLogLine = Find-LogLine 'restarting it'
    if ($oldAlive) {
        $Report.sidecarCase = 'orphan survived the install; the new app had to replace it'
        Assert-True ([bool]$Report.restartLogLine) 'Log shows the stale sidecar was restarted.'
    } else {
        $Report.sidecarCase = 'msiexec (Restart Manager) closed the orphan; the new app spawned a fresh sidecar'
    }
}

# Operator-driven: the tray item click is the only path not driven by the script.
function Invoke-ClickLeg {
    param([System.Collections.IDictionary]$Report)
    Install-SmokeMsi (Join-Path $ArtifactDir 'new-0.0.1.msi')
    Assert-Equal (Get-InstalledVersion) '0.0.1' 'Installed version before the update.'
    Start-ManifestServer (Join-Path $ArtifactDir 'new-0.0.2.msi') (Join-Path $ArtifactDir 'new-0.0.2.msi.sig') '0.0.2'
    $original = Start-SmokeApp -ExtraEnv @{ HAMMER_SMOKE_OVERLAY_VISIBLE = '1' }
    $ready = Wait-Until { [bool](Find-LogLine 'Update 0.0.2 ready; restart to update') } 120
    $Report.readyLogLine = Find-LogLine 'Update 0.0.2 ready; restart to update'
    Assert-True $ready "Log has 'Update 0.0.2 ready; restart to update' within 120 s."
    Assert-Equal (Get-InstalledVersion) '0.0.1' 'Installed version stays 0.0.1 until the click.'

    Write-Host ''
    Write-Host ">>> Click the tray item 'Restart to update 0.0.2' within 180 s <<<" -ForegroundColor Yellow
    Write-Host "    (the '$ProductName' tray icon; the installer then shows a progress bar)" -ForegroundColor Yellow
    Write-Host ''
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    # Two waits: the click itself (operator, 180 s), then the install and relaunch (about 210-245 s here).
    $clicked = Wait-Until { $original.HasExited -or [bool](Find-LogLine 'Restart to update requested from system tray') } 180
    $Report.secondsPromptToClick = [math]::Round($stopwatch.Elapsed.TotalSeconds, 1)
    Assert-True $clicked "Operator clicked 'Restart to update 0.0.2' within 180 s of the prompt."
    $clickClock = [Diagnostics.Stopwatch]::StartNew()
    $flipped = Wait-Until {
        $now = Get-SmokeAppProcess
        $original.HasExited -and $now -and $now.ProcessId -ne $original.Id -and (Get-InstalledVersion) -eq '0.0.2'
    } 600
    $Report.clickToRelaunchSeconds = [math]::Round($clickClock.Elapsed.TotalSeconds, 1)
    Assert-True $flipped 'Within 600 s of the click the original process exited, a process from the install path is running and 0.0.2 is installed.'
    $Report.clickedBy = 'operator'
    $Report.trayClickLogLine = Find-LogLine 'Restart to update requested from system tray'
    Assert-True ([bool]$Report.trayClickLogLine) "Log has 'Restart to update requested from system tray'."

    $relaunched = Get-SmokeAppProcess
    $Report.relaunchedPid = [int]$relaunched.ProcessId
    $Report.relaunchedPath = $relaunched.ExecutablePath
    Assert-Equal $relaunched.ExecutablePath $Exe 'Relaunched process runs from the install path.'
    $healthy = Wait-Until { (Get-SidecarHealth).Body.appVersion -eq '0.0.2' } 60
    $Report.sidecarHealth = (Get-SidecarHealth).Body
    Assert-True $healthy 'Sidecar /health reports appVersion 0.0.2.'
    $listeners = @(Get-ListenerPids $ParserPort)
    $Report.parserListenerPids = $listeners
    Assert-Equal $listeners.Count 1 "Exactly one listener on port $ParserPort."
    $upToDate = Wait-Until { [bool](Find-LogLine 'Up to date (0.0.2)') } 60
    $Report.upToDateLogLine = Find-LogLine 'Up to date (0.0.2)'
    Assert-True $upToDate 'Relaunched 0.0.2 checks again and reports up to date (no install loop).'
}

function Invoke-ElevatedLegs {
    New-Item -ItemType Directory -Force $Output | Out-Null
    $failed = 0
    $realBefore = Get-RealAppPids
    Assert-NoSmokeRunning
    foreach ($name in $Legs) {
        $report = [ordered]@{ leg = $name; status = 'failed'; startedAt = (Get-Date).ToString('o'); elevatedRun = $true; manifestPort = $ManifestPort }
        $report.appRanElevated = $true
        $source = if ($ViaRunAs) { 'the RunAs child (one UAC prompt, approved by the operator)' } else { 'the already elevated shell' }
        $report.note = "The app inherited the elevated token of $source, so the user-facing UAC prompt on the app's own msiexec was not exercised."
        $report.artifactSha256 = [ordered]@{}
        Get-ChildItem $ArtifactDir -Filter '*.msi' | ForEach-Object { $report.artifactSha256[$_.Name] = (Get-FileHash $_.FullName -Algorithm SHA256).Hash }
        $script:checks = New-Object System.Collections.ArrayList
        $script:requestLog = $null
        Write-Host "=== leg $name ==="
        try {
            Remove-SmokeInstall
            Reset-SmokeData
            switch ($name) {
                'auto' { Invoke-AutoLeg $report }
                'tray' { Invoke-TrayLeg $report }
                'oldhop' { Invoke-OldHopLeg $report }
                'click' { Invoke-ClickLeg $report }
            }
            $report.status = 'passed'
        } catch {
            $failed++
            $report.error = $_.Exception.Message
            try { $report.logTail = @((Get-SmokeLog) -split "`r?`n" | Select-Object -Last 40) } catch { $report.logTail = @("log unreadable: $($_.Exception.Message)") }
            Write-Host "Leg $name FAILED: $($_.Exception.Message)" -ForegroundColor Red
        } finally {
            try { Stop-ManifestServer } catch { $report.cleanupError = $_.Exception.Message }
            try { $report.servedRequests = Get-ServedRequests } catch { $report.servedRequests = @("unreadable: $($_.Exception.Message)") }
            try { Remove-SmokeInstall } catch { $report.cleanupError = $_.Exception.Message }
            $report.realHammerOverlayPidsUnchanged = (@(Get-RealAppPids) -join ',') -eq ($realBefore -join ',')
            $report.checks = $script:checks
            $report.finishedAt = (Get-Date).ToString('o')
            Write-Report $name $report
        }
    }
    Remove-Item -LiteralPath (Join-Path $WorkDir 'manifest-requests.log') -Force -ErrorAction SilentlyContinue
    $script:failed = $failed
}

# ---------------------------------------------------------------- entry

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($Elevated) {
    if (-not $isAdmin) { throw 'The -Elevated run must be elevated: the smoke MSI installs per-machine.' }
    $runLog = Join-Path $Output 'updater-smoke-run.log'
    New-Item -ItemType Directory -Force $Output | Out-Null
    Start-Transcript -LiteralPath $runLog -Force | Out-Null
    # The leg count lives in $script:failed so stray pipeline output can never become the exit code.
    $script:failed = 99
    try { Invoke-ElevatedLegs | Out-Host } catch { Write-Host "Run aborted: $($_.Exception.Message)"; $script:failed = 99 } finally { Stop-Transcript | Out-Null }
    exit $script:failed
}

if ($isAdmin -and -not $SkipBuild) {
    throw 'Run this from a normal (non-elevated) PowerShell: builds must not run as admin. The script elevates itself for the installs (one UAC prompt).'
}

New-Item -ItemType Directory -Force $WorkDir | Out-Null
if (-not $SkipBuild) { Invoke-Builds }
$needed = @('new-0.0.2.msi')
if (@($Legs | Where-Object { $_ -in 'auto', 'tray', 'click' }).Count -gt 0) { $needed += 'new-0.0.1.msi' }
if ($Legs -contains 'oldhop') { $needed += 'old-0.0.1.msi' }
foreach ($n in $needed) { Assert-True (Test-Path (Join-Path $ArtifactDir $n)) "Artifact $n exists in $ArtifactDir." }
foreach ($name in $Legs) { Remove-Item -LiteralPath (Join-Path $Output "updater-smoke-$name.json") -Force -ErrorAction SilentlyContinue }

try {
    $childArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Leg $Leg -ManifestPort $ManifestPort -OldCommit $OldCommit -Output `"$Output`" -WorkDir `"$WorkDir`" -Elevated -ViaRunAs"
    if ($isAdmin) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Leg $Leg -ManifestPort $ManifestPort -OldCommit $OldCommit -Output $Output -WorkDir $WorkDir -Elevated
        $exitCode = $LASTEXITCODE
    } else {
        Write-Host 'Elevating for the MSI installs (approve the UAC prompt)...'
        # The click leg prompts the operator in the elevated window, so keep it visible then.
        $windowStyle = if ($Legs -contains 'click') { 'Normal' } else { 'Minimized' }
        $child = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle $windowStyle -ArgumentList $childArgs
        $exitCode = $child.ExitCode
    }
} finally {
    if (-not $KeepArtifacts) { Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue }
}

foreach ($name in $Legs) {
    $path = Join-Path $Output "updater-smoke-$name.json"
    if (Test-Path $path) {
        $r = Get-Content -Raw $path | ConvertFrom-Json
        Write-Host ("{0,-7} {1}{2}" -f $name, $r.status, $(if ($r.error) { " - $($r.error)" } else { '' }))
    } else {
        Write-Host ("{0,-7} no report" -f $name)
    }
}
Write-Host "Run log: $(Join-Path $Output 'updater-smoke-run.log')"
exit $exitCode
