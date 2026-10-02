# ADR-0005: Similarity retrieval with PostgreSQL + pgvector

Date: 2026-10-01

## Context

Phase 3 exported one 128-d, L2-normalised play embedding per play (14,108 plays) from the served trajectory encoder `trajectory-gnn-transformer-v1` (ADR-0004). Phase 4 turns that representation into a product: Similar Plays on the Play view and a synchronized Compare view, with metadata filters, inspectable evidence, and an honest account of what a similarity score means.

Constraints that shaped the decision:

- The embeddings are frozen. Retrieval must use them as exported: no centering, whitening, renormalisation, or retraining (that would be a new representation version).
- The space is anisotropic: random play pairs average cosine 0.44 (Phase 3), and each play's nearest neighbour typically scores about 0.99. Absolute scores are not interpretable on their own.
- The corpus is small (14,108 vectors) and runs on a laptop: Colima VM with 2 CPUs and 3.8 GiB.
- Filters must be trustworthy. Pre-snap context (down, distance, quarter, teams, formation, field position) has full coverage; charted labels (coverage, route) are recorded after the play.
- Replay, forecasts, and Compare's tracking evidence must keep working when the database is down.
- The Masterbrain names PostgreSQL + pgvector + HNSW for retrieval and asks to keep an exact mode for evaluating the index (§12).

## Decision

1. **Store**: one PostgreSQL 18 + pgvector 0.8.7 service in Docker Compose (`pgvector/pgvector:0.8.7-pg18-trixie`, pinned, multi-arch). Schema by plain versioned SQL migrations (`services/api/src/playlens_api/retrieval/migrations/`, applied by a ~100-line runner with checksums and an advisory lock), not an ORM.
2. **Schema**: `embedding_sets` (one row per imported export: model, dataset and split versions, artifact and weight hashes, dimension, row count, and the cosine reference distribution) and `play_embeddings` keyed by `(play_id, model_version)` with `embedding vector(128)`, the play's split, and a few pre-snap filter columns copied from the canonical dataset. Tracking frames stay in Parquet.
3. **Metric**: cosine distance (`<=>`), reported as `cosine_distance` and `cosine_similarity = 1 − distance`. Never presented as a probability, confidence, or percentage.
4. **Index**: HNSW with `vector_cosine_ops`, m = 16, ef_construction = 64 (pgvector defaults, written out). Approximate search sets `hnsw.ef_search = max(40, k)` and `hnsw.iterative_scan = relaxed_order` per transaction (`SET LOCAL`), and re-sorts by `(distance, play_id)`.
5. **Exact search is kept** as a first-class mode (`mode: "exact"`): index scans disabled for the transaction, sequential scan, ordered by `(distance, play_id)`. It is the ground truth for evaluating the index, and it is itself verified against an independent NumPy brute force (`pnpm retrieval:verify`).
6. **Report the plan, do not assume it.** For approximate requests the store runs `EXPLAIN` on the exact statement it then executes (unprepared, so no generic plan can differ) and reports `plan: hnsw_index_scan | exact_scan`. Under very selective filters PostgreSQL may choose an exact scan; the response says so.
7. **Filters** are a fixed allowlist of parameterised predicates on pre-snap context and split, applied inside the same SQL statement as the vector order. Charted labels are evidence only, never filters, and are always marked as charted and not model inputs.
8. **Evidence** is deterministic and separate from the retrieval signal: metadata relations (same / different) and five structural tracking descriptors (`playlens_ml.descriptors`, computed once at API startup from the canonical Parquet tracking), each with a stable ID, definition, and frame reference.
9. **Degrade, don't fail**: the API opens its read-only pool without waiting, `/health` reports the retrieval block (`ready | unavailable | disabled`), retrieval routes return typed 503s, and Compare still returns its tracking evidence without similarity.
10. **Model-version isolation**: every query filters on `model_version`; a query embedding from one version is never compared with another version's vectors.

## Why PostgreSQL + pgvector

- It is the store the Masterbrain already commits to, so there is one database to run, back up, and reason about, and metadata filters are ordinary SQL in the same statement as the vector search.
- pgvector 0.8's iterative index scans solve the classic filtered-ANN failure (an index returning fewer than k rows after filtering) inside the database.
- At this scale an exact sequential scan is a few milliseconds, so exact search stays practical as ground truth and as a fallback.

