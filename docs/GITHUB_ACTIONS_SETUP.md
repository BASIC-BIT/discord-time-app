# GitHub Actions CI/CD Setup

## Overview

This repository includes two GitHub Actions workflows for automated building, testing, and releasing:

1. **`.github/workflows/build.yml`** - Development builds and testing
2. **`.github/workflows/release.yml`** - Production releases with code signing

## 🚀 Quick Start

### For Development
- Push to `main` or create a pull request → Automatic build and test
- Download test artifacts from the Actions tab

### For Releases
1. Create a new release tag: `git tag v1.0.0 && git push origin v1.0.0`
2. GitHub Actions will automatically build, sign, and create a release
3. Users can download the signed MSI and auto-updater will work

## 📋 Required Secrets

Set these in your repository settings under **Settings > Secrets and variables > Actions**:

### Essential Secrets

| Secret Name | Description | Required |
|-------------|-------------|----------|
| `TAURI_PRIVATE_KEY` | Private key for update signing | ✅ Yes |
| `TAURI_KEY_PASSWORD` | Password for the private key | ✅ Yes |

### Code Signing Secrets (Optional but Recommended)

| Secret Name | Description | Required |
|-------------|-------------|----------|
| `WINDOWS_CERTIFICATE` | Base64-encoded .p12 certificate | 🔶 Optional |
| `WINDOWS_CERTIFICATE_PASSWORD` | Certificate password | 🔶 Optional |

## 🔐 Setting Up Secrets

### 1. Generate Tauri Update Signing Keys

```bash
# Generate a new private key
npm install -g @tauri-apps/cli
tauri signer generate -w ~/.tauri/

# This creates:
# - Private key: ~/.tauri/myapp.key
# - Public key: ~/.tauri/myapp.pub
```

**Set GitHub Secrets:**
- `TAURI_PRIVATE_KEY`: Content of the `.key` file
- `TAURI_KEY_PASSWORD`: Password you set during generation

### 2. Code Signing Certificate (Optional)

For professional Windows releases without SmartScreen warnings:

#### Option A: Purchase from Certificate Authority
1. Buy a code signing certificate from DigiCert, Sectigo, etc.
2. Export as `.p12` file with password
3. Convert to base64: `base64 -i certificate.p12 -o certificate.b64`

#### Option B: Self-Signed (Development Only)
```powershell
# Create self-signed certificate (Windows)
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=HammerOverlay" -KeyAlgorithm RSA -KeyLength 2048 -Provider "Microsoft Enhanced RSA and AES Cryptographic Provider" -KeyExportPolicy Exportable -KeyUsage DigitalSignature -ValidityPeriod Years -ValidityPeriodUnits 3

# Export to PFX
$password = ConvertTo-SecureString -String "YourPassword" -Force -AsPlainText
Export-PfxCertificate -cert $cert -FilePath "certificate.p12" -Password $password

# Convert to base64
[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.p12")) > certificate.b64
```

**Set GitHub Secrets:**
- `WINDOWS_CERTIFICATE`: Content of the `.b64` file
- `WINDOWS_CERTIFICATE_PASSWORD`: Certificate password

## 📦 Release Process

### Automatic Release (Recommended)

1. **Update version in code:**
   ```bash
   # The workflow will auto-update these, but you can do it manually:
   npm version 1.0.0  # Updates package.json
   # Update src-tauri/Cargo.toml version = "1.0.0"
   # Update src-tauri/tauri.conf.json version: "1.0.0"
   ```

2. **Create and push tag:**
   ```bash
   git add -A
   git commit -m "Release v1.0.0"
   git tag v1.0.0
   git push origin main
   git push origin v1.0.0
   ```

3. **Workflow automatically:**
   - Updates version numbers
   - Builds the application
   - Signs the MSI (if certificate available)
   - Creates GitHub release with changelog
   - Uploads MSI installer
   - Generates and uploads update manifest

### Manual Release

Trigger manually from GitHub Actions tab:
1. Go to Actions → Build and Release
2. Click "Run workflow"
3. Enter version (e.g., `v1.0.0`)
4. Click "Run workflow"

## 🔄 Update Manifest

The workflow automatically generates `latest.json` with this format:

```json
{
  "version": "1.0.0",
  "notes": "Release v1.0.0",
  "pub_date": "2024-01-15T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "base64-signature-here",
      "url": "https://github.com/BASIC-BIT/discord-time-app/releases/download/v1.0.0/HammerOverlay_1.0.0_x64_en-US.msi"
    }
  }
}
```

## 🛠️ Workflow Features

### Development Build (`.github/workflows/build.yml`)

**Triggers:**
- Push to `main` branch
- Pull requests to `main` branch

**Actions:**
- ✅ Install dependencies
- ✅ Run frontend tests
- ✅ Check TypeScript compilation
- ✅ Run Rust tests and linting
- ✅ Build debug version
- ✅ Upload build artifacts (7-day retention)

### Production Release (`.github/workflows/release.yml`)

**Triggers:**
- Push tags matching `v*` (e.g., `v1.0.0`)
- Manual workflow dispatch

**Actions:**
- ✅ Update version numbers automatically
- ✅ Build production version
- ✅ Code sign MSI (if certificate available)
- ✅ Generate update manifest with signatures
- ✅ Create GitHub release with changelog
- ✅ Upload MSI installer and update manifest

## 🐛 Troubleshooting

### Build Failures

**"No MSI file found"**
- Check if Tauri build completed successfully
- Verify all dependencies are installed
- Check for Rust compilation errors

**"Failed to sign MSI"**
- Verify certificate secrets are set correctly
- Check certificate is valid and not expired
- Ensure certificate password is correct

**"Permission denied"**
- Verify repository has `contents: write` permission
- Check `GITHUB_TOKEN` has necessary permissions
- Ensure you're pushing to the correct repository

### Update System Issues

**"Update check failed"**
- Verify update manifest URL is accessible
- Check JSON format is valid
- Ensure signature matches the binary

**"Failed to download update"**
- Check GitHub release assets are public
- Verify MSI file was uploaded correctly
- Check internet connectivity

## 📊 Monitoring Releases

### GitHub Actions Dashboard
- View build status: `https://github.com/BASIC-BIT/discord-time-app/actions`
- Download artifacts from failed builds for debugging
- Check logs for detailed error messages

### Release Metrics
- Monitor download counts on GitHub Releases
- Track update adoption through logs
- Watch for user-reported issues with new versions

## 🔒 Security Best Practices

1. **Secrets Management:**
   - Never commit secrets to the repository
   - Rotate signing keys periodically
   - Use repository secrets, not environment secrets

2. **Code Signing:**
   - Always use proper certificates for public releases
   - Timestamp signatures for long-term validity
   - Test signed binaries on fresh Windows systems

3. **Release Process:**
   - Review changes before creating tags
   - Test updates in staging environment
   - Monitor for security vulnerabilities in dependencies

## 📈 Next Steps

### Enhanced CI/CD
- [ ] Add macOS and Linux builds
- [ ] Implement beta/stable release channels
- [ ] Add automated security scanning
- [ ] Set up staging environment

### Advanced Features
- [ ] Delta updates for smaller downloads
- [ ] Rollback capability
- [ ] Telemetry for update success rates
- [ ] Automated dependency updates

---

**Status**: ✅ **CI/CD Implementation Complete**
**Next**: Configure repository secrets and create your first release! 