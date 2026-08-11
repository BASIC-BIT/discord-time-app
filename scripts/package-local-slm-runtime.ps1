[CmdletBinding()]
param(
    [string]$AdapterPath = "ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-clock-choice-v19-prefix-ambiguity-balanced-lora",
    [string]$OutputDir = "artifacts/local-slm-runtime",
    [string]$PackageName = "",
    [string]$DownloadBaseUrl = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$adapterFullPath = if ([System.IO.Path]::IsPathRooted($AdapterPath)) {
    (Resolve-Path -LiteralPath $AdapterPath).Path
} else {
    (Resolve-Path -LiteralPath (Join-Path $repoRoot $AdapterPath)).Path
}
$adapterName = Split-Path -Leaf $adapterFullPath
if ($PackageName.Trim().Length -eq 0) {
    $PackageName = "$adapterName.zip"
}

$outputFullPath = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    $OutputDir
} else {
    Join-Path $repoRoot $OutputDir
}
New-Item -ItemType Directory -Force -Path $outputFullPath | Out-Null

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hammeroverlay-local-slm-package-$([System.Guid]::NewGuid().ToString('N'))"
$stagedAdapter = Join-Path $stagingRoot "ml\temporal-ir\outputs\$adapterName"
New-Item -ItemType Directory -Force -Path $stagedAdapter | Out-Null
$adapterItems = @(Get-ChildItem -LiteralPath $adapterFullPath -Force)
if ($adapterItems.Count -eq 0) {
    throw "Adapter directory is empty: $adapterFullPath"
}
Copy-Item -LiteralPath $adapterItems.FullName -Destination $stagedAdapter -Recurse -Force

# Compress-Archive records entry timestamps. Normalize the disposable staging
# tree so repackaging identical adapter contents produces the same release hash.
$normalizedTimestamp = [DateTime]::SpecifyKind([DateTime]::Parse("2000-01-01T00:00:00"), [DateTimeKind]::Utc)
Get-ChildItem -LiteralPath $stagingRoot -Recurse -Force | ForEach-Object {
    $_.LastWriteTimeUtc = $normalizedTimestamp
}
(Get-Item -LiteralPath (Join-Path $stagingRoot "ml")).LastWriteTimeUtc = $normalizedTimestamp

$packagePath = Join-Path $outputFullPath $PackageName
if (Test-Path -LiteralPath $packagePath) {
    Remove-Item -LiteralPath $packagePath -Force
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$packageStream = [System.IO.File]::Open(
    $packagePath,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
)
try {
    $archive = New-Object System.IO.Compression.ZipArchive(
        $packageStream,
        [System.IO.Compression.ZipArchiveMode]::Create,
        $false
    )
    try {
        foreach ($file in @(Get-ChildItem -LiteralPath $stagingRoot -Recurse -File | Sort-Object FullName)) {
            $entryName = $file.FullName.Substring($stagingRoot.Length).TrimStart("\").Replace("\", "/")
            $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = [DateTimeOffset]$normalizedTimestamp
            $entryStream = $entry.Open()
            $fileStream = [System.IO.File]::OpenRead($file.FullName)
            try {
                $fileStream.CopyTo($entryStream)
            }
            finally {
                $fileStream.Dispose()
                $entryStream.Dispose()
            }
        }
    }
    finally {
        $archive.Dispose()
    }
}
finally {
    $packageStream.Dispose()
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}

$packageInfo = Get-Item -LiteralPath $packagePath
if ($packageInfo.Length -lt 1MB) {
    throw "Packaged adapter is unexpectedly small: $($packageInfo.Length) bytes"
}
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $packagePath).Hash.ToLowerInvariant()
$downloadUrl = if ($DownloadBaseUrl.Trim().Length -gt 0) {
    "$($DownloadBaseUrl.TrimEnd('/'))/$PackageName"
} else {
    ""
}

$manifest = [ordered]@{
    adapterName = $adapterName
    adapterPath = "ml/temporal-ir/outputs/$adapterName"
    packageName = $PackageName
    packagePath = $PackageName
    packageSizeBytes = $packageInfo.Length
    sha256 = $hash
    downloadUrl = $downloadUrl
}
$manifestPath = Join-Path $outputFullPath "local-slm-runtime-manifest.json"
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

"Package: $packagePath"
"Manifest: $manifestPath"
"SHA256: $hash"
