"""Verify the loaded embeddings and exact pgvector search against NumPy.

    uv run python -m playlens_api.retrieval.verify

1. Schema current, pgvector installed, an HNSW index present.
2. Provenance in ``embedding_sets`` equals the export manifest; the row count equals
   the export.
3. Every stored vector equals the exported float32 vector bit for bit.
4. For a deterministic sample of query plays, exact pgvector search returns the
   same neighbours in the same order as an independent NumPy brute force, with
   and without filters, and never the query play itself.

Exits non-zero on any mismatch. The ANN path is evaluated separately by
``pnpm retrieval:benchmark``, which treats exact search as ground truth.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import polars as pl
import psycopg
from pgvector.psycopg import register_vector

from ..config import DEFAULT_EMBEDDING_MODEL, Settings
from .artifact import EmbeddingArtifact, load_artifact, search_rows
from .db import connect
from .reference import compare_to_reference, eligible, topk, unit
from .store import read_status, run_search
from .types import SearchFilters, SearchQuery

SALT = "retrieval-verify-v1"


def sample_queries(
    ids: list[str], splits: list[str], per_split: int, salt: str
) -> list[int]:
    """Deterministic, stratified sample: the ``per_split`` plays of each split with
    the smallest salted SHA-256 of their ID (no RNG, no inspection)."""
    chosen: list[int] = []
    for split in ("train", "validation", "test"):
        members = [i for i, s in enumerate(splits) if s == split]
        members.sort(key=lambda i: hashlib.sha256(f"{salt}:{ids[i]}".encode()).digest())
        chosen.extend(members[:per_split])
    return chosen


def filter_scenarios(row: dict[str, Any]) -> dict[str, SearchFilters]:
    """Filters derived from the query play's own context, plus fixed ones."""
    ytg = int(row["yards_to_go"])
    return {
        "none": SearchFilters(),
        "same_down": SearchFilters(down=int(row["down"])),
        "distance_range": SearchFilters(
            yards_to_go_min=max(1, ytg - 2), yards_to_go_max=ytg + 2
        ),
        "same_quarter": SearchFilters(quarter=int(row["quarter"])),
        "weeks_1_4": SearchFilters(week_min=1, week_max=4),
        "same_offense_and_down": SearchFilters(
            offense=str(row["offense"]), down=int(row["down"])
        ),
        "multi": SearchFilters(
            down=int(row["down"]),
            yards_to_go_min=max(1, ytg - 3),
            yards_to_go_max=ytg + 3,
            quarter=int(row["quarter"]),
            offense_formation=str(row["offense_formation"]),
        ),
        "held_out_only": SearchFilters(splits=("validation", "test")),
        "no_match": SearchFilters(down=4, quarter=5, offense="ZZZ"),
    }


@dataclass
class VerifyReport:
    ok: bool = True
    checks: dict[str, Any] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)

    def fail(self, message: str) -> None:
        self.ok = False
        self.problems.append(message)


