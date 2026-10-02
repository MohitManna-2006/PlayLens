"""Cosine nearest-neighbour search in PostgreSQL + pgvector.

Two modes, chosen per request and enforced per transaction with SET LOCAL, so
concurrent requests never see each other's settings:

* ``exact``: index scans are disabled, so PostgreSQL computes the cosine distance
  to every eligible row (sequential scan) and sorts by (distance, play_id). This
  is the ground truth for evaluating the ANN path.
* ``approximate``: the HNSW index (``vector_cosine_ops``) with
  ``hnsw.ef_search`` and ``hnsw.iterative_scan = relaxed_order``. Iterative scans
  keep walking the graph when filters reject candidates, so a filtered search
  still returns k rows when k exist (up to ``hnsw.max_scan_tuples``). The relaxed
  order is re-sorted by (distance, play_id) in an outer query, as the pgvector
  docs recommend. The planner stays free to pick an exact scan when it estimates
  that is cheaper (very selective filters); the plan actually used is read with
  EXPLAIN in the same transaction and reported, never assumed.

The query vector never leaves the database: it is a scalar subquery on the query
play's row, which PostgreSQL evaluates once and pgvector treats as a constant.
Metadata filters are a fixed allowlist of parameterised predicates.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from typing import Any, Literal, LiteralString

import psycopg
from psycopg import sql
from psycopg.pq import TransactionStatus
from psycopg_pool import ConnectionPool, PoolTimeout

from .db import normalize_url, redact
from .migrate import MigrationError, schema_state
from .types import (
    DatabaseDown,
    EmbeddingSet,
    EmbeddingSetMissing,
    Hit,
    IndexInfo,
    PairOutcome,
    PlayEmbeddingMissing,
    SearchFilters,
    SearchOutcome,
    SearchParams,
    SearchQuery,
    StoreStatus,
    StoreUnavailable,
)

log = logging.getLogger("playlens.api.retrieval")

ITERATIVE_SCAN = "relaxed_order"
HNSW_INDEX = "play_embeddings_embedding_hnsw"
FILTER_PREDICATES: dict[str, LiteralString] = {
    "down": "down = %(down)s",
    "yards_to_go_min": "yards_to_go >= %(yards_to_go_min)s",
    "yards_to_go_max": "yards_to_go <= %(yards_to_go_max)s",
    "quarter": "quarter = %(quarter)s",
    "week_min": "week >= %(week_min)s",
    "week_max": "week <= %(week_max)s",
    "offense": "offense = %(offense)s",
    "defense": "defense = %(defense)s",
    "offense_formation": "offense_formation = %(offense_formation)s",
    "field_position_min": "yards_from_own_goal >= %(field_position_min)s",
    "field_position_max": "yards_from_own_goal <= %(field_position_max)s",
    "splits": "split = ANY(%(splits)s)",
}
QUERY_VECTOR: LiteralString = (
    "(SELECT q.embedding FROM play_embeddings q "
    "WHERE q.play_id = %(query)s AND q.model_version = %(model_version)s)"
)
MISSING_SCHEMA = (
    psycopg.errors.UndefinedTable,
    psycopg.errors.UndefinedObject,
    psycopg.errors.UndefinedFunction,
)


def where_clause(filters: SearchFilters) -> tuple[sql.Composable, dict[str, Any]]:
    """Model version, self-exclusion, then one fixed predicate per active filter."""
    parts: list[sql.Composable] = [
        sql.SQL("model_version = %(model_version)s"),
        sql.SQL("play_id <> %(query)s"),
    ]
    params: dict[str, Any] = {}
    for name, value in filters.active().items():
        parts.append(sql.SQL(FILTER_PREDICATES[name]))
        params[name] = list(value) if isinstance(value, tuple) else value
    return sql.SQL(" AND ").join(parts), params


EXACT_SQL = sql.SQL(
    """
    SELECT play_id, split, embedding <=> {query_vector} AS distance
    FROM play_embeddings
    WHERE {where}
    ORDER BY distance, play_id
    LIMIT %(k)s
    """
)
APPROXIMATE_SQL = sql.SQL(
    """
    WITH relaxed AS MATERIALIZED (
        SELECT play_id, split, embedding <=> {query_vector} AS distance
        FROM play_embeddings
        WHERE {where}
        ORDER BY distance
        LIMIT %(k)s
    )
    SELECT play_id, split, distance FROM relaxed ORDER BY distance, play_id
    """
)
COUNT_SQL = sql.SQL("SELECT count(*) FROM play_embeddings WHERE {where}")


def search_statement(q: SearchQuery) -> tuple[sql.Composed, dict[str, Any]]:
    where, params = where_clause(q.filters)
    template = EXACT_SQL if q.mode == "exact" else APPROXIMATE_SQL
    stmt = template.format(query_vector=sql.SQL(QUERY_VECTOR), where=where)
    return stmt, {
        **params,
        "query": q.play_id,
        "model_version": q.model_version,
        "k": q.k,
    }


def apply_mode(conn: psycopg.Connection, q: SearchQuery) -> SearchParams | None:
    """Transaction-local planner and HNSW settings for one search. Both modes set
    every setting they depend on, so neither inherits the other's state."""
    if q.mode == "exact":
        conn.execute("SELECT set_config('enable_indexscan', 'off', true)")
        return None
    ef = max(q.ef_search, q.k)
    conn.execute(
        "SELECT set_config('enable_indexscan', 'on', true), "
        "set_config('hnsw.ef_search', %s, true), "
        "set_config('hnsw.iterative_scan', %s, true)",
        (str(ef), ITERATIVE_SCAN),
    )
    return SearchParams(
        ef_search=ef, iterative_scan=ITERATIVE_SCAN, max_scan_tuples=None
    )


