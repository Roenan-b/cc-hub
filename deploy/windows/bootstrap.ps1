<#
.SYNOPSIS
  One-command cc-hub setup on Windows + WSL.

.DESCRIPTION
  Run from PowerShell (not as admin). It:
    1. Checks WSL and picks your Ubuntu distro
    2. Copies cc-hub into your WSL home (~/cc-hub), keeping an existing .env
    3. Runs scripts/setup.sh inside WSL (packages, Postgres, Claude Code, .env, vault)
       and restarts WSL once if systemd had to be enabled
    4. Opens Claude Code for /login if it is not logged in yet
    5. Installs autostart at Windows login (keeps WSL running) and starts the hub
    6. Installs Obsidian, registers the vault, and opens it
    7. Optionally sets up Tailscale for phone access
    8. Opens the dashboard with the admin token on your clipboard

  Re-running is safe: every step skips what is already done.

.EXAMPLE
  # From the folder the zip was extracted to:
  powershell -ExecutionPolicy Bypass -File .\cc-hub\deploy\windows\bootstrap.ps1
#>
param(
  [string]$Distro,                    # default: your default WSL distro, preferring Ubuntu
  [string]$Roots,                     # Linux dirs agents may use; default: your WSL home
  [string]$VaultPath,                 # Windows path; default: Documents\Vault
  [switch]$NoSleepSettings,           # leave Windows power settings alone
  [ValidateSet('ask', 'yes', 'no')][string]$Tailscale = 'ask',
  [switch]$SkipObsidian
)
$ErrorActionPreference = 'Stop'
function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "   ok: $t" -ForegroundColor Green }
function Note($t) { Write-Host "   $t" -ForegroundColor Yellow }
function Wsl([string]$cmd, [switch]$Interactive) {
  # Run a bash command in the distro as the default user. --exec passes argv
  # straight to bash (no second parse by the login shell). Commands built here
  # never contain double quotes, so Windows argument quoting stays simple.
  if ($cmd.Contains('"')) { throw "internal: double quote in WSL command: $cmd" }
  if ($Interactive) {
    # Start-Process keeps the console attached so sudo prompts and the Claude TUI work.
    $p = Start-Process -FilePath 'wsl.exe' -ArgumentList "-d $Distro --exec bash -lc `"$cmd`"" -NoNewWindow -Wait -PassThru
    return $p.ExitCode
  }
  $out = & wsl.exe -d $Distro --exec bash -lc $cmd 2>&1
  if ($LASTEXITCODE -ne 0) { throw "WSL command failed ($LASTEXITCODE): $cmd`n$out" }
  return ($out | Out-String).Trim()
}
function Quote-Bash([string]$s) { "'" + $s.Replace("'", "'\''") + "'" }

$Src = Resolve-Path (Join-Path $PSScriptRoot '..\..')   # the extracted cc-hub folder

# ---------------------------------------------------------------- 1. WSL
Step 'WSL'
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw 'WSL is not available. Run "wsl --install" in an admin PowerShell, reboot, then run this again.' }
$distros = @((& wsl.exe -l -q 2>$null) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($LASTEXITCODE -ne 0 -or -not $distros) {
  Note 'No Linux distro installed. Installing Ubuntu (you will create a Linux username and password).'
  & wsl.exe --install -d Ubuntu
  Note 'When Ubuntu finishes setting up (you may need to reboot), run this script again.'
  exit 1
}
if (-not $Distro) {
  $Distro = ($distros | Where-Object { $_ -like 'Ubuntu*' } | Select-Object -First 1)
  if (-not $Distro) { $Distro = $distros[0] }
}
$wslUser = Wsl 'whoami'
$wslHome = Wsl 'echo $HOME'
if ($wslUser -eq 'root') { throw "The default user in $Distro is root. Create a normal user first (see https://learn.microsoft.com/windows/wsl/setup/environment)." }
Ok "$Distro as $wslUser"

# ---------------------------------------------------------------- 2. Copy files
Step 'Copy cc-hub into WSL'
# Stop a running hub (not the agent sessions) so the new code is what starts.
Wsl "if [ -x ~/cc-hub/scripts/stop.sh ]; then cd ~/cc-hub && ./scripts/stop.sh >/dev/null 2>&1; fi; true" | Out-Null
$srcLinux = Wsl ("wslpath -a " + (Quote-Bash $Src.Path))
$dest = "$wslHome/cc-hub"
Wsl ("mkdir -p $(Quote-Bash $dest) && cp -r " + (Quote-Bash "$srcLinux/.") + " " + (Quote-Bash $dest) + "/ && cd $(Quote-Bash $dest) && " +
     "find . -path ./node_modules -prune -o -path ./.git -prune -o -type f -exec chmod 644 {} + && " +
     "chmod 755 scripts/*.sh test/fake-claude test/fake-claude.mjs && find . -path ./node_modules -prune -o -type d -exec chmod 755 {} +") | Out-Null
Ok "files in $dest (existing .env, if any, kept)"

# ---------------------------------------------------------------- 3. Linux setup
Step 'Linux setup (you may be asked for your Ubuntu sudo password)'
if (-not $VaultPath) { $VaultPath = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Vault' }
New-Item -ItemType Directory -Force -Path $VaultPath | Out-Null
$vaultLinux = Wsl ("wslpath -a " + (Quote-Bash $VaultPath))
if (-not $Roots) {
  $answer = Read-Host "   Folders agents may work in, inside WSL (colon-separated) [$wslHome]"
  $Roots = if ($answer) { $answer } else { $wslHome }
}
$envs = "CCHUB_NONINTERACTIVE=1 CCHUB_ROOTS=$(Quote-Bash $Roots) CCHUB_VAULT=$(Quote-Bash $vaultLinux)"
$code = Wsl "cd $(Quote-Bash $dest) && $envs ./scripts/setup.sh" -Interactive
if ($code -eq 10) {
  Note 'Restarting WSL once so systemd (and Postgres at boot) take effect...'
  & wsl.exe --shutdown; Start-Sleep -Seconds 8
  $code = Wsl "cd $(Quote-Bash $dest) && $envs ./scripts/setup.sh" -Interactive
}
if ($code -ne 0 -and $code -ne 10) { throw "setup.sh failed with exit code $code. Fix the error above and run this script again." }
Ok 'Linux setup complete'

# ---------------------------------------------------------------- 4. Claude login
Step 'Claude Code login'
$loggedIn = (Wsl 'test -e ~/.claude/.credentials.json && echo yes || echo no') -eq 'yes'
if (-not $loggedIn) {
  Note 'Claude Code will open here. Type /login, finish signing in in your browser, then type /exit.'
  Read-Host '   Press Enter to open Claude Code'
  Wsl 'export PATH=$HOME/.local/bin:$PATH; cd ~ && claude' -Interactive | Out-Null
}
Ok 'Claude Code ready'

# ---------------------------------------------------------------- 5. Autostart + start
Step 'Autostart and start the hub'
$autostart = Join-Path $Src 'deploy\windows\install-autostart.ps1'
$asArgs = @{ Distro = $Distro; LinuxUser = $wslUser; RepoPath = $dest; StartNow = $true }
if (-not $NoSleepSettings) { $asArgs.NoSleepOnAC = $true }
& $autostart @asArgs
$healthy = $false
foreach ($i in 1..45) {
  try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:8787/healthz).StatusCode -eq 200) { $healthy = $true; break } } catch {}
  Start-Sleep -Seconds 2
}
if ($healthy) { Ok 'hub running at http://localhost:8787' }
else { Note "Hub did not answer yet. Check:  wsl -d $Distro -- tail -50 ~/cc-hub/hub.log  and  ~/cc-hub/autostart.log" }

