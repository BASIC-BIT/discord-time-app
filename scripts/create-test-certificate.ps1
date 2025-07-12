# Create Test Code Signing Certificate
# WARNING: This is for TESTING ONLY - not for public distribution!

Write-Host "Creating test code signing certificate for HammerOverlay..." -ForegroundColor Green

try {
    # Create self-signed certificate
    Write-Host "Step 1: Creating self-signed certificate..." -ForegroundColor Yellow
    
    # Calculate expiry date (3 years from now)
    $expiryDate = (Get-Date).AddYears(3)
    
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject "CN=HammerOverlay Test Certificate" `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -Provider "Microsoft Enhanced RSA and AES Cryptographic Provider" `
        -KeyExportPolicy Exportable `
        -KeyUsage DigitalSignature `
        -NotAfter $expiryDate

    Write-Host "Certificate created with thumbprint: $($cert.Thumbprint)" -ForegroundColor Green
    Write-Host "Certificate expires: $($cert.NotAfter)" -ForegroundColor Green

    # Set password for export
    $password = ConvertTo-SecureString -String "TestPassword123!" -Force -AsPlainText
    $pfxPath = ".\test-certificate.p12"
    $fullPfxPath = (Resolve-Path $pfxPath -ErrorAction SilentlyContinue).Path

    # Export to PFX with error handling
    Write-Host "Step 2: Exporting certificate to PFX..." -ForegroundColor Yellow
    try {
        Export-PfxCertificate -cert $cert -FilePath $pfxPath -Password $password -ErrorAction Stop
        Write-Host "Certificate exported to: $pfxPath" -ForegroundColor Green
        # Update the full path after export
        $fullPfxPath = (Resolve-Path $pfxPath).Path
    }
    catch {
        Write-Host "Export-PfxCertificate failed. Trying alternative method..." -ForegroundColor Yellow
        
        # Alternative method using certlm.msc store
        $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("My", "CurrentUser")
        $store.Open("ReadWrite")
        $store.Add($cert)
        $store.Close()
        
        # Export using .NET classes
        $pfxBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, "TestPassword123!")
        [System.IO.File]::WriteAllBytes($pfxPath, $pfxBytes)
        Write-Host "Certificate exported using alternative method: $pfxPath" -ForegroundColor Green
        # Update the full path after export
        $fullPfxPath = (Resolve-Path $pfxPath).Path
    }

    # Verify file exists before proceeding
    if (Test-Path $pfxPath) {
        Write-Host "Step 3: Converting to base64..." -ForegroundColor Yellow
        Write-Host "Reading certificate from: $fullPfxPath" -ForegroundColor Gray
        
        # Convert to base64 using the full path
        $base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($fullPfxPath))
        $base64 | Out-File "test-certificate.b64" -Encoding UTF8
        
        Write-Host "Base64 encoded certificate saved to: test-certificate.b64" -ForegroundColor Green
        Write-Host ""
        Write-Host "=== GitHub Secrets Configuration ===" -ForegroundColor Cyan
        Write-Host "Add these secrets to your GitHub repository:" -ForegroundColor White
        Write-Host ""
        Write-Host "Secret Name: WINDOWS_CERTIFICATE" -ForegroundColor Yellow
        Write-Host "Secret Value:" -ForegroundColor Yellow
        Get-Content "test-certificate.b64" -Raw
        Write-Host ""
        Write-Host "Secret Name: WINDOWS_CERTIFICATE_PASSWORD" -ForegroundColor Yellow  
        Write-Host "Secret Value: TestPassword123!" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "=== Setup Instructions ===" -ForegroundColor Cyan
        Write-Host "1. Go to your GitHub repository" -ForegroundColor White
        Write-Host "2. Navigate to Settings > Secrets and variables > Actions" -ForegroundColor White
        Write-Host "3. Click 'New repository secret'" -ForegroundColor White
        Write-Host "4. Add the WINDOWS_CERTIFICATE secret with the base64 content above" -ForegroundColor White
        Write-Host "5. Add the WINDOWS_CERTIFICATE_PASSWORD secret with value: TestPassword123!" -ForegroundColor White
        Write-Host ""
        Write-Host "⚠️  WARNING: This is a TEST certificate only!" -ForegroundColor Red
        Write-Host "   Users will still see security warnings." -ForegroundColor Red
        Write-Host "   Use a commercial certificate for production releases." -ForegroundColor Red
        
        # Clean up PFX file (keep base64 for reference)
        Write-Host ""
        Write-Host "Cleaning up temporary files..." -ForegroundColor Yellow
        Remove-Item $pfxPath -ErrorAction SilentlyContinue
        Write-Host "Setup complete! The base64 certificate file has been saved for your reference." -ForegroundColor Green
        
    } else {
        Write-Host "ERROR: Certificate file was not created successfully." -ForegroundColor Red
        Write-Host "Please run this script as Administrator and try again." -ForegroundColor Red
        exit 1
    }
    
} catch {
    Write-Host "ERROR: Failed to create certificate: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Please run this script as Administrator and try again." -ForegroundColor Red
    exit 1
} 