# cc-hub one-command installer for Windows (WSL).
#
#   irm https://raw.githubusercontent.com/Roenan-b/cc-hub/main/install.ps1 | iex
#
# Downloads the repo, then runs deploy/windows/bootstrap.ps1, which does the full
# setup (WSL packages, Postgres, Claude Code, vault, Obsidian, autostart, Tailscale).
# Forks: set $env:CCHUB_REPO = "<you>/cc-hub" first. Re-run any time to update.
$ErrorActionPreference = 'Stop'
$repo = if ($env:CCHUB_REPO) { $env:CCHUB_REPO } else { 'Roenan-b/cc-hub' }
$ref  = if ($env:CCHUB_REF)  { $env:CCHUB_REF }  else { 'main' }
if ($repo -notmatch '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$' -or $ref -notmatch '^[A-Za-z0-9._/-]+$') { throw 'Invalid CCHUB_REPO or CCHUB_REF' }

$dir = Join-Path $env:TEMP 'cc-hub-src'
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $dir | Out-Null
$zip = Join-Path $dir 'src.zip'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Write-Host "Downloading $repo@$ref ..."
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$repo/archive/refs/heads/$ref.zip" -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $dir
$bootstrap = Get-ChildItem $dir -Recurse -Filter bootstrap.ps1 | Select-Object -First 1
if (-not $bootstrap) { throw "deploy/windows/bootstrap.ps1 not found in $repo@$ref" }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $bootstrap.FullName