def read_embedding_set(conn: psycopg.Connection, model_version: str) -> EmbeddingSet:
    row = conn.execute(
        "SELECT model_version, dataset_version, split_version, dimension, "
        "normalization, row_count, artifact_sha256, model_weights_sha256, "
        "cosine_reference, loaded_at FROM embedding_sets WHERE model_version = %s",
        (model_version,),
    ).fetchone()
    if row is None:
        raise EmbeddingSetMissing(
            f"No embeddings are loaded for model {model_version}. Load them with "
            "`pnpm retrieval:load`."
        )
    return _embedding_set(row)


def _embedding_set(row: tuple[Any, ...]) -> EmbeddingSet:
    reference = row[8] if isinstance(row[8], dict) else json.loads(row[8])
    return EmbeddingSet(
        model_version=row[0],
        dataset_version=row[1],
        split_version=row[2],
        dimension=int(row[3]),
        normalization=row[4],
        row_count=int(row[5]),
        artifact_sha256=row[6],
        model_weights_sha256=row[7],
        cosine_reference=reference,
        loaded_at=row[9].isoformat() if row[9] is not None else None,
    )


def query_split(conn: psycopg.Connection, play_id: str, model_version: str) -> str:
    row = conn.execute(
        "SELECT split FROM play_embeddings WHERE play_id = %s AND model_version = %s",
        (play_id, model_version),
    ).fetchone()
    if row is None:
        raise PlayEmbeddingMissing(play_id, model_version)
    return str(row[0])


def require_idle(conn: psycopg.Connection) -> None:
    """SET LOCAL lasts until the top-level transaction ends, not a savepoint, so a
    search must own its transaction or its settings could leak into the next."""
    if conn.info.transaction_status != TransactionStatus.IDLE:
        raise RuntimeError(
            "Retrieval queries need an idle connection (no open transaction); use "
            "autocommit or a pooled connection."
        )


def run_search(
    conn: psycopg.Connection, q: SearchQuery, index: IndexInfo | None = None
) -> SearchOutcome:
    """One search in its own top-level transaction on ``conn`` (pooled or direct)."""
    require_idle(conn)
    start = time.perf_counter()
    with conn.transaction():
        emb_set = read_embedding_set(conn, q.model_version)
        split = query_split(conn, q.play_id, q.model_version)
        where, params = where_clause(q.filters)
        if q.filters.active():
            count_row = conn.execute(
                COUNT_SQL.format(where=where),
                {**params, "query": q.play_id, "model_version": q.model_version},
                prepare=False,
            ).fetchone()
            candidates = int(count_row[0]) if count_row else 0
        else:
            candidates = emb_set.row_count - 1  # everything but the query play
        search_params = apply_mode(conn, q)
        stmt, args = search_statement(q)
        used_index = False
        # Never prepared: a prepared statement may switch to a generic plan that
        # differs from the custom plan EXPLAIN reports (and from what the filters
        # warrant). Unprepared, the executed plan is the one EXPLAIN shows.
        if q.mode == "approximate":
            plan = conn.execute(
                sql.SQL("EXPLAIN (FORMAT JSON) ") + stmt, args, prepare=False
            )
            used_index = uses_index(plan.fetchone(), HNSW_INDEX)
        search_start = time.perf_counter()
        rows = conn.execute(stmt, args, prepare=False).fetchall()
        search_ms = (time.perf_counter() - search_start) * 1000
        if used_index and index is None:
            index = read_index(conn)
    hits = [Hit(str(r[0]), float(r[2]), str(r[1])) for r in rows]
    return SearchOutcome(
        query_split=split,
        hits=hits,
        candidates=candidates,
        embedding_set=emb_set,
        index=index if used_index else None,
        plan="hnsw_index_scan" if used_index else "exact_scan",
        params=search_params,
        search_ms=round(search_ms, 3),
        database_ms=round((time.perf_counter() - start) * 1000, 3),
    )


