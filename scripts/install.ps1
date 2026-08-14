# Paseo install script (Windows)
#
# Usage:
#   irm https://github.com/kevenhu001-cyber/paseo/releases/latest/download/install.ps1 | iex
#
# Environment override:
#   PASEO_REPO  GitHub repository to install from (default: kevenhu001-cyber/paseo)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = if ($env:PASEO_REPO) { $env:PASEO_REPO } else { 'kevenhu001-cyber/paseo' }

Write-Host 'Resolving the latest Paseo release...'
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'paseo-install' }
$version = $release.tag_name.TrimStart('v')

$nativeArch = $env:PROCESSOR_ARCHITECTURE
if ($nativeArch -eq 'x86' -and $env:PROCESSOR_ARCHITEW6432) {
  $nativeArch = $env:PROCESSOR_ARCHITEW6432
}
$arch = switch ($nativeArch) {
  'ARM64' { 'arm64' }
  default { 'x64' }
}

$assetName = "Paseo-Setup-$version-$arch.exe"
$asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
if (-not $asset) {
  $assetName = "Paseo-Setup-$version.exe"
  $asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
}
if (-not $asset) {
  throw "Could not find a Windows installer for Paseo $version"
}

$installer = Join-Path $env:TEMP $assetName
Write-Host "Downloading $assetName ..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer

Write-Host "Installing Paseo $version ..."
$process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
if ($process.ExitCode -ne 0) {
  throw "The Paseo installer failed with exit code $($process.ExitCode)"
}
Write-Host "Paseo $version installed."
