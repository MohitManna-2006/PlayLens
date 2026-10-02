# PlayLens

PlayLens is an AI-native NFL play intelligence platform that transforms player-tracking sequences into learned play representations that can be replayed, searched, compared, predicted, explained, and manipulated.

See [PLAYLENS_MASTERBRAIN.md](PLAYLENS_MASTERBRAIN.md) for the product specification, ML architecture, and guidelines.

## Current status: Phase 4 (similarity search + Compare)

Real tracking from the NFL Big Data Bowl 2026 Analytics release flows through a deterministic preprocessing pipeline into canonical Parquet artifacts, a FastAPI service, and the web app (Phase 2). Phase 3 adds game-safe temporal splits, constant-velocity baselines, a spatial-temporal graph encoder (GATv2 + Transformer) with a trajectory head, evaluation reports, a versioned model artifact, exported play embeddings, and real predicted paths in the Play view.

Phase 4 stores those frozen 128-d play embeddings in PostgreSQL + pgvector and serves real nearest-neighbour retrieval (exact and HNSW, with database-side metadata filters) as **Similar Plays** on the Play view and a synchronized **Compare** view with deterministic evidence. Cosine similarity is a learned-representation distance, not a probability.

PlayLab and the Analyst are not built yet and show unavailable states.

- Phase 4 architecture: [docs/architecture/phase-4-retrieval-compare.md](docs/architecture/phase-4-retrieval-compare.md)
- Retrieval evaluation (exact vs HNSW recall, latency, examples): [docs/evaluation/retrieval-v1.md](docs/evaluation/retrieval-v1.md)
- Decision: [ADR-0005 pgvector similarity retrieval](docs/decisions/ADR-0005-pgvector-similarity-retrieval.md)
- Phase 3 architecture: [docs/architecture/phase-3-ml.md](docs/architecture/phase-3-ml.md)
- Model card: [docs/model-cards/trajectory-gnn-transformer-v1.md](docs/model-cards/trajectory-gnn-transformer-v1.md)
- Evaluation summary: [docs/evaluation/trajectory-gnn-transformer-v1.md](docs/evaluation/trajectory-gnn-transformer-v1.md)
- Decisions: [ADR-0003 split and leakage](docs/decisions/ADR-0003-ml-split-and-leakage-policy.md), [ADR-0004 encoder](docs/decisions/ADR-0004-spatial-temporal-encoder.md)
- Phase 2 architecture: [docs/architecture/phase-2-real-data.md](docs/architecture/phase-2-real-data.md)
- Dataset notes, validation findings, and limitations: [docs/data/nfl-bdb-2026-analytics.md](docs/data/nfl-bdb-2026-analytics.md)
- Canonical data model: [docs/decisions/ADR-0002-canonical-play-data-model.md](docs/decisions/ADR-0002-canonical-play-data-model.md)

## Prerequisites

