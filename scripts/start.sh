#!/usr/bin/env bash
# Start Postgres (docker) and the hub (in tmux session "cchub-server").
# First run: creates .env with random secrets and installs npm deps.
set -euo pipefail
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }; }
need node; need npm; need tmux; need git; need claude; need openssl

rand() { openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-"$1"; }
if [ ! -f .env ]; then
  pw=$(openssl rand -hex 24); admin=$(rand 40); observer=$(rand 40)
  sed -e "s|^HUB_UI_TOKEN=.*|HUB_UI_TOKEN=${admin}|" \
      -e "s|^HUB_OBSERVER_TOKEN=.*|HUB_OBSERVER_TOKEN=${observer}|" \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${pw}|" \
      -e "s|CHANGE_ME|${pw}|" .env.example > .env
  chmod 600 .env
  echo "Created .env (mode 600)."
  echo "  Admin token (full control):  ${admin}"
  echo "  Observer token (read-only):  ${observer}"
  echo "Edit HUB_WORKSPACE_ROOTS and HUB_VAULT in .env, then run this script again."
  exit 0
fi

[ -d node_modules ] || npm ci --omit=dev
set -a; . ./.env; set +a
for d in "${HUB_WORKSPACE_ROOTS%%:*}" "${HUB_VAULT:-~/Vault}"; do mkdir -p "${d/#\~/$HOME}"; done

if [ "${SKIP_DOCKER:-0}" != "1" ]; then
  need docker
  docker compose up -d --wait db
fi

if tmux has-session -t '=cchub-server' 2>/dev/null; then
  echo "hub already running (tmux attach -t cchub-server)"
else
  tmux new-session -d -s cchub-server -c "$PWD" "node src/hub.mjs 2>&1 | tee -a hub.log"
  echo "hub started in tmux session cchub-server (log: hub.log)"
fi
for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:${HUB_PORT:-8787}/healthz" >/dev/null 2>&1 && { echo "UI: http://127.0.0.1:${HUB_PORT:-8787}"; exit 0; }
  sleep 0.5
done
echo "hub did not come up; check: tmux attach -t cchub-server" >&2; exit 1
