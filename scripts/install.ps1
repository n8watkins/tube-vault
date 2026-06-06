# TubeVault — Windows (WSL-backed) native messaging registration
# Run once after loading the extension in Chrome to get the extension ID.
# Usage:  .\install.ps1 -ExtensionId <your-chrome-extension-id>
#
# All paths are derived from this script's own location, so there is no
# hardcoded username — it works for any Windows user who clones the repo.

param(
  [Parameter(Mandatory=$true)]
  [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

# repo root = parent of the scripts/ folder this file lives in
$repoRoot     = Split-Path -Parent $PSScriptRoot
$manifestDir  = Join-Path $repoRoot "native-messaging"
$manifestFile = Join-Path $manifestDir "com.tube_vault.helper.json"
$launcher     = Join-Path $repoRoot "scripts\run-helper.bat"
$regPath      = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.tube_vault.helper"

# Patch the launcher path + extension ID into the manifest
$manifest = Get-Content $manifestFile -Raw | ConvertFrom-Json
$manifest.path = $launcher
$manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
$manifest | ConvertTo-Json -Depth 10 | Set-Content $manifestFile -Encoding UTF8

# Register the manifest path in Chrome's native messaging registry key
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(Default)" -Value $manifestFile

Write-Host ""
Write-Host "TubeVault native host registered." -ForegroundColor Green
Write-Host "  Registry : $regPath"
Write-Host "  Manifest : $manifestFile"
Write-Host "  Launcher : $launcher"
Write-Host "  Origin   : chrome-extension://$ExtensionId/"
Write-Host ""
Write-Host "Reload the extension in Chrome and you're good to go."