## Why cosine

The vectors are L2-normalised at export, so cosine distance ranks exactly like the dot product, and the Phase 3 sanity checks were done in cosine. Euclidean distance on unit vectors is a monotone function of cosine and would add nothing.

## Why HNSW

It is pgvector's best recall/latency index and needs no training step (IVFFlat needs representative data to pick lists and degrades as data shifts). Measured on this corpus (docs/evaluation/retrieval-v1.md, 600 queries): HNSW returned exactly the exact-search neighbours (recall@5/10/20 = 1.000 at every tested `ef_search` from 10 to 200, with iterative scans), and its nearest-neighbour statement took 1.2 ms at the median against 4.6 ms for the exact scan. That is a real reduction in database retrieval latency (also at p95: 2.6 vs 5.2 ms), but a modest one in practice: both are small next to the rest of a request (about 9 ms server side for an approximate search, 11 ms exact), and under very selective filters the index is no faster than the scan. The benefit grows with the corpus.

## Alternatives considered

- **NumPy / FAISS in the API process.** Fastest at 14k vectors and no service to run, but filters and provenance would be reimplemented in Python, every API process would hold a copy, and it would not exercise the database the Masterbrain plans for. An in-memory store over the same NumPy reference is kept for tests and generated contract examples only; `create_app` never builds it from settings.
- **A dedicated vector database** (Qdrant, Milvus, Weaviate). Another service, client, and failure mode for a 14k-row corpus that PostgreSQL handles in milliseconds.
- **IVFFlat.** Needs list tuning and retraining as data grows; no advantage here.
- **Centering the embeddings** to reduce anisotropy. It would change the representation (a new version) and is out of scope for a phase that must prove the frozen vectors work. Recorded as a future, separately versioned experiment.
- **Alembic.** Already a dependency, but plain SQL files plus a small runner keep the migration story readable without an ORM.
- **A separate metadata table joined at query time.** Equivalent results, but a join makes the planner's choice between HNSW and a scan less predictable; a few denormalised columns on the embedding row keep filters in one table.
- **Forcing the HNSW index under selective filters** (`enable_seqscan = off`). PostgreSQL then picks a bitmap scan on the primary key instead, and a forced index scan over a nearly empty filter result walks the whole graph. Letting the planner choose and reporting the plan is simpler and honest.

## Consequences

- Phase 4 needs Docker (Colima here) for similarity. Replay and forecasts do not.
- `pnpm db:up`, `pnpm db:migrate`, `pnpm retrieval:load` are part of setup; `pnpm retrieval:verify` and `pnpm retrieval:benchmark` produce the evidence in `docs/evaluation/retrieval-v1.*`.
- The `vector(128)` column fixes the dimension. A model with another dimension needs a new column or table and migration; the importer refuses a mismatched export.
- A second model version shares the HNSW index; filtering by `model_version` keeps results correct (iterative scans), but a partial index per version would be more efficient.
- API startup computes structural descriptors for every served play (about 0.35–1.2 s for 14,108 plays, streaming Polars).
- CI runs the integration tests against the same pgvector image as a service container, with tiny deterministic vectors; the full benchmark runs locally only.
- Two departures from earlier planning documents, following the Phase 4 instructions: the embedding column is `vector(128)` (the real export), not the Masterbrain §22.1 placeholder `vector(512)`; and Compare's default synchronization is normalized progress, not the design bible's snap-relative default (§8). This dataset has no snap events, so snap alignment could never apply; snap and phase modes remain for sources that supply events.

## Revisit triggers

- The corpus grows past what an exact scan serves interactively (order of 10⁵–10⁶ vectors), or HNSW recall at the served `ef_search` drops below 0.99 → re-tune `ef_search`/`m`, consider halfvec or quantization.
- A second embedding model is served → partial HNSW index per `model_version`, or a table per dimension.
- Retrieval quality, not speed, becomes the bottleneck → evaluate a centered or retrieval-trained representation as a new, separately versioned embedding set; compare against the temporal-only encoder's embeddings.
- Concurrency needs exceed a 4-connection pool on one API process → measure, then size the pool or add replicas.

## Relevant commit/PR

Phase 4 similarity search and Compare (this change).
