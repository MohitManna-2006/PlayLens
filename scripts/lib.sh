# shellcheck shell=bash
# Shared helpers for the PlayLens developer scripts (sourced, not executed).
# Bash 3.2 compatible (the macOS default); no GNU-only flags.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# The API port is fixed by `pnpm dev:api` (package.json); the web app takes the
# first free port from PLAYLENS_WEB_PORT (default 3000) upward, like `next dev`.
API_PORT=8000
API_URL="http://localhost:${API_PORT}"
DB_PORT="${PLAYLENS_DB_PORT:-5432}"
WEB_PORT_START="${PLAYLENS_WEB_PORT:-3000}"
WEB_PORT_SPAN=10
MODEL_VERSION="${PLAYLENS_EMBEDDING_MODEL_VERSION:-trajectory-gnn-transformer-v1}"
DATASET_DIR="data/processed/nfl_bdb_2026_analytics/full"
EMBEDDING_EXPORT="${DATASET_DIR}/embeddings/${MODEL_VERSION}.parquet"
MODEL_ARTIFACT="artifacts/models/${MODEL_VERSION}/model.json"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  GREEN=$'\033[32m' RED=$'\033[31m' YELLOW=$'\033[33m' DIM=$'\033[2m' BOLD=$'\033[1m' RESET=$'\033[0m'
else
  GREEN="" RED="" YELLOW="" DIM="" BOLD="" RESET=""
fi

ok() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
fail() { printf '%s✗%s %s\n' "$RED" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
note() { printf '  %s%s%s\n' "$DIM" "$*" "$RESET"; }
heading() { printf '\n%s%s%s\n' "$BOLD" "$*" "$RESET"; }
# Errors go to stderr so they still show when raised inside $(...).
die() {
  {
    fail "$1"
    shift
    for line in "$@"; do note "$line"; done
  } >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

docker_ready() { have docker && docker info >/dev/null 2>&1; }

# Why Docker is not usable, and what to do about it.
docker_problem() {
  if ! have docker; then
    echo "Docker CLI not found|Install Docker (Colima or another runtime); PlayLens does not require Docker Desktop."
  elif have colima && ! colima status >/dev/null 2>&1; then
    echo "Docker daemon is not reachable (Colima is stopped)|Start it with: colima start"
  else
    echo "Docker daemon is not reachable|Start Colima (colima start) or another Docker runtime and retry."
  fi
}

require_docker() {
  docker_ready && return 0
  local problem
  problem="$(docker_problem)"
  die "${problem%%|*}" "${problem#*|}"
}

# "running healthy", "running starting", "exited", or "" when no container exists.
postgres_state() {
  { docker compose ps -a --format '{{.State}} {{.Health}}' postgres 2>/dev/null || true; } | head -n 1 | sed 's/ *$//'
}

# PIDs listening on a TCP port (empty when free or when lsof is unavailable).
# These helpers always succeed so they are safe under `set -euo pipefail`.
port_pids() {
  { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; } | sort -u | tr '\n' ' ' | sed 's/ *$//'
}

# "Python -m http.server 8000": executable name plus its first arguments.
pid_command() {
  { ps -o command= -p "$1" 2>/dev/null || true; } |
    awk '{ n = split($1, p, "/"); printf "%s", p[n]; for (i = 2; i <= NF && i <= 5; i++) printf " %s", $i; print "" }'
}

pid_cwd() { { lsof -a -p "$1" -d cwd -Fn 2>/dev/null || true; } | sed -n 's/^n//p' | head -n 1; }

# JSON body of the API's /health, or nothing when no PlayLens API answers.
api_health() {
  local body
  body="$(curl -fsS --max-time 3 "${API_URL}/health" 2>/dev/null)" || return 1
  case "$body" in *'"playlens-api"'*) printf '%s' "$body" ;; *) return 1 ;; esac
}

# Port of a running PlayLens web dev server (a listener whose working directory
# is this repository's apps/web), so another app on 3000 is never mistaken for it.
# Compared by file identity (-ef), not spelling: macOS paths are case-insensitive.
web_port() {
  local port pid cwd
  port="$WEB_PORT_START"
  while [ "$port" -le $((WEB_PORT_START + WEB_PORT_SPAN)) ]; do
    for pid in $(port_pids "$port"); do
      cwd="$(pid_cwd "$pid")"
      if [ -n "$cwd" ] && [ "$cwd" -ef "$REPO_ROOT/apps/web" ]; then
        echo "$port"
        return 0
      fi
    done
    port=$((port + 1))
  done
  return 1
}

# First free port at or above PLAYLENS_WEB_PORT.
free_web_port() {
  local port="$WEB_PORT_START"
  while [ "$port" -le $((WEB_PORT_START + WEB_PORT_SPAN)) ]; do
    [ -z "$(port_pids "$port")" ] && { echo "$port"; return 0; }
    port=$((port + 1))
  done
  return 1
}

# Python for small JSON reads: the system python3 when present, else uv's.
py() {
  if have python3; then python3 "$@"; else uv run --no-project python "$@"; fi
}

# Retrieval readiness from the database itself (exit codes in
# services/api/src/playlens_api/retrieval/status.py).
retrieval_status() { uv run --quiet python -m playlens_api.retrieval.status "$@"; }
