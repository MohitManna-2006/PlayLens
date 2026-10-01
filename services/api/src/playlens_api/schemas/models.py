"""Model registry contract. Phase 2 serves no models, so the registry is empty."""

from typing import Literal

from .common import ApiModel


class TrajectoryModelInfo(ApiModel):
    horizons_s: list[float]
    input_window_frames: int
    uncertainty: Literal["none", "samples", "gaussian"]
    uncertainty_note: str | None
    origin_rule: str
    origin_after_snap: bool


class RetrievalModelInfo(ApiModel):
    representation: str
    distance: Literal["cosine"]
    index: Literal["exact", "hnsw"]
    corpus_size: int


class ModelInfo(ApiModel):
    model_version: str
    task: Literal["trajectory", "retrieval", "counterfactual"]
    kind: Literal["learned", "baseline", "mock"]
    name: str
    description: str
    served: bool
    evaluation_status: Literal["evaluated", "pending", "unavailable"]
    trajectory: TrajectoryModelInfo | None
    retrieval: RetrievalModelInfo | None
