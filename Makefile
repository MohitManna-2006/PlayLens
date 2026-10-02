# PlayLens developer commands. `make` (or `make help`) lists them.
#
# This is a convenience layer: each target runs a pnpm script (package.json) or a
# small script in scripts/. Nothing here replaces the underlying commands, which
# keep working on their own (see README.md).

SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help install doctor status dev api web open stop \
	db-up db-down db-status db-migrate db-load db-verify db-logs db-reset \
	retrieval-benchmark \
	test test-db lint format format-check typecheck build check clean

##@ Environment

help: ## Show this list of commands
	@if [ -t 1 ]; then b=$$'\033[1m'; c=$$'\033[36m'; r=$$'\033[0m'; fi; \
	awk -v b="$$b" -v c="$$c" -v r="$$r" 'BEGIN { FS = ":.*## " } \
		/^##@/ { printf "\n%s%s%s\n", b, substr($$0, 5), r } \
		/^[a-z][a-z0-9-]*:.*## / { printf "  %smake %-20s%s %s\n", c, $$1, r, $$2 }' $(MAKEFILE_LIST)
	@echo

install: ## Install JavaScript (pnpm) and Python (uv) dependencies
	pnpm install
	uv sync

doctor: ## Check tools, Docker, local data and model files, and ports
	@bash scripts/doctor.sh

status: ## Show what is running: Docker, Postgres, API, retrieval, web
	@bash scripts/status.sh

##@ Development

dev: ## Start Postgres if needed, migrate, then run the API and web app (Ctrl-C stops them)
	@bash scripts/dev.sh all

api: ## Run only the API on :8000 with the full dataset
	@bash scripts/dev.sh api

web: ## Run only the web app (first free port from 3000)
	@bash scripts/dev.sh web

open: ## Open the running web app in your browser
	@bash scripts/dev.sh open

stop: ## Stop Postgres (data is kept); API and web stop with Ctrl-C
	@bash scripts/db.sh stop

##@ Database

db-up: ## Start Postgres + pgvector and wait until healthy
	@bash scripts/db.sh up

db-down: ## Stop Postgres (data is kept)
	pnpm db:down

db-status: ## Show container, migration, and embedding readiness
	@bash scripts/db.sh status

db-migrate: db-up ## Apply pending SQL migrations (safe to rerun)
	pnpm db:migrate

db-load: db-up ## Load the Phase 3 play embeddings (idempotent, ~15 s the first time)
	pnpm retrieval:load

db-verify: db-up ## Check stored embeddings and exact search against NumPy
	pnpm retrieval:verify

db-logs: ## Follow the Postgres container logs
	docker compose logs --follow --tail=100 postgres

db-reset: ## DESTRUCTIVE: delete the database volume and reload (needs FORCE=1)
	@FORCE=$(FORCE) bash scripts/db.sh reset

##@ Retrieval

retrieval-benchmark: db-up ## Exact vs HNSW benchmark -> docs/evaluation/retrieval-v1.{json,md} (~10 min)
	pnpm retrieval:benchmark

##@ Quality

test: ## Run frontend and backend tests (database tests run if Postgres is up)
	pnpm test

test-db: db-up ## Run all tests with the database tests required
	PLAYLENS_REQUIRE_DB_TESTS=1 pnpm test

lint: ## ESLint and Ruff
	pnpm lint

format: ## Format Python code with Ruff
	pnpm format

format-check: ## Check Python formatting
	uv run ruff format --check .

typecheck: ## TypeScript (after Next.js route types) and strict mypy
	pnpm typecheck

build: ## Production build of the web app
	pnpm build

check: ## Every pre-commit gate: lint, format, types, tests (with DB), build, diff check
	@bash scripts/check.sh

clean: ## Remove caches and build output (keeps data, models, embeddings, and the database)
	rm -rf .mypy_cache .ruff_cache .pytest_cache apps/web/.next
	find services ml -type d -name __pycache__ -prune -exec rm -rf {} +
