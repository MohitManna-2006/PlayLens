#!/usr/bin/env bash
# `make doctor`: check the tools, services, and local files PlayLens needs.
# Read-only: installs nothing and starts nothing. Exits 1 if anything required fails.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

problems=0
problem() { fail "$1"; shift; for line in "$@"; do note "$line"; done; problems=$((problems + 1)); }

major() { printf '%s' "$1" | sed 's/^v//' | cut -d. -f1; }

heading "Tools"
if have node; then
  v="$(node --version)"
  if [ "$(major "$v")" -ge 22 ]; then ok "node $v"; else problem "node $v (needs >= 22)" "Install Node.js 22 or newer."; fi
else
  problem "node not found" "Install Node.js 22 or newer."
fi
if have pnpm; then
  v="$(pnpm --version)"
  if [ "$(major "$v")" -ge 9 ]; then ok "pnpm $v"; else problem "pnpm $v (needs >= 9)" "Run: corepack enable"; fi
else
  problem "pnpm not found" "Run: corepack enable"
fi
if have uv; then
  ok "$(uv --version)"
  if [ -x .venv/bin/python ]; then
    ok "python $(.venv/bin/python -c 'import platform; print(platform.python_version())') (project .venv)"
  else
    problem "Python environment missing (.venv)" "Run: uv sync   (or make install)"
  fi
else
  problem "uv not found" "Install uv: https://docs.astral.sh/uv/"
fi
if have docker; then
  ok "Docker CLI $(docker version --format '{{.Client.Version}}' 2>/dev/null || echo '')"
  if docker compose version >/dev/null 2>&1; then
    ok "Docker Compose $(docker compose version --short 2>/dev/null)"
  else
    problem "Docker Compose plugin not found" "Install the docker compose v2 plugin."
  fi
  if docker_ready; then
    ok "Docker daemon $(docker info --format '{{.ServerVersion}} · {{.NCPU}} CPUs · {{.OperatingSystem}}' 2>/dev/null)"
  else
    p="$(docker_problem)"
    problem "${p%%|*}" "${p#*|}"
  fi
else
  problem "Docker CLI not found" "Install Docker (Colima or another runtime); Docker Desktop is not required."
fi
if have colima; then
  if colima status >/dev/null 2>&1; then note "colima: running (optional)"; else note "colima: installed, stopped (optional; start with: colima start)"; fi
fi

heading "Project"
if [ -d node_modules ] && [ -d apps/web/node_modules ]; then ok "JavaScript dependencies"; else problem "JavaScript dependencies missing" "Run: pnpm install   (or make install)"; fi
if [ -f "${DATASET_DIR}/dataset.json" ]; then
  ok "processed full dataset (${DATASET_DIR})"
else
  problem "processed full dataset missing (${DATASET_DIR})" \
    "Place the competition files under data/raw (see README), then run: pnpm data:full"
fi
if [ -f "$MODEL_ARTIFACT" ]; then
  ok "trajectory model artifact (${MODEL_ARTIFACT%/model.json})"
else
  warn "trajectory model artifact missing (${MODEL_ARTIFACT%/model.json})"
  note "Forecasts stay unavailable until it exists: pnpm ml:train (or copy the artifact)."
fi
if [ -f "$EMBEDDING_EXPORT" ]; then
  ok "embedding export (${EMBEDDING_EXPORT})"
else
  warn "embedding export missing (${EMBEDDING_EXPORT})"
  note "Only needed to load a fresh database: pnpm ml:embeddings (after pnpm ml:train)."
fi
if [ -f .env.example ]; then
  if [ -n "${PLAYLENS_DATABASE_URL:-}" ]; then note "PLAYLENS_DATABASE_URL is set in your environment"; else note "PLAYLENS_DATABASE_URL not set: the API uses the docker compose default (localhost:${DB_PORT})"; fi
fi

heading "Ports"
pids="$(port_pids "$API_PORT")"
if [ -z "$pids" ]; then
  ok "port $API_PORT free for the API"
elif api_health >/dev/null; then
  warn "port $API_PORT: a PlayLens API is already running (pid $pids)"
else
  problem "port $API_PORT is used by another process (pid $pids: $(pid_command "${pids%%[[:space:]]*}"))" \
    "The PlayLens API needs port $API_PORT. Free it; PlayLens never stops other processes."
fi
if port="$(web_port)"; then
  warn "PlayLens web is already running on port $port"
elif port="$(free_web_port)"; then
  if [ "$port" = "$WEB_PORT_START" ]; then ok "port $port free for the web app"; else ok "web app will use port $port (port $WEB_PORT_START is taken by another process)"; fi
else
  problem "no free web port between $WEB_PORT_START and $((WEB_PORT_START + WEB_PORT_SPAN))" "Set PLAYLENS_WEB_PORT to a free port."
fi

echo
if [ "$problems" -eq 0 ]; then
  ok "${BOLD}Ready.${RESET} Start everything with: make dev"
else
  fail "${BOLD}${problems} problem(s) found.${RESET} Fix them, then run make doctor again."
  exit 1
fi
