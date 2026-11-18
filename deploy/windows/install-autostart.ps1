<#
.SYNOPSIS
  Start cc-hub when you log into Windows and keep WSL running in the background.

.DESCRIPTION
  WSL shuts a distro down shortly after its last terminal closes, which would
  kill the hub and every agent. This installs a hidden launcher in your Startup
  folder that runs scripts/start.sh inside WSL and then keeps a long-lived
  process alive so WSL stays up. Optionally stops Windows from sleeping while
  plugged in (agents pause while the machine sleeps).

  Usually run from Ubuntu with ./scripts/windows-autostart.sh, which fills in
  the parameters.

.EXAMPLE
  .\install-autostart.ps1 -Distro Ubuntu -LinuxUser roe -RepoPath /home/roe/cc-hub -NoSleepOnAC
.EXAMPLE
  .\install-autostart.ps1 -Uninstall
#>
param(
  [string]$Distro,
  [string]$LinuxUser,
  [string]$RepoPath,
  [switch]$NoSleepOnAC,
  [switch]$StartNow,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$startup = [Environment]::GetFolderPath('Startup')
$launcher = Join-Path $startup 'cc-hub.vbs'

if ($Uninstall) {
  if (Test-Path $launcher) { Remove-Item $launcher; Write-Host "Removed $launcher" } else { Write-Host 'Autostart was not installed.' }
  Write-Host 'To stop a running hub now: wsl --terminate <distro>  (or ./scripts/stop.sh inside Ubuntu)'
  exit 0
}
if (-not $Distro -or -not $LinuxUser -or -not $RepoPath) {
  throw 'Distro, LinuxUser, and RepoPath are required (run ./scripts/windows-autostart.sh from Ubuntu to fill them in).'
}
foreach ($v in @($Distro, $LinuxUser, $RepoPath)) {
  if ($v -match "[`"'`$;&|<>]") { throw "Unsafe character in parameter: $v" }
}

# Hidden window (0), do not wait (False). 'exec sleep infinity' keeps the distro alive.
$cmd = "wsl.exe -d $Distro -u $LinuxUser -- bash -lc ""cd '$RepoPath' && ./scripts/start.sh >> autostart.log 2>&1; exec sleep infinity"""
$vbs = @"
' cc-hub autostart (installed by deploy/windows/install-autostart.ps1)
Set sh = CreateObject("WScript.Shell")
sh.Run "$($cmd.Replace('"', '""'))", 0, False
"@
Set-Content -Path $launcher -Value $vbs -Encoding ASCII
Write-Host "Installed autostart: $launcher"

if ($NoSleepOnAC) {
  powercfg /change standby-timeout-ac 0
  powercfg /change hibernate-timeout-ac 0
  powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0   # lid close: do nothing (plugged in)
  powercfg /setactive SCHEME_CURRENT
  Write-Host 'Plugged in: Windows will not sleep, and closing the lid does nothing. On battery, your normal settings still apply.'
}

if ($StartNow) {
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$launcher`""
  Write-Host 'Started. Give it ~20 seconds, then open http://localhost:8787'
}
