#!/usr/bin/env bash
# cc-hub one-command installer for Ubuntu/Debian, including inside WSL.
#
#   curl -fsSL https://raw.githubusercontent.com/Roenan-b/cc-hub/main/install.sh | bash
#
# Clones (or updates) ~/cc-hub, runs scripts/setup.sh, logs in Claude Code if
# needed, starts the hub, and on WSL installs the Windows autostart.
# Forks: CCHUB_REPO=<you>/cc-hub. Install location: CCHUB_DIR (default ~/cc-hub).
set -euo pipefail
REPO="${CCHUB_REPO:-Roenan-b/cc-hub}"
DIR="${CCHUB_DIR:-$HOME/cc-hub}"
[[ "$REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || { echo "invalid CCHUB_REPO"; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo "Run as your normal user, not root."; exit 1; }
# Prompts must read from the terminal, not from this piped script.
exec </dev/tty

command -v git >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq git; }
if [ -d "$DIR/.git" ]; then
  echo "Updating $DIR"; git -C "$DIR" pull --ff-only
else
  echo "Cloning $REPO into $DIR"; git clone -q "https://github.com/$REPO.git" "$DIR"
fi
cd "$DIR"

set +e; ./scripts/setup.sh; code=$?; set -e
if [ "$code" = "10" ]; then
  echo
  echo "WSL needs one restart to enable systemd. In PowerShell run:  wsl --shutdown"
  echo "Then open Ubuntu again and re-run the same install command."
  exit 0
fi
[ "$code" = "0" ] || exit "$code"

export PATH="$HOME/.local/bin:$PATH"
if [ ! -e "$HOME/.claude/.credentials.json" ]; then
  echo; echo "Claude Code will open. Type /login, finish in your browser, then /exit."
  read -r -p "Press Enter to continue " _
  claude || true
fi

if grep -qi microsoft /proc/version 2>/dev/null && command -v powershell.exe >/dev/null; then
  ./scripts/windows-autostart.sh --no-sleep-on-ac
elif [ "$(ps -p 1 -o comm=)" = "systemd" ]; then
  # Server: run as a systemd user service that starts on boot and restarts on failure.
  mkdir -p ~/.config/systemd/user
  sed "s|%CCHUB_DIR%|$DIR|g" deploy/cc-hub.service > ~/.config/systemd/user/cc-hub.service
  systemctl --user daemon-reload
  systemctl --user enable --now cc-hub
  sudo loginctl enable-linger "$USER"   # keep running after logout and start at boot
  echo "Installed systemd service cc-hub (logs: journalctl --user -u cc-hub -f)"
else
  ./scripts/start.sh
fi
echo
echo "Admin token: $(grep -E '^HUB_UI_TOKEN=' .env | cut -d= -f2-)"
echo "Open http://localhost:8787"
