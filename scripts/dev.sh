#!/usr/bin/env bash
# Development servers behind `make dev`, `make api`, `make web`, and `make open`.
#   dev.sh all   preflight (Docker, Postgres, migrations, retrieval data), then run
#                the API and web app in the foreground via scripts/dev.mjs
#   dev.sh api   the API alone (full dataset), in the foreground
#   dev.sh web   the web app alone, on the first free port from 3000, in the foreground
#   dev.sh open  open the running web app in the default browser
# Ctrl-C stops the foreground servers. Postgres keeps running (make stop stops it).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

# The served subset must match the loaded embeddings (full) unless overridden.
export PLAYLENS_SUBSET="${PLAYLENS_SUBSET:-full}"

require_installed() {
  [ -d node_modules ] && [ -d apps/web/node_modules ] || die "JavaScript dependencies missing" "Run: make install"
  [ -x .venv/bin/python ] || die "Python environment missing (.venv)" "Run: make install"
}

require_dataset() {
  [ "$PLAYLENS_SUBSET" != "full" ] || [ -f "${DATASET_DIR}/dataset.json" ] ||
    die "Processed full dataset missing (${DATASET_DIR})" \
      "Place the competition files under data/raw (see README), then run: pnpm data:full"
}

# Refuse to start if the API port is taken; never stop the other process.
require_api_port() {
  local pids
  pids="$(port_pids "$API_PORT")"
  [ -z "$pids" ] && return 0
  if api_health >/dev/null; then
    die "A PlayLens API is already running on port $API_PORT (pid $pids)" \
      "Use it, or stop it with Ctrl-C in its terminal, then retry."
  fi
  die "Port $API_PORT is in use by another process (pid $pids: $(pid_command "${pids%%[[:space:]]*}"))" \
    "The PlayLens API needs port $API_PORT. Free the port; PlayLens never stops other processes."
}

choose_web_port() {
  local port
  if port="$(web_port)"; then
    die "PlayLens web is already running on http://localhost:$port" "Use it, or stop it with Ctrl-C in its terminal, then retry."
  fi
  port="$(free_web_port)" || die "No free web port between $WEB_PORT_START and $((WEB_PORT_START + WEB_PORT_SPAN))" "Set PLAYLENS_WEB_PORT to a free port."
  echo "$port"
}

# Retrieval data: load the Phase 3 export into a fresh database automatically
# (idempotent, about 15 s); never invent embeddings when the export is missing.
ensure_retrieval() {
  local out code=0
  out="$(retrieval_status --brief)" || code=$?
  case "$code" in
    0) ok "retrieval corpus: $out" ;;
    3)
      if [ -f "$EMBEDDING_EXPORT" ]; then
        echo "Loading play embeddings into the fresh database (first run, about 15 s)..."
        local loaded
        loaded="$(pnpm --silent retrieval:load 2>&1)" || die "Loading embeddings failed" "$loaded"
        out="$(retrieval_status --brief)" || die "Embeddings did not load" "$out"
        ok "retrieval corpus: $out"
      else
        warn "retrieval corpus: no embeddings loaded, and the Phase 3 export is missing"
        note "Expected: $EMBEDDING_EXPORT"
        note "Create it with the Phase 3 workflow (pnpm ml:train, then pnpm ml:embeddings), then run: make db-load"
        note "Starting anyway: replay and forecasts work; Similar Plays will say retrieval is unavailable."
      fi
      ;;
    *) die "Retrieval database not ready: $out" "Run: make db-status" ;;
  esac
}

all() {
  printf '%sPlayLens development environment%s\n\n' "$BOLD" "$RESET"
  require_docker
  ok "Docker daemon"
  require_installed
  require_dataset
  require_api_port
  local web
  web="$(choose_web_port)"

  if [ "$(postgres_state)" = "running healthy" ]; then
    ok "PostgreSQL running (localhost:${DB_PORT})"
  else
    echo "Starting PostgreSQL..."
    pnpm --silent db:up >/dev/null 2>&1 || die "PostgreSQL did not start" "See: make db-logs"
    ok "PostgreSQL started and healthy (localhost:${DB_PORT})"
  fi
  local migrated
  migrated="$(pnpm --silent db:migrate 2>&1)" || die "Migrations failed" "$migrated"
  # The runner ends with "<url>: applied ['0001', '0002']; pending none".
  ok "migrations applied: $(printf '%s' "${migrated##*: applied }" | tr -d "[]'")"
  ensure_retrieval
  if [ ! -f "$MODEL_ARTIFACT" ]; then
    warn "trajectory model artifact missing: forecasts will be unavailable (pnpm ml:train)"
  fi

  echo
  echo "Starting PlayLens API (dataset: $PLAYLENS_SUBSET) and web..."
  echo
  printf '  API: %s%s%s   (docs %s/docs)\n' "$BOLD" "$API_URL" "$RESET" "$API_URL"
  printf '  Web: %shttp://localhost:%s%s' "$BOLD" "$web" "$RESET"
  if [ "$web" != "$WEB_PORT_START" ]; then printf '   (port %s is taken by another process)' "$WEB_PORT_START"; fi
  printf '\n\n  Press Ctrl-C to stop the development servers (PostgreSQL keeps running).\n\n'
  PLAYLENS_WEB_PORT="$web" exec node scripts/dev.mjs
}

api() {
  require_installed
  require_dataset
  require_api_port
  if ! docker_ready || [ "$(postgres_state)" != "running healthy" ]; then
    warn "PostgreSQL is not running: Similar Plays and Compare similarity stay unavailable (make db-up)"
  fi
  printf '%sPlayLens API%s\n%s   (dataset: %s, docs %s/docs)\n\n' "$BOLD" "$RESET" "$API_URL" "$PLAYLENS_SUBSET" "$API_URL"
  exec pnpm --silent dev:api
}

web() {
  require_installed
  local port
  port="$(choose_web_port)"
  printf '%sPlayLens web%s\nhttp://localhost:%s' "$BOLD" "$RESET" "$port"
  if [ "$port" != "$WEB_PORT_START" ]; then printf '   (port %s is taken by another process)' "$WEB_PORT_START"; fi
  printf '\n'
  if ! api_health >/dev/null; then note "The API is not running at $API_URL; start it with: make api"; fi
  echo
  PORT="$port" exec pnpm --silent dev:web
}

open_browser() {
  local port url
  port="$(web_port)" || die "PlayLens web is not running" "Start it with: make dev (or make web)"
  url="http://localhost:${port}/explore"
  if have open; then
    open "$url"
  elif have xdg-open; then
    xdg-open "$url" >/dev/null 2>&1
  else
    echo "Open $url in your browser."
    return 0
  fi
  ok "Opened $url"
}

case "${1:-}" in
  all | api | web) "$1" ;;
  open) open_browser ;;
  *) echo "usage: $0 all|api|web|open" >&2; exit 2 ;;
esac
