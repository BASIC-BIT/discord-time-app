# PowerShell script to check where Tauri store files are saved
# Usage: powershell -ExecutionPolicy Bypass -File scripts/check-store-simple.ps1

Write-Host "Checking Tauri store locations for HammerOverlay..." -ForegroundColor Cyan

# Check common AppData locations
$appId = "com.hammer-overlay.app"
$possibleLocations = @(
    "$env:APPDATA\$appId",
    "$env:LOCALAPPDATA\$appId",
    "$env:APPDATA\hammer-overlay",
    "$env:LOCALAPPDATA\hammer-overlay",
    "$env:APPDATA\HammerOverlay",
    "$env:LOCALAPPDATA\HammerOverlay"
)

Write-Host "`nSearching for store files in common locations:" -ForegroundColor Yellow

foreach ($location in $possibleLocations) {
    Write-Host "`nChecking: $location" -ForegroundColor Gray
    if (Test-Path $location) {
        Write-Host "  Directory exists!" -ForegroundColor Green
        
        # List all files in the directory
        $files = Get-ChildItem -Path $location -Recurse -File 2>$null
        if ($files) {
            Write-Host "  Files found:" -ForegroundColor Green
            foreach ($file in $files) {
                Write-Host "    - $($file.Name)" -ForegroundColor White
                Write-Host "      Size: $($file.Length) bytes" -ForegroundColor Gray
                Write-Host "      Last modified: $($file.LastWriteTime)" -ForegroundColor Gray
                
                # If it's a JSON file, try to read it
                if ($file.Extension -eq ".json") {
                    try {
                        $content = Get-Content $file.FullName -Raw
                        if ($content.Length -lt 200) {
                            Write-Host "      Content: $content" -ForegroundColor DarkGray
                        } else {
                            Write-Host "      Content: (file too large to display)" -ForegroundColor DarkGray
                        }
                    } catch {
                        Write-Host "      Could not read file content" -ForegroundColor Red
                    }
                }
            }
        } else {
            Write-Host "  - Directory is empty" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  Directory does not exist" -ForegroundColor Red
    }
}

Write-Host "`nDone!" -ForegroundColor Cyan