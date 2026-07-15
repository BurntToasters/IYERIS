#requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'Azure Artifact Signing must run on Windows.'
}

$requiredVariables = @(
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_ARTIFACT_SIGNING_ENDPOINT',
  'AZURE_ARTIFACT_SIGNING_ACCOUNT',
  'AZURE_ARTIFACT_SIGNING_PROFILE',
  'AZURE_ARTIFACT_SIGNING_PUBLISHER'
)

$missingVariables = @(
  $requiredVariables | Where-Object {
    [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_))
  }
)

if ($missingVariables.Count -gt 0) {
  throw "Missing Azure Artifact Signing environment variables: $($missingVariables -join ', ')"
}

$resolvedFile = (Resolve-Path -LiteralPath $FilePath).Path
$extension = [IO.Path]::GetExtension($resolvedFile).ToLowerInvariant()
if ($extension -in @('.appx', '.msix', '.appxbundle', '.msixbundle')) {
  throw "Microsoft Store package signing is intentionally excluded: $resolvedFile"
}

$minimumVersion = [Version]'0.5.8'
$module = Get-Module -ListAvailable -Name TrustedSigning |
  Where-Object { $_.Version -ge $minimumVersion } |
  Sort-Object Version -Descending |
  Select-Object -First 1

if (-not $module) {
  throw 'TrustedSigning 0.5.8 or newer is required. Run npm run setup:win:artifact-signing first.'
}

Import-Module $module.Path -Force

$signingParameters = @{
  Endpoint = $env:AZURE_ARTIFACT_SIGNING_ENDPOINT.Trim()
  CodeSigningAccountName = $env:AZURE_ARTIFACT_SIGNING_ACCOUNT.Trim()
  CertificateProfileName = $env:AZURE_ARTIFACT_SIGNING_PROFILE.Trim()
  Files = @($resolvedFile)
  FileDigest = 'SHA256'
  TimestampRfc3161 = 'http://timestamp.acs.microsoft.com'
  TimestampDigest = 'SHA256'
}

Write-Host "Artifact Signing: $resolvedFile"
Invoke-TrustedSigning @signingParameters

$signature = Get-AuthenticodeSignature -LiteralPath $resolvedFile
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "Authenticode verification failed for $resolvedFile: $($signature.Status) $($signature.StatusMessage)"
}
if (-not $signature.SignerCertificate) {
  throw "No Authenticode signer certificate was found for $resolvedFile"
}

$actualPublisher = $signature.SignerCertificate.GetNameInfo(
  [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
  $false
)
$expectedPublisher = $env:AZURE_ARTIFACT_SIGNING_PUBLISHER.Trim()
if ($actualPublisher -ne $expectedPublisher) {
  throw "Unexpected Authenticode publisher for $resolvedFile. Expected '$expectedPublisher', got '$actualPublisher'."
}
if (-not $signature.TimeStamperCertificate) {
  throw "The Authenticode signature is missing its RFC3161 timestamp: $resolvedFile"
}

Write-Host "Verified Authenticode signature: $actualPublisher ($resolvedFile)"
