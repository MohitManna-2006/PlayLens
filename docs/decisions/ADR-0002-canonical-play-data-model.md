# ADR-0002: Canonical play data model and the NFL BDB 2026 Analytics adapter

Date: 2026-09-30

## Context

Phase 2 replaces the synthetic fixture with real tracking from the NFL Big Data Bowl 2026 Analytics release (see `docs/data/nfl-bdb-2026-analytics.md`). That release is organized around trajectory prediction: an observed input window, held-out future positions for some players, and a supplementary file that mixes pre-snap context, charted labels, and post-play outcomes. It has no ball track and no event annotations.

The product needs one representation that the replay, the API, and the later models (graph construction, trajectory baselines, embeddings) can all rely on without another data rewrite, and that makes leakage of future or outcome information hard.

## Decision

1. **Adapter plus canonical schema.** Dataset-specific code lives in `ml/src/playlens_ml/data/bdb2026/` (file layout, raw schemas, loading, validation, canonicalization). The canonical artifacts are defined once in `canonical_schema.py`; every column has a type, a description, and an availability class. The API and future ML code read processed data only through `artifacts.load_processed`, which rejects artifacts that do not match the schema.
2. **Canonical coordinates are stored, raw values are kept.** Plays recorded moving left are rotated 180° (`x' = 120 − x`, `y' = 53⅓ − y`, `angle' = angle + 180 mod 360`) so the offense always attacks toward +x. `x_raw`, `y_raw`, `dir_raw`, `o_raw`, and `play_direction_raw` stay in the Parquet artifacts. The rotation is its own inverse, so the web app's Source view re-applies it for display.
3. **Artifacts are split by availability**: `observed/` (plays, players, tracking), `targets/` (future trajectories), `descriptive/` (charted annotations, post-play outcomes). `check_feature_columns` refuses targets, annotations, and outcomes as model inputs, and requires an explicit opt-in for fields that describe the pass (`task_input_at_origin`).
4. **Play identity** is `"<game_id>-<play_id>"`. Resources carry the external `id` plus integer `game_id` and `play_id`.
5. **Deterministic development subset.** Preprocessing validates the full release, then selects 3 plays per week (54 plays) by eligibility filters and a diversity-first greedy pick with salted SHA-256 tie-breaks. The rule is recorded in the manifest; the same raw files always produce the same subset and byte-identical Parquet.
6. **Storage for Phase 2 is Parquet plus an in-process index.** Per-play metadata is indexed at API startup; tracking is read per play with predicate pushdown and cached. Routes and services depend on a `PlayRepository` protocol, so a PostgreSQL implementation can replace the Parquet one later.
7. **The web app defaults to the API.** The synthetic fixture remains available only with `NEXT_PUBLIC_PLAYLENS_DATA_SOURCE=fixture`. There is no automatic fallback. Model capabilities the API does not serve reject as `unavailable` and render as unavailable states.

## Alternatives considered

- **Keep source coordinates in the API and normalize only for display** (the Phase 1 web contract). Rejected: the Masterbrain wants model inputs in a consistent frame, and doing the transform once in preprocessing avoids two implementations drifting. The display is unchanged because the rotation is an involution.
- **Mirror (reflect y) instead of rotating left-moving plays.** Rejected: a mirror flips handedness (the offense's left becomes its right), which would corrupt route and sideline semantics.
- **One wide play table with every supplementary column.** Rejected: it puts outcomes one `select` away from features.
- **Load the processed dataset into PostgreSQL now.** Rejected for Phase 2: it adds a service to run and migrate without a query the Parquet index cannot answer. Retrieval (pgvector) is the trigger.
- **Random sample for the dev subset.** Rejected: not diverse by construction, and its reproducibility depends on library RNG details.

## Consequences

- The `/api/v1` play contract changed (schema version 2): `id` replaces the Phase 1 string `play_id`, metadata is grouped into `context`, `annotations`, `outcome`, and `tracking`, frames carry `frame_index`, and a separate `/future` resource holds held-out trajectories. The fixture was updated to the same contract.
- The design bible describes direction normalization as a display transform. Behavior is the same, but the stored frame is now the normalized one and the Source view is the transform.
- Real replays show a partial field (no linemen, no ball) and no event markers. The UI says so rather than filling gaps.
- `pnpm data:dev` takes about four seconds on the full release, including SHA-256 checksums of every raw file. `pnpm data:full` produces all 14,108 plays (136 MB of Parquet) and the API serves them with the same code.

## Revisit trigger

- Retrieval work needs SQL filters or vector search → add a PostgreSQL `PlayRepository`.
- A second tracking release or season arrives → add an adapter next to `bdb2026/` that emits the same canonical schema.
- A task needs pre-throw inputs → build features with `check_feature_columns(..., allow_task_inputs=False)`.

## Relevant commit/PR

Phase 2 real-data vertical slice (this change).
