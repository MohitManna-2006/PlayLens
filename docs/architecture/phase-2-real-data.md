# Phase 2: real NFL data vertical slice

```text
data/raw (immutable, Git-ignored)
   │  playlens_ml.data.preprocess   (pnpm data:dev)
   ▼
discover → check headers → typed load → validate full release → select plays → canonicalize
   │                                                                      │
   ▼                                                                      ▼
data/manifests/<dataset>.<subset>.manifest.json          data/processed/<dataset>/<subset>/
data/interim/<dataset>/play_index.<subset>.parquet         observed/  targets/  descriptive/  dataset.json
                                                                          │
                                   services/api (FastAPI)  ParquetPlayRepository → PlayService → /api/v1
                                                                          │
                                   apps/web  HttpSource → zod contracts → TrackingSeries → canvas replay
```

## Data pipeline (`ml/src/playlens_ml/data/`)

| Module | Responsibility |
|---|---|
| `paths.py` | Repo-relative data layout; `PLAYLENS_DATA_ROOT` override |
| `ids.py` | PlayLens play ID encode/decode |
| `coordinates.py` | Pure canonical transforms (scalar and Polars) |
| `bdb2026/spec.py` | Release layout, raw schemas, frame rate |
| `bdb2026/discovery.py` | Weekly file pairing, header checks |
| `bdb2026/load.py` | Typed CSV loading (the only place CSVs are parsed) |
| `bdb2026/validate.py` | Integrity checks over the full release, per-play exclusion reasons |
| `bdb2026/canonicalize.py` | Raw → canonical tables for chosen plays |
| `canonical_schema.py` | Every processed column: type, description, availability class |
| `availability.py` | Availability classes and the feature-column guard |
| `subset.py` | Deterministic dev subset rule |
| `artifacts.py` | Parquet writing, schema-checked loading |
| `manifest.py` | Checksums, schema fingerprints, dataset version, git info |
| `preprocess.py` | CLI orchestration and summary |
| `testing.py` | Synthetic raw datasets for tests and contract examples |

Command: `pnpm data:dev` (`uv run python -m playlens_ml.data.preprocess --dataset nfl_bdb_2026_analytics --subset dev`). `--subset full` writes every valid play.

### Processed artifacts

| Artifact | Rows (dev) | Content |
|---|---:|---|
| `observed/plays.parquet` | 54 | Identity, pre-snap context, line of scrimmage, frame ranges, counts, ball landing (raw and canonical) |
| `observed/players.parquet` | 652 | Name, position, side, role, `player_to_predict`, height, weight, birth date, roster order |
| `observed/tracking.parquet` | 19,404 | `frame_id`, `frame_index`, `time_s`, canonical `x y s a dir o`, raw `x y dir o` |
| `targets/future_trajectories.parquet` | 2,400 | Output-file positions, `frame_id` 1..n, `frame_index` continuing the observed window |
| `descriptive/annotations.parquet` | 54 | Charted labels: coverage, route, dropback, play action, pass location |
| `descriptive/outcomes.parquet` | 54 | Pass result, yards, EPA, WPA, penalty flags, narrative |
| `dataset.json` | — | Dataset version, schema version, counts, artifact checksums |

Rows are sorted by stable keys and written with fixed Parquet settings; a rerun on the same raw files reproduces every artifact byte for byte and the same dataset version (only `generated_at` changes).

## Canonical coordinate system

- Yards. `x` 0–120 along the field including both 10-yard end zones; `y` 0–53⅓ across it.
- The offense attacks toward +x on every play. Right-moving plays are unchanged. Left-moving plays are rotated 180° about the field center: `x' = 120 − x`, `y' = 53⅓ − y`, `dir' = (dir + 180) mod 360`, `o' = (o + 180) mod 360`. Speed and acceleration are unchanged.
- The rotation is its own inverse. Raw values stay in the artifacts; the API exposes `play_direction` and `coordinates.raw_transform`; the web Source view applies the rotation back.
- The line of scrimmage is `absolute_yardline_number` rotated the same way; the line to gain is the line of scrimmage + `yards_to_go`.
- `ball_land_x/y` are rotated with the same transform. They can lie outside the field (231 plays).
- Angles: degrees, 0° = +y, clockwise.
- Canonical analytical data is never interpolated. The renderer interpolates between real frames only for drawing; scrubbing, stepping, and inspection resolve to real frame IDs.

## Play IDs

`"<game_id>-<play_id>"`, for example `2023091008-3826` (`playlens_ml.data.ids`, `apps/web/src/lib/playId.ts`). URLs use it directly: `/play/2023091008-3826`. A malformed ID returns 422 `invalid_play_id`; a well-formed unknown ID returns 404 `play_not_found`. The web app shows both as a not-found state.