def verify(
    conn: psycopg.Connection,
    art: EmbeddingArtifact,
    rows: pl.DataFrame,
    per_split: int = 40,
    k: int = 10,
) -> VerifyReport:
    report = VerifyReport()
    register_vector(conn)
    status = read_status(conn)
    report.checks["server_version"] = status.server_version
    report.checks["pgvector_version"] = status.pgvector_version
    report.checks["schema_version"] = status.schema_version
    if status.pending_migrations:
        report.fail(f"pending migrations {status.pending_migrations}")
    if status.index is None:
        report.fail("no HNSW index on play_embeddings")
    else:
        report.checks["index"] = status.index.__dict__
    sets = {s.model_version: s for s in status.embedding_sets}
    emb = sets.get(art.model_version)
    if emb is None:
        report.fail(f"no embedding set for {art.model_version}; run retrieval:load")
        return report
    m = art.manifest
    for name, have, expected in (
        ("dataset_version", emb.dataset_version, m["dataset_version"]),
        ("split_version", emb.split_version, m["split_version"]),
        ("artifact_sha256", emb.artifact_sha256, m["sha256"]),
        ("model_weights_sha256", emb.model_weights_sha256, m["model_weights_sha256"]),
        ("dimension", emb.dimension, m["dimension"]),
    ):
        if have != expected:
            report.fail(f"{name}: database {have} != manifest {expected}")
    report.checks["provenance_matches_manifest"] = report.ok

    with conn.transaction():
        stored = conn.execute(
            "SELECT play_id, embedding, split FROM play_embeddings "
            "WHERE model_version = %s",
            (art.model_version,),
        ).fetchall()
    report.checks["rows_in_database"] = len(stored)
    report.checks["rows_in_export"] = art.table.height
    if len(stored) != art.table.height:
        report.fail(f"database has {len(stored)} rows, export {art.table.height}")
    ids = art.ids
    index_of = {pid: i for i, pid in enumerate(ids)}
    vectors = art.vectors
    max_diff = 0.0
    split_mismatch = 0
    splits = [str(s) for s in art.table["split"].to_list()]
    for pid, vec, split in stored:
        i = index_of.get(pid)
        if i is None:
            report.fail(f"database play {pid} is not in the export")
            continue
        stored_vec = vec.to_numpy() if hasattr(vec, "to_numpy") else np.asarray(vec)
        max_diff = max(max_diff, float(np.abs(stored_vec - vectors[i]).max()))
        split_mismatch += split != splits[i]
    report.checks["vector_max_abs_difference"] = max_diff
    if max_diff != 0.0:
        report.fail(f"stored vectors differ from the export by up to {max_diff:.3e}")
    if split_mismatch:
        report.fail(f"{split_mismatch} stored split labels differ from the export")

    uv = unit(vectors)
    queries = sample_queries(ids, splits, per_split, SALT)
    meta = rows.to_dicts()
    tally: dict[str, dict[str, int | float]] = {}
    for qi in queries:
        for name, flt in filter_scenarios(meta[qi]).items():
            q = SearchQuery(ids[qi], art.model_version, k, "exact", flt)
            got = run_search(conn, q)
            expected = topk(uv, ids, qi, k, eligible(rows, flt, ids[qi]))
            agree = compare_to_reference(
                [(h.play_id, h.distance) for h in got.hits], uv, index_of, qi, expected
            )
            t = tally.setdefault(
                name,
                {"queries": 0, "identical": 0, "equivalent": 0, "max_err": 0.0},
            )
            t["queries"] += 1
            t["identical"] += agree.identical
            t["equivalent"] += agree.equivalent
            t["max_err"] = max(float(t["max_err"]), agree.max_distance_error)
            if got.plan != "exact_scan":
                report.fail(f"exact search used {got.plan}")
            if any(h.play_id == ids[qi] for h in got.hits):
                report.fail(f"self-match returned for {ids[qi]} ({name})")
            if not agree.equivalent:
                report.fail(
                    f"{ids[qi]} [{name}]: pgvector {[h.play_id for h in got.hits]} "
                    f"!= reference {[e.play_id for e in expected]}"
                )
    report.checks["exact_vs_numpy"] = {
        "k": k,
        "query_plays": len(queries),
        "per_split": per_split,
        "sample_rule": f"smallest sha256('{SALT}:<play_id>') per split",
        "scenarios": tally,
    }
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--model-version", default=DEFAULT_EMBEDDING_MODEL)
    parser.add_argument("--subset", default="full")
    parser.add_argument("--per-split", type=int, default=40)
    parser.add_argument("--database-url", default=None)
    args = parser.parse_args(argv)
    settings = Settings()
    try:
        art = load_artifact(args.model_version, args.subset, settings.data_root)
        rows = search_rows(art, settings.data_root)
        with connect(
            args.database_url or settings.database_url, "playlens-verify"
        ) as conn:
            report = verify(conn, art, rows, args.per_split)
    except (RuntimeError, psycopg.Error) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    print(json.dumps(report.checks, indent=2, default=str), file=sys.stderr)
    if not report.ok:
        print("FAILED:\n  - " + "\n  - ".join(report.problems[:20]), file=sys.stderr)
        return 1
    print("verify: OK", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
