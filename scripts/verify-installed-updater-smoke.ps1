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
  kill    installed 0.0.2 finds a hand-started sidecar reporting appVersion 0.0.9 on 8858
          and must kill it and spawn its own (KillThenSpawn).

.PARAMETER Leg           all (auto, tray, oldhop, kill), or a comma-separated list of auto, tray, oldhop, kill, click
                         (e.g. auto,tray), run in that order. Only the listed legs' reports are replaced.
.PARAMETER ManifestPort  Port of the local manifest server (also baked into the smoke builds).
.PARAMETER OldCommit     Commit for the oldhop 0.0.1 build. Defaults to df68d0d, the last
                         main before the auto-updater; do not point it at code that has it.
.PARAMETER Output        Reports directory. Default: api\reports\temporal-ml (git-ignored).
.PARAMETER WorkDir       Scratch directory for the key, configs, old-code worktree and MSIs.
.PARAMETER SkipBuild     Reuse the MSIs already in <WorkDir>\artifacts.
.PARAMETER KeepArtifacts Keep <WorkDir>\artifacts after the run (for -SkipBuild reruns).
.PARAMETER BuildOnly     Build the missing MSIs and stop (no elevation, no install).
.PARAMETER AllowDirtyBuild Build the new-code MSIs in this checkout when it has uncommitted changes (its
                         Cargo.toml version is rewritten during the build); otherwise they build from a
                         temporary worktree of HEAD.
.PARAMETER AllowStaleArtifacts Run the legs on MSIs whose new.commit stamp differs from this checkout's tree
                         (normally refused); every leg report then records staleArtifactsAllowed and both stamps.
.PARAMETER NoNpm         Build through node only, with npm dropped from PATH (also used when npm is absent).
.PARAMETER NodeExe       Node runtime for -NoNpm builds. Default: node on PATH, else C:\ProgramData\nvm\v24.22.2\node.exe.
.PARAMETER Elevated      Internal: set on the elevated re-launch.
.PARAMETER ViaRunAs      Internal: the elevated run came from the RunAs relaunch (recorded in the reports).
#>
[CmdletBinding()]
param(
    [ValidatePattern('^(all|(auto|tray|oldhop|kill|click)(,(auto|tray|oldhop|kill|click))*)$')][string]$Leg = 'all',
    [int]$ManifestPort = 8859,
    [string]$OldCommit = 'df68d0d',
    [string]$Output = '',
    [string]$WorkDir = (Join-Path $env:TEMP 'hammer-updater-smoke'),
    [switch]$SkipBuild,
    [switch]$KeepArtifacts,
    [switch]$BuildOnly,
    [switch]$AllowDirtyBuild,
    [switch]$AllowStaleArtifacts,
    [switch]$NoNpm,
    [string]$NodeExe = '',
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
$Legs = if ($Leg -eq 'all') { @('auto', 'tray', 'oldhop', 'kill') } else { @($Leg -split ',' | Select-Object -Unique) }
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

# Without npm (or with -NoNpm) every build step runs through node directly and Tauri's
# beforeBuildCommand is blanked. -NoNpm also drops npm directories from PATH, so the build
# proves it never needs npm.
function Initialize-BuildTools {
    if ($NoNpm) {
        $env:Path = (($env:Path -split ';') | Where-Object { $_ -and -not (Test-Path (Join-Path $_ 'npm.cmd')) }) -join ';'
    }
    $script:useNpm = [bool](Get-Command npm -ErrorAction SilentlyContinue)
    $script:node = $NodeExe
    if (-not $script:node) {
        $cmd = Get-Command node -ErrorAction SilentlyContinue
        $script:node = if ($cmd) { $cmd.Source } else { 'C:\ProgramData\nvm\v24.22.2\node.exe' }
    }
    Assert-True (Test-Path -LiteralPath $script:node) "Node runtime exists at $($script:node)."
    Write-Host "Build tools: $(if ($script:useNpm) { 'npm' } else { 'node only' }), node $($script:node)"
}

function Invoke-Node {
    param([string]$What, [string[]]$NodeArgs)
    & $script:node @NodeArgs | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$What failed ($LASTEXITCODE)." }
}

function Invoke-TauriCli {
    param([string]$SourceRoot, [string[]]$CliArgs)
    if ($script:useNpm) {
        Push-Location $SourceRoot
        try { & npx tauri @CliArgs | Out-Host } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw "tauri $($CliArgs[0]) failed ($LASTEXITCODE)." }
    } else {
        Push-Location $SourceRoot
        try { Invoke-Node "tauri $($CliArgs[0])" (@((Join-Path $SourceRoot 'node_modules\@tauri-apps\cli\tauri.js')) + $CliArgs) } finally { Pop-Location }
    }
}

