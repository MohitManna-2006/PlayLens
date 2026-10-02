# PlayLens web

This is the Next.js 16 app that implements `docs/PLAYLENS_DESIGN_BIBLE.md`: Explore, Play, Compare, PlayLab, Evaluation, and the Analyst. It uses a graphite, chalk, and amber design system with no component library, Geist type, Lucide icons, and a Canvas 2D field renderer.

## Run

```bash
pnpm install            # from the repo root (pnpm workspace)
pnpm dev                # http://localhost:3000
pnpm test               # vitest: geometry, alignment and sync, formatting, datasource and API contract, Similar Plays states (jsdom), analyst validation
pnpm lint && pnpm typecheck && pnpm build
```

Copy `.env.example` to `.env.local` to configure the data source:

| Variable | Values | Default |
|---|---|---|
| `NEXT_PUBLIC_PLAYLENS_DATA_SOURCE` | `api` (PlayLens FastAPI service, real NFL tracking) or `fixture` (synthetic plays, in-browser baseline and mock models) | `api` |
| `NEXT_PUBLIC_PLAYLENS_API_BASE_URL` | Base URL of the FastAPI service | `http://localhost:8000` |

In `api` mode an unreachable API shows an error state; the app never falls back to the fixture. The fixture is labeled "Synthetic fixture data" in the navigation. Its limits are described in `docs/decisions/ADR-0001-web-fixture-data-source.md`.

## API contract

`src/lib/contracts.ts` mirrors the Pydantic models in `services/api/src/playlens_api/schemas` and parses every response; a mismatch surfaces as a contract error. `src/lib/datasource/contract.test.ts` parses the generated examples in `packages/contracts/examples` and fails if a field is missing, mistyped, or unknown.

Served by the API:

| Method | Path | Returns |
|---|---|---|
| GET | `/api/v1/dataset` | `DatasetStatus` |
| GET | `/api/v1/plays?q&season&week&offense&defense&formation&coverage&down&distance&play_type&quarter&outcome&sort&page&page_size` | `PlayPage` |
| GET | `/api/v1/plays/facets` | `Facets` |
| GET | `/api/v1/plays/{id}` | `PlayDetail` (`id` = `"<game_id>-<play_id>"`) |
| GET | `/api/v1/plays/{id}/frames` | `FramesPayload` (observed frames, canonical coordinates, NGS angles) |
| GET | `/api/v1/plays/{id}/future` | `FuturePayload` (held-out actual future; ground truth, not a prediction) |
| GET | `/api/v1/models` | `ModelInfo[]` (empty until a model is trained; `retrieval` set when its embeddings are searchable) |
| POST | `/api/v1/predict/trajectory` | `TrajectoryPrediction` |
| GET | `/api/v1/evaluation/summary?model_version` | `EvaluationReport` |
| POST | `/api/v1/search/similar` | `SimilaritySearchResponse` (pgvector nearest neighbours, filters, evidence, provenance) |
| POST | `/api/v1/compare` | `CompareResponse` (embedding similarity and exact ranks, metadata and tracking evidence) |

Errors use `{ "error": { "code", "message", "status", "request_id", "details" } }`. A 4xx response is shown as a user error and a 5xx response as a server error.

Retrieval outages arrive as 503 `retrieval_unavailable` / `database_unavailable`; Similar Plays shows "temporarily unavailable" with Retry, and Compare keeps both replays and its tracking evidence. A play without a stored embedding is a 404 `embedding_unavailable`, shown as such; nothing else is substituted.

Not served yet, so `HttpSource` rejects them as `unavailable` without a request and the screens show unavailable states: PlayLab configuration and counterfactuals. The Analyst reads `/api/v1/analyst/status` and reports itself unavailable when the route does not exist.

## Layout of the code

```text
src/app/                   routes: explore, play/[id], compare, playlab/[id], evaluation
src/lib/contracts.ts       zod schemas for the web ⇄ API contract
src/lib/datasource/        typed client, HTTP source, synthetic fixture (simulator + baseline/mock models)
src/lib/playId.ts          PlayLens play ID format and parsing
src/lib/play/              forecast helpers, ground truth (actual future, landing spot)
src/lib/tracking/          geometry and orientation transform over canonical coordinates, series building, deterministic measures
src/lib/replay/            timestamp-driven replay clock, replay keyboard shortcuts
src/lib/compare/           sync modes (normalized progress, last observed frame, recording start, snap, phase) and sync on/off clocks
src/lib/similar/           Similar Plays filter chips and evidence summaries
src/lib/analyst/           event and generative-UI schemas, session store, transports, local tools
src/components/field/      canvas renderer (§12 layer order), viewport, overlays, legend, frame data table
src/components/replay/     dock and timeline
src/components/{explore,play,compare,playlab,evaluation,analyst}/
src/components/ui/         menus, popovers, tooltips, dialog, status states, metric rows
```

## Conventions

- Colors, type sizes, radii, and breakpoints come only from the tokens in `src/app/globals.css`. Tailwind defaults are cleared.
- Monospace is for frames, times, coordinates, distances, IDs, and versions. Missing values render as an em dash with a reason.
- Replay time comes from real timestamps. Seeks resolve to real frames and pause. Gaps are never bridged.
- The Analyst mounts only validated blocks and actions. Actions stay pinned to the context captured when the question was asked.
