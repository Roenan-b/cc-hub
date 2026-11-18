#!/usr/bin/env bash
# Stop the hub. Pass --all to also stop every Claude session and Postgres.
set -euo pipefail
cd "$(dirname "$0")/.."
tmux kill-session -t '=cchub-server' 2>/dev/null && echo "hub stopped" || echo "hub not running"
if [ "${1:-}" = "--all" ]; then
  for s in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^cc-' || true); do
    tmux kill-session -t "=$s" && echo "stopped $s"
  done
  docker compose stop db
fi
