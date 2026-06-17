[CmdletBinding()]
param(
    [string]$AdapterPath = "ml/temporal-ir/outputs/qwen-temporal-ir-qwen35-08b-bf16-chat-time-range-2687-lora",
    [string]$OutputDir = "dist/local-slm-runtime",
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

$packagePath = Join-Path $outputFullPath $PackageName
if (Test-Path -LiteralPath $packagePath) {
    Remove-Item -LiteralPath $packagePath -Force
}
Compress-Archive -LiteralPath (Join-Path $stagingRoot "ml") -DestinationPath $packagePath -Force
Remove-Item -LiteralPath $stagingRoot -Recurse -Force

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
    packagePath = $packagePath
    packageSizeBytes = $packageInfo.Length
    sha256 = $hash
    downloadUrl = $downloadUrl
}
$manifestPath = Join-Path $outputFullPath "local-slm-runtime-manifest.json"
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

"Package: $packagePath"
"Manifest: $manifestPath"
"SHA256: $hash"
