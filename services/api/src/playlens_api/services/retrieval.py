"""Similar plays and Compare: real nearest neighbours plus deterministic evidence.

The store (PostgreSQL + pgvector) ranks plays by cosine distance between the
frozen Phase 3 embeddings. This service resolves plays, checks that the stored
embeddings belong to the dataset being served, attaches play summaries and
evidence, and maps store failures to typed API errors. It never substitutes
another similarity when retrieval is unavailable.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, TypeVar

from playlens_ml.data.ids import decode_play_id
from playlens_ml.descriptors import DESCRIPTOR_VERSION

from ..errors import (
    ApiError,
    DatabaseUnavailable,
    DatasetUnavailable,
    EmbeddingUnavailable,
    InvalidComparison,
    ModelVersionUnavailable,
    RetrievalUnavailable,
    UnsupportedMode,
)
from ..repository.base import PlayRecord
from ..retrieval.types import (
    DatabaseDown,
    EmbeddingSet,
    EmbeddingSetMissing,
    PlayEmbeddingMissing,
    SearchFilters,
    SearchOutcome,
    SearchQuery,
    StoreStatus,
    StoreUnavailable,
    VectorStore,
)
from ..retrieval.types import UnsupportedMode as StoreUnsupportedMode
from ..schemas.health import HealthRetrieval
from ..schemas.models import RetrievalModelInfo
from ..schemas.retrieval import (
    ComparePlay,
    CompareRequest,
    CompareResponse,
    Correspondence,
    CorrespondencePair,
    CosineReference,
    EmbeddingSimilarity,
    HnswSettings,
    RetrievalProvenance,
    SimilarityFilters,
    SimilarityQuery,
    SimilarityRequest,
    SimilarityResult,
    SimilaritySearchResponse,
)
from .descriptors import DescriptorIndex
from .evidence import pair_evidence
from .plays import PlayService

log = logging.getLogger("playlens.api.retrieval")
T = TypeVar("T")
REPRESENTATION = (
    "128-d L2-normalised play embedding: the trajectory encoder's attention-pooled "
    "play representation"
)
ROLE_PAIRS = ("Passer", "Targeted Receiver")


@dataclass(frozen=True)
class Readiness:
    status: Literal["ready", "unavailable", "disabled"]
    reason: str | None
    error: type[ApiError] | None
    store: StoreStatus | None
    embedding_set: EmbeddingSet | None


def _reference(emb: EmbeddingSet) -> CosineReference | None:
    ref = emb.cosine_reference or {}
    rp, nn = ref.get("random_pairs"), ref.get("nearest_neighbor")
    if not rp or not nn:
        return None
    return CosineReference(
        random_pair_mean=rp["mean"],
        random_pair_p50=rp["p50"],
        random_pair_p95=rp["p95"],
        nearest_neighbor_p05=nn["p05"],
        nearest_neighbor_p50=nn["p50"],
        nearest_neighbor_p95=nn["p95"],
        description=(
            f"Cosine similarity in this embedding space: {rp['n']:,} random play "
            f"pairs (median {rp['p50']:.3f}) and each play's single nearest neighbour "
            f"(median {nn['p50']:.3f}). Scores are relative to this space, not "
            "probabilities."
        ),
    )


def _filters(f: SimilarityFilters) -> SearchFilters:
    return SearchFilters(
        down=f.down,
        yards_to_go_min=f.yards_to_go_min,
        yards_to_go_max=f.yards_to_go_max,
        quarter=f.quarter,
        week_min=f.week_min,
        week_max=f.week_max,
        offense=f.offense,
        defense=f.defense,
        offense_formation=f.offense_formation,
        field_position_min=f.field_position_min,
        field_position_max=f.field_position_max,
        splits=tuple(f.splits) if f.splits else None,
    )


def _ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 2)


class RetrievalService:
    def __init__(
        self,
        store: VectorStore | None,
        plays: PlayService | None,
        descriptors: DescriptorIndex | None,
        default_model: str,
        ef_search: int,
        disabled_reason: str | None = None,
    ) -> None:
        self.store = store
        self.plays = plays
        self.descriptors = descriptors
        self.default_model = default_model
        self.ef_search = ef_search
        self.disabled_reason = disabled_reason or (
            "Retrieval is disabled: PLAYLENS_DATABASE_URL is empty."
        )

    # ---- readiness ----

    def _dataset_version(self) -> str | None:
        return self.plays.repo.info().dataset_version if self.plays else None

    def evaluate(self, status: StoreStatus, model_version: str) -> Readiness:
        def down(
            reason: str, error: type[ApiError] = RetrievalUnavailable
        ) -> Readiness:
            return Readiness("unavailable", reason, error, status, None)

        if not status.reachable:
            return down(
                status.error or "The database is unreachable.", DatabaseUnavailable
            )
        if status.error:
            return down(status.error)
        if status.backend == "pgvector":
            if not status.pgvector_version:
                return down(
                    "The pgvector extension is not installed. Run `pnpm db:migrate`."
                )
            if status.pending_migrations:
                return down(
                    f"Pending migrations {status.pending_migrations}. "
                    "Run `pnpm db:migrate`."
                )
        emb = next(
            (s for s in status.embedding_sets if s.model_version == model_version), None
        )
        if emb is None or emb.row_count == 0:
            return down(
                f"No embeddings are loaded for {model_version}. Run "
                "`pnpm retrieval:load`.",
                ModelVersionUnavailable,
            )
        served = self._dataset_version()
        if served and emb.dataset_version != served:
            return down(
                f"The stored embeddings were computed on {emb.dataset_version}, but "
                f"this API serves {served}. Start the API with PLAYLENS_SUBSET=full."
            )
        return Readiness("ready", None, None, status, emb)

    def readiness(
        self, model_version: str | None = None, refresh: bool = False
    ) -> Readiness:
        if self.store is None:
            return Readiness(
                "disabled", self.disabled_reason, RetrievalUnavailable, None, None
            )
        return self.evaluate(
            self.store.status(refresh), model_version or self.default_model
        )

    def health(self) -> HealthRetrieval:
        r = self.readiness()
        st = r.store
        emb = r.embedding_set or (
            next(
                (s for s in st.embedding_sets if s.model_version == self.default_model),
                None,
            )
            if st
            else None
        )
        return HealthRetrieval(
            status=r.status,
            reason=r.reason,
            database_reachable=st.reachable if st else None,
            backend=st.backend if st else None,
            server_version=st.server_version if st else None,
            pgvector_version=st.pgvector_version if st else None,
            schema_version=st.schema_version if st else None,
            pending_migrations=st.pending_migrations if st else [],
            model_version=self.default_model,
            embedding_count=emb.row_count if emb else None,
            dataset_version=emb.dataset_version if emb else None,
            split_version=emb.split_version if emb else None,
            hnsw_index=st.index.name if st and st.index else None,
        )

    def model_info(self) -> tuple[str, RetrievalModelInfo] | None:
        """Retrieval capability of the served embedding model, from the last status
        check only (never blocks on the database)."""
        if self.store is None:
            return None
        status = self.store.cached_status()
        if status is None:
            return None
        r = self.evaluate(status, self.default_model)
        if r.status != "ready" or r.embedding_set is None:
            return None
        return r.embedding_set.model_version, RetrievalModelInfo(
            representation=REPRESENTATION,
            distance="cosine",
            index="hnsw" if status.index else "exact",
            corpus_size=r.embedding_set.row_count,
        )

    def _require(self, model_version: str) -> tuple[VectorStore, EmbeddingSet]:
        r = self.readiness(model_version)
        if r.status != "ready" or self.store is None or r.embedding_set is None:
            raise (r.error or RetrievalUnavailable)(
                r.reason or "Retrieval is unavailable."
            )
        return self.store, r.embedding_set

    def _plays(self) -> PlayService:
        if self.plays is None:
            raise DatasetUnavailable("The processed dataset is not loaded.")
        return self.plays

    def _call(self, fn: Callable[[], T]) -> T:
        try:
            return fn()
        except DatabaseDown as err:
            raise DatabaseUnavailable(str(err)) from err
        except StoreUnavailable as err:
            raise RetrievalUnavailable(str(err)) from err
        except EmbeddingSetMissing as err:
            raise ModelVersionUnavailable(str(err)) from err
        except PlayEmbeddingMissing as err:
            raise EmbeddingUnavailable(
                f"{err} Similarity needs the play's embedding; no other similarity "
                "is substituted.",
                {"play_id": err.play_id, "model_version": err.model_version},
            ) from err
        except StoreUnsupportedMode as err:
            raise UnsupportedMode(str(err)) from err

    def _descriptors(self, record: PlayRecord) -> dict[str, Any]:
        if self.descriptors is None:
            return {}
        return self.descriptors.get(record)

    # ---- search ----

    def search(
        self, req: SimilarityRequest, request_id: str
    ) -> SimilaritySearchResponse:
        start = time.perf_counter()
        plays = self._plays()
        query = plays.record(req.play_id)
        model_version = req.model_version or self.default_model
        store, emb = self._require(model_version)
        q = SearchQuery(
            play_id=query.id,
            model_version=model_version,
            k=req.k,
            mode=req.mode,
            filters=_filters(req.filters),
            ef_search=self.ef_search,
        )
        outcome: SearchOutcome = self._call(lambda: store.search(q))
        query_desc = self._descriptors(query)
        results: list[SimilarityResult] = []
        warnings: list[str] = []
        unknown = 0
        for hit in outcome.hits:
            record = plays.repo.get_play(*decode_play_id(hit.play_id))
            if record is None:
                unknown += 1
                continue
            results.append(
                SimilarityResult(
                    rank=len(results) + 1,
                    play_id=hit.play_id,
                    cosine_distance=round(hit.distance, 6),
                    cosine_similarity=round(1.0 - hit.distance, 6),
                    split=hit.split,
                    play=plays.summary(record),
                    evidence=pair_evidence(
                        hit.play_id,
                        query,
                        record,
                        query_desc,
                        self._descriptors(record),
                    ),
                )
            )
        if unknown:
            warnings.append(f"{unknown} retrieved plays are not in the served dataset.")
        n = len(results)
        if n < req.k:
            if outcome.candidates < req.k:
                warnings.append(
                    f"Only {outcome.candidates} plays match these filters."
                    if req.filters.model_dump(exclude_none=True)
                    else f"The corpus has only {outcome.candidates} other plays."
                )
            elif outcome.plan == "hnsw_index_scan":
                warnings.append(
                    f"The index returned {n} of {req.k} neighbours although "
                    f"{outcome.candidates} plays match; exact search returns all."
                )
        if (
            req.mode == "approximate"
            and outcome.plan == "exact_scan"
            and store.backend == "pgvector"
            and outcome.candidates > 0
        ):
            warnings.append(
                "PostgreSQL scanned the filtered plays exactly instead of using the "
                "HNSW index (estimated cheaper for these filters); results are exact."
            )
        hnsw = None
        if outcome.index is not None and outcome.params is not None:
            hnsw = HnswSettings(
                index=outcome.index.name,
                m=outcome.index.m,
                ef_construction=outcome.index.ef_construction,
                ef_search=outcome.params.ef_search,
                iterative_scan=outcome.params.iterative_scan,
                max_scan_tuples=outcome.params.max_scan_tuples,
            )
        latency = _ms(start)
        response = SimilaritySearchResponse(
            request_id=request_id,
            query=SimilarityQuery(
                play_id=query.id,
                split=outcome.query_split,
                model_version=model_version,
                k=req.k,
                mode=req.mode,
                filters=req.filters,
            ),
            results=results,
            retrieval=RetrievalProvenance(
                mode=req.mode,
                plan=outcome.plan,
                representation="learned_embedding",
                backend=store.backend,
                model_version=emb.model_version,
                dataset_version=emb.dataset_version,
                split_version=emb.split_version,
                embedding_dimension=emb.dimension,
                normalization=emb.normalization,
                corpus_size=outcome.embedding_set.row_count,
                candidates=outcome.candidates,
                self_match_excluded=True,
                hnsw=hnsw,
                cosine_reference=_reference(outcome.embedding_set),
                latency_ms=latency,
                database_ms=outcome.database_ms,
                search_ms=outcome.search_ms,
            ),
            warnings=warnings,
        )
        log.info(
            "retrieval.search",
            extra={
                "request_id": request_id,
                "query_play_id": query.id,
                "model_version": model_version,
                "retrieval_mode": req.mode,
                "plan": outcome.plan,
                "k": req.k,
                "filter_count": len(req.filters.model_dump(exclude_none=True)),
                "candidates": outcome.candidates,
                "result_count": n,
                "db_latency_ms": outcome.database_ms,
                "search_ms": outcome.search_ms,
                "total_latency_ms": latency,
            },
        )
        return response

    # ---- compare ----

    def compare(self, req: CompareRequest, request_id: str) -> CompareResponse:
        start = time.perf_counter()
        plays = self._plays()
        left = plays.record(req.left_play_id)
        right = plays.record(req.right_play_id)
        if left.id == right.id:
            raise InvalidComparison("Choose two different plays to compare.")
        model_version = req.model_version or self.default_model
        similarity: EmbeddingSimilarity | None = None
        reason: str | None = None
        code: str | None = None
        splits: dict[str, str] = {}
        try:
            store, _ = self._require(model_version)
            pair = self._call(lambda: store.pair(left.id, right.id, model_version))
            splits = {left.id: pair.left_split, right.id: pair.right_split}
            emb = pair.embedding_set
            similarity = EmbeddingSimilarity(
                model_version=emb.model_version,
                dataset_version=emb.dataset_version,
                split_version=emb.split_version,
                cosine_similarity=round(1.0 - pair.cosine_distance, 6),
                cosine_distance=round(pair.cosine_distance, 6),
                right_rank_from_left=pair.right_rank_from_left,
                left_rank_from_right=pair.left_rank_from_right,
                rank_pool=pair.candidates,
                cosine_reference=_reference(emb),
            )
        except ApiError as err:
            # Structural evidence does not need the database; Compare still works.
            reason, code = err.message, err.code
        ld, rd = self._descriptors(left), self._descriptors(right)
        evidence = pair_evidence("comparison", left, right, ld, rd)
        latency = _ms(start)
        response = CompareResponse(
            request_id=request_id,
            left=self._compare_play(plays, left, ld, splits.get(left.id)),
            right=self._compare_play(plays, right, rd, splits.get(right.id)),
            similarity=similarity,
            similarity_unavailable_reason=reason,
            similarity_unavailable_code=code,
            evidence=evidence,
            correspondence=self._correspondence(left, right),
            descriptor_version=DESCRIPTOR_VERSION,
            dataset_version=plays.repo.info().dataset_version,
            latency_ms=latency,
            warnings=[],
        )
        log.info(
            "retrieval.compare",
            extra={
                "request_id": request_id,
                "left_play_id": left.id,
                "right_play_id": right.id,
                "model_version": model_version,
                "similarity_available": similarity is not None,
                "evidence_count": len(evidence),
                "latency_ms": latency,
            },
        )
        return response

    @staticmethod
    def _compare_play(
        plays: PlayService, r: PlayRecord, desc: dict[str, Any], split: str | None
    ) -> ComparePlay:
        p = r.play
        start = desc.get("window_start_frame_id")
        return ComparePlay(
            play_id=r.id,
            play=plays.summary(r),
            split=split or "unknown",
            observed_frame_count=int(p["observed_frame_count"]),
            first_frame_id=int(p["observed_first_frame_id"]),
            last_frame_id=int(p["observed_last_frame_id"]),
            window_start_frame_id=int(start) if start is not None else None,
        )

    @staticmethod
    def _correspondence(left: PlayRecord, right: PlayRecord) -> Correspondence | None:
        def by_role(r: PlayRecord) -> dict[str, str]:
            seen: dict[str, list[str]] = {}
            for p in r.players:
                if p.get("player_role") in ROLE_PAIRS:
                    seen.setdefault(str(p["player_role"]), []).append(str(p["nfl_id"]))
            return {role: ids[0] for role, ids in seen.items() if len(ids) == 1}

        a, b = by_role(left), by_role(right)
        pairs = [
            CorrespondencePair(
                left_player_id=a[role], right_player_id=b[role], basis=role
            )
            for role in ROLE_PAIRS
            if role in a and role in b
        ]
        if not pairs:
            return None
        return Correspondence(
            method="Same dataset role (passer, targeted receiver). Not an assignment.",
            pairs=pairs,
        )
