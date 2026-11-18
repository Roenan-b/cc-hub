#!/usr/bin/env bash
# Run from Ubuntu on WSL: installs the Windows autostart launcher for this repo.
#   ./scripts/windows-autostart.sh                  install and start now
#   ./scripts/windows-autostart.sh --no-sleep-on-ac also keep Windows awake while plugged in
#   ./scripts/windows-autostart.sh --uninstall
set -euo pipefail
cd "$(dirname "$0")/.."
grep -qi microsoft /proc/version || { echo "This is for WSL. On Linux, install.sh sets up the systemd service (docs/SETUP-LINUX.md)."; exit 1; }
[ -n "${WSL_DISTRO_NAME:-}" ] || { echo "WSL_DISTRO_NAME is not set; run this from a WSL terminal."; exit 1; }

ps1=$(wslpath -w "$PWD/deploy/windows/install-autostart.ps1")
args=(-NoProfile -ExecutionPolicy Bypass -File "$ps1")
case "${1:-}" in
  --uninstall) args+=(-Uninstall) ;;
  --no-sleep-on-ac) args+=(-Distro "$WSL_DISTRO_NAME" -LinuxUser "$USER" -RepoPath "$PWD" -NoSleepOnAC -StartNow) ;;
  "") args+=(-Distro "$WSL_DISTRO_NAME" -LinuxUser "$USER" -RepoPath "$PWD" -StartNow) ;;
  *) echo "unknown option $1"; exit 2 ;;
esac
powershell.exe "${args[@]}"
