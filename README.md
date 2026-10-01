# PlayLens

PlayLens is an AI-native NFL play intelligence platform that transforms player-tracking sequences into learned play representations that can be replayed, searched, compared, predicted, explained, and manipulated.

See [PLAYLENS_MASTERBRAIN.md](PLAYLENS_MASTERBRAIN.md) for the product specification, ML architecture, and guidelines.

## Current status: Phase 2 (real NFL data)

Real tracking from the NFL Big Data Bowl 2026 Analytics release flows through a deterministic preprocessing pipeline into canonical Parquet artifacts, a FastAPI service, and the existing web app. You can browse real plays in Explore and watch their tracking animate in Play.

No model is trained or served yet. Forecasts, similar plays, compare measures, PlayLab, evaluation metrics, and the Analyst show unavailable states in real-data mode rather than placeholder results.

- Architecture: [docs/architecture/phase-2-real-data.md](docs/architecture/phase-2-real-data.md)
- Dataset notes, validation findings, and limitations: [docs/data/nfl-bdb-2026-analytics.md](docs/data/nfl-bdb-2026-analytics.md)
- Decision record: [docs/decisions/ADR-0002-canonical-play-data-model.md](docs/decisions/ADR-0002-canonical-play-data-model.md)

## Prerequisites

- Node.js ≥ 22 and pnpm ≥ 9
- Python ≥ 3.12 and [uv](https://docs.astral.sh/uv/)
- The NFL Big Data Bowl 2026 Analytics files (not in this repository; see below)
- Docker is not needed for Phase 2

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

`pnpm data:full` writes every valid play (14,108) with the same code.

## Run

```bash
pnpm dev          # API on :8000 and web on :3000, together
# or separately
pnpm dev:api      # uv run --directory services/api uvicorn playlens_api.main:app --reload --port 8000
pnpm dev:web      # pnpm --filter web dev
```

Open `http://localhost:3000/explore`, choose a play, or go straight to a play such as `http://localhost:3000/play/2023091008-3826`. If port 3000 is taken, Next.js picks the next free port; the API accepts any local port.

API docs: `http://localhost:8000/docs`. Health: `http://localhost:8000/health`.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_PLAYLENS_API_BASE_URL` | `http://localhost:8000` | Where the web app finds the API |
| `NEXT_PUBLIC_PLAYLENS_DATA_SOURCE` | `api` | Set to `fixture` for synthetic interface-development plays |
| `PLAYLENS_DATA_ROOT` | `<repo>/data` | Data directory for preprocessing and the API |
| `PLAYLENS_SUBSET` | `dev` | Processed subset the API serves (`dev` or `full`) |

Web variables go in `apps/web/.env.local` (see `apps/web/.env.example`).

## Development commands

- `pnpm lint` — ESLint (web) and Ruff (Python)
- `pnpm typecheck` — TypeScript and mypy (strict)
- `pnpm test` — Vitest and pytest
- `pnpm build` — production web build
- `pnpm contracts:generate` — regenerate `packages/contracts` (OpenAPI and example payloads from a synthetic dataset)

## Repository structure

- `apps/web` — Next.js frontend
- `services/api` — FastAPI service (`playlens_api`)
- `ml/` — Python ML package (`playlens_ml`); `playlens_ml.data` holds the dataset adapter and canonical schema
- `packages/contracts` — generated API contract artifacts shared with the web tests
- `data/` — raw, interim, processed (ignored) and manifests (committed)
- `docs/` — architecture, data notes, and decision records

## Troubleshooting

- **"No processed dataset" / API health `degraded`**: run `pnpm data:dev`, then restart the API.
- **"Raw dataset not found"**: check the path above, or pass `--raw-dir`.
- **Web shows "The PlayLens API could not be reached"**: start `pnpm dev:api` or set `NEXT_PUBLIC_PLAYLENS_API_BASE_URL`. The web app never falls back to synthetic data.
- **Python packages missing**: run `uv sync` from the repository root; it installs both workspace members.
