#!/usr/bin/env bash
# `make check`: every pre-commit gate, in order. Each gate runs even if an
# earlier one failed, so one run shows every problem; the exit code is nonzero
# if any gate failed. The database tests are required, so Postgres is started.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

results=()
failed=0

gate() {
  local name="$1"
  shift
  heading "── $name: $*"
  local start=$SECONDS
  if "$@"; then
    results+=("$(ok "$name ($((SECONDS - start)) s)")")
  else
    results+=("$(fail "$name ($((SECONDS - start)) s)")")
    failed=$((failed + 1))
  fi
}

diff_check() { git diff --check && git diff --cached --check; }

gate "lint (ESLint, Ruff)" pnpm --silent lint
gate "format check (Ruff)" uv run ruff format --check .
gate "typecheck (TypeScript, strict mypy)" pnpm --silent typecheck
gate "database" bash scripts/db.sh up
gate "tests (Vitest, pytest; database tests required)" env PLAYLENS_REQUIRE_DB_TESTS=1 pnpm --silent test
gate "production build (Next.js)" pnpm --silent build
gate "git diff --check" diff_check

heading "Summary"
for line in "${results[@]}"; do echo "$line"; done
if [ "$failed" -gt 0 ]; then
  echo
  fail "$failed gate(s) failed"
  exit 1
fi
echo
ok "All gates passed"