## API (`services/api`)

`routes → PlayService → PlayRepository (protocol) → ParquetPlayRepository`, with Pydantic response models in `schemas/`.

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | Liveness plus dataset readiness (`ok` or `degraded` with the reason) |
| GET | `/api/v1/dataset` | Dataset status and data-use note |
| GET | `/api/v1/plays` | Paginated summaries. Filters: `q`, `season`, `week`, `offense`, `defense`, `formation`, `coverage`, `down`, `distance`, `quarter`, `play_type`, `outcome`; `page`, `page_size` ≤ 200 |
| GET | `/api/v1/plays/facets` | Filter values present in the data |
| GET | `/api/v1/plays/{id}` | Detail: roster, geometry, coordinate info, provenance |
| GET | `/api/v1/plays/{id}/frames` | Observed frames only; optional `start_frame`, `end_frame` |
| GET | `/api/v1/plays/{id}/future` | Held-out actual future trajectories (ground truth, not predictions) |
| GET | `/api/v1/models` | The model registry; empty in Phase 2 |

Every error is `{"error": {"code", "message", "status", "request_id", "details"}}`. Logs are JSON lines with request ID, path, status, and duration; responses carry `X-Request-ID` and `Server-Timing`. If the processed dataset is missing the API still starts, `/health` reports `degraded`, and data routes return 503 with the command to run. OpenAPI: `http://localhost:8000/docs`; a generated copy is in `packages/contracts/openapi.json`.

Not served, deliberately: similarity, compare measures, trajectory prediction, PlayLab, evaluation, and the Analyst. `/api/v1/plays?sort=similarity` returns 422 `capability_unavailable`.

## Web app

- `lib/datasource/http.ts` is the only place that calls the API. It separates network, user (4xx), server (5xx), contract, and `unavailable` errors. Unserved model capabilities reject as `unavailable` without a request.
- The default source is the API (`NEXT_PUBLIC_PLAYLENS_API_BASE_URL`, default `http://localhost:8000`). The synthetic fixture runs only with `NEXT_PUBLIC_PLAYLENS_DATA_SOURCE=fixture`. An unreachable API shows an error state; it never shows fixture plays.
- Explore lists real plays with week, formation, and coverage filters and a coverage column. Play shows real metadata grouped as play context, charted labels, post-play outcome, and tracking.
- The field labels tokens with positions (the release has no jersey numbers), hides the ball legend when there is no ball track, and notes "Ball not tracked".
- Overlays add a "ground truth" group: **Actual future paths** (fetched from `/future` only when switched on, drawn as solid observed-style paths from each player's last observed position) and **Ball landing spot**. The predicted-path overlay stays disabled because no trajectory model is served.
- Compare shows both real replays aligned from recording start (neither play has a snap event) and marks structural measures unavailable. PlayLab, Evaluation, and the Analyst show unavailable states.

### Replay time model

One tracking frame is 0.1 s (10 Hz, verified from the data). `time_s = frame_index / 10`, measured from the first observed frame. The timeline covers the observed window only; the held-out future is never appended to it.

## Configuration

| Variable | Used by | Default |
|---|---|---|
| `PLAYLENS_DATA_ROOT` | preprocessing, API | `<repo>/data` |
| `PLAYLENS_SUBSET` | API | `dev` |
| `PLAYLENS_LOG_LEVEL` | API | `INFO` |
| `PLAYLENS_CORS_ORIGINS` | API | `http://localhost:3000`, `http://127.0.0.1:3000`; any local port is also allowed by `PLAYLENS_CORS_ORIGIN_REGEX` |
| `NEXT_PUBLIC_PLAYLENS_API_BASE_URL` | web | `http://localhost:8000` |
| `NEXT_PUBLIC_PLAYLENS_DATA_SOURCE` | web | `api` (`fixture` for synthetic plays) |

## Seams for Phase 3

- Game-level splits: `data/interim/<dataset>/play_index.<subset>.parquet` has one row per play with week, game, validity, and eligibility; `pnpm data:full` produces every valid play in the same schema.
- Graph construction and baselines read `observed/tracking.parquet` (canonical, 10 Hz, complete frames) and `targets/future_trajectories.parquet` (aligned `frame_index`). Feature builders call `check_feature_columns`.
- A trajectory model registers in `/api/v1/models`; the web app then enables the predicted-path overlay and draws predictions next to the actual future.
- Retrieval replaces or extends `ParquetPlayRepository` with PostgreSQL + pgvector behind the same protocol.
