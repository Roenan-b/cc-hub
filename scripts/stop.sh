#!/usr/bin/env bash
# Stop the hub. Pass --all to also stop every Claude session (and Docker Postgres, if used).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }
tmux kill-session -t '=cchub-server' 2>/dev/null && echo "hub stopped" || echo "hub not running"
if [ "${1:-}" = "--all" ]; then
  for s in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^cc-' || true); do
    tmux kill-session -t "=$s" && echo "stopped $s"
  done
  # Mark sessions stopped on purpose so the hub does not resume them on next start.
  if command -v psql >/dev/null && [ -n "${DATABASE_URL:-}" ]; then
    psql -q "$DATABASE_URL" -c "UPDATE sessions SET status = 'stopped' WHERE status <> 'stopped'" 2>/dev/null || true
  fi
  [ "${CCHUB_DOCKER_DB:-1}" = "1" ] && command -v docker >/dev/null && docker compose stop db || true
fi