- Node.js ≥ 22 and pnpm ≥ 9
- Python ≥ 3.12 and [uv](https://docs.astral.sh/uv/)
- The NFL Big Data Bowl 2026 Analytics files (not in this repository; see below)
- Docker with Compose (Docker Desktop or [Colima](https://github.com/abiosoft/colima)) for the similarity database. Replay and forecasts work without it.
- Training: Apple Silicon (MPS), CUDA, or CPU. The reference run used an M1 Pro (16 GB) and MPS.

## Setup

```bash
corepack enable
pnpm install          # web workspace
uv sync               # Python workspace (API + ML) into .venv
```

### Data

The competition data is used under the competition's data-use terms and is **not committed**. Place the release so this path exists:

```text
data/raw/114239_nfl_competition_files_published_analytics_final/
├── supplementary_data.csv
└── train/input_2023_w01.csv … output_2023_w18.csv
```

`data/raw`, `data/interim`, and `data/processed` are Git-ignored. Raw files are only read.

### Preprocess

```bash
pnpm data:dev
# = uv run python -m playlens_ml.data.preprocess --dataset nfl_bdb_2026_analytics --subset dev
```

This validates the full release, selects a deterministic 54-play development subset (3 per week), and writes:

- `data/processed/nfl_bdb_2026_analytics/dev/` — canonical Parquet (`observed/`, `targets/`, `descriptive/`) and `dataset.json`
- `data/interim/nfl_bdb_2026_analytics/play_index.dev.parquet` — one row per play with validation and eligibility
- `data/manifests/nfl_bdb_2026_analytics.dev.manifest.json` — checksums, schemas, counts, selection rule, git commit (committed)

`pnpm data:full` writes every valid play (14,108) with the same code. The model is trained on `full`.

### Train and evaluate

```bash
pnpm data:full            # once
pnpm ml:splits            # temporal week split + committed manifest
pnpm ml:baseline          # constant-velocity validation metrics (no training)
pnpm ml:train             # trains, selects on validation, evaluates test once, exports artifacts/models/trajectory-gnn-transformer-v1/
pnpm ml:benchmark         # inference latency into the artifact
pnpm ml:embeddings        # play embeddings Parquet + committed manifest
pnpm ml:sanity            # embedding neighbour checks vs a metadata baseline
pnpm mlflow:ui            # browse runs at http://localhost:5001
```

`artifacts/` and `mlruns/` are Git-ignored. The reference run (30 epochs on the full train split, M1 Pro, MPS) trained in 1,116 s.

### Similarity database (Phase 4)

Needs the Phase 3 embedding export (`pnpm ml:embeddings`, above) and Docker. With Colima, run `colima start` first.

```bash
pnpm db:up                # docker compose up -d --wait postgres (pgvector 0.8.7, PostgreSQL 18, port 5432)
pnpm db:migrate           # pgvector extension, tables, HNSW index (versioned SQL; safe to rerun)
pnpm retrieval:load       # validate the export and load 14,108 embeddings (idempotent; ~15 s first time)
pnpm retrieval:verify     # exact pgvector search vs an independent NumPy brute force
pnpm retrieval:benchmark  # exact vs HNSW recall and latency -> docs/evaluation/retrieval-v1.{json,md}
pnpm db:down              # stop the container (data kept)
```

Reset the database (destroys local database state): `docker compose down -v`, then `pnpm db:up && pnpm db:migrate && pnpm retrieval:load`. Normal startup never resets anything.

## Run

```bash
pnpm db:up                     # once per boot, for Similar Plays and Compare similarity
PLAYLENS_SUBSET=full pnpm dev  # API on :8000 (full dataset, matches the embeddings) and web on :3000
# or separately
pnpm dev:api      # uv run --directory services/api uvicorn playlens_api.main:app --reload --port 8000
pnpm dev:web      # pnpm --filter web dev
```

Open `http://localhost:3000/explore`, choose a play, or go straight to a play such as `http://localhost:3000/play/2023123114-3710`, then **Find similar plays** and **Compare**. If port 3000 is taken, Next.js picks the next free port; the API accepts any local port.

API docs: `http://localhost:8000/docs`. Health: `http://localhost:8000/health`.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_PLAYLENS_API_BASE_URL` | `http://localhost:8000` | Where the web app finds the API |
| `NEXT_PUBLIC_PLAYLENS_DATA_SOURCE` | `api` | Set to `fixture` for synthetic interface-development plays |
| `PLAYLENS_DATA_ROOT` | `<repo>/data` | Data directory for preprocessing and the API |
| `PLAYLENS_SUBSET` | `dev` | Processed subset the API serves (`dev` or `full`); use `full` with the trained model |
| `PLAYLENS_MODEL_DIR` | `<repo>/artifacts/models` | Trained model artifacts the API loads at startup |
| `PLAYLENS_MODEL_DEVICE` | `cpu` | Inference device for the API |
| `PLAYLENS_DATABASE_URL` | `postgresql://playlens_dev:playlens_dev@localhost:5432/playlens` | Retrieval database (docker compose `postgres`); empty disables similarity |
| `PLAYLENS_EMBEDDING_MODEL_VERSION` | `trajectory-gnn-transformer-v1` | Embedding set searched by default |
| `PLAYLENS_HNSW_EF_SEARCH` | `40` | HNSW candidate list size (raised to k); see the retrieval evaluation |
| `PLAYLENS_DB_PORT` | `5432` | Host port of the database container |

Web variables go in `apps/web/.env.local` (see `apps/web/.env.example`).

## Development commands

- `pnpm lint` — ESLint (web) and Ruff (Python)
- `pnpm typecheck` — TypeScript and mypy (strict)
- `pnpm test` — Vitest and pytest (the pgvector integration tests run when the database is up, or always with `PLAYLENS_REQUIRE_DB_TESTS=1`; `PLAYLENS_TEST_DATABASE_URL` overrides the target, and each run uses its own temporary schema)
- `pnpm build` — production web build
- `pnpm contracts:generate` — regenerate `packages/contracts` (OpenAPI and example payloads from a synthetic dataset)

## Repository structure

- `apps/web` — Next.js frontend
- `services/api` — FastAPI service (`playlens_api`)
- `ml/` — Python ML package (`playlens_ml`): `data` (dataset adapter, canonical schema), `datasets`, `features`, `graphs`, `models`, `training`, `evaluation`, `inference`, `embeddings`, `descriptors` (structural tracking descriptors)
- `configs/` — training configs (YAML)
- `artifacts/`, `mlruns/` — local training outputs and MLflow store (ignored)
- `services/api/src/playlens_api/retrieval` — pgvector store, SQL migrations, embedding import, verification, benchmark
- `packages/contracts` — generated API contract artifacts shared with the web tests
- `data/` — raw, interim, processed (ignored) and manifests (committed)
- `docs/` — architecture, data notes, and decision records

## Troubleshooting

- **"No processed dataset" / API health `degraded`**: run `pnpm data:dev`, then restart the API.
- **"Raw dataset not found"**: check the path above, or pass `--raw-dir`.
- **Web shows "The PlayLens API could not be reached"**: start `pnpm dev:api` or set `NEXT_PUBLIC_PLAYLENS_API_BASE_URL`. The web app never falls back to synthetic data.
- **Python packages missing**: run `uv sync` from the repository root; it installs both workspace members.
- **Play view says "No trajectory model is served"**: run `pnpm ml:train` (or copy an artifact into `artifacts/models/`), start the API with `PLAYLENS_SUBSET=full`, and restart it.
- **Forecast returns `unsupported_origin`**: this model forecasts only from the last observed frame of a play.
- **Similar plays: "temporarily unavailable" / `/health` retrieval `unavailable`**: start the database (`colima start` if needed, then `pnpm db:up`); the API reconnects within a few seconds. The `reason` field in `/health` names the cause.
- **`retrieval_unavailable` … "computed on …@full-…, but this API serves …@dev-…"**: start the API with `PLAYLENS_SUBSET=full`; the embeddings cover the full dataset.
- **"No embeddings are loaded" / "Pending migrations"**: run `pnpm db:migrate` and `pnpm retrieval:load`.
- **"Phase 3 embedding artifact not found"**: run the Phase 3 workflow (`pnpm data:full`, `pnpm ml:splits`, `pnpm ml:train`, `pnpm ml:embeddings`). The loader never creates or downloads embeddings.
- **Port 5432 already in use**: set `PLAYLENS_DB_PORT` for compose and the matching port in `PLAYLENS_DATABASE_URL`.
