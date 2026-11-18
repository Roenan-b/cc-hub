#!/usr/bin/env bash
# Update this install to the latest main and restart the hub, rolling back if
# the new version fails its health check. Agent sessions keep running.
# Used by the GitHub deploy workflow (over SSH) and safe to run by hand.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
BRANCH="${1:-main}"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "bad branch"; exit 2; }
set -a; . ./.env; set +a
PORT="${HUB_PORT:-8787}"

prev=$(git rev-parse HEAD)
git fetch -q origin "$BRANCH"
next=$(git rev-parse "origin/$BRANCH")
if [ "$prev" = "$next" ] && [ "${FORCE:-0}" != "1" ]; then echo "already at $next"; exit 0; fi
echo "updating $prev -> $next"
git checkout -q --detach "$next"

install_deps() {
  local h; h=$(sha256sum package-lock.json | cut -c1-16)
  if [ ! -f node_modules/.cchub-lock ] || [ "$(cat node_modules/.cchub-lock)" != "$h" ]; then
    npm ci --omit=dev --silent && echo "$h" > node_modules/.cchub-lock
  fi
}
restart() {
  if systemctl --user is-enabled -q cc-hub 2>/dev/null; then systemctl --user restart cc-hub
  else ./scripts/stop.sh >/dev/null || true; ./scripts/start.sh >/dev/null; fi
}
healthy() {
  for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

if install_deps && restart && healthy; then
  git branch -f "$BRANCH" "$next" >/dev/null 2>&1 || true
  git checkout -q "$BRANCH" 2>/dev/null || true
  echo "deployed $next"
else
  echo "new version failed its health check; rolling back to $prev" >&2
  git checkout -q --detach "$prev"; install_deps; restart; healthy || echo "rollback also unhealthy; check hub.log" >&2
  exit 1
fi