def uses_index(explain_row: tuple[Any, ...] | None, index_name: str) -> bool:
    """Whether an EXPLAIN (FORMAT JSON) plan scans ``index_name``."""
    if explain_row is None:
        return False
    doc = explain_row[0]
    plans = json.loads(doc) if isinstance(doc, str) else doc
    stack = [p["Plan"] for p in plans]
    while stack:
        node = stack.pop()
        if node.get("Index Name") == index_name:
            return True
        stack.extend(node.get("Plans", []))
    return False


def run_pair(
    conn: psycopg.Connection, left: str, right: str, model_version: str
) -> PairOutcome:
    """Cosine distance between two stored embeddings, and each one's exact rank
    among the other's neighbours (sequential scan, no index)."""
    require_idle(conn)
    start = time.perf_counter()
    with conn.transaction():
        emb_set = read_embedding_set(conn, model_version)
        left_split = query_split(conn, left, model_version)
        right_split = query_split(conn, right, model_version)
        conn.execute("SELECT set_config('enable_indexscan', 'off', true)")
        row = conn.execute(
            """
            WITH l AS (SELECT embedding FROM play_embeddings
                       WHERE play_id = %(left)s AND model_version = %(mv)s),
                 r AS (SELECT embedding FROM play_embeddings
                       WHERE play_id = %(right)s AND model_version = %(mv)s),
                 d AS (SELECT (SELECT embedding FROM l) <=> (SELECT embedding FROM r)
                       AS distance)
            SELECT d.distance,
                (SELECT count(*) FROM play_embeddings e
                 WHERE e.model_version = %(mv)s AND e.play_id <> %(left)s
                   AND (e.embedding <=> (SELECT embedding FROM l)) < d.distance),
                (SELECT count(*) FROM play_embeddings e
                 WHERE e.model_version = %(mv)s AND e.play_id <> %(right)s
                   AND (e.embedding <=> (SELECT embedding FROM r)) < d.distance)
            FROM d
            """,
            {"left": left, "right": right, "mv": model_version},
            prepare=False,
        ).fetchone()
    assert row is not None
    return PairOutcome(
        cosine_distance=float(row[0]),
        left_split=left_split,
        right_split=right_split,
        right_rank_from_left=int(row[1]) + 1,
        left_rank_from_right=int(row[2]) + 1,
        candidates=emb_set.row_count - 1,
        embedding_set=emb_set,
        database_ms=round((time.perf_counter() - start) * 1000, 3),
    )


def read_index(conn: psycopg.Connection) -> IndexInfo | None:
    row = conn.execute(
        """
        SELECT c.relname, c.reloptions
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
        WHERE i.indrelid = to_regclass('play_embeddings') AND am.amname = 'hnsw'
        ORDER BY c.relname LIMIT 1
        """
    ).fetchone()
    if row is None:
        return None
    options = dict(str(o).split("=", 1) for o in (row[1] or []))
    return IndexInfo(
        name=str(row[0]),
        method="hnsw",
        m=int(options["m"]) if "m" in options else 16,
        ef_construction=int(options["ef_construction"])
        if "ef_construction" in options
        else 64,
    )


def read_status(conn: psycopg.Connection) -> StoreStatus:
    with conn.transaction():
        version = conn.execute("SHOW server_version").fetchone()
        ext = conn.execute(
            "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
        ).fetchone()
        state = schema_state(conn)
        sets: list[EmbeddingSet] = []
        index = None
        max_scan = None
        has_table = conn.execute("SELECT to_regclass('embedding_sets')").fetchone()
        if has_table and has_table[0] is not None:
            rows = conn.execute(
                "SELECT model_version, dataset_version, split_version, dimension, "
                "normalization, row_count, artifact_sha256, model_weights_sha256, "
                "cosine_reference, loaded_at FROM embedding_sets "
                "ORDER BY model_version"
            ).fetchall()
            sets = [_embedding_set(r) for r in rows]
            index = read_index(conn)
        if ext:
            # Using the type loads the extension library, which defines hnsw.*.
            conn.execute("SELECT '[1]'::vector")
            setting = conn.execute(
                "SELECT current_setting('hnsw.max_scan_tuples', true)"
            ).fetchone()
            max_scan = int(setting[0]) if setting and setting[0] else None
    return StoreStatus(
        reachable=True,
        server_version=str(version[0]) if version else None,
        pgvector_version=str(ext[0]) if ext else None,
        schema_version=state.current,
        pending_migrations=state.pending,
        embedding_sets=sets,
        index=index,
        max_scan_tuples=max_scan,
    )