# build:desktop without npm: api tsc (api/package.json "build": "tsc --strict"), sidecar staging, vite.
# prepare-api-sidecar.mjs still runs `npm ci` itself unless its staging stamp is current.
function Invoke-DesktopBuildWithoutNpm {
    param([string]$SourceRoot)
    Push-Location (Join-Path $SourceRoot 'api')
    try { Invoke-Node 'api tsc --strict' @('node_modules\typescript\bin\tsc', '--strict') } finally { Pop-Location }
    Push-Location $SourceRoot
    try {
        Invoke-Node 'prepare-api-sidecar' @('scripts\prepare-api-sidecar.mjs')
        Invoke-Node 'vite build' @('node_modules\vite\bin\vite.js', 'build')
    } finally { Pop-Location }
}

function New-SmokeKey {
    $keyPath = Join-Path $WorkDir 'smoke.key'
    $password = [guid]::NewGuid().ToString('N')
    Invoke-TauriCli $repoRoot @('signer', 'generate', '-w', $keyPath, '-p', $password, '--ci', '-f')
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
    if (-not $script:useNpm) { $config | Add-Member -NotePropertyName build -NotePropertyValue ([pscustomobject]@{ beforeBuildCommand = '' }) -Force }
    $configPath = Join-Path $WorkDir "tauri.updater-smoke.$Name.conf.json"
    Write-Utf8 $configPath ($config | ConvertTo-Json -Depth 10)

    # Mirror release.yml: the Cargo version is what the sidecar reports as appVersion.
    $cargoToml = Join-Path $SourceRoot 'src-tauri\Cargo.toml'
    $cargoLock = Join-Path $SourceRoot 'src-tauri\Cargo.lock'
    $originalToml = [IO.File]::ReadAllText($cargoToml)
    $originalLock = [IO.File]::ReadAllText($cargoLock)
    $patched = ([regex]'(?m)^version = "[^"]*"').Replace($originalToml, "version = `"$Version`"", 1)
    [IO.File]::WriteAllText($cargoToml, $patched)
    try {
        Write-Host "Building $Name ($Version, features $Features) in $SourceRoot"
        if (-not $script:useNpm) { Invoke-DesktopBuildWithoutNpm $SourceRoot }
        Invoke-TauriCli $SourceRoot @('build', '--config', $configPath, '--features', $Features)
    } finally {
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

# The real checkout's Cargo.toml is only ever rewritten by an -AllowDirtyBuild build, and a
# killed build there skips its restore, so refuse to start on top of a leftover rewrite.
function Assert-CargoManifestClean {
    $changed = @(git -C $repoRoot status --porcelain -- src-tauri/Cargo.toml src-tauri/Cargo.lock)
    if ($LASTEXITCODE -ne 0) { throw "git status failed ($LASTEXITCODE)." }
    if ($changed.Count -gt 0) {
        $changed | ForEach-Object { Write-Host $_ }
        throw 'Cargo.toml/Cargo.lock are modified; restore them (git checkout -- src-tauri/Cargo.toml src-tauri/Cargo.lock) before running the smoke'
    }
}

$BuildTreeLinks = @('node_modules', 'api\node_modules')

# Unlinks the node_modules junctions first so removing the worktree never deletes through them.
function Remove-BuildWorktree {
    param([string]$Tree)
    if (Test-Path $Tree) {
        foreach ($rel in $BuildTreeLinks) {
            $link = Join-Path $Tree $rel
            if ((Get-Item $link -ErrorAction SilentlyContinue).LinkType -eq 'Junction') { cmd /c rmdir "$link" | Out-Null }
        }
        git -C $repoRoot worktree remove --force $Tree
    }
    git -C $repoRoot worktree prune
}

# A detached worktree of $Commit that borrows this checkout's node_modules through junctions.
function New-BuildWorktree {
    param([string]$Tree, [string]$Commit)
    Remove-BuildWorktree $Tree
    git -C $repoRoot worktree add --detach $Tree $Commit | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "git worktree add $Commit failed." }
    foreach ($rel in $BuildTreeLinks) { New-Item -ItemType Junction -Path (Join-Path $Tree $rel) -Target (Join-Path $repoRoot $rel) | Out-Null }
}

# The stamp written to <artifacts>\new.commit: HEAD, plus '+dirty' when the built paths have uncommitted changes.
function Get-TreeState {
    $dirty = git -C $repoRoot status --porcelain -- src src-tauri api shared scripts/prepare-api-sidecar.mjs package.json
    [pscustomobject]@{ Dirty = $dirty; State = (git -C $repoRoot rev-parse HEAD) + $(if ($dirty) { '+dirty' } else { '' }) }
}

# Builds only what is missing from <WorkDir>\artifacts, so an interrupted run resumes.
# The new-code MSIs share one throwaway key: if either is missing, both are rebuilt with a
# fresh key. The old-code MSI is never served, so it is built unsigned against the saved
# public key. Both build in temporary worktrees, so the version patch never touches this
# checkout; only -AllowDirtyBuild builds the new code here, since a worktree of HEAD cannot
# see uncommitted changes.
function Invoke-Builds {
    Assert-CargoManifestClean
    New-Item -ItemType Directory -Force $ArtifactDir | Out-Null
    Initialize-BuildTools
    $newNames = @('new-0.0.2')
    if (@($Legs | Where-Object { $_ -in 'auto', 'tray', 'click' }).Count -gt 0) { $newNames = @('new-0.0.1', 'new-0.0.2') }
    $pubPath = Join-Path $WorkDir 'smoke.pub'
    # New-code MSIs are rebuilt whenever the tree they came from differs from the current one.
    $commitPath = Join-Path $ArtifactDir 'new.commit'
    $tree = Get-TreeState
    $dirty = $tree.Dirty
    $treeState = $tree.State
    $builtFrom = if (Test-Path $commitPath) { (Get-Content -Raw $commitPath).Trim() } else { '' }
    $missingNew = @($newNames | Where-Object { -not (Test-Path (Join-Path $ArtifactDir "$_.msi.sig")) })
    if ($builtFrom -ne $treeState) { $missingNew = $newNames }
    Write-Host "New-code MSIs built from '$builtFrom'; tree is '$treeState'; building: $($missingNew -join ', ')"
    if ($missingNew.Count -gt 0 -and $dirty -and -not $AllowDirtyBuild) {
        $dirty | ForEach-Object { Write-Host $_ }
        throw 'The tree has uncommitted changes (listed above) that a worktree of HEAD would not build. Commit them, or pass -AllowDirtyBuild to build from this checkout (its Cargo.toml version is rewritten during the build).'
    }
    $needOld = ($Legs -contains 'oldhop') -and -not (Test-Path (Join-Path $ArtifactDir 'old-0.0.1.msi'))
    $newTree = Join-Path $WorkDir 'new'
    $oldTree = Join-Path $WorkDir 'old'
    $key = $null
    try {
        if ($missingNew.Count -gt 0) {
            $key = New-SmokeKey
            Write-Utf8 $pubPath $key.PublicKey
            Remove-Item -Path (Join-Path $ArtifactDir 'new-*') -Force -ErrorAction SilentlyContinue
            $newSource = $repoRoot
            if (-not $dirty) {
                New-BuildWorktree $newTree HEAD
                # The sidecar staging stamp hashes relative paths and contents, so this checkout's
                # staging stays current in the worktree and prepare-api-sidecar skips its npm ci.
                $staging = Join-Path $repoRoot 'src-tauri\sidecars'
                if (Test-Path $staging) { Copy-Item -LiteralPath $staging (Join-Path $newTree 'src-tauri\sidecars') -Recurse -Force }
                # Share the compiled dependencies; the bundle lands under this target dir.
                $env:CARGO_TARGET_DIR = Join-Path $repoRoot 'src-tauri\target'
                $newSource = $newTree
            }
            try {
                foreach ($name in $newNames) {
                    Build-SmokeMsi -Version $name.Substring(4) -Features 'routing-smoke,updater-smoke' -SourceRoot $newSource -Name $name -PublicKey $key.PublicKey
                }
            } finally { Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue }
            Write-Utf8 $commitPath $treeState
        }
        if ($needOld) {
            Assert-True (Test-Path $pubPath) "Saved smoke public key $pubPath exists."
            New-BuildWorktree $oldTree $OldCommit
            # Same lockfiles, so the old tree can borrow this tree's node_modules.
            foreach ($rel in 'package-lock.json', 'api\package-lock.json') {
                Assert-True ((Get-FileHash (Join-Path $repoRoot $rel)).Hash -eq (Get-FileHash (Join-Path $oldTree $rel)).Hash) "$rel is identical in $OldCommit (node_modules can be shared)."
            }
            Assert-True $script:useNpm 'The old-code build needs npm: prepare-api-sidecar.mjs runs npm ci for the sidecar staging.'
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
        foreach ($tree in $newTree, $oldTree) { Remove-BuildWorktree $tree }
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

# The app's relaunch watchdog (updater.rs): a hidden powershell, given the exe through
# HAMMER_RELAUNCH_EXE, that later starts it with --minimized. Only watchdogs whose parent is
# a smoke app process this run has seen count, so the real HammerOverlay's are never touched.
$script:smokeAppPids = @()
function Get-WatchdogProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains('HAMMER_RELAUNCH_EXE') -and $_.CommandLine.Contains('--minimized') -and
        [int]$_.ParentProcessId -in $script:smokeAppPids
    })
}

function Save-Watchdogs {
    param([System.Collections.IDictionary]$Report)
    if (-not $Report.Contains('watchdogs')) { $Report.watchdogs = [ordered]@{} }
    foreach ($w in Get-WatchdogProcesses) { $Report.watchdogs["$($w.ProcessId)"] = $w.CommandLine }
}

# A watchdog relaunch can briefly add a second process that exits on the single-instance guard.
function Assert-SingleAppProcess {
    param([System.Collections.IDictionary]$Report)
    $settled = Wait-Until { @(Get-ProcessesUnder $InstallRoot 'hammer-overlay.exe').Count -eq 1 } 15
    $Report.appProcessesFromInstallPath = @(Get-ProcessesUnder $InstallRoot 'hammer-overlay.exe' | ForEach-Object { [int]$_.ProcessId })
    $script:smokeAppPids += $Report.appProcessesFromInstallPath
    Assert-True $settled 'Exactly one app process from the install path within 15 s.'
}

function Stop-SmokeApp {
    param([switch]$KeepSidecar)
    # A pending watchdog would start the app again later, possibly inside the next leg.
    foreach ($w in Get-WatchdogProcesses) { Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue }
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
        $p = Start-Process -FilePath $Exe -WorkingDirectory $InstallRoot -PassThru
        $script:smokeAppPids += $p.Id
        return $p
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

# Token evidence for a process: the elevated run can open other processes' tokens. Never throws.
function Initialize-TokenInfo {
    if ('SmokeTokenInfo' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SmokeTokenInfo {
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, TOKEN_QUERY = 0x8;
    const int TokenElevation = 20, TokenIntegrityLevel = 25;

    // -1 when the process or its token cannot be read.
    static int Query(int pid, int infoClass) {
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero) return -1;
        IntPtr token = IntPtr.Zero, info = IntPtr.Zero;
        try {
            if (!OpenProcessToken(process, TOKEN_QUERY, out token)) return -1;
            int length;
            GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out length);
            if (length <= 0) return -1;
            info = Marshal.AllocHGlobal(length);
            if (!GetTokenInformation(token, infoClass, info, length, out length)) return -1;
            if (infoClass == TokenElevation) return Marshal.ReadInt32(info) != 0 ? 1 : 0;
            // TOKEN_MANDATORY_LABEL: the label SID's last sub-authority is the integrity RID.
            IntPtr sid = Marshal.ReadIntPtr(info);
            int count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
        } finally {
            if (info != IntPtr.Zero) Marshal.FreeHGlobal(info);
            if (token != IntPtr.Zero) CloseHandle(token);
            CloseHandle(process);
        }
    }
    public static int IntegrityRid(int pid) { return Query(pid, TokenIntegrityLevel); }
    public static int Elevation(int pid) { return Query(pid, TokenElevation); }
}
'@
}

function Get-ProcessIntegrityLevel {
    param([int]$Id)
    try {
        Initialize-TokenInfo
        $rid = [SmokeTokenInfo]::IntegrityRid($Id)
        switch ($rid) { -1 { 'unknown' } 0 { 'Untrusted' } 0x1000 { 'Low' } 0x2000 { 'Medium' } 0x3000 { 'High' } 0x4000 { 'System' } default { '0x{0:X}' -f $rid } }
    } catch { 'unknown' }
}

# $true/$false from TokenElevation; $null when the token cannot be read.
function Get-ProcessElevated {
    param([int]$Id)
    try {
        Initialize-TokenInfo
        switch ([SmokeTokenInfo]::Elevation($Id)) { 1 { $true } 0 { $false } default { $null } }
    } catch { $null }
}

# Evidence only: the integrity of the (first) app process from the install path and of the (first) parser-port listener.
function Save-ProcessIntegrity {
    param([System.Collections.IDictionary]$Report, [int[]]$SidecarPids)
    $appPids = @(Get-ProcessesUnder $InstallRoot 'hammer-overlay.exe' | ForEach-Object { [int]$_.ProcessId })
    $first = if ($appPids.Count -gt 0) { $appPids[0] } else { 0 }
    $Report.relaunchedIntegrityPid = $first
    $Report.relaunchedIntegrity = if ($first) { Get-ProcessIntegrityLevel $first } else { 'unknown' }
    $Report.elevated = if ($first) { Get-ProcessElevated $first } else { $null }
    $sidecar = if (@($SidecarPids).Count -gt 0) { $SidecarPids[0] } else { 0 }
    $Report.sidecarIntegrityPid = $sidecar
    $Report.sidecarIntegrity = if ($sidecar) { Get-ProcessIntegrityLevel $sidecar } else { 'unknown' }
    $Report.sidecarElevated = if ($sidecar) { Get-ProcessElevated $sidecar } else { $null }
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
        Save-Watchdogs $Report
        $now = Get-SmokeAppProcess
        $original.HasExited -and (Get-InstalledVersion) -eq '0.0.2' -and $now -and $now.ProcessId -ne $original.Id
    } 600
    $Report.elapsedSecondsLaunchToRelaunched = [math]::Round($stopwatch.Elapsed.TotalSeconds, 1)
    $Report.appInstallerCommandLine = $script:installerCommand
    Assert-True $flipped 'Within 600 s the original process exited, 0.0.2 is installed and the app is running again.'
    Assert-SingleAppProcess $Report
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
    Save-ProcessIntegrity $Report $listeners
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
    Save-ProcessIntegrity $Report $listeners
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
    # Unmissable but non-blocking: beeps plus a detached message box that stays up during the wait.
    try { 1..3 | ForEach-Object { [Console]::Beep(880, 300) } } catch { }
    $box = 'Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(''Click the tray icon "HammerOverlay Updater Smoke" and choose "Restart to update 0.0.2" within 3 minutes.'', ''Updater smoke: your turn'') | Out-Null'
    $encodedBox = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($box))
    $Report.promptBoxPid = (Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList "-NoProfile -EncodedCommand $encodedBox").Id
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    # Two waits: the click itself (operator, 180 s), then the install and relaunch (about 210-245 s here).
    $clicked = Wait-Until { $original.HasExited -or [bool](Find-LogLine 'Restart to update requested from system tray') } 180
    $Report.secondsPromptToClick = [math]::Round($stopwatch.Elapsed.TotalSeconds, 1)
    Assert-True $clicked "Operator clicked 'Restart to update 0.0.2' within 180 s of the prompt."
    $clickClock = [Diagnostics.Stopwatch]::StartNew()
    $flipped = Wait-Until {
        Save-Watchdogs $Report
        $now = Get-SmokeAppProcess
        $original.HasExited -and $now -and $now.ProcessId -ne $original.Id -and (Get-InstalledVersion) -eq '0.0.2'
    } 600
    $Report.clickToRelaunchSeconds = [math]::Round($clickClock.Elapsed.TotalSeconds, 1)
    Assert-True $flipped 'Within 600 s of the click the original process exited, a process from the install path is running and 0.0.2 is installed.'
    Assert-SingleAppProcess $Report
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
    Save-ProcessIntegrity $Report $listeners
    Assert-Equal $listeners.Count 1 "Exactly one listener on port $ParserPort."
    $upToDate = Wait-Until { [bool](Find-LogLine 'Up to date (0.0.2)') } 60
    $Report.upToDateLogLine = Find-LogLine 'Up to date (0.0.2)'
    Assert-True $upToDate 'Relaunched 0.0.2 checks again and reports up to date (no install loop).'
}

# Deterministic KillThenSpawn: a sidecar from another app version already owns the parser port.
# The hand-started node runs from the install dir, so Stop-SmokeApp (and the leg's cleanup) stops it too.
function Invoke-KillLeg {
    param([System.Collections.IDictionary]$Report)
    Install-SmokeMsi (Join-Path $ArtifactDir 'new-0.0.2.msi')
    $installed = Get-InstalledVersion
    Assert-Equal $installed '0.0.2' 'Installed version.'
    $sidecarEnv = @{
        PORT = "$ParserPort"; STATIC_API_KEY = 'updater-smoke-kill'; NODE_ENV = 'production'; HAMMER_APP_VERSION = '0.0.9'
        TELEMETRY_HMAC_KEY = 'updater-smoke-kill-telemetry'; TELEMETRY_HMAC_KEY_ID = 'updater-smoke'
        DB_PATH = (Join-Path $WorkDir 'kill-sidecar.db')
    }
    $saved = @{}
    foreach ($k in $sidecarEnv.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $sidecarEnv[$k]) }
    try {
        $stale = Start-Process -FilePath (Join-Path $InstallRoot 'api\bin\node.exe') -ArgumentList "`"$(Join-Path $InstallRoot 'api\dist\index.js')`"" `
            -WorkingDirectory (Join-Path $InstallRoot 'api') -NoNewWindow -PassThru `
            -RedirectStandardOutput (Join-Path $WorkDir 'kill-sidecar.out.log') -RedirectStandardError (Join-Path $WorkDir 'kill-sidecar.err.log')
    } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    }
    $Report.staleSidecarPid = $stale.Id
    $up = Wait-Until { (Get-SidecarHealth).Body.appVersion -eq '0.0.9' } 60
    Assert-True $up "Hand-started sidecar reports appVersion 0.0.9 on port $ParserPort."
    Assert-Equal (@(Get-ListenerPids $ParserPort) -join ',') "$($stale.Id)" 'The hand-started sidecar owns the parser port.'

    $null = Start-SmokeApp
    $restartText = "reports app version `"0.0.9`", expected $installed; restarting it"
    $replaced = Wait-Until {
        $listeners = @(Get-ListenerPids $ParserPort)
        [bool](Find-LogLine $restartText) -and $stale.HasExited -and $listeners.Count -eq 1 -and $listeners[0] -ne $stale.Id -and
            (Get-SidecarHealth).Body.appVersion -eq $installed
    } 60
    $Report.restartLogLine = Find-LogLine $restartText
    $Report.sidecarHealth = (Get-SidecarHealth).Body
    $listeners = @(Get-ListenerPids $ParserPort)
    $Report.parserListenerPids = $listeners
    Save-ProcessIntegrity $Report $listeners
    Assert-True ([bool]$Report.restartLogLine) "Log has '$restartText'."
    Assert-True $stale.HasExited 'The stale sidecar process is gone.'
    Assert-Equal $listeners.Count 1 "Exactly one listener on port $ParserPort."
    Assert-True ($listeners[0] -ne $stale.Id) 'The listener is a new process, not the stale sidecar.'
    Assert-Equal $Report.sidecarHealth.appVersion $installed 'Sidecar /health reports the installed version.'
    Assert-True $replaced 'All of the above held together within 60 s of launch.'
}

# A -SkipBuild rerun must not pass off MSIs built from another tree as evidence for this one.
function Get-ArtifactFreshness {
    $builtFromPath = Join-Path $ArtifactDir 'new.commit'
    $builtFrom = if (Test-Path $builtFromPath) { (Get-Content -Raw $builtFromPath).Trim() } else { 'unknown' }
    $head = (Get-TreeState).State
    if ($builtFrom -ne $head -and -not $AllowStaleArtifacts) {
        throw "Smoke MSIs were built from $builtFrom, but HEAD is $head; rebuild (drop -SkipBuild) or pass -AllowStaleArtifacts"
    }
    [pscustomobject]@{ BuiltFrom = $builtFrom; Head = $head }
}

function Invoke-ElevatedLegs {
    New-Item -ItemType Directory -Force $Output | Out-Null
    $freshness = Get-ArtifactFreshness
    $failed = 0
    $realBefore = Get-RealAppPids
    Assert-NoSmokeRunning
    foreach ($name in $Legs) {
        $report = [ordered]@{ leg = $name; status = 'failed'; startedAt = (Get-Date).ToString('o'); elevatedRun = $true; manifestPort = $ManifestPort }
        $report.appRanElevated = $true
        $source = if ($ViaRunAs) { 'the RunAs child (one UAC prompt, approved by the operator)' } else { 'the already elevated shell' }
        $report.note = "The app inherited the elevated token of $source, so the user-facing UAC prompt on the app's own msiexec was not exercised."
        $report.newMsisBuiltFrom = $freshness.BuiltFrom
        $report.headTreeState = $freshness.Head
        if ($AllowStaleArtifacts) { $report.staleArtifactsAllowed = $true }
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
                'kill' { Invoke-KillLeg $report }
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
# A killed build can leave a worktree whose junctions point into this checkout's node_modules;
# unlink them before anything deletes <WorkDir>.
foreach ($tree in 'new', 'old') { Remove-BuildWorktree (Join-Path $WorkDir $tree) }
if (-not $SkipBuild) { Invoke-Builds }
if ($BuildOnly) {
    Get-ChildItem $ArtifactDir | ForEach-Object { Write-Host ("{0,-22} {1,12:N0} bytes  {2}" -f $_.Name, $_.Length, $_.LastWriteTime) }
    exit 0
}
$needed = @('new-0.0.2.msi')
if (@($Legs | Where-Object { $_ -in 'auto', 'tray', 'click' }).Count -gt 0) { $needed += 'new-0.0.1.msi' }
if ($Legs -contains 'oldhop') { $needed += 'old-0.0.1.msi' }
foreach ($n in $needed) { Assert-True (Test-Path (Join-Path $ArtifactDir $n)) "Artifact $n exists in $ArtifactDir." }
foreach ($name in $Legs) { Remove-Item -LiteralPath (Join-Path $Output "updater-smoke-$name.json") -Force -ErrorAction SilentlyContinue }

try {
    $childArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Leg $Leg -ManifestPort $ManifestPort -OldCommit $OldCommit -Output `"$Output`" -WorkDir `"$WorkDir`" -Elevated -ViaRunAs"
    # Native -File arguments cannot carry -Switch:$false, so the switch is forwarded only when set.
    $staleArg = @(if ($AllowStaleArtifacts) { '-AllowStaleArtifacts' })
    if ($staleArg) { $childArgs += " $staleArg" }
    if ($isAdmin) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Leg $Leg -ManifestPort $ManifestPort -OldCommit $OldCommit -Output $Output -WorkDir $WorkDir -Elevated @staleArg
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
