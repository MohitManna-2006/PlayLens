"""Load the Phase 3 play embeddings into PostgreSQL + pgvector.

    uv run python -m playlens_api.retrieval.ingest \
        --model-version trajectory-gnn-transformer-v1 --subset full

Reads ``data/processed/<dataset>/<subset>/embeddings/<model_version>.parquet`` and
its committed manifest, validates both against the canonical dataset, joins a few
pre-snap context columns for filtering, and replaces the model version's rows in
one transaction:

* idempotent: rows whose values are unchanged are not rewritten, and a rerun
  reports zero inserts and updates;
* restart-safe: an interrupted run rolls back and leaves the previous state;
* exact: rows of that model version missing from the export are deleted, so the
  table mirrors the export, and the final row count is checked before commit.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import polars as pl
import psycopg
from pgvector.psycopg import register_vector
from playlens_ml.data.paths import find_repo_root

from ..config import DEFAULT_EMBEDDING_MODEL, Settings
from .artifact import (
    EmbeddingArtifact,
    EmbeddingArtifactError,
    ValidationReport,
    cosine_reference,
    load_artifact,
    search_rows,
    validate_artifact,
)
from .db import connect
from .migrate import MigrationError, schema_state

LOCK_KEY = 7_302_515
COLUMNS = (
    "play_id",
    "model_version",
    "dataset_version",
    "split_version",
    "split",
    "embedding",
    "season",
    "week",
    "quarter",
    "down",
    "yards_to_go",
    "offense",
    "defense",
    "offense_formation",
    "yards_from_own_goal",
)
VALUE_COLUMNS = COLUMNS[2:]


@dataclass
class LoadResult:
    model_version: str
    rows_read: int
    inserted: int
    updated: int
    unchanged: int
    deleted: int
    rows_in_database: int
    seconds: float
    validation: ValidationReport
    cosine_reference: dict[str, Any] = field(default_factory=dict)


def database_dimension(conn: psycopg.Connection) -> int:
    row = conn.execute(
        "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
        "WHERE attrelid = 'play_embeddings'::regclass AND attname = 'embedding'"
    ).fetchone()
    if row is None:
        raise MigrationError("play_embeddings.embedding is missing; run migrations.")
    text = str(row[0])  # e.g. vector(128)
    return int(text[text.index("(") + 1 : text.index(")")])


def _records(rows: pl.DataFrame, art: EmbeddingArtifact) -> list[tuple[Any, ...]]:
    vectors = art.vectors
    out = []
    for i, r in enumerate(rows.iter_rows(named=True)):
        out.append(
            (
                r["pid"],
                art.model_version,
                art.dataset_version,
                art.split_version,
                r["split"],
                vectors[i],
                r["season"],
                r["week"],
                r["quarter"],
                r["down"],
                r["yards_to_go"],
                r["offense"],
                r["defense"],
                r["offense_formation"],
                r["yards_from_own_goal"],
            )
        )
    return out


def load(
    conn: psycopg.Connection,
    model_version: str,
    subset: str = "full",
    data_root: Path | None = None,
) -> LoadResult:
    start = time.perf_counter()
    # Each block commits on exit, so the load below runs in its own top-level
    # transaction (temporary staging table dropped at commit) on any connection.
    with conn.transaction():
        state = schema_state(conn)
        if state.pending:
            raise MigrationError(
                f"Pending migrations {state.pending}; run `pnpm db:migrate` first."
            )
        register_vector(conn)
        dimension = database_dimension(conn)
    art = load_artifact(model_version, subset, data_root)
    report = validate_artifact(art, data_root, dimension)
    rows = search_rows(art, data_root)
    if rows["season"].null_count():
        raise EmbeddingArtifactError("Some embedded plays have no canonical metadata.")
    reference = cosine_reference(art.vectors)
    records = _records(rows, art)
    root = find_repo_root()
    rel = (
        str(art.path.relative_to(root))
        if art.path.is_relative_to(root)
        else str(art.path)
    )
    cols = ", ".join(COLUMNS)
    changed = " OR ".join(
        f"play_embeddings.{c} IS DISTINCT FROM excluded.{c}" for c in VALUE_COLUMNS
    )
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_KEY,))
        conn.execute(
            """
            INSERT INTO embedding_sets (model_version, dataset_version, split_version,
                dimension, normalization, artifact_path, artifact_sha256,
                model_weights_sha256, row_count, cosine_reference)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (model_version) DO UPDATE SET
                dataset_version = excluded.dataset_version,
                split_version = excluded.split_version,
                dimension = excluded.dimension,
                normalization = excluded.normalization,
                artifact_path = excluded.artifact_path,
                artifact_sha256 = excluded.artifact_sha256,
                model_weights_sha256 = excluded.model_weights_sha256,
                row_count = excluded.row_count,
                cosine_reference = excluded.cosine_reference,
                loaded_at = now()
            """,
            (
                model_version,
                art.dataset_version,
                art.split_version,
                art.dimension,
                str(art.manifest.get("normalization", "L2-normalised")),
                rel,
                str(art.manifest["sha256"]),
                str(art.manifest.get("model_weights_sha256", "")),
                len(records),
                json.dumps(reference),
            ),
        )
        conn.execute(
            "CREATE TEMP TABLE staging_embeddings "
            "(LIKE play_embeddings INCLUDING DEFAULTS) ON COMMIT DROP"
        )
        with conn.cursor().copy(
            f"COPY staging_embeddings ({cols}) FROM STDIN".encode()
        ) as copy:
            for rec in records:
                copy.write_row(rec)
        outcome = conn.execute(
            f"""
            INSERT INTO play_embeddings ({cols})
            SELECT {cols} FROM staging_embeddings
            ON CONFLICT (play_id, model_version) DO UPDATE SET
                {", ".join(f"{c} = excluded.{c}" for c in VALUE_COLUMNS)}
            WHERE {changed}
            RETURNING (xmax = 0) AS inserted
            """.encode()
        ).fetchall()
        inserted = sum(1 for (flag,) in outcome if flag)
        updated = len(outcome) - inserted
        deleted = conn.execute(
            "DELETE FROM play_embeddings p WHERE p.model_version = %s AND NOT EXISTS "
            "(SELECT 1 FROM staging_embeddings s WHERE s.play_id = p.play_id)",
            (model_version,),
        ).rowcount
        count_row = conn.execute(
            "SELECT count(*) FROM play_embeddings WHERE model_version = %s",
            (model_version,),
        ).fetchone()
        in_db = int(count_row[0]) if count_row else -1
        if in_db != len(records):
            raise EmbeddingArtifactError(
                f"After loading, the database holds {in_db} rows for {model_version}, "
                f"expected {len(records)}. Rolled back."
            )
        conn.execute("ANALYZE play_embeddings")
    return LoadResult(
        model_version=model_version,
        rows_read=art.table.height,
        inserted=inserted,
        updated=updated,
        unchanged=len(records) - inserted - updated,
        deleted=deleted,
        rows_in_database=in_db,
        seconds=round(time.perf_counter() - start, 2),
        validation=report,
        cosine_reference=reference,
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--model-version", default=DEFAULT_EMBEDDING_MODEL)
    parser.add_argument("--subset", default="full")
    parser.add_argument("--database-url", default=None)
    args = parser.parse_args(argv)
    settings = Settings()
    url = args.database_url or settings.database_url
    try:
        with connect(url, "playlens-ingest") as conn:
            result = load(conn, args.model_version, args.subset, settings.data_root)
    except (EmbeddingArtifactError, MigrationError, psycopg.Error) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    v = result.validation
    print(
        f"loaded {result.model_version}: read {result.rows_read} rows; inserted "
        f"{result.inserted}, updated {result.updated}, unchanged {result.unchanged}, "
        f"deleted {result.deleted}; {result.rows_in_database} rows in the database "
        f"({result.seconds} s)",
        file=sys.stderr,
    )
    print(f"  checks: {json.dumps(v.checks, default=str)}", file=sys.stderr)
    for note in v.notes:
        print(f"  note: {note}", file=sys.stderr)
    ref = result.cosine_reference
    rp, nn = ref.get("random_pairs") or {}, ref.get("nearest_neighbor") or {}
    print(
        f"  cosine reference: random pairs mean {rp.get('mean')} (p95 "
        f"{rp.get('p95')}); nearest neighbour median {nn.get('p50')}; mean vector "
        f"norm {ref.get('mean_vector_norm')}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
