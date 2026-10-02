"""Similarity search and Compare contracts. Mirrored in apps/web/src/lib/contracts.ts.

Scores are cosine similarity between learned play embeddings (1 - cosine
distance). They are not probabilities, confidences, or percentages, and the
embedding space is anisotropic (random pairs average about 0.44), so each
response carries the space's own reference distribution and ranks.

Evidence records are deterministic observations about both plays: pre-snap
context, charted labels, and tracking descriptors. None of them is a model
input, and none explains why the embedding places two plays close together.
"""

from typing import Literal, Self

from pydantic import Field, model_validator

from .common import ApiModel
from .plays import PlaySummary

Mode = Literal["exact", "approximate"]
Split = Literal["train", "validation", "test"]
TEAM_PATTERN = r"^[A-Z]{2,3}$"
EVIDENCE_NOTE = (
    "Evidence lists deterministic observations about both plays: pre-snap context, "
    "charted labels, and tracking descriptors. None of them is a model input, and "
    "none explains why the learned embedding places the plays close together."
)


class SimilarityFilters(ApiModel):
    """Optional metadata filters, applied in the database query (not afterwards).

    Only pre-snap context and the temporal split are filterable. Charted labels
    (coverage, route) describe the play after the fact and are evidence only."""

    down: int | None = Field(default=None, ge=1, le=4)
    yards_to_go_min: int | None = Field(default=None, ge=1, le=99)
    yards_to_go_max: int | None = Field(default=None, ge=1, le=99)
    quarter: int | None = Field(default=None, ge=1, le=5, description="5 = overtime.")
    week_min: int | None = Field(default=None, ge=1, le=22)
    week_max: int | None = Field(default=None, ge=1, le=22)
    offense: str | None = Field(default=None, pattern=TEAM_PATTERN)
    defense: str | None = Field(default=None, pattern=TEAM_PATTERN)
    offense_formation: str | None = Field(
        default=None, pattern=r"^[A-Z_]{1,32}$", examples=["SHOTGUN"]
    )
    field_position_min: float | None = Field(
        default=None,
        ge=0,
        le=100,
        description="Line of scrimmage, yards from the offense's own goal line.",
    )
    field_position_max: float | None = Field(default=None, ge=0, le=100)
    splits: list[Split] | None = Field(
        default=None,
        min_length=1,
        max_length=3,
        description="Temporal split of the retrieved plays (train weeks 1-14, "
        "validation 15-16, test 17-18).",
    )

    @model_validator(mode="after")
    def _ranges(self) -> Self:
        for lo, hi in (
            ("yards_to_go_min", "yards_to_go_max"),
            ("week_min", "week_max"),
            ("field_position_min", "field_position_max"),
        ):
            a, b = getattr(self, lo), getattr(self, hi)
            if a is not None and b is not None and a > b:
                raise ValueError(f"{lo} ({a}) is greater than {hi} ({b}).")
        return self


class SimilarityRequest(ApiModel):
    play_id: str = Field(description="PlayLens play ID.", examples=["2023123114-3710"])
    k: int = Field(default=10, ge=1, le=50, description="Neighbours to return.")
    mode: Mode = Field(
        default="approximate",
        description="approximate: HNSW index (iterative scan). exact: full scan; the "
        "ground truth used to evaluate the index.",
    )
    model_version: str | None = Field(
        default=None, description="Embedding model; default: the served one."
    )
    filters: SimilarityFilters = Field(default_factory=SimilarityFilters)


class FrameReference(ApiModel):
    anchor: Literal["last_observed_frame", "last_2s_window"]
    left_frame_ids: list[int] = Field(
        description="[frame_id] for a frame, [first, last] for a window."
    )
    right_frame_ids: list[int]


class Evidence(ApiModel):
    """One observation about both plays. In search results ``left`` is the query
    play and ``right`` the retrieved play."""

    id: str = Field(
        description="Stable within the response, e.g. "
        "'comparison.structure.target_separation'."
    )
    kind: Literal["metadata", "structural_metric"]
    source: Literal["pre_snap_context", "charted_label", "tracking"] = Field(
        description="pre_snap_context: known before the snap. charted_label: charted "
        "after the play. tracking: computed from observed tracking."
    )
    label: str
    left_value: float | None = None
    right_value: float | None = None
    left_text: str | None = None
    right_text: str | None = None
    unit: str | None
    decimals: int = Field(ge=0, le=3)
    delta: float | None = Field(description="right - left, for numeric values.")
    relation: Literal["same", "different", "unavailable"] | None = Field(
        description="Equality for discrete metadata; null for continuous measures."
    )
    definition: str
    missing_reason: str | None = None
    frame_reference: FrameReference | None = None


