"""Storage-neutral retrieval types shared by the stores, the API, and the tools."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Protocol

Mode = Literal["exact", "approximate"]
Split = Literal["train", "validation", "test"]


@dataclass(frozen=True)
class SearchFilters:
    """Allowlisted metadata filters. Every field maps to one fixed SQL predicate;
    user input never names a column."""

    down: int | None = None
    yards_to_go_min: int | None = None
    yards_to_go_max: int | None = None
    quarter: int | None = None
    week_min: int | None = None
    week_max: int | None = None
    offense: str | None = None
    defense: str | None = None
    offense_formation: str | None = None
    field_position_min: float | None = None
    field_position_max: float | None = None
    splits: tuple[Split, ...] | None = None

    def active(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}


@dataclass(frozen=True)
class SearchQuery:
    play_id: str
    model_version: str
    k: int
    mode: Mode
    filters: SearchFilters = field(default_factory=SearchFilters)
    ef_search: int = 40


@dataclass(frozen=True)
class EmbeddingSet:
    model_version: str
    dataset_version: str
    split_version: str
    dimension: int
    normalization: str
    row_count: int
    artifact_sha256: str
    model_weights_sha256: str
    cosine_reference: dict[str, Any]
    loaded_at: str | None


@dataclass(frozen=True)
class IndexInfo:
    name: str
    method: Literal["hnsw"]
    m: int | None
    ef_construction: int | None


@dataclass(frozen=True)
class SearchParams:
    """Approximate-search settings applied to one transaction (SET LOCAL)."""

    ef_search: int
    iterative_scan: str
    max_scan_tuples: int | None


@dataclass(frozen=True)
class Hit:
    play_id: str
    distance: float
    split: str


@dataclass(frozen=True)
class SearchOutcome:
    query_split: str
    hits: list[Hit]
    candidates: int
    """Rows eligible after the model version, filters, and self-exclusion."""
    embedding_set: EmbeddingSet
    index: IndexInfo | None
    """The ANN index the search ran on; None when the plan was an exact scan."""
    plan: Literal["hnsw_index_scan", "exact_scan"]
    """What PostgreSQL executed (from EXPLAIN), not what was requested."""
    params: SearchParams | None
    search_ms: float
    """The nearest-neighbour statement alone."""
    database_ms: float
    """The whole read-only transaction: lookups, candidate count, plan, search."""


@dataclass(frozen=True)
class PairOutcome:
    cosine_distance: float
    left_split: str
    right_split: str
    right_rank_from_left: int
    """1 + plays (left excluded) strictly closer to left than right is."""
    left_rank_from_right: int
    candidates: int
    """Plays each rank is counted over (the corpus minus the query play)."""
    embedding_set: EmbeddingSet
    database_ms: float


@dataclass(frozen=True)
class StoreStatus:
    reachable: bool
    error: str | None = None
    server_version: str | None = None
    pgvector_version: str | None = None
    schema_version: str | None = None
    pending_migrations: list[str] = field(default_factory=list)
    embedding_sets: list[EmbeddingSet] = field(default_factory=list)
    index: IndexInfo | None = None
    max_scan_tuples: int | None = None
    backend: Literal["pgvector", "memory"] = "pgvector"


class RetrievalStoreError(Exception):
    """Base for failures the API maps to typed error responses."""


class StoreUnavailable(RetrievalStoreError):
    """The store is not ready (schema missing, query cancelled)."""


class DatabaseDown(StoreUnavailable):
    """The database cannot be reached."""


class EmbeddingSetMissing(RetrievalStoreError):
    """No embeddings are loaded for the requested model version."""


class PlayEmbeddingMissing(RetrievalStoreError):
    def __init__(self, play_id: str, model_version: str) -> None:
        super().__init__(
            f"Play {play_id} has no stored embedding for model {model_version}."
        )
        self.play_id = play_id
        self.model_version = model_version


class UnsupportedMode(RetrievalStoreError):
    """The store cannot run the requested retrieval mode."""


class VectorStore(Protocol):
    @property
    def backend(self) -> Literal["pgvector", "memory"]: ...

    def status(self, refresh: bool = False) -> StoreStatus: ...

    def cached_status(self) -> StoreStatus | None:
        """The last status check, without contacting the database."""
        ...

    def embedding_set(self, model_version: str) -> EmbeddingSet: ...

    def search(self, q: SearchQuery) -> SearchOutcome: ...

    def pair(self, left: str, right: str, model_version: str) -> PairOutcome: ...

    def close(self) -> None: ...
