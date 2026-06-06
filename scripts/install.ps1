# TubeVault — Windows native messaging registration
# Run once after loading the extension in Chrome to get the extension ID.
# Usage: .\install.ps1 -ExtensionId <your-chrome-extension-id>

param(
  [Parameter(Mandatory=$true)]
  [string]$ExtensionId
)

$manifestDir  = "C:\Users\natha\Projects\Tools\tube-vault\native-messaging"
$manifestFile = Join-Path $manifestDir "com.tube_vault.helper.json"
$regPath      = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.tube_vault.helper"

# Patch the extension ID into the manifest
$manifest = Get-Content $manifestFile -Raw | ConvertFrom-Json
$manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
$manifest | ConvertTo-Json -Depth 10 | Set-Content $manifestFile -Encoding UTF8

# Register the manifest path in Chrome's native messaging registry key
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(Default)" -Value $manifestFile

Write-Host ""
Write-Host "TubeVault native host registered." -ForegroundColor Green
Write-Host "  Registry : $regPath"
Write-Host "  Manifest : $manifestFile"
Write-Host "  Origin   : chrome-extension://$ExtensionId/"
Write-Host ""
Write-Host "Reload the extension in Chrome and you're good to go."
