#!/usr/bin/env bash
# First-time setup for Ubuntu/Debian, including Ubuntu on WSL2.
# Installs what is missing, sets up a local Postgres database, writes .env,
# and prepares the vault. Safe to re-run: it skips anything already done.
#
#   ./scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   ok: %s\n' "$*"; }
warn() { printf '   \033[33mnote:\033[0m %s\n' "$*"; }
# CCHUB_NONINTERACTIVE=1 accepts every default (used by the Windows bootstrap).
ask()  {
  local prompt="$1" def="$2" ans
  if [ "${CCHUB_NONINTERACTIVE:-0}" = "1" ]; then echo "$def"; return; fi
  read -r -p "   $prompt [$def]: " ans; echo "${ans:-$def}"
}
NEEDS_WSL_RESTART=0
is_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }

[ "$(id -u)" -ne 0 ] || { echo "Run as your normal user, not root (sudo is used where needed)."; exit 1; }
command -v apt-get >/dev/null || { echo "This script supports Ubuntu/Debian (including WSL). macOS and other systems are not supported yet."; exit 1; }

# ---------------------------------------------------------------- packages
say "System packages"
# A third-party apt source with an expired or missing key (often the GitHub CLI
# repo) makes "apt-get update" fail and silently blocks every install. Refresh
# the GitHub CLI key if that source exists, and never let one bad source stop us.
apt_update() {
  local gh_list
  gh_list=$(ls /etc/apt/sources.list.d/github-cli*.list /etc/apt/sources.list.d/github-cli*.sources 2>/dev/null | head -1 || true)
  if [ -n "$gh_list" ]; then
    local key
    key=$(grep -ohP 'signed-by=\K[^] ]+|Signed-By:\s*\K\S+' "$gh_list" | head -1 || true)
    key=${key:-/usr/share/keyrings/githubcli-archive-keyring.gpg}
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee "$key" >/dev/null 2>&1 \
      && sudo chmod go+r "$key" || true
  fi
  if ! sudo apt-get update -qq; then
    warn "apt-get update reported errors from some sources (see above); continuing with the sources that work."
  fi
}
need_pkg() { ! dpkg -s "$1" >/dev/null 2>&1; }
pkgs=()
for p in tmux git curl ca-certificates postgresql postgresql-client openssl; do need_pkg "$p" && pkgs+=("$p"); done
if [ ${#pkgs[@]} -gt 0 ]; then
  echo "   installing: ${pkgs[*]}"
  apt_update
  sudo apt-get install -y -qq "${pkgs[@]}"
fi
for p in tmux git curl postgresql postgresql-client openssl; do
  need_pkg "$p" && { echo "   FAILED to install $p. Fix the apt errors above, then run setup again."; exit 1; }
done
command -v pg_isready >/dev/null || { echo "   pg_isready missing even though postgresql-client is installed"; exit 1; }
ok "tmux $(tmux -V | cut -d' ' -f2), git, postgresql"

say "Node.js (20+)"
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }
if [ -z "$(node_major)" ] || [ "$(node_major)" -lt 20 ]; then
  echo "   Node 20+ not found (have: $(node -v 2>/dev/null || echo none)). Installing Node 22 from NodeSource."
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  sudo -E bash /tmp/nodesource_setup.sh >/dev/null 2>&1 || warn "NodeSource setup reported errors; trying the install anyway."
  sudo apt-get install -y -qq nodejs
  hash -r
fi
if [ -z "$(node_major)" ] || [ "$(node_major)" -lt 20 ]; then
  echo "   FAILED: still on Node $(node -v 2>/dev/null || echo none). Fix the apt errors above, then run setup again."
  exit 1
fi
ok "node $(node -v)"
lock_hash=$(sha256sum package-lock.json | cut -c1-16)
if [ ! -f node_modules/.cchub-lock ] || [ "$(cat node_modules/.cchub-lock)" != "$lock_hash" ]; then
  npm ci --omit=dev --silent && echo "$lock_hash" > node_modules/.cchub-lock
fi
ok "npm dependencies"

say "Claude Code"
export PATH="$HOME/.local/bin:$PATH"
if ! command -v claude >/dev/null || [[ "$(command -v claude)" == /mnt/* ]]; then
  echo "   Installing Claude Code with the native installer (no sudo, auto-updates)."
  curl -fsSL https://claude.ai/install.sh | bash
  grep -q '.local/bin' ~/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
fi
ok "claude $(claude --version 2>/dev/null | head -1)"
if [ ! -e "$HOME/.claude/.credentials.json" ]; then
  warn "Claude Code may not be logged in. If not, run: claude  (then /login, then /exit)"
fi

# ---------------------------------------------------------------- systemd (WSL)
if is_wsl && [ "$(ps -p 1 -o comm=)" != "systemd" ]; then
  say "WSL systemd"
  echo "   Postgres should start on its own when WSL boots. That needs systemd enabled in /etc/wsl.conf."
  if [ "$(ask 'Enable systemd now? (requires "wsl --shutdown" from PowerShell afterwards)' 'y')" = "y" ]; then
    if grep -q '^systemd=' /etc/wsl.conf 2>/dev/null; then
      sudo sed -i 's/^systemd=.*/systemd=true/' /etc/wsl.conf
    elif grep -q '^\[boot\]' /etc/wsl.conf 2>/dev/null; then
      sudo sed -i '/^\[boot\]/a systemd=true' /etc/wsl.conf
    else
      printf '\n[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf >/dev/null
    fi
    NEEDS_WSL_RESTART=1
    warn "systemd enabled. WSL must restart once (the Windows bootstrap does this; manually: wsl --shutdown in PowerShell)"
  fi
fi

# ---------------------------------------------------------------- Postgres
say "Postgres"
if [ "$(ps -p 1 -o comm=)" = "systemd" ]; then
  sudo systemctl enable --now postgresql >/dev/null 2>&1 || true
else
  sudo service postgresql start >/dev/null
fi
for _ in $(seq 1 20); do pg_isready -q -h 127.0.0.1 -p 5432 && break; sleep 0.5; done
pg_isready -q -h 127.0.0.1 -p 5432 || { echo "Postgres did not start; check: sudo service postgresql status"; exit 1; }

DB_PW=""
if [ -f .env ]; then DB_PW=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2- || true); fi
[ -n "$DB_PW" ] || DB_PW=$(openssl rand -hex 24)
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='cchub'" | grep -q 1; then
  sudo -u postgres psql -qc "ALTER ROLE cchub WITH LOGIN PASSWORD '${DB_PW}'"
else
  sudo -u postgres psql -qc "CREATE ROLE cchub WITH LOGIN PASSWORD '${DB_PW}'"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='cchub'" | grep -q 1 \
  || sudo -u postgres createdb -O cchub cchub
ok "database cchub on 127.0.0.1:5432 (local only)"

# ---------------------------------------------------------------- .env
say "Configuration"
if [ -f .env ]; then
  ok ".env already exists; leaving it as is"
else
  echo "   Agents can only start sessions inside these directories. List your project folders,"
  echo "   e.g. $HOME/research:$HOME/projects  (or $HOME to allow everything in your home)."
  roots=$(ask "Directories agents may work in (colon-separated)" "${CCHUB_ROOTS:-$HOME/projects}")

  default_vault="$HOME/Vault"
  if is_wsl && command -v powershell.exe >/dev/null; then
    winprofile=$(powershell.exe -NoProfile -Command '$env:USERPROFILE' 2>/dev/null | tr -d '\r')
    [ -n "$winprofile" ] && default_vault="$(wslpath "$winprofile")/Documents/Vault"
  fi
  echo "   The Obsidian vault is where plans, notes, and reports go. On WSL, keeping it in your Windows"
  echo "   Documents folder lets the Obsidian desktop app open it directly."
  vault=$(ask "Vault folder" "${CCHUB_VAULT:-$default_vault}")

  admin=$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-40)
  observer=$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-40)
  sed -e "s|^HUB_UI_TOKEN=.*|HUB_UI_TOKEN=${admin}|" \
      -e "s|^HUB_OBSERVER_TOKEN=.*|HUB_OBSERVER_TOKEN=${observer}|" \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${DB_PW}|" \
      -e "s|^DATABASE_URL=.*|DATABASE_URL=postgres://cchub:${DB_PW}@127.0.0.1:5432/cchub|" \
      -e "s|^CCHUB_DOCKER_DB=.*|CCHUB_DOCKER_DB=0|" \
      -e "s|^HUB_WORKSPACE_ROOTS=.*|HUB_WORKSPACE_ROOTS=${roots}|" \
      -e "s|^HUB_VAULT=.*|HUB_VAULT=${vault}|" \
      -e "s|^HUB_TRUST_PROXY=.*|HUB_TRUST_PROXY=1|" \
      .env.example > .env
  chmod 600 .env
  ok ".env written (mode 600)"
  echo
  echo "   ┌─ Save these somewhere safe (also in $REPO/.env) ─────────────"
  echo "   │ Admin token (full control):  ${admin}"
  echo "   │ Observer token (read-only):  ${observer}"
  echo "   └──────────────────────────────────────────────────────────────"
fi

set -a; . ./.env; set +a
for d in ${HUB_WORKSPACE_ROOTS//:/ } "$HUB_VAULT"; do mkdir -p "${d/#\~/$HOME}"; done
ok "workspace and vault folders exist"

# ---------------------------------------------------------------- check
say "Check"
node -e "import('./src/db.mjs').then(m=>m.initSchema().then(()=>{console.log('   ok: database schema');return m.pool.end()})).catch(e=>{console.error('   database error: '+e.message);process.exit(1)})"

say "Next steps"
echo "   1. If Claude Code is not logged in:  claude   then /login, then /exit"
echo "   2. Start the hub:                    ./scripts/start.sh"
echo "      Open http://localhost:8787 and sign in with the admin token."
if is_wsl; then
  echo "   3. Start on Windows login and keep WSL running:  ./scripts/windows-autostart.sh --no-sleep-on-ac"
  echo "   4. Phone: install Tailscale on Windows and your phone, then in PowerShell:  tailscale serve --bg 8787"
fi
echo "   Full guide: docs/SETUP-WINDOWS.md"
[ "$NEEDS_WSL_RESTART" = "1" ] && exit 10
exit 0
