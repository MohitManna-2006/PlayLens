# PlayLens

PlayLens is an AI-native NFL play intelligence platform that transforms player-tracking sequences into learned play representations that can be replayed, searched, compared, predicted, explained, and manipulated.

See the [PLAYLENS_MASTERBRAIN.md](PLAYLENS_MASTERBRAIN.md) document for the complete product specification, ML architecture, and guidelines.

## Current Status: Phase 1 (Foundation)

The project currently has a minimal development stack initialized, including a Next.js frontend, a FastAPI backend, a Python ML package structure, and local Docker infrastructure (PostgreSQL + pgvector and Redis).

No actual ML models or NFL data features are implemented yet.

## Prerequisites

- Node.js (>= 22 LTS)
- pnpm (>= 9)
- Python (>= 3.12)
- uv (Python package manager)
- Docker Desktop / Docker Compose

## Installation

### 1. JavaScript/TypeScript Environment
```bash
corepack enable
pnpm install
```

### 2. Python Environment
```bash
uv sync
```

### 3. Environment Configuration
```bash
cp .env.example .env
```
*(Optionally update `.env` with actual development credentials if needed).*

## Running Locally

### Start Infrastructure (Database & Redis)
```bash
pnpm infra:up
```

### Start API Backend
```bash
pnpm dev:api
```

### Start Frontend Web App
```bash
pnpm dev:web
```

The frontend will be available at `http://localhost:3000` and will display the health status of the backend systems.

## Development Commands

- `pnpm lint`: Run ESLint on the frontend and Ruff on the Python code.
- `pnpm format`: Run Prettier on the frontend and Ruff formatter on the Python code.
- `pnpm typecheck`: Run TypeScript compilation check on frontend and mypy on Python code.
- `pnpm test`: Run frontend tests (Vitest) and backend tests (pytest).
- `pnpm contracts:generate`: (Placeholder) Generate TypeScript contracts from the OpenAPI schema.

## Repository Structure

- `apps/web`: Next.js frontend
- `services/api`: FastAPI backend
- `ml/`: Python ML package for models, features, training
- `infra/`: Docker and deployment configs
- `docs/`: Architecture and decision records

## Troubleshooting

- **Python dependencies not resolving**: Ensure you're using `uv sync` and not `pip install`. If you're on a Mac, `uv` should correctly fetch CPU/MPS wheels.
- **Database connection failed**: Ensure `pnpm infra:up` was run successfully and `docker ps` shows the `postgres` container running.
- **Frontend can't reach API**: Check if `NEXT_PUBLIC_API_URL` is correct in `.env` and `pnpm dev:api` is actively running.
