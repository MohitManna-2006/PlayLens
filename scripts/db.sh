#!/usr/bin/env bash
# Database commands behind `make db-*`. Business logic stays in the pnpm scripts
# (docker compose, migrations, loading); this adds Docker checks and readable output.
#   db.sh up       start Postgres (if needed) and wait for its health check
#   db.sh status   container state plus migration and embedding readiness
#   db.sh stop     stop the container; data is kept in the postgres_data volume
#   db.sh reset    delete the volume, then recreate, migrate, and reload (needs FORCE=1)
set -euo pipefail
source "$(dirname "$0")/lib.sh"

up() {
  require_docker
  if [ "$(postgres_state)" = "running healthy" ]; then
    ok "PostgreSQL already running (localhost:${DB_PORT})"
    return 0
  fi
  echo "Starting PostgreSQL + pgvector (docker compose service \"postgres\")..."
  pnpm --silent db:up
  ok "PostgreSQL running and healthy (localhost:${DB_PORT})"
}

status() {
  require_docker
  local state
  state="$(postgres_state)"
  if [ "$state" != "running healthy" ]; then
    fail "PostgreSQL: ${state:-no container} — start it with: make db-up"
    exit 1
  fi
  ok "PostgreSQL container: running, healthy"
  local out code=0
  out="$(retrieval_status)" || code=$?
  if [ "$code" -eq 0 ]; then ok "${out%%$'\n'*}"; else fail "${out%%$'\n'*}"; fi
  printf '%s\n' "$out" | sed -n '2,$p'
  return "$code"
}

stop() {
  if ! docker_ready; then
    ok "Docker is not running, so PostgreSQL is already stopped"
  elif [ -z "$(postgres_state)" ] || [ "$(postgres_state)" = "exited" ]; then
    ok "PostgreSQL already stopped"
  else
    pnpm --silent db:down
    ok "PostgreSQL stopped (data kept in the postgres_data volume)"
  fi
  # make dev runs the API and web app in the foreground; they stop with Ctrl-C.
  # Report any that are still running, but never stop processes from here.
  local pids port
  pids="$(port_pids "$API_PORT")"
  if [ -n "$pids" ] && api_health >/dev/null; then
    warn "PlayLens API still running on :$API_PORT (pid $pids); stop it with Ctrl-C in its terminal"
  fi
  if port="$(web_port)"; then
    warn "PlayLens web still running on :$port (pid $(port_pids "$port")); stop it with Ctrl-C in its terminal"
  fi
}

reset() {
  if [ "${FORCE:-}" != "1" ]; then
    die "db-reset deletes the local PostgreSQL volume (all loaded embeddings)." \
      "Run it explicitly with: make db-reset FORCE=1"
  fi
  require_docker
  local volume
  volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Name}}{{end}}{{end}}' \
    "$(docker compose ps -a -q postgres 2>/dev/null)" 2>/dev/null || true)"
  warn "Deleting the PostgreSQL container${volume:+ and volume $volume}"
  docker compose rm --stop --force postgres >/dev/null
  if [ -n "$volume" ]; then docker volume rm "$volume" >/dev/null; fi
  up
  pnpm --silent db:migrate
  pnpm --silent retrieval:load
  ok "Database recreated, migrated, and loaded"
}

case "${1:-}" in
  up | status | stop | reset) "$1" ;;
  *) echo "usage: $0 up|status|stop|reset" >&2; exit 2 ;;
esac