# ---------------------------------------------------------------- 6. Obsidian
if (-not $SkipObsidian) {
  Step 'Obsidian'
  $obsExe = Join-Path $env:LOCALAPPDATA 'Programs\Obsidian\Obsidian.exe'
  if (-not (Test-Path $obsExe)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      winget install -e --id Obsidian.Obsidian --accept-package-agreements --accept-source-agreements --silent | Out-Null
    } else { Note 'winget not found; install Obsidian from https://obsidian.md' }
  }
  # Register the vault so Obsidian opens it directly (only while Obsidian is closed,
  # since Obsidian rewrites this file on exit).
  $cfgDir = Join-Path $env:APPDATA 'obsidian'
  $cfgFile = Join-Path $cfgDir 'obsidian.json'
  if (-not (Get-Process -Name Obsidian -ErrorAction SilentlyContinue)) {
    New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
    $cfg = if (Test-Path $cfgFile) { Get-Content $cfgFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{ vaults = [pscustomobject]@{} } }
    if (-not $cfg.PSObject.Properties['vaults']) { $cfg | Add-Member -NotePropertyName vaults -NotePropertyValue ([pscustomobject]@{}) }
    $known = $cfg.vaults.PSObject.Properties | Where-Object { $_.Value.path -eq $VaultPath }
    foreach ($v in $cfg.vaults.PSObject.Properties) { $v.Value | Add-Member -Force -NotePropertyName open -NotePropertyValue $false }
    if ($known) { $known.Value.open = $true }
    else {
      $id = -join ((1..16) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
      $cfg.vaults | Add-Member -NotePropertyName $id -NotePropertyValue ([pscustomobject]@{
        path = $VaultPath; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); open = $true })
    }
    # UTF-8 without BOM (Windows PowerShell's -Encoding UTF8 adds one).
    [IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))
    Ok "vault registered: $VaultPath"
  } else { Note "Obsidian is open; use 'Open folder as vault' and pick $VaultPath" }
  if (Test-Path $obsExe) { Start-Process $obsExe; Ok 'Obsidian opened' }
}

