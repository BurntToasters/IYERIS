#requires -Version 5.1

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'Azure Artifact Signing setup must run on Windows.'
}

if (-not (Get-PackageProvider -Name NuGet -ErrorAction SilentlyContinue)) {
  Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null
}

$minimumVersion = [Version]'0.5.8'
$installed = Get-Module -ListAvailable -Name TrustedSigning |
  Sort-Object Version -Descending |
  Select-Object -First 1

if (-not $installed -or $installed.Version -lt $minimumVersion) {
  Install-Module `
    -Name TrustedSigning `
    -MinimumVersion $minimumVersion `
    -Repository PSGallery `
    -Scope CurrentUser `
    -Force `
    -AllowClobber
}

$installed = Get-Module -ListAvailable -Name TrustedSigning |
  Sort-Object Version -Descending |
  Select-Object -First 1

if (-not $installed -or $installed.Version -lt $minimumVersion) {
  throw "TrustedSigning $minimumVersion or newer was not installed."
}

Write-Host "TrustedSigning $($installed.Version) is ready."
