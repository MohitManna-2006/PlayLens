#!/usr/bin/env bash
# `make status`: what is running right now. Never fails because a service is
# down; reads /health when the API is up, the database directly otherwise.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

row() { printf '%-11s %s %s\n' "$1" "$2" "$3"; }
up() { printf '%s✓%s' "$GREEN" "$RESET"; }
down() { printf '%s✗%s' "$RED" "$RESET"; }
partial() { printf '%s!%s' "$YELLOW" "$RESET"; }

docker_up=0
if docker_ready; then
  docker_up=1
  row "Docker" "$(up)" "running ($(docker info --format '{{.ServerVersion}}' 2>/dev/null))"
else
  p="$(docker_problem)"
  row "Docker" "$(down)" "${p%%|*} — ${p#*|}"
fi

pg_ready=0
if [ "$docker_up" -eq 1 ]; then
  state="$(postgres_state)"
  case "$state" in
    "running healthy") pg_ready=1; row "Postgres" "$(up)" "healthy (localhost:${DB_PORT})" ;;
    running*) row "Postgres" "$(partial)" "${state#running } (container running)" ;;
    "") row "Postgres" "$(down)" "no container — make db-up" ;;
    *) row "Postgres" "$(down)" "$state — make db-up" ;;
  esac
else
  row "Postgres" "$(down)" "unknown (Docker is not reachable)"
fi

if health="$(api_health)"; then
  summary="$(printf '%s' "$health" | py -c '
import json, sys
h = json.load(sys.stdin)
d, r, m = h["dataset"], h["retrieval"], h["models"]
plays = d.get("play_count") or 0
models = ", ".join(m["loaded"]) or "none"
print("{} · {} dataset, {:,} plays · models: {}".format(h["status"], d.get("subset"), plays, models))
print(r["status"])
if r["status"] == "ready":
    print("ready · {:,} embeddings ({})".format(r["embedding_count"], r["model_version"]))
else:
    print("{}: {}".format(r["status"], r.get("reason") or ""))
')"
  api_line="$(printf '%s\n' "$summary" | sed -n 1p)"
  ret_state="$(printf '%s\n' "$summary" | sed -n 2p)"
  ret_line="$(printf '%s\n' "$summary" | sed -n 3p)"
  row "API" "$(up)" "$API_URL · $api_line"
  if [ "$ret_state" = "ready" ]; then row "Retrieval" "$(up)" "$ret_line"; else row "Retrieval" "$(down)" "$ret_line"; fi
else
  pids="$(port_pids "$API_PORT")"
  if [ -n "$pids" ]; then
    row "API" "$(down)" "port $API_PORT is used by another process (pid $pids)"
  else
    row "API" "$(down)" "not running — make api (or make dev)"
  fi
  if [ "$pg_ready" -eq 1 ]; then
    line="$(retrieval_status --brief 2>/dev/null)"
    code=$?
    if [ "$code" -eq 0 ]; then row "Retrieval" "$(up)" "$line (database; API not running)"; else row "Retrieval" "$(down)" "$line"; fi
  else
    row "Retrieval" "$(down)" "unavailable (database not running)"
  fi
fi

if port="$(web_port)"; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://localhost:${port}/explore" 2>/dev/null)"
  if [ "$code" = "200" ]; then row "Web" "$(up)" "http://localhost:${port}"; else row "Web" "$(partial)" "http://localhost:${port} (HTTP ${code:-no answer})"; fi
else
  row "Web" "$(down)" "not running — make web (or make dev)"
fi
exit 0