# ---------------------------------------------------------------- 7. Phone access
Step 'Phone access (Tailscale)'
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
$doTs = $Tailscale
if ($doTs -eq 'ask') { $doTs = if ((Read-Host '   Set up phone access with Tailscale now? [Y/n]') -match '^[Nn]') { 'no' } else { 'yes' } }
if ($doTs -eq 'yes') {
  if (-not (Test-Path $ts)) {
    winget install -e --id Tailscale.Tailscale --accept-package-agreements --accept-source-agreements --silent | Out-Null
    Start-Sleep -Seconds 5
  }
  if (Test-Path $ts) {
    $state = (& $ts status --json 2>$null | ConvertFrom-Json -ErrorAction SilentlyContinue)
    if (-not $state -or $state.BackendState -ne 'Running') {
      Note 'A browser window will open to sign in to Tailscale.'
      & $ts up
      $state = (& $ts status --json | ConvertFrom-Json)
    }
    & $ts serve --bg 8787   # first time, this may print a link to enable Serve for your tailnet
    $dns = $state.Self.DNSName.TrimEnd('.')
    $phoneUrl = "https://$dns"
    Ok "tailnet URL: $phoneUrl"
    Note 'Install Tailscale on your phone, sign in with the same account, then open that URL.'
  } else { Note 'Tailscale install did not finish; install it from https://tailscale.com/download and run: tailscale serve --bg 8787' }
} else { Note 'Skipped. Later: install Tailscale, then run  tailscale serve --bg 8787' }

# ---------------------------------------------------------------- 8. Finish
Step 'Done'
$token = Wsl "grep -E '^HUB_UI_TOKEN=' $(Quote-Bash "$dest/.env") | cut -d= -f2-"
$observer = Wsl "grep -E '^HUB_OBSERVER_TOKEN=' $(Quote-Bash "$dest/.env") | cut -d= -f2-"
Set-Clipboard -Value $token
$desktop = [Environment]::GetFolderPath('Desktop')
Set-Content -Path (Join-Path $desktop 'cc-hub.url') -Value "[InternetShortcut]`r`nURL=http://localhost:8787/`r`n"
Write-Host ''
Write-Host '   Dashboard:       http://localhost:8787   (shortcut on your Desktop)'
if ($phoneUrl) { Write-Host "   Phone:           $phoneUrl" }
Write-Host "   Vault:           $VaultPath"
Write-Host "   Admin token:     copied to clipboard (also in ~/cc-hub/.env inside WSL)"
Write-Host "   Observer token:  $observer   (read-only, safe to share)"
Write-Host '   The hub starts when you log into Windows. It pauses while the laptop sleeps or is off and resumes on its own.'
if ($healthy) { Start-Process 'http://localhost:8787' }
