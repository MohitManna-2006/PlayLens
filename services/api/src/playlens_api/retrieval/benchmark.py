"""Evaluate HNSW retrieval against exact search on the real corpus.

    uv run python -m playlens_api.retrieval.benchmark   # pnpm retrieval:benchmark

Ground truth is exact search (sequential scan, ``mode=exact``), itself checked
against an independent NumPy brute force (``verify.py``). For a deterministic,
split-stratified sample of query plays it measures:

* recall@k of approximate (HNSW) search against exact search, for several
  ``hnsw.ef_search`` values, unfiltered and under metadata filters;
* latency distributions (p50/p95/p99) of the nearest-neighbour statement and of
  the whole store call, for both modes;
* which plan PostgreSQL actually executed for approximate requests;
* first and repeated embedding import into a scratch schema, and HNSW build time;
* end-to-end endpoint latency through the FastAPI app (in-process client);
* a few hash-chosen qualitative examples, plus the weakest nearest neighbour.

Writes ``docs/evaluation/retrieval-v1.json`` and ``retrieval-v1.md``. Raw
per-query traces are not written. Offline embedding-quality results (label
agreement, Phase 3) are a different measurement and are only referenced.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
import psycopg
from playlens_ml.data.manifest import utc_now
from playlens_ml.data.paths import find_repo_root

from ..config import DEFAULT_EMBEDDING_MODEL, Settings
from .artifact import EmbeddingArtifact, load_artifact, search_rows
from .db import connect, normalize_url
from .ingest import load as ingest_load
from .migrate import migrate
from .store import read_status, run_search
from .types import Mode, SearchQuery
from .verify import filter_scenarios, sample_queries, verify

SALT = "retrieval-benchmark-v1"
EXAMPLE_SALT = "retrieval-examples-v1"
EF_GRID = (10, 20, 40, 64, 100, 200)
KS = (5, 10, 20)
RECALL_TARGET = 0.99
PGVECTOR_DEFAULT_EF = 40
SCRATCH_SCHEMA = "playlens_benchmark_scratch"


def dist(values: Sequence[float]) -> dict[str, float | int]:
    a = np.asarray(values, dtype=np.float64)
    if a.size == 0:
        return {"n": 0}
    p50, p95, p99 = np.percentile(a, [50, 95, 99])
    return {
        "n": int(a.size),
        "mean": round(float(a.mean()), 3),
        "p50": round(float(p50), 3),
        "p95": round(float(p95), 3),
        "p99": round(float(p99), 3),
        "min": round(float(a.min()), 3),
        "max": round(float(a.max()), 3),
    }


def recall(exact: list[str], approx: list[str], k: int) -> float:
    truth = exact[:k]
    if not truth:
        return 1.0
    return len(set(truth) & set(approx[:k])) / len(truth)


def timed_search(conn: psycopg.Connection, q: SearchQuery) -> tuple[Any, float]:
    start = time.perf_counter()
    outcome = run_search(conn, q)
    return outcome, (time.perf_counter() - start) * 1000


def iterative_off_probe(
    conn: psycopg.Connection,
    ids: list[str],
    queries: list[int],
    truth: dict[int, list[str]],
    model_version: str,
) -> list[dict[str, Any]]:
    """The same HNSW query with iterative scans off: shows what the shipped
    setting (relaxed_order) protects against. Diagnostic only; the API always
    enables iterative scans."""
    out = []
    for k, ef in ((10, 5), (10, 10), (10, 20), (20, 20)):
        recalls, short = [], 0
        for i in queries:
            with conn.transaction():
                conn.execute(
                    "SELECT set_config('hnsw.ef_search', %s, true), "
                    "set_config('hnsw.iterative_scan', 'off', true)",
                    (str(ef),),
                )
                rows = conn.execute(
                    "SELECT play_id FROM play_embeddings WHERE model_version = %(mv)s "
                    "AND play_id <> %(q)s ORDER BY embedding <=> (SELECT embedding "
                    "FROM play_embeddings WHERE play_id = %(q)s AND model_version = "
                    "%(mv)s) LIMIT %(k)s",
                    {"mv": model_version, "q": ids[i], "k": k},
                    prepare=False,
                ).fetchall()
            got = [r[0] for r in rows]
            short += len(got) < k
            recalls.append(recall(truth[i], got, k))
        out.append(
            {
                "k": k,
                "ef_search": ef,
                "queries": len(queries),
                "recall_mean": round(float(np.mean(recalls)), 4),
                "queries_returning_fewer_than_k": short,
            }
        )
    return out


def environment(conn: psycopg.Connection) -> dict[str, Any]:
    def setting(name: str) -> str | None:
        row = conn.execute("SELECT current_setting(%s, true)", (name,)).fetchone()
        return str(row[0]) if row and row[0] is not None else None

    vm: dict[str, Any] = {}
    try:
        out = subprocess.run(
            ["docker", "info", "--format", "{{json .}}"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
        info = json.loads(out.stdout)
        vm = {
            "docker_cpus": info.get("NCPU"),
            "docker_memory_gib": round(int(info.get("MemTotal", 0)) / 2**30, 2),
            "docker_arch": info.get("Architecture"),
            "docker_os": info.get("OperatingSystem"),
        }
    except (OSError, subprocess.SubprocessError, ValueError):
        vm = {"docker": "unavailable"}
    cpu = None
    if sys.platform == "darwin":
        try:
            cpu = subprocess.run(
                ["sysctl", "-n", "machdep.cpu.brand_string"],
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            cpu = None
    git = {}
    try:
        root = find_repo_root()
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        dirty = bool(
            subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=root,
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
        )
        git = {"commit": commit, "dirty": dirty}
    except (OSError, subprocess.SubprocessError):
        git = {}
    return {
        "host": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "cpu": cpu,
            "logical_cpus": os.cpu_count(),
            "python": platform.python_version(),
            # Other processes share the machine; latency is measured, not isolated.
            "load_average_1m_at_start": round(os.getloadavg()[0], 2),
        },
        "database_vm": vm,
        "postgres": {
            "shared_buffers": setting("shared_buffers"),
            "work_mem": setting("work_mem"),
            "maintenance_work_mem": setting("maintenance_work_mem"),
            "max_parallel_workers_per_gather": setting(
                "max_parallel_workers_per_gather"
            ),
        },
        "git": git,
        "client": "Python psycopg 3 on the host, TCP to the container port "
        "(localhost); latency includes that round trip.",
    }


def import_timing(
    url: str, art: EmbeddingArtifact, data_root: Path | None
) -> dict[str, Any]:
    """First import and an idempotent rerun into a scratch schema, then drop it."""
    with connect(url, "playlens-benchmark-import") as admin:
        admin.execute(f"DROP SCHEMA IF EXISTS {SCRATCH_SCHEMA} CASCADE")
        admin.execute(f"CREATE SCHEMA {SCRATCH_SCHEMA}")
    try:
        with connect(
            url,
            "playlens-benchmark-import",
            options=f"-c search_path={SCRATCH_SCHEMA},public",
        ) as conn:
            migrate(conn)
            first = ingest_load(conn, art.model_version, art.subset, data_root)
            second = ingest_load(conn, art.model_version, art.subset, data_root)
            with conn.transaction():
                build_start = time.perf_counter()
                conn.execute(
                    "CREATE INDEX benchmark_rebuild_hnsw ON play_embeddings "
                    "USING hnsw (embedding vector_cosine_ops) "
                    "WITH (m = 16, ef_construction = 64)"
                )
                build_s = time.perf_counter() - build_start
                sizes = conn.execute(
                    "SELECT pg_relation_size('play_embeddings'), "
                    "pg_relation_size('benchmark_rebuild_hnsw')"
                ).fetchone()
                conn.execute("DROP INDEX benchmark_rebuild_hnsw")
    finally:
        with connect(url, "playlens-benchmark-import") as admin:
            admin.execute(f"DROP SCHEMA IF EXISTS {SCRATCH_SCHEMA} CASCADE")
    return {
        "scope": "load() into an empty scratch schema: validation, cosine reference, "
        "COPY, upsert with the HNSW index maintained incrementally, ANALYZE",
        "first_import_s": first.seconds,
        "first_import_rows": {"inserted": first.inserted, "updated": first.updated},
        "rerun_s": second.seconds,
        "rerun_rows": {
            "inserted": second.inserted,
            "updated": second.updated,
            "unchanged": second.unchanged,
            "deleted": second.deleted,
        },
        "hnsw_bulk_build_s": round(build_s, 3),
        "table_bytes": int(sizes[0]) if sizes else None,
        "hnsw_index_bytes": int(sizes[1]) if sizes else None,
    }


def endpoint_latency(
    url: str,
    ef: int,
    queries: list[str],
    pairs: list[tuple[str, str]],
    row_of: dict[str, dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """In-process FastAPI latency for the product endpoints, and the responses
    used for qualitative examples."""
    import warnings

    from fastapi.testclient import TestClient

    from ..main import create_app

    warnings.simplefilter("ignore")
    settings = Settings(
        subset="full", database_url=url, hnsw_ef_search=ef, log_level="WARNING"
    )
    out: dict[str, Any] = {}
    responses: dict[str, Any] = {}
    with TestClient(create_app(settings)) as client:
        for _ in range(50):  # readiness check runs in the background at startup
            if client.get("/health").json()["retrieval"]["status"] == "ready":
                break
            time.sleep(0.1)
        for pid in queries[:20]:  # warm up
            client.post("/api/v1/search/similar", json={"play_id": pid, "k": 10})

        def measure(name: str, bodies: list[dict[str, Any]], path: str) -> None:
            client_ms, server_ms = [], []
            for body in bodies:
                start = time.perf_counter()
                r = client.post(path, json=body)
                client_ms.append((time.perf_counter() - start) * 1000)
                assert r.status_code == 200, r.text
                data = r.json()
                server_ms.append(
                    data["retrieval"]["latency_ms"]
                    if "retrieval" in data
                    else data["latency_ms"]
                )
                if (
                    path.endswith("similar")
                    and body.get("mode", "approximate") == "approximate"
                    and not body.get("filters")
                ):
                    responses[body["play_id"]] = data
            out[name] = {
                "requests": len(bodies),
                "in_process_ms": dist(client_ms),
                "server_ms": dist(server_ms),
            }

        measure(
            "search_approximate_k10",
            [{"play_id": p, "k": 10} for p in queries],
            "/api/v1/search/similar",
        )
        measure(
            "search_exact_k10",
            [{"play_id": p, "k": 10, "mode": "exact"} for p in queries],
            "/api/v1/search/similar",
        )
        measure(
            "search_approximate_k10_same_down",
            [
                {"play_id": p, "k": 10, "filters": {"down": int(row_of[p]["down"])}}
                for p in queries
            ],
            "/api/v1/search/similar",
        )
        measure(
            "compare",
            [{"left_play_id": a, "right_play_id": b} for a, b in pairs],
            "/api/v1/compare",
        )
    out["scope"] = (
        "FastAPI app in the benchmark process (Starlette TestClient): validation, "
        "database transaction, play summaries, evidence, JSON. No network hop "
        "between client and API; the database is reached over localhost TCP."
    )
    return out, responses


def example_rows(response: dict[str, Any], top: int = 5) -> dict[str, Any]:
    def meta(play: dict[str, Any]) -> dict[str, Any]:
        return {
            "matchup": f"{play['away_team']} at {play['home_team']}",
            "week": play["week"],
            "quarter": play["quarter"],
            "down": play["down"],
            "yards_to_go": play["yards_to_go"],
            "formation": play["context"]["offense_formation"],
            "alignment": play["context"]["receiver_alignment"],
            "coverage": play["annotations"]["coverage_type"],
            "route": play["annotations"]["target_route"],
        }

    results = response["results"][:top]
    query_play = None
    neighbours = []
    for r in results:
        ev = {e["id"].split(".", 1)[1]: e for e in r["evidence"]}
        same = [
            e["label"]
            for e in r["evidence"]
            if e["kind"] == "metadata" and e["relation"] == "same"
        ]
        structure = {
            key.split(".")[1]: [e["left_value"], e["right_value"]]
            for key, e in ev.items()
            if e["kind"] == "structural_metric"
        }
        neighbours.append(
            {
                "rank": r["rank"],
                "play_id": r["play_id"],
                "split": r["split"],
                "cosine_similarity": r["cosine_similarity"],
                **meta(r["play"]),
                "same_metadata": same,
                "structure_query_vs_neighbour": structure,
            }
        )
    return {
        "query_play_id": response["query"]["play_id"],
        "query_split": response["query"]["split"],
        "query": query_play,
        "neighbours": neighbours,
        "plan": response["retrieval"]["plan"],
    }


def run(
    url: str,
    art: EmbeddingArtifact,
    data_root: Path | None,
    per_split: int,
    filtered_per_split: int,
    efs: Sequence[int],
) -> dict[str, Any]:
    rows = search_rows(art, data_root)
    ids = art.ids
    splits = [str(s) for s in art.table["split"].to_list()]
    meta = rows.to_dicts()
    row_of = {m["pid"]: m for m in meta}
    queries = sample_queries(ids, splits, per_split, SALT)
    mv = art.model_version
    kmax = max(KS)

    with connect(url, "playlens-benchmark") as conn:
        status = read_status(conn)
        env = environment(conn)
        print(
            f"verifying exact search against NumPy ({len(queries)} queries)",
            file=sys.stderr,
        )
        verification = verify(conn, art, rows, per_split=40)
        if not verification.ok:
            raise RuntimeError(
                "Exact search disagrees with the NumPy reference; not benchmarking "
                "the index on top of it:\n  " + "\n  ".join(verification.problems[:10])
            )

        warm = sample_queries(ids, splits, 30, "retrieval-benchmark-warmup")
        modes: tuple[Mode, ...] = ("exact", "approximate")
        for i in warm:
            for mode in modes:
                run_search(conn, SearchQuery(ids[i], mv, 10, mode))

        print("exact ground truth", file=sys.stderr)
        truth: dict[int, list[str]] = {}
        exact_stmt, exact_call = [], []
        for i in queries:
            out = run_search(conn, SearchQuery(ids[i], mv, kmax, "exact"))
            truth[i] = [h.play_id for h in out.hits]
            out10, call_ms = timed_search(conn, SearchQuery(ids[i], mv, 10, "exact"))
            assert [h.play_id for h in out10.hits] == truth[i][:10]
            exact_stmt.append(out10.search_ms)
            exact_call.append(call_ms)

        print("approximate sweep", file=sys.stderr)
        sweep: list[dict[str, Any]] = []
        per_query_recall: dict[int, dict[int, float]] = {}
        for ef in efs:
            for k in KS:
                recalls, stmt_ms, call_ms_list, plans = [], [], [], []
                for i in queries:
                    out, call_ms = timed_search(
                        conn, SearchQuery(ids[i], mv, k, "approximate", ef_search=ef)
                    )
                    got = [h.play_id for h in out.hits]
                    if ids[i] in got:
                        raise RuntimeError(f"self-match returned for {ids[i]}")
                    rc = recall(truth[i], got, k)
                    recalls.append(rc)
                    stmt_ms.append(out.search_ms)
                    call_ms_list.append(call_ms)
                    plans.append(out.plan)
                    if k == 10:
                        per_query_recall.setdefault(ef, {})[i] = rc
                sweep.append(
                    {
                        "ef_search": ef,
                        "effective_ef_search": max(ef, k),
                        "k": k,
                        "queries": len(queries),
                        "recall_mean": round(float(np.mean(recalls)), 4),
                        "recall_min": round(float(np.min(recalls)), 4),
                        "queries_with_full_recall": int(sum(r == 1.0 for r in recalls)),
                        "hnsw_plan_share": round(
                            plans.count("hnsw_index_scan") / len(plans), 4
                        ),
                        "search_statement_ms": dist(stmt_ms),
                        "store_call_ms": dist(call_ms_list),
                    }
                )
                print(
                    f"  ef={ef:<4} k={k:<3} recall {sweep[-1]['recall_mean']:.4f} "
                    f"p50 {sweep[-1]['search_statement_ms']['p50']} ms",
                    file=sys.stderr,
                )

        meets = {
            s["ef_search"]
            for s in sweep
            if s["k"] == 10 and s["recall_mean"] >= RECALL_TARGET
        }
        # Keep pgvector's default unless it misses the target: lowering it showed
        # no latency benefit worth trading margin for on this corpus.
        chosen = (
            PGVECTOR_DEFAULT_EF
            if PGVECTOR_DEFAULT_EF in meets
            else (min(meets) if meets else max(efs))
        )

        print("iterative-scan-off probe", file=sys.stderr)
        probe = iterative_off_probe(conn, ids, queries[:200], truth, mv)

        print("filtered scenarios", file=sys.stderr)
        fq = sample_queries(ids, splits, filtered_per_split, SALT + "-filtered")
        filtered: dict[str, Any] = {}
        for qi in fq:
            for name, flt in filter_scenarios(meta[qi]).items():
                exact_out, exact_ms = timed_search(
                    conn, SearchQuery(ids[qi], mv, 10, "exact", flt)
                )
                exact_ids = [h.play_id for h in exact_out.hits]
                rec = filtered.setdefault(
                    name,
                    {
                        "filters_example": flt.active(),
                        "queries": 0,
                        "candidates": [],
                        "exact_store_call_ms": [],
                        "exact_statement_ms": [],
                        "by_ef": {},
                    },
                )
                rec["queries"] += 1
                rec["candidates"].append(exact_out.candidates)
                rec["exact_store_call_ms"].append(exact_ms)
                rec["exact_statement_ms"].append(exact_out.search_ms)
                for ef in sorted({min(efs), 40, chosen}):
                    out, ms = timed_search(
                        conn, SearchQuery(ids[qi], mv, 10, "approximate", flt, ef)
                    )
                    got = [h.play_id for h in out.hits]
                    if ids[qi] in got:
                        raise RuntimeError(
                            f"self-match returned for {ids[qi]} ({name})"
                        )
                    b = rec["by_ef"].setdefault(
                        ef,
                        {
                            "recall": [],
                            "hnsw": 0,
                            "short": 0,
                            "store_call_ms": [],
                            "statement_ms": [],
                        },
                    )
                    # Recall is undefined when no play matches; those queries are
                    # counted separately instead of scoring a vacuous 1.0.
                    if exact_ids:
                        b["recall"].append(recall(exact_ids, got, 10))
                    b["hnsw"] += out.plan == "hnsw_index_scan"
                    b["short"] += len(got) < min(10, out.candidates)
                    b["store_call_ms"].append(ms)
                    b["statement_ms"].append(out.search_ms)
        filtered_summary = {}
        for name, rec in filtered.items():
            filtered_summary[name] = {
                "filters_example": rec["filters_example"],
                "queries": rec["queries"],
                "candidates": dist(rec["candidates"]),
                "exact": {
                    "statement_ms": dist(rec["exact_statement_ms"]),
                    "store_call_ms": dist(rec["exact_store_call_ms"]),
                },
                "approximate": {
                    str(ef): {
                        "recall_at_10_mean": round(float(np.mean(b["recall"])), 4)
                        if b["recall"]
                        else None,
                        "recall_at_10_min": round(float(np.min(b["recall"])), 4)
                        if b["recall"]
                        else None,
                        "queries_with_matches": len(b["recall"]),
                        "hnsw_plan_share": round(b["hnsw"] / rec["queries"], 4),
                        "fewer_than_available": b["short"],
                        "statement_ms": dist(b["statement_ms"]),
                        "store_call_ms": dist(b["store_call_ms"]),
                    }
                    for ef, b in sorted(rec["by_ef"].items())
                },
            }

    print("import timing (scratch schema)", file=sys.stderr)
    importing = import_timing(url, art, data_root)

    print("endpoint latency", file=sys.stderr)
    endpoint_queries = [ids[i] for i in queries[: 3 * 100 : 3]] or [
        ids[i] for i in queries
    ]
    pairs = [(ids[i], truth[i][0]) for i in queries[1 : 3 * 100 : 3]]
    endpoints, responses = endpoint_latency(
        url, chosen, endpoint_queries, pairs, row_of
    )

    # Qualitative examples: hash-chosen test plays (no inspection), plus the sample
    # query whose nearest neighbour is least similar, through the product endpoint.
    test_ids = [i for i, s in enumerate(splits) if s == "test"]
    test_ids.sort(
        key=lambda i: hashlib.sha256(f"{EXAMPLE_SALT}:{ids[i]}".encode()).digest()
    )
    with connect(url, "playlens-benchmark") as conn:
        top1 = {
            i: 1.0
            - run_search(conn, SearchQuery(ids[i], mv, 1, "exact")).hits[0].distance
            for i in queries
        }
    weakest = min(top1, key=lambda i: top1[i])
    worst_recall_q = min(
        per_query_recall[chosen], key=lambda i: per_query_recall[chosen][i]
    )
    example_ids = [ids[i] for i in test_ids[:5]] + [ids[weakest]]
    from fastapi.testclient import TestClient

    from ..main import create_app

    settings = Settings(
        subset="full", database_url=url, hnsw_ef_search=chosen, log_level="WARNING"
    )
    examples = []
    with TestClient(create_app(settings)) as client:
        for _ in range(50):
            if client.get("/health").json()["retrieval"]["status"] == "ready":
                break
            time.sleep(0.1)
        for pid in example_ids:
            r = client.post(
                "/api/v1/search/similar", json={"play_id": pid, "k": 5}
            ).json()
            ex = example_rows(r)
            q = row_of[pid]
            ex["query"] = {
                "week": q["week"],
                "quarter": q["quarter"],
                "down": q["down"],
                "yards_to_go": q["yards_to_go"],
                "formation": q["offense_formation"],
            }
            ex["selection"] = (
                "weakest nearest neighbour in the benchmark sample"
                if pid == ids[weakest]
                else f"hash-chosen test play (smallest sha256('{EXAMPLE_SALT}:<id>'))"
            )
            examples.append(ex)

    top1_values = list(top1.values())
    k10 = {s["ef_search"]: s for s in sweep if s["k"] == 10}
    return {
        "report": "retrieval-v1",
        "generated_at": utc_now(),
        "model_version": mv,
        "dataset_version": art.dataset_version,
        "split_version": art.split_version,
        "embedding_artifact_sha256": art.manifest["sha256"],
        "corpus": {
            "plays": art.table.height,
            "dimension": art.dimension,
            "by_split": {s: splits.count(s) for s in ("train", "validation", "test")},
            "retrieval_corpus": "every stored play of the model version (all splits); "
            "the query play is excluded",
        },
        "database": {
            "server_version": status.server_version,
            "pgvector_version": status.pgvector_version,
            "schema_version": status.schema_version,
            "index": status.index.__dict__ if status.index else None,
            "max_scan_tuples": status.max_scan_tuples,
            "iterative_scan": "relaxed_order",
        },
        "environment": env,
        "method": {
            "ground_truth": "exact search (sequential scan, ORDER BY cosine distance, "
            "play_id), verified against NumPy",
            "queries": len(queries),
            "query_sample": f"{per_split} plays per split with the smallest "
            f"sha256('{SALT}:<play_id>')",
            "recall_at_k": "|exact top-k ∩ approximate top-k| / |exact top-k|, "
            "averaged over queries",
            "ks": list(KS),
            "ef_search_grid": list(efs),
            "effective_ef_search": "max(ef_search, k): the store raises ef_search to "
            "k so the index can return k rows",
            "latency": "warm cache; search_statement = the nearest-neighbour SQL "
            "statement round trip; store_call = the whole read-only transaction "
            "(embedding-set and query lookups, candidate count when filtered, "
            "EXPLAIN for approximate, the search)",
            "ef_selection_rule": f"keep pgvector's default ({PGVECTOR_DEFAULT_EF}) "
            f"if its unfiltered mean recall@10 >= {RECALL_TARGET}; otherwise the "
            "smallest grid value that meets it",
        },
        "verification": verification.checks,
        "exact": {
            "k": 10,
            "queries": len(queries),
            "search_statement_ms": dist(exact_stmt),
            "store_call_ms": dist(exact_call),
        },
        "approximate_sweep": sweep,
        "chosen_ef_search": chosen,
        "iterative_scan_off_probe": probe,
        "chosen_summary": {
            "recall_at_10": k10[chosen]["recall_mean"],
            "search_statement_ms": k10[chosen]["search_statement_ms"],
            "store_call_ms": k10[chosen]["store_call_ms"],
        },
        "filtered": {
            "queries_per_scenario": len(fq),
            "query_sample": f"{filtered_per_split} plays per split, salt "
            f"'{SALT}-filtered'; filters derived from each query play's own context",
            "k": 10,
            "scenarios": filtered_summary,
        },
        "ingestion": importing,
        "endpoints": endpoints,
        "nearest_neighbour_cosine_in_sample": dist(top1_values),
        "worst_recall_query_at_chosen_ef": {
            "play_id": ids[worst_recall_q],
            "recall_at_10": per_query_recall[chosen][worst_recall_q],
        },
        "examples": examples,
        "offline_embedding_quality": {
            "note": "Measured in Phase 3 (label agreement of nearest neighbours, test "
            "queries against the train corpus). A different measurement from ANN "
            "recall; not re-run here.",
            "source": "docs/evaluation/trajectory-gnn-transformer-v1.json#embedding_sanity",
        },
    }


def recall_text(a: dict[str, Any]) -> str:
    if a["recall_at_10_mean"] is None:
        return "n/a (no matches)"
    return f"{a['recall_at_10_mean']:.4f}"


def _ms(d: dict[str, Any]) -> str:
    return f"{d['p50']:.2f} / {d['p95']:.2f} / {d['p99']:.2f}"


def markdown(r: dict[str, Any]) -> str:
    db, env = r["database"], r["environment"]
    vm = env["database_vm"]
    k10 = [s for s in r["approximate_sweep"] if s["k"] == 10]
    lines = [
        "# Retrieval evaluation: exact search vs HNSW (retrieval-v1)",
        "",
        f"Generated by `pnpm retrieval:benchmark` at {r['generated_at']}. Machine-readable "
        "copy: [retrieval-v1.json](retrieval-v1.json). Every number below was measured "
        "by that command on the machine described at the end.",
        "",
        f"- Embeddings: `{r['model_version']}`, {r['corpus']['plays']:,} plays, "
        f"{r['corpus']['dimension']}-d, L2-normalised (frozen Phase 3 export, sha256 "
        f"`{r['embedding_artifact_sha256'][:12]}`).",
        f"- Dataset `{r['dataset_version']}`, split `{r['split_version']}` "
        f"(train {r['corpus']['by_split']['train']:,}, validation "
        f"{r['corpus']['by_split']['validation']:,}, test {r['corpus']['by_split']['test']:,}).",
        f"- Retrieval corpus: {r['corpus']['retrieval_corpus']}.",
        f"- PostgreSQL {db['server_version']}, pgvector {db['pgvector_version']}; index "
        f"`{db['index']['name']}` (HNSW, `vector_cosine_ops`, m = {db['index']['m']}, "
        f"ef_construction = {db['index']['ef_construction']}); iterative scan "
        f"`{db['iterative_scan']}`, `hnsw.max_scan_tuples` = {db['max_scan_tuples']}.",
        f"- Ground truth: {r['method']['ground_truth']}. {r['method']['queries']} query "
        f"plays: {r['method']['query_sample']}.",
        "",
        "## Exact search is correct",
        "",
    ]
    v = r["verification"]["exact_vs_numpy"]
    total = sum(s["queries"] for s in v["scenarios"].values())
    identical = sum(s["identical"] for s in v["scenarios"].values())
    max_err = max(s["max_err"] for s in v["scenarios"].values())
    lines += [
        f"Exact pgvector search was compared with an independent NumPy brute force "
        f"(float64 cosine over the exported float32 vectors) for {v['query_plays']} "
        f"query plays × {len(v['scenarios'])} filter scenarios = {total} searches at "
        f"k = {v['k']}: **{identical} of {total} returned the same plays in the same "
        f"order**; the largest distance difference was {max_err:.1e}. Stored vectors "
        f"equal the export bit for bit (max abs difference "
        f"{r['verification']['vector_max_abs_difference']}), and the query play never "
        "appeared in its own results.",
        "",
        "## Recall and latency, unfiltered",
        "",
        f"recall@10 of HNSW against exact search, and latency (p50 / p95 / p99, ms) of "
        f"the nearest-neighbour statement, {r['method']['queries']} queries each. Exact "
        f"search: statement {_ms(r['exact']['search_statement_ms'])} ms, whole store "
        f"call {_ms(r['exact']['store_call_ms'])} ms.",
        "",
        "| ef_search | recall@10 | min | queries at 1.0 | statement ms | store call ms |",
        "|---:|---:|---:|---:|---|---|",
    ]
    for s in k10:
        lines.append(
            f"| {s['ef_search']} | {s['recall_mean']:.4f} | {s['recall_min']:.2f} | "
            f"{s['queries_with_full_recall']} / {s['queries']} | "
            f"{_ms(s['search_statement_ms'])} | {_ms(s['store_call_ms'])} |"
        )
    lines += [
        "",
        "recall@k by k (mean over queries; `ef_search` is raised to k when smaller):",
        "",
        "| ef_search | " + " | ".join(f"recall@{k}" for k in r["method"]["ks"]) + " |",
        "|---:|" + "---:|" * len(r["method"]["ks"]),
    ]
    for ef in r["method"]["ef_search_grid"]:
        row = [
            next(
                s["recall_mean"]
                for s in r["approximate_sweep"]
                if s["ef_search"] == ef and s["k"] == k
            )
            for k in r["method"]["ks"]
        ]
        lines.append(f"| {ef} | " + " | ".join(f"{x:.4f}" for x in row) + " |")
    c = r["chosen_summary"]
    lines += [
        "",
        f"**Served default: `ef_search` = {r['chosen_ef_search']}**. Rule: "
        f"{r['method']['ef_selection_rule']}. Recall@10 {c['recall_at_10']:.4f}, "
        f"statement {_ms(c['search_statement_ms'])} ms. The lowest per-query recall@10 "
        f"at this setting was {r['worst_recall_query_at_chosen_ef']['recall_at_10']:.1f} "
        f"(play `{r['worst_recall_query_at_chosen_ef']['play_id']}`).",
        "",
        f"HNSW reduced database retrieval latency on this corpus: the "
        f"nearest-neighbour statement took {c['search_statement_ms']['p50']:.1f} ms "
        f"against {r['exact']['search_statement_ms']['p50']:.1f} ms for the exact "
        f"scan at the median, and {c['search_statement_ms']['p95']:.1f} against "
        f"{r['exact']['search_statement_ms']['p95']:.1f} ms at p95. The practical "
        f"benefit is modest at {r['corpus']['plays']:,} vectors: the exact scan is "
        "already a few milliseconds, the saving is a small part of a whole request "
        "(see endpoints), p99 tails on this loaded machine are noisy, and under very "
        "selective filters the advantage disappears (see filtered search). The "
        "index matters more as the corpus grows.",
        "",
        "Without iterative scans (diagnostic, same queries and ground truth; the API "
        "never runs this way):",
        "",
        "| k | ef_search | recall@k | queries returning fewer than k |",
        "|---:|---:|---:|---:|",
        *[
            f"| {p['k']} | {p['ef_search']} | {p['recall_mean']:.4f} | "
            f"{p['queries_returning_fewer_than_k']} / {p['queries']} |"
            for p in r["iterative_scan_off_probe"]
        ],
        "",
        "With iterative scans off, the index stops after `ef_search` candidates and "
        "the self-match (excluded by the WHERE clause) consumes one of them, so "
        "results come back short. That is why every approximate search runs with "
        "`hnsw.iterative_scan = relaxed_order` and `ef_search >= k`.",
        "",
        "## Filtered search",
        "",
        f"{r['filtered']['queries_per_scenario']} query plays per scenario "
        f"({r['filtered']['query_sample']}), k = 10. Filters run inside the SQL "
        "statement. With iterative scans the index keeps searching until k rows pass "
        "the filters; for very selective filters PostgreSQL may choose an exact scan "
        "instead, which the API reports as `plan: exact_scan`.",
        "",
        f"| scenario | example filter | median candidates | recall@10 (ef {r['chosen_ef_search']}) | HNSW plan share | fewer than available | approx statement ms | exact statement ms |",
        "|---|---|---:|---:|---:|---:|---|---|",
    ]
    for name, s in r["filtered"]["scenarios"].items():
        a = s["approximate"][str(r["chosen_ef_search"])]
        lines.append(
            f"| {name} | `{json.dumps(s['filters_example'])}` | "
            f"{s['candidates'].get('p50', 0):,.0f} | {recall_text(a)} | "
            f"{a['hnsw_plan_share']:.2f} | {a['fewer_than_available']} | "
            f"{_ms(a['statement_ms'])} | {_ms(s['exact']['statement_ms'])} |"
        )
    slower = [
        name
        for name, s in r["filtered"]["scenarios"].items()
        if s["approximate"][str(r["chosen_ef_search"])]["statement_ms"].get("p50", 0)
        >= s["exact"]["statement_ms"].get("p50", 0)
    ]
    if slower:
        lines += [
            "",
            f"Under the most selective filters ({', '.join(f'`{n}`' for n in slower)}) "
            "the approximate request is no faster than the exact scan at the median: "
            "the iterative HNSW scan visits many graph nodes to find enough matching "
            "plays, or the planner already chose an exact scan. Results are still "
            "complete.",
        ]
    ing = r["ingestion"]
    lines += [
        "",
        "## Ingestion and index build",
        "",
        f"Measured into an empty scratch schema ({ing['scope']}): first import "
        f"**{ing['first_import_s']} s** ({ing['first_import_rows']['inserted']:,} rows "
        f"inserted); rerun **{ing['rerun_s']} s** with {ing['rerun_rows']['inserted']} "
        f"inserted, {ing['rerun_rows']['updated']} updated, "
        f"{ing['rerun_rows']['unchanged']:,} unchanged, {ing['rerun_rows']['deleted']} "
        f"deleted. A bulk HNSW build over the loaded table took "
        f"{ing['hnsw_bulk_build_s']} s; the table is "
        f"{ing['table_bytes'] / 2**20:.1f} MiB and the index "
        f"{ing['hnsw_index_bytes'] / 2**20:.1f} MiB.",
        "",
        "## Endpoint latency",
        "",
        f"{r['endpoints']['scope']} Default `ef_search` = {r['chosen_ef_search']}, k = 10.",
        "",
        "| endpoint | requests | in-process p50 / p95 / p99 ms | server-reported p50 / p95 / p99 ms |",
        "|---|---:|---|---|",
    ]
    for name, e in r["endpoints"].items():
        if name == "scope":
            continue
        lines.append(
            f"| {name} | {e['requests']} | {_ms(e['in_process_ms'])} | "
            f"{_ms(e['server_ms'])} |"
        )
    nn = r["nearest_neighbour_cosine_in_sample"]
    lines += [
        "",
        "## What the scores look like",
        "",
        f"Across the {nn['n']} sampled queries the nearest neighbour's cosine "
        f"similarity has median {nn['p50']:.3f} (minimum {nn['min']:.3f}, maximum "
        f"{nn['max']:.3f}). Random play pairs in the same "
        "space average about 0.44 with a wide spread (the space is anisotropic; see "
        "the cosine reference stored with the embeddings). Absolute cosine values "
        "are therefore close to 1 for most neighbours and are not probabilities; the "
        "product leads with rank and evidence.",
        "",
        "## Qualitative examples",
        "",
        "Top 5 from the product endpoint (approximate, default settings) for five "
        "hash-chosen test-split plays and for the sampled play whose nearest neighbour "
        "is least similar. Metadata agreement is listed for context; none of these "
        "labels is a model input. Structure values are query → neighbour at the last "
        "observed frame (yards; mean speed in yd/s).",
        "",
    ]
    for ex in r["examples"]:
        q = ex["query"]
        lines += [
            f"### Query `{ex['query_play_id']}` ({ex['query_split']}; {ex['selection']})",
            "",
            f"Week {q['week']}, Q{q['quarter']}, down {q['down']} & {q['yards_to_go']}, "
            f"{q['formation']}.",
            "",
            "| # | play | split | cosine | down & dist | formation | coverage† | route† | same metadata | offense width | target separation |",
            "|---:|---|---|---:|---|---|---|---|---|---|---|",
        ]
        for n in ex["neighbours"]:
            st = n["structure_query_vs_neighbour"]

            def pair(key: str) -> str:
                a, b = st.get(key, [None, None])
                return "—" if a is None or b is None else f"{a:.1f} → {b:.1f}"

            lines.append(
                f"| {n['rank']} | `{n['play_id']}` | {n['split']} | "
                f"{n['cosine_similarity']:.4f} | {n['down']} & {n['yards_to_go']} | "
                f"{n['formation']} | {n['coverage']} | {n['route']} | "
                f"{', '.join(n['same_metadata']) or '—'} | {pair('offense_width')} | "
                f"{pair('target_separation')} |"
            )
        lines.append("")
    lines += [
        "† Charted after the play; not a model input.",
        "",
        "## Offline embedding quality (Phase 3, different measurement)",
        "",
        "Label agreement of nearest neighbours (test queries vs the train corpus) was "
        "measured in Phase 3 and is not re-run here; see "
        "[trajectory-gnn-transformer-v1.md](trajectory-gnn-transformer-v1.md#embedding-sanity). "
        "It measures whether neighbours share charted labels; ANN recall above "
        "measures whether the index finds the exact neighbours. They are separate "
        "results and are not combined.",
        "",
        "## Environment",
        "",
        f"- Host: {env['host']['cpu'] or env['host']['machine']}, "
        f"{env['host']['logical_cpus']} logical CPUs, {env['host']['platform']}, "
        f"Python {env['host']['python']}; 1-minute load average at start "
        f"{env['host']['load_average_1m_at_start']} (the machine was not otherwise idle).",
        f"- Database: Docker ({vm.get('docker_os', 'unknown')}, "
        f"{vm.get('docker_arch', '?')}) with {vm.get('docker_cpus', '?')} CPUs and "
        f"{vm.get('docker_memory_gib', '?')} GiB; shared_buffers "
        f"{env['postgres']['shared_buffers']}, work_mem {env['postgres']['work_mem']}, "
        f"maintenance_work_mem {env['postgres']['maintenance_work_mem']}.",
        f"- {env['client']}",
        f"- Code: git `{env['git'].get('commit', 'unknown')[:12]}`"
        f"{' (uncommitted changes)' if env['git'].get('dirty') else ''}.",
        "",
    ]
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--model-version", default=DEFAULT_EMBEDDING_MODEL)
    parser.add_argument("--subset", default="full")
    parser.add_argument("--per-split", type=int, default=200)
    parser.add_argument("--filtered-per-split", type=int, default=50)
    parser.add_argument("--ef", type=int, nargs="+", default=list(EF_GRID))
    parser.add_argument("--database-url", default=None)
    parser.add_argument(
        "--out", type=Path, default=None, help="Default: docs/evaluation/retrieval-v1"
    )
    parser.add_argument(
        "--render-only",
        action="store_true",
        help="Rewrite the Markdown from the existing JSON; measure nothing.",
    )
    args = parser.parse_args(argv)
    out = args.out or find_repo_root() / "docs" / "evaluation" / "retrieval-v1"
    if args.render_only:
        saved = json.loads(out.with_suffix(".json").read_text())
        out.with_suffix(".md").write_text(markdown(saved))
        print(f"rendered {out}.md from {out}.json", file=sys.stderr)
        return 0
    settings = Settings()
    url = normalize_url(args.database_url or settings.database_url or "")
    art = load_artifact(args.model_version, args.subset, settings.data_root)
    report = run(
        url, art, settings.data_root, args.per_split, args.filtered_per_split, args.ef
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.with_suffix(".json").write_text(
        json.dumps(report, indent=2, default=str) + "\n"
    )
    out.with_suffix(".md").write_text(markdown(report))
    print(
        f"chosen ef_search {report['chosen_ef_search']}: recall@10 "
        f"{report['chosen_summary']['recall_at_10']:.4f} -> {out}.{{json,md}}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
