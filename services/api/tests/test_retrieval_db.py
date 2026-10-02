"""PostgreSQL + pgvector integration: migrations, ingestion, exact and HNSW search,
filters, version isolation, concurrency, and the API on the real store.

Each session works in its own schema, dropped at the end. The database comes from
PLAYLENS_TEST_DATABASE_URL (default: the docker compose service). Without a
reachable database the module is skipped, unless PLAYLENS_REQUIRE_DB_TESTS=1
(CI), which turns that into a failure.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl
import psycopg
import pytest
from fastapi.testclient import TestClient
from pgvector.psycopg import register_vector
from playlens_api.config import Settings
from playlens_api.main import create_app
from playlens_api.retrieval import status as status_cli
from playlens_api.retrieval.artifact import EmbeddingArtifactError, artifact_paths
from playlens_api.retrieval.db import DEFAULT_DATABASE_URL, connect
from playlens_api.retrieval.ingest import load
from playlens_api.retrieval.migrate import (
    MigrationError,
    available_migrations,
    migrate,
    schema_state,
)
from playlens_api.retrieval.store import (
    HNSW_INDEX,
    PostgresVectorStore,
    apply_mode,
    read_status,
    run_pair,
    run_search,
    search_statement,
)
from playlens_api.retrieval.types import (
    EmbeddingSetMissing,
    Mode,
    PlayEmbeddingMissing,
    SearchFilters,
    SearchQuery,
)
from playlens_ml.data.artifacts import sha256_file
from playlens_ml.datasets.testing import build_synthetic_ml_root
from psycopg import sql

URL = os.environ.get("PLAYLENS_TEST_DATABASE_URL", DEFAULT_DATABASE_URL)
DIM = 128
KNOWN = "test-known-v1"
OTHER = "test-other-v1"
BULK = "test-bulk-v1"


def _reachable() -> str | None:
    try:
        with connect(URL, "playlens-tests") as conn:
            conn.execute("SELECT 1")
        return None
    except (psycopg.Error, RuntimeError) as err:
        return str(err)


_problem = _reachable()
if _problem and os.environ.get("PLAYLENS_REQUIRE_DB_TESTS") == "1":
    raise RuntimeError(f"PostgreSQL test database unavailable: {_problem}")
pytestmark = pytest.mark.skipif(
    _problem is not None,
    reason=f"PostgreSQL not reachable ({_problem}); run `pnpm db:up`.",
)

Connect = Callable[[], psycopg.Connection]


@pytest.fixture(scope="session")
def schema() -> Iterator[str]:
    name = f"pltest_{uuid.uuid4().hex[:10]}"
    with connect(URL, "playlens-tests") as conn:
        conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(name)))
    try:
        yield name
    finally:
        with connect(URL, "playlens-tests") as conn:
            conn.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(name)))


@pytest.fixture(scope="session")
def options(schema: str) -> str:
    return f"-c search_path={schema},public"


@pytest.fixture(scope="session")
def db(options: str) -> Connect:
    def make() -> psycopg.Connection:
        return connect(URL, "playlens-tests", options=options)

    with make() as conn:
        migrate(conn)
    return make


def unit(v: np.ndarray) -> np.ndarray:
    out: np.ndarray = (v / np.linalg.norm(v)).astype(np.float32)
    return out


def e(i: int) -> np.ndarray:
    v = np.zeros(DIM, np.float64)
    v[i] = 1.0
    return v


# Known geometry around A = e0: B is closest, C and E tie, D is orthogonal, F opposite.
KNOWN_ROWS: dict[str, tuple[np.ndarray, dict[str, Any]]] = {
    "1-1": (
        e(0),
        dict(
            split="train", down=1, ytg=10, quarter=1, week=1, off="AAA", form="SHOTGUN"
        ),
    ),
    "1-2": (
        e(0) + 0.1 * e(1),
        dict(
            split="train", down=2, ytg=6, quarter=1, week=2, off="BBB", form="SHOTGUN"
        ),
    ),
    "1-3": (
        e(0) + 0.5 * e(1),
        dict(
            split="validation",
            down=3,
            ytg=3,
            quarter=2,
            week=15,
            off="AAA",
            form="EMPTY",
        ),
    ),
    "1-4": (
        e(1),
        dict(
            split="test", down=3, ytg=8, quarter=4, week=17, off="CCC", form="SHOTGUN"
        ),
    ),
    "1-5": (
        e(0) + 0.5 * e(2),
        dict(
            split="train", down=1, ytg=10, quarter=4, week=3, off="AAA", form="SHOTGUN"
        ),
    ),
    "1-6": (
        -e(0),
        dict(split="test", down=4, ytg=1, quarter=5, week=18, off="DDD", form="PISTOL"),
    ),
}


def _insert_set(conn: psycopg.Connection, model_version: str, n: int) -> None:
    conn.execute(
        "INSERT INTO embedding_sets (model_version, dataset_version, split_version, "
        "dimension, normalization, artifact_path, artifact_sha256, "
        "model_weights_sha256, row_count, cosine_reference) VALUES "
        "(%s, 'testds', 'testsplit', 128, 'L2', 'none', 'x', 'y', %s, %s)",
        (model_version, n, json.dumps({})),
    )


def _insert(
    conn: psycopg.Connection,
    model_version: str,
    pid: str,
    vec: np.ndarray,
    m: dict[str, Any],
) -> None:
    conn.execute(
        "INSERT INTO play_embeddings (play_id, model_version, dataset_version, "
        "split_version, split, embedding, season, week, quarter, down, yards_to_go, "
        "offense, defense, offense_formation, yards_from_own_goal) VALUES "
        "(%s, %s, 'testds', 'testsplit', %s, %s, 2023, %s, %s, %s, %s, %s, 'ZZZ', "
        "%s, 30)",
        (
            pid,
            model_version,
            m["split"],
            unit(vec),
            m["week"],
            m["quarter"],
            m["down"],
            m["ytg"],
            m["off"],
            m["form"],
        ),
    )


@pytest.fixture(scope="session")
def known(db: Connect) -> Connect:
    rng = np.random.default_rng(0)
    with db() as conn, conn.transaction():
        register_vector(conn)
        _insert_set(conn, KNOWN, len(KNOWN_ROWS))
        for pid, (vec, m) in KNOWN_ROWS.items():
            _insert(conn, KNOWN, pid, vec, m)
        # Same plays under another model version, with unrelated vectors.
        _insert_set(conn, OTHER, 3)
        for i, pid in enumerate(["1-1", "1-2", "1-7"]):
            _insert(conn, OTHER, pid, e(10 + i) + 0.01 * e(20), KNOWN_ROWS["1-1"][1])
        # A larger seeded corpus so the planner prefers the HNSW index.
        n = 3000
        _insert_set(conn, BULK, n)
        # Clustered, like a learned embedding space (random isotropic vectors are
        # an unrealistically hard case for any ANN index).
        centers = rng.normal(size=(60, DIM))
        vectors = centers[rng.integers(0, 60, n)] + 0.35 * rng.normal(size=(n, DIM))
        downs = rng.integers(1, 5, n)
        with conn.cursor().copy(
            "COPY play_embeddings (play_id, model_version, dataset_version, "
            "split_version, split, embedding, down) FROM STDIN"
        ) as copy:
            for i in range(n):
                copy.write_row(
                    (
                        f"9-{i}",
                        BULK,
                        "testds",
                        "testsplit",
                        "train",
                        unit(vectors[i]),
                        int(downs[i]),
                    )
                )
        conn.execute("ANALYZE play_embeddings")
    return db


def ids(conn: psycopg.Connection, q: SearchQuery) -> list[str]:
    return [h.play_id for h in run_search(conn, q).hits]


# ---- migrations and schema ----


def test_migrations_are_applied_once_and_protected(db: Connect) -> None:
    with db() as conn:
        state = schema_state(conn)
        assert state.applied == [m.version for m in available_migrations()]
        assert state.pending == []
        assert migrate(conn) == []
        status = read_status(conn)
        assert (
            status.pgvector_version and status.index and status.index.name == HNSW_INDEX
        )
        assert (status.index.m, status.index.ef_construction) == (16, 64)
        column = conn.execute(
            "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
            "WHERE attrelid = 'play_embeddings'::regclass AND attname = 'embedding'"
        ).fetchone()
        assert column == ("vector(128)",)
        with conn.transaction():
            conn.execute(
                "UPDATE schema_migrations SET checksum = 'edited' "
                "WHERE version = '0002'"
            )
            with pytest.raises(MigrationError, match="changed after it was applied"):
                schema_state(conn)
            conn.execute(
                "UPDATE schema_migrations SET checksum = %s WHERE version = '0002'",
                (available_migrations()[1].checksum,),
            )


def test_the_column_rejects_other_dimensions(db: Connect) -> None:
    with db() as conn, pytest.raises(psycopg.errors.DataException):
        with conn.transaction():
            register_vector(conn)
            _insert_set(conn, "dim-check", 1)
            _insert(conn, "dim-check", "1-1", np.ones(64), KNOWN_ROWS["1-1"][1])


# ---- exact search ----


def test_exact_search_orders_by_cosine_and_breaks_ties_by_play_id(
    known: Connect,
) -> None:
    with known() as conn:
        out = run_search(conn, SearchQuery("1-1", KNOWN, 10, "exact"))
    assert [h.play_id for h in out.hits] == ["1-2", "1-3", "1-5", "1-4", "1-6"]
    d = {h.play_id: h.distance for h in out.hits}
    assert d["1-2"] == pytest.approx(1 - 1 / np.sqrt(1.01), abs=1e-6)
    assert d["1-3"] == pytest.approx(d["1-5"], abs=1e-6)  # tie, broken by ID
    assert d["1-4"] == pytest.approx(1.0, abs=1e-6)
    assert d["1-6"] == pytest.approx(2.0, abs=1e-6)
    assert out.plan == "exact_scan" and out.index is None and out.candidates == 5
    assert out.query_split == "train"


MODES: tuple[Mode, ...] = ("exact", "approximate")


@pytest.mark.parametrize("mode", MODES)
def test_self_match_is_never_returned(known: Connect, mode: Mode) -> None:
    with known() as conn:
        for pid in KNOWN_ROWS:
            for flt in (
                SearchFilters(),
                SearchFilters(down=KNOWN_ROWS[pid][1]["down"]),
            ):
                q = SearchQuery(pid, KNOWN, 10, mode, flt)
                assert pid not in ids(conn, q)


@pytest.mark.parametrize(
    ("flt", "expected"),
    [
        (SearchFilters(), ["1-2", "1-3", "1-5", "1-4", "1-6"]),
        (SearchFilters(down=3), ["1-3", "1-4"]),
        (SearchFilters(yards_to_go_min=3, yards_to_go_max=8), ["1-2", "1-3", "1-4"]),
        (SearchFilters(week_min=2, week_max=16), ["1-2", "1-3", "1-5"]),
        (SearchFilters(quarter=4), ["1-5", "1-4"]),
        (SearchFilters(offense="CCC"), ["1-4"]),
        (SearchFilters(offense_formation="SHOTGUN", down=1), ["1-5"]),
        (SearchFilters(splits=("validation", "test")), ["1-3", "1-4", "1-6"]),
        (
            SearchFilters(field_position_min=25, field_position_max=35),
            ["1-2", "1-3", "1-5", "1-4", "1-6"],
        ),
        (SearchFilters(down=4, quarter=1), []),
    ],
)
@pytest.mark.parametrize("mode", MODES)
def test_filters_run_inside_the_query(
    known: Connect, flt: SearchFilters, expected: list[str], mode: Mode
) -> None:
    with known() as conn:
        out = run_search(conn, SearchQuery("1-1", KNOWN, 10, mode, flt))
    assert [h.play_id for h in out.hits] == expected
    assert out.candidates == len(expected)


def test_k_limits_the_result_count(known: Connect) -> None:
    with known() as conn:
        assert ids(conn, SearchQuery("1-1", KNOWN, 2, "exact")) == ["1-2", "1-3"]
        assert ids(conn, SearchQuery("1-1", KNOWN, 2, "approximate")) == ["1-2", "1-3"]


def test_model_versions_are_isolated(known: Connect) -> None:
    with known() as conn:
        other = run_search(conn, SearchQuery("1-1", OTHER, 10, "exact"))
        assert [h.play_id for h in other.hits] == ["1-2", "1-7"]
        assert all(
            h.distance == pytest.approx(1 - 0.0001 / 1.0001, abs=1e-5)
            for h in other.hits
        )
        with pytest.raises(PlayEmbeddingMissing):
            run_search(conn, SearchQuery("1-7", KNOWN, 5, "exact"))
        with pytest.raises(EmbeddingSetMissing):
            run_search(conn, SearchQuery("1-1", "never-loaded-v1", 5, "exact"))


def test_pair_distance_and_exact_ranks(known: Connect) -> None:
    with known() as conn:
        pair = run_pair(conn, "1-1", "1-3", KNOWN)
    assert pair.cosine_distance == pytest.approx(1 - 1 / np.sqrt(1.25), abs=1e-6)
    assert pair.right_rank_from_left == 2  # only 1-2 is strictly closer to 1-1
    assert pair.left_split == "train" and pair.right_split == "validation"


def test_searches_are_never_prepared(known: Connect) -> None:
    """Prepared statements may switch to a generic plan that differs from the custom
    plan EXPLAIN reports; searches therefore run unprepared, however often."""
    with known() as conn:
        q = SearchQuery(
            "9-1", BULK, 10, "approximate", SearchFilters(down=4, quarter=5)
        )
        plans = {run_search(conn, q).plan for _ in range(12)}
        assert len(plans) == 1
        # Small lookups may be prepared by psycopg; the search and count must not.
        prepared = conn.execute(
            "SELECT count(*) FROM pg_prepared_statements "
            "WHERE statement LIKE '%<=>%' OR statement LIKE '%count(*)%'"
        ).fetchone()
        assert prepared == (0,)


def test_search_refuses_to_run_inside_an_open_transaction(known: Connect) -> None:
    """SET LOCAL lasts until the top-level transaction ends; a nested search could
    leak its planner settings into the next one."""
    with known() as conn, conn.transaction():
        with pytest.raises(RuntimeError, match="idle connection"):
            run_search(conn, SearchQuery("1-1", KNOWN, 5, "exact"))


# ---- HNSW ----


def _bulk_truth(
    conn: psycopg.Connection, pid: str, k: int, flt: SearchFilters
) -> list[str]:
    return ids(conn, SearchQuery(pid, BULK, k, "exact", flt))


def test_approximate_search_uses_the_hnsw_index_and_matches_exact(
    known: Connect,
) -> None:
    with known() as conn:
        recalls = []
        for i in range(0, 3000, 150):
            pid = f"9-{i}"
            truth = _bulk_truth(conn, pid, 10, SearchFilters())
            out = run_search(
                conn, SearchQuery(pid, BULK, 10, "approximate", ef_search=40)
            )
            assert out.plan == "hnsw_index_scan" and out.index is not None
            assert (
                out.params is not None and out.params.iterative_scan == "relaxed_order"
            )
            assert pid not in [h.play_id for h in out.hits]
            distances = [h.distance for h in out.hits]
            assert distances == sorted(distances)
            recalls.append(len(set(truth) & {h.play_id for h in out.hits}) / 10)
    assert np.mean(recalls) >= 0.95


def test_plans_are_what_each_mode_claims(known: Connect) -> None:
    """EXPLAIN: exact never touches the HNSW index; approximate does (unfiltered)."""
    with known() as conn:
        for mode in MODES:
            q = SearchQuery("9-1", BULK, 10, mode)
            with conn.transaction():
                apply_mode(conn, q)
                stmt, args = search_statement(q)
                plan = "\n".join(
                    r[0]
                    for r in conn.execute(sql.SQL("EXPLAIN ") + stmt, args).fetchall()
                )
            assert (HNSW_INDEX in plan) == (mode == "approximate"), plan


def test_filtered_hnsw_still_returns_k_rows(known: Connect) -> None:
    """Iterative scans keep walking the graph when filters reject candidates."""
    with known() as conn:
        for i in range(0, 3000, 300):
            pid = f"9-{i}"
            for down in (1, 4):
                flt = SearchFilters(down=down)
                truth = _bulk_truth(conn, pid, 20, flt)
                out = run_search(
                    conn, SearchQuery(pid, BULK, 20, "approximate", flt, 10)
                )
                assert len(out.hits) == len(truth) == 20
                assert len(set(truth) & {h.play_id for h in out.hits}) >= 18


def test_concurrent_searches_do_not_share_settings(
    known: Connect, options: str
) -> None:
    store = PostgresVectorStore(URL, max_size=4, session_options=options)
    store.open()
    try:
        settings: tuple[tuple[Mode, int], ...] = (
            ("exact", 40),
            ("approximate", 10),
            ("approximate", 200),
        )
        queries = [
            SearchQuery(
                f"9-{i}",
                BULK,
                10,
                mode,
                SearchFilters(down=1 + i % 4) if i % 3 else SearchFilters(),
                ef,
            )
            for i in range(0, 3000, 97)
            for mode, ef in settings
        ]
        sequential = [[h.play_id for h in store.search(q).hits] for q in queries]
        plans = [store.search(q).plan for q in queries]
        with ThreadPoolExecutor(max_workers=8) as pool:
            concurrent = list(
                pool.map(lambda q: [h.play_id for h in store.search(q).hits], queries)
            )
        assert concurrent == sequential
        exact_plans = {
            p for q, p in zip(queries, plans, strict=True) if q.mode == "exact"
        }
        assert exact_plans == {"exact_scan"}
    finally:
        store.close()


# ---- ingestion ----


def _export(
    root: Path, model_version: str, frame: pl.DataFrame, **manifest: Any
) -> None:
    """Write an export + manifest exactly where `pnpm ml:embeddings` would."""
    path, manifest_path = artifact_paths(model_version, "full", root)
    path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    frame.write_parquet(path)
    info = json.loads(
        (root / "processed/nfl_bdb_2026_analytics/full/dataset.json").read_text()
    )
    splits = json.loads(
        (root / "processed/nfl_bdb_2026_analytics/full/ml/splits.json").read_text()
    )
    body = {
        "model_version": model_version,
        "dataset_version": info["dataset_version"],
        "split_version": splits["split_version"],
        "dimension": DIM,
        "normalization": "L2-normalised; cosine similarity = dot product",
        "model_weights_sha256": "test-weights",
        "sha256": sha256_file(path),
        "checks": {"rows": frame.height},
        **manifest,
    }
    manifest_path.write_text(json.dumps(body))


@pytest.fixture(scope="module")
def synthetic_root(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return build_synthetic_ml_root(tmp_path_factory.mktemp("ingest"))


def _frame(root: Path, model_version: str, seed: int = 1) -> pl.DataFrame:
    splits = pl.read_parquet(
        root / "processed/nfl_bdb_2026_analytics/full/ml/splits.parquet"
    )
    rng = np.random.default_rng(seed)
    v = rng.normal(size=(splits.height, DIM))
    v = (v / np.linalg.norm(v, axis=1, keepdims=True)).astype(np.float32)
    return splits.select("id", "game_id", "play_id", "week", "split").with_columns(
        pl.lit(model_version).alias("model_version"),
        pl.Series("embedding", v, dtype=pl.Array(pl.Float32, DIM)),
    )


def _count(conn: psycopg.Connection, model_version: str) -> int:
    row = conn.execute(
        "SELECT count(*) FROM play_embeddings WHERE model_version = %s",
        (model_version,),
    ).fetchone()
    return int(row[0]) if row else -1


def test_ingest_is_validated_idempotent_and_exact(
    db: Connect, synthetic_root: Path
) -> None:
    mv = "embedding-test-v1"
    root = synthetic_root
    frame = _frame(root, mv)
    _export(root, mv, frame)
    with db() as conn:
        first = load(conn, mv, "full", root)
        assert (first.inserted, first.updated, first.deleted) == (frame.height, 0, 0)
        assert first.validation.checks["splits_match_assignment"] is True
        again = load(conn, mv, "full", root)
        assert (again.inserted, again.updated, again.unchanged) == (0, 0, frame.height)
        assert _count(conn, mv) == frame.height
        stored = conn.execute(
            "SELECT down, offense, yards_from_own_goal FROM play_embeddings "
            "WHERE model_version = %s AND play_id = %s",
            (mv, frame["id"][0]),
        ).fetchone()
        assert stored is not None and stored[0] == 2 and stored[1]

        # One vector changed, one play dropped: one update, one delete.
        vectors = np.asarray(frame["embedding"].to_numpy(), np.float32).copy()
        vectors[0] = np.eye(DIM, dtype=np.float32)[3]
        changed = frame.with_columns(
            pl.Series("embedding", vectors, dtype=pl.Array(pl.Float32, DIM))
        ).head(frame.height - 1)
        _export(root, mv, changed)
        third = load(conn, mv, "full", root)
        assert (third.inserted, third.updated, third.deleted) == (0, 1, 1)
        assert _count(conn, mv) == frame.height - 1
        _export(root, mv, frame)
        load(conn, mv, "full", root)


@pytest.mark.parametrize(
    ("corrupt", "message"),
    [
        (
            lambda f: f.with_columns(
                pl.Series(
                    "embedding",
                    np.full((f.height, DIM), np.nan, np.float32),
                    dtype=pl.Array(pl.Float32, DIM),
                )
            ),
            "NaN",
        ),
        (
            lambda f: f.with_columns(
                pl.Series(
                    "embedding",
                    np.full((f.height, DIM), 0.5, np.float32),
                    dtype=pl.Array(pl.Float32, DIM),
                )
            ),
            "L2-normalised",
        ),
        (lambda f: pl.concat([f, f.head(1)]), "duplicate"),
        (
            lambda f: f.with_columns(
                pl.when(pl.col("id") == f["id"][0])
                .then(pl.lit("2099099999-1"))
                .otherwise(pl.col("id"))
                .alias("id")
            ),
            "play IDs",
        ),
        (
            lambda f: f.with_columns(pl.lit("other-model").alias("model_version")),
            "model versions",
        ),
    ],
)
def test_invalid_exports_are_rejected_without_touching_the_table(
    db: Connect,
    synthetic_root: Path,
    corrupt: Callable[[pl.DataFrame], pl.DataFrame],
    message: str,
) -> None:
    mv = "embedding-bad-v1"
    good = _frame(synthetic_root, mv, seed=2)
    _export(synthetic_root, mv, good)
    with db() as conn:
        load(conn, mv, "full", synthetic_root)
        before = _count(conn, mv)
        bad = corrupt(good)
        _export(synthetic_root, mv, bad, checks={"rows": bad.height})
        with pytest.raises(EmbeddingArtifactError, match=message):
            load(conn, mv, "full", synthetic_root)
        assert _count(conn, mv) == before


def test_manifest_mismatch_and_missing_artifact(
    db: Connect, synthetic_root: Path
) -> None:
    mv = "embedding-manifest-v1"
    frame = _frame(synthetic_root, mv, seed=3)
    _export(synthetic_root, mv, frame, sha256="0" * 64)
    with db() as conn:
        with pytest.raises(EmbeddingArtifactError, match="sha256"):
            load(conn, mv, "full", synthetic_root)
        with pytest.raises(
            EmbeddingArtifactError, match="Phase 3 embedding artifact not found"
        ):
            load(conn, "never-exported-v1", "full", synthetic_root)


def test_wrong_dimension_is_rejected(db: Connect, synthetic_root: Path) -> None:
    mv = "embedding-dim-v1"
    splits = _frame(synthetic_root, mv)
    v = np.random.default_rng(4).normal(size=(splits.height, 64))
    v = (v / np.linalg.norm(v, axis=1, keepdims=True)).astype(np.float32)
    frame = splits.drop("embedding").with_columns(
        pl.Series("embedding", v, dtype=pl.Array(pl.Float32, 64))
    )
    _export(synthetic_root, mv, frame, dimension=64)
    with db() as conn, pytest.raises(EmbeddingArtifactError, match="dimension 64"):
        load(conn, mv, "full", synthetic_root)


# ---- developer status CLI (make db-status) ----


def test_status_cli_reports_ready_and_missing_embeddings(
    known: Connect, schema: str, capsys: pytest.CaptureFixture[str]
) -> None:
    url = f"{URL}?options=-c%20search_path%3D{schema}%2Cpublic"
    assert (
        status_cli.main(["--database-url", url, "--model-version", KNOWN, "--brief"])
        == 0
    )
    assert capsys.readouterr().out.strip() == f"{len(KNOWN_ROWS)} embeddings ({KNOWN})"
    code = status_cli.main(["--database-url", url, "--model-version", "not-loaded-v1"])
    out = capsys.readouterr().out
    assert code == status_cli.NOT_LOADED == 3
    assert "make db-load" in out and "pgvector" in out and "HNSW index" in out


# ---- the API on the real store ----


def test_api_end_to_end_on_pgvector(
    db: Connect, synthetic_root: Path, options: str
) -> None:
    mv = "embedding-api-v1"
    frame = _frame(synthetic_root, mv, seed=5)
    _export(synthetic_root, mv, frame)
    with db() as conn:
        load(conn, mv, "full", synthetic_root)
    store = PostgresVectorStore(URL, session_options=options)
    store.open()
    settings = Settings(
        data_root=synthetic_root,
        subset="full",
        model_dir=synthetic_root / "no-models",
        database_url=None,
        embedding_model_version=mv,
        log_level="WARNING",
    )
    try:
        with TestClient(create_app(settings, retrieval_store=store)) as c:
            health = c.get("/health").json()["retrieval"]
            assert health["status"] == "ready" and health["backend"] == "pgvector"
            assert health["embedding_count"] == frame.height
            query = frame["id"][0]
            exact = c.post(
                "/api/v1/search/similar",
                json={"play_id": query, "k": 50, "mode": "exact"},
            ).json()
            approx = c.post(
                "/api/v1/search/similar", json={"play_id": query, "k": 50}
            ).json()
            assert [r["play_id"] for r in exact["results"]] == [
                r["play_id"] for r in approx["results"]
            ]
            assert query not in [r["play_id"] for r in approx["results"]]
            assert len(exact["results"]) == frame.height - 1
            assert exact["retrieval"]["backend"] == "pgvector"
            filtered = c.post(
                "/api/v1/search/similar",
                json={"play_id": query, "k": 50, "filters": {"splits": ["test"]}},
            ).json()
            assert {r["split"] for r in filtered["results"]} == {"test"}
            for k in (0, 51):
                r = c.post("/api/v1/search/similar", json={"play_id": query, "k": k})
                assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_k"
            right = exact["results"][1]["play_id"]
            cmp = c.post(
                "/api/v1/compare", json={"left_play_id": query, "right_play_id": right}
            ).json()
            assert cmp["similarity"]["right_rank_from_left"] == 2
            assert cmp["similarity"]["cosine_similarity"] == pytest.approx(
                exact["results"][1]["cosine_similarity"], abs=1e-6
            )
    finally:
        store.close()