class PostgresVectorStore:
    """The API's store: a small read-only connection pool plus cached status."""

    backend: Literal["pgvector"] = "pgvector"

    def __init__(
        self,
        url: str,
        max_size: int = 4,
        timeout_s: float = 2.0,
        status_ttl_s: float = 30.0,
        failure_ttl_s: float = 5.0,
        session_options: str = "",
    ) -> None:
        """``session_options``: extra libpq ``-c`` settings (tests set search_path)."""
        self.url = normalize_url(url)
        self.timeout_s = timeout_s
        self._status_ttl = status_ttl_s
        self._failure_ttl = failure_ttl_s
        self._status: tuple[float, StoreStatus] | None = None
        self._lock = threading.Lock()
        timeout_ms = int(timeout_s * 1000)
        self._pool = ConnectionPool(
            self.url,
            min_size=1,
            max_size=max_size,
            timeout=timeout_s,
            open=False,
            name="playlens-retrieval",
            reconnect_timeout=60,
            # A database restart leaves idle connections dead; test each one before
            # handing it out (an empty query, well under a millisecond locally).
            check=ConnectionPool.check_connection,
            kwargs={
                "connect_timeout": max(1, round(timeout_s)),
                "application_name": "playlens-api",
                # Read-only sessions; a runaway statement is cancelled.
                "options": f"-c default_transaction_read_only=on "
                f"-c statement_timeout={timeout_ms} {session_options}".strip(),
            },
        )

    def open(self) -> None:
        # Does not wait: the API starts even when the database is down.
        self._pool.open(wait=False)

    def close(self) -> None:
        self._pool.close(timeout=2.0)

    @contextmanager
    def _connection(self) -> Iterator[psycopg.Connection]:
        cached = self._status
        if (
            cached
            and not cached[1].reachable
            and time.monotonic() - cached[0] < self._failure_ttl
        ):
            raise DatabaseDown(cached[1].error or "The database is unavailable.")
        try:
            with self._pool.connection(timeout=self.timeout_s) as conn:
                yield conn
        except PoolTimeout as err:
            raise self._down(
                f"No database connection within {self.timeout_s:g} s "
                f"({redact(self.url)}). Is it running? `pnpm db:up`."
            ) from err
        except psycopg.errors.QueryCanceled as err:
            raise StoreUnavailable(
                f"The retrieval query exceeded {self.timeout_s:g} s and was cancelled."
            ) from err
        except psycopg.OperationalError as err:
            raise self._down(f"Database error: {err}".strip()) from err
        except MISSING_SCHEMA as err:
            raise StoreUnavailable(
                f"The retrieval schema is missing ({err.diag.message_primary}). "
                "Run `pnpm db:migrate` and `pnpm retrieval:load`."
            ) from err

    def _down(self, message: str) -> DatabaseDown:
        self._status = (time.monotonic(), StoreStatus(reachable=False, error=message))
        log.warning("retrieval.database_unavailable", extra={"reason": message})
        return DatabaseDown(message)

    def cached_status(self) -> StoreStatus | None:
        cached = self._status
        return cached[1] if cached else None

    def status(self, refresh: bool = False) -> StoreStatus:
        with self._lock:
            cached = self._status
            if cached and not refresh:
                ttl = self._status_ttl if cached[1].reachable else self._failure_ttl
                if time.monotonic() - cached[0] < ttl:
                    return cached[1]
            try:
                with self._pool.connection(timeout=self.timeout_s) as conn:
                    current = read_status(conn)
            except PoolTimeout:
                current = StoreStatus(
                    reachable=False,
                    error=f"No database connection within {self.timeout_s:g} s "
                    f"({redact(self.url)}). Start it with `pnpm db:up`.",
                )
            except psycopg.Error as err:
                current = StoreStatus(reachable=False, error=f"Database error: {err}")
            except MigrationError as err:
                current = StoreStatus(reachable=True, error=str(err))
            self._status = (time.monotonic(), current)
            return current

    def _index(self) -> IndexInfo | None:
        status = self.status()
        if status.index is None and status.reachable:
            status = self.status(refresh=True)
        return status.index

    def embedding_set(self, model_version: str) -> EmbeddingSet:
        with self._connection() as conn, conn.transaction():
            return read_embedding_set(conn, model_version)

    def search(self, q: SearchQuery) -> SearchOutcome:
        index = self._index() if q.mode == "approximate" else None
        with self._connection() as conn:
            outcome = run_search(conn, q, index)
        if outcome.params is not None:
            max_scan = self.status().max_scan_tuples
            outcome = replace(
                outcome, params=replace(outcome.params, max_scan_tuples=max_scan)
            )
        return outcome

    def pair(self, left: str, right: str, model_version: str) -> PairOutcome:
        with self._connection() as conn:
            return run_pair(conn, left, right, model_version)
