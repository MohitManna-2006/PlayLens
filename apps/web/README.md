# PlayLens web

This is the Next.js 16 app that implements `docs/PLAYLENS_DESIGN_BIBLE.md`: Explore, Play, Compare, PlayLab, Evaluation, and the Analyst. It uses a graphite, chalk, and amber design system with no component library, Geist type, Lucide icons, and a Canvas 2D field renderer.

## Run

```bash
pnpm install            # from the repo root (pnpm workspace)
pnpm dev                # http://localhost:3000
pnpm test               # vitest: geometry, alignment, formatting, contracts, analyst validation
pnpm lint && pnpm typecheck && pnpm build
```

Copy `.env.example` to `.env.local` to choose a data source:

| Variable | Values | Default |
|---|---|---|
| `NEXT_PUBLIC_PLAYLENS_DATA_SOURCE` | `fixture` (synthetic plays, in-browser baseline and mock models) or `api` | `fixture` |
| `NEXT_PUBLIC_API_URL` | Base URL of the FastAPI service | `http://localhost:8000` |

The fixture is labeled "Synthetic fixture data" in the navigation. Its limits are described in `docs/decisions/ADR-0001-web-fixture-data-source.md`.

## API contract expected in `api` mode

`src/lib/contracts.ts` parses every response. A mismatch surfaces as a contract error.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/v1/plays?q&season&offense&defense&down&distance&play_type&quarter&outcome&sort&similar_to&page&page_size` | `PlayPage` |
| GET | `/api/v1/plays/facets` | `Facets` |
| GET | `/api/v1/plays/{id}` | `PlayDetail` |
| GET | `/api/v1/plays/{id}/frames` | `FramesPayload` (source coordinates, NGS angles) |
| GET | `/api/v1/models` | `ModelInfo[]` |
| POST | `/api/v1/search/similar` | `SimilarResult` |
| POST | `/api/v1/compare` | `CompareResult` |
| POST | `/api/v1/predict/trajectory` | `TrajectoryPrediction` |
| GET | `/api/v1/playlab/{id}/config` | `PlayLabConfig` (editable frame, radius, half-plane constraints) |
| POST | `/api/v1/playlab/counterfactual` | `CounterfactualResult` |
| GET | `/api/v1/evaluation/summary?model_version=` | `EvaluationReport` |
| GET | `/api/v1/analyst/status` | `{ available, reason }` |
| POST | `/api/v1/analyst/respond` | NDJSON stream of `AnalystEvent` (`src/lib/analyst/schema.ts`) |

Errors should use `{ "detail": "..." }`. A 4xx response is shown as a user error and a 5xx response as a server error.

## Layout of the code

```text
src/app/                   routes: explore, play/[id], compare, playlab/[id], evaluation
src/lib/contracts.ts       zod schemas for the web ⇄ API contract
src/lib/datasource/        typed client, HTTP source, synthetic fixture (simulator + baseline/mock models)
src/lib/tracking/          geometry and direction normalization, series building, deterministic measures
src/lib/replay/            timestamp-driven replay clock, replay keyboard shortcuts
src/lib/compare/           snap / recording-start / phase alignment
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