class CosineReference(ApiModel):
    """Cosine similarity across this embedding space, measured at load time."""

    random_pair_mean: float
    random_pair_p50: float
    random_pair_p95: float
    nearest_neighbor_p05: float
    nearest_neighbor_p50: float
    nearest_neighbor_p95: float
    description: str


class HnswSettings(ApiModel):
    index: str
    m: int | None
    ef_construction: int | None
    ef_search: int
    iterative_scan: str
    max_scan_tuples: int | None


class RetrievalProvenance(ApiModel):
    mode: Mode = Field(description="Requested mode.")
    plan: Literal["hnsw_index_scan", "exact_scan"] = Field(
        description="What PostgreSQL executed (read from EXPLAIN in the same "
        "transaction). Approximate requests run exactly when the planner estimates "
        "a scan is cheaper, e.g. under very selective filters."
    )
    metric: Literal["cosine"] = "cosine"
    representation: Literal["learned_embedding", "baseline_descriptor"]
    backend: Literal["pgvector", "memory"]
    model_version: str
    dataset_version: str
    split_version: str
    embedding_dimension: int
    normalization: str
    corpus_size: int = Field(description="Stored embeddings for this model version.")
    candidates: int = Field(
        description="Plays eligible after filters, excluding the query play."
    )
    self_match_excluded: bool
    hnsw: HnswSettings | None = Field(
        description="Index and per-request search settings when the index ran."
    )
    cosine_reference: CosineReference | None
    latency_ms: float = Field(description="Server-side, whole request.")
    database_ms: float = Field(description="The read-only database transaction.")
    search_ms: float = Field(description="The nearest-neighbour statement alone.")


class SimilarityQuery(ApiModel):
    play_id: str
    split: Split
    model_version: str
    k: int
    mode: Mode
    filters: SimilarityFilters


class SimilarityResult(ApiModel):
    rank: int = Field(ge=1)
    play_id: str
    cosine_distance: float = Field(
        description="1 - cosine similarity; 0 = same direction."
    )
    cosine_similarity: float = Field(
        description="Cosine similarity of the learned embeddings. Not a probability."
    )
    split: Split
    play: PlaySummary
    evidence: list[Evidence]


class SimilaritySearchResponse(ApiModel):
    request_id: str
    query: SimilarityQuery
    results: list[SimilarityResult]
    retrieval: RetrievalProvenance
    warnings: list[str]
    evidence_note: str = EVIDENCE_NOTE


class CompareRequest(ApiModel):
    left_play_id: str = Field(examples=["2023123114-3710"])
    right_play_id: str = Field(examples=["2023110502-3603"])
    model_version: str | None = Field(
        default=None, description="Embedding model; default: the served one."
    )


class ComparePlay(ApiModel):
    play_id: str
    play: PlaySummary
    split: Split | Literal["unknown"]
    observed_frame_count: int
    first_frame_id: int
    last_frame_id: int = Field(description="Last observed frame (forecast origin).")
    window_start_frame_id: int | None = Field(
        description="First frame of the last 2.0 s window."
    )


class EmbeddingSimilarity(ApiModel):
    representation: Literal["learned_embedding", "baseline_descriptor"] = (
        "learned_embedding"
    )
    model_version: str
    dataset_version: str
    split_version: str
    cosine_similarity: float
    cosine_distance: float
    right_rank_from_left: int = Field(
        description="1 + plays strictly closer to the left play than the right "
        "play is (exact, unfiltered corpus)."
    )
    left_rank_from_right: int
    rank_pool: int = Field(description="Plays each rank is counted over.")
    cosine_reference: CosineReference | None


class CorrespondencePair(ApiModel):
    left_player_id: str
    right_player_id: str
    basis: str


class Correspondence(ApiModel):
    method: str
    pairs: list[CorrespondencePair]


class CompareResponse(ApiModel):
    request_id: str
    left: ComparePlay
    right: ComparePlay
    similarity: EmbeddingSimilarity | None
    similarity_unavailable_reason: str | None
    similarity_unavailable_code: str | None
    evidence: list[Evidence]
    correspondence: Correspondence | None
    descriptor_version: str
    dataset_version: str
    latency_ms: float
    warnings: list[str]
    evidence_note: str = EVIDENCE_NOTE
