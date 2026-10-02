"""Exact cosine search over in-memory NumPy arrays.

For tests and generated contract examples only. ``create_app`` never builds one
from settings; the served store is always PostgreSQL + pgvector. It runs the
independent reference in ``reference.py`` and refuses approximate search.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Literal

import numpy as np
import polars as pl

from .artifact import EmbeddingArtifact, cosine_reference, search_rows
from .reference import eligible, topk, unit
from .types import (
    EmbeddingSet,
    EmbeddingSetMissing,
    Hit,
    PairOutcome,
    PlayEmbeddingMissing,
    SearchOutcome,
    SearchQuery,
    StoreStatus,
    UnsupportedMode,
)


class InMemoryVectorStore:
    backend: Literal["memory"] = "memory"

    def __init__(
        self, rows: pl.DataFrame, vectors: np.ndarray, embedding_set: EmbeddingSet
    ) -> None:
        self.rows = rows
        self.ids = [str(v) for v in rows["pid"].to_list()]
        self.splits = [str(v) for v in rows["split"].to_list()]
        self.index_of = {pid: i for i, pid in enumerate(self.ids)}
        self.unit = unit(vectors)
        self.set = embedding_set

    @classmethod
    def from_artifact(
        cls, art: EmbeddingArtifact, data_root: Path | None = None
    ) -> InMemoryVectorStore:
        rows = search_rows(art, data_root)
        emb_set = EmbeddingSet(
            model_version=art.model_version,
            dataset_version=art.dataset_version,
            split_version=art.split_version,
            dimension=art.dimension,
            normalization=str(art.manifest.get("normalization", "L2-normalised")),
            row_count=rows.height,
            artifact_sha256=str(art.manifest.get("sha256", "")),
            model_weights_sha256=str(art.manifest.get("model_weights_sha256", "")),
            cosine_reference=cosine_reference(art.vectors),
            loaded_at=None,
        )
        return cls(rows, art.vectors, emb_set)

    def status(self, refresh: bool = False) -> StoreStatus:
        return StoreStatus(
            reachable=True,
            embedding_sets=[self.set],
            backend="memory",
        )

    def cached_status(self) -> StoreStatus | None:
        return self.status()

    def embedding_set(self, model_version: str) -> EmbeddingSet:
        if model_version != self.set.model_version:
            raise EmbeddingSetMissing(
                f"No embeddings are loaded for model {model_version}."
            )
        return self.set

    def _query(self, play_id: str, model_version: str) -> int:
        self.embedding_set(model_version)
        if play_id not in self.index_of:
            raise PlayEmbeddingMissing(play_id, model_version)
        return self.index_of[play_id]

    def search(self, q: SearchQuery) -> SearchOutcome:
        if q.mode != "exact":
            raise UnsupportedMode(
                "Approximate search needs the pgvector HNSW index; the in-memory "
                "store runs exact search only."
            )
        start = time.perf_counter()
        qi = self._query(q.play_id, q.model_version)
        mask = eligible(self.rows, q.filters, q.play_id)
        found = topk(self.unit, self.ids, qi, q.k, mask)
        ms = round((time.perf_counter() - start) * 1000, 3)
        return SearchOutcome(
            query_split=self.splits[qi],
            hits=[Hit(n.play_id, n.distance, self.splits[n.index]) for n in found],
            candidates=int(mask.sum()),
            embedding_set=self.set,
            index=None,
            plan="exact_scan",
            params=None,
            search_ms=ms,
            database_ms=ms,
        )

    def pair(self, left: str, right: str, model_version: str) -> PairOutcome:
        start = time.perf_counter()
        li, ri = self._query(left, model_version), self._query(right, model_version)
        d = 1.0 - float(self.unit[li] @ self.unit[ri])

        def rank(q: int, other: int) -> int:
            # Compare against the other play's distance from the same matrix
            # product: a separately computed dot product can round differently,
            # which would count the other play as closer than itself.
            dist = 1.0 - self.unit @ self.unit[q]
            dist[q] = np.inf
            return int((dist < dist[other]).sum()) + 1

        return PairOutcome(
            cosine_distance=d,
            left_split=self.splits[li],
            right_split=self.splits[ri],
            right_rank_from_left=rank(li, ri),
            left_rank_from_right=rank(ri, li),
            candidates=len(self.ids) - 1,
            embedding_set=self.set,
            database_ms=round((time.perf_counter() - start) * 1000, 3),
        )

    def close(self) -> None:
        return None
