"""Model registry, trajectory prediction, and evaluation report contracts.

Mirrored in apps/web/src/lib/contracts.ts. Every value comes from a trained
model artifact and its recorded evaluation; nothing is filled in.
"""

from typing import Literal

from pydantic import Field

from .common import ApiModel


class TrajectoryModelInfo(ApiModel):
    horizons_s: list[float]
    input_window_frames: int
    uncertainty: Literal["none", "samples", "gaussian"]
    uncertainty_note: str | None
    origin_rule: str
    origin_after_snap: bool
    origin: Literal["any_frame", "last_observed_frame"] = Field(
        description="Which frame a forecast may start from."
    )


class RetrievalModelInfo(ApiModel):
    representation: str
    distance: Literal["cosine"]
    index: Literal["exact", "hnsw"]
    corpus_size: int


class ModelProvenance(ApiModel):
    model_name: str
    run_id: str | None
    mlflow_run_id: str | None
    dataset_version: str
    split_version: str
    created_at: str | None
    parameters: int
    weights_bytes: int
    git_commit: str | None


class ModelMetric(ApiModel):
    split: Literal["validation", "test"]
    ade_yd: float
    fde_yd: float
    players: int
    baseline_model_version: str
    baseline_ade_yd: float
    baseline_fde_yd: float


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
    provenance: ModelProvenance | None = None
    metrics: list[ModelMetric] = Field(default_factory=list)


class TrajectoryRequest(ApiModel):
    play_id: str = Field(description="PlayLens play ID.", examples=["2023091008-3826"])
    model_version: str | None = Field(
        default=None, description="Default: the served trajectory model."
    )
    origin_frame_id: int | None = Field(
        default=None, description="Must be the play's last observed frame when given."
    )
    horizon_s: float | None = Field(
        default=None, gt=0, description="Default and maximum: the model horizon."
    )
    player_ids: list[str] | None = Field(
        default=None, description="Subset of target players; default all."
    )


class PathPoint(ApiModel):
    x: float
    y: float


class PredictedPlayer(ApiModel):
    player_id: str
    path: list[PathPoint] = Field(
        description="Predicted canonical positions at future steps 1..n."
    )
    valid: list[bool] = Field(
        description=(
            "True where the play supplies an actual future position for comparison."
        )
    )
    samples: list[list[PathPoint]] | None = None


class InputWindow(ApiModel):
    start_frame_id: int
    end_frame_id: int


class TrajectoryUncertainty(ApiModel):
    kind: Literal["none", "samples", "gaussian"]
    calibration: Literal["nominal", "empirical", "uncalibrated"] | None
    description: str | None


class TrajectoryPrediction(ApiModel):
    request_id: str
    play_id: str
    model_name: str
    model_version: str
    dataset_version: str
    split_version: str
    play_split: Literal["train", "validation", "test", "unknown"] = Field(
        description=(
            "Which partition this play's game belonged to when the model was trained."
        )
    )
    origin_frame_id: int
    input_window: InputWindow
    horizon_s: float
    step_s: float
    future_frame_ids: list[int] = Field(
        description=(
            "Output-file frame_id of each predicted step (step k is frame_id k after "
            "the origin)."
        )
    )
    target_horizon_frames: int | None = Field(
        description="Future frames the dataset supplies for this play."
    )
    players: list[PredictedPlayer]
    uncertainty: TrajectoryUncertainty
    latency_ms: float
    latency_scope: str
    warnings: list[str]


class Interval(ApiModel):
    lo: float
    hi: float
    level: float


class EvaluationScope(ApiModel):
    predicted: str
    observation_window: str
    horizon: str
    population: str
    sample_unit: str
    sample_count: int
    exclusions: str
    split_policy: str
    limitations: list[str]


class TrajectoryRow(ApiModel):
    model_version: str
    label: str
    is_served: bool
    kind: Literal["learned", "baseline", "mock"]
    ade_yd: float | None
    fde_yd: float | None
    ade_interval: Interval | None
    fde_interval: Interval | None
    horizon_s: float
    n: int


class ConditionGroup(ApiModel):
    conditions: str
    rows: list[TrajectoryRow]


class TrajectoryMetrics(ApiModel):
    aggregation: str
    masks: str
    condition_groups: list[ConditionGroup]


class HorizonPoint(ApiModel):
    horizon_s: float
    value: float | None
    lo: float | None
    hi: float | None
    n: int


class HorizonSeries(ApiModel):
    model_version: str
    label: str
    is_served: bool
    points: list[HorizonPoint]


class ErrorByHorizon(ApiModel):
    definition: str
    series: list[HorizonSeries]


class CoveragePoint(ApiModel):
    nominal: float
    empirical: float | None
    n: int


class UncertaintyEvaluation(ApiModel):
    calibration: Literal["nominal", "empirical", "uncalibrated"] | None
    supported: bool
    unsupported_reason: str | None
    definition: str
    coverage: list[CoveragePoint]


class LatencyRow(ApiModel):
    operation: str
    p50_ms: float | None
    p95_ms: float | None
    p99_ms: float | None
    n: int


class LatencyConditions(ApiModel):
    hardware: str
    dataset_size: str
    index_size: str | None
    batch_size: int
    warm: bool
    timing_scope: Literal["model_only", "end_to_end"]


class SystemMetrics(ApiModel):
    rows: list[LatencyRow]
    conditions: LatencyConditions


class SliceRow(ApiModel):
    slice: str
    n: int
    ade_yd: float | None
    fde_yd: float | None
    coverage: float | None
    sufficient: bool
    note: str | None


class SliceMetrics(ApiModel):
    reporting_rule: str
    rows: list[SliceRow]


class Reproducibility(ApiModel):
    git_commit: str | None
    config: str | None
    dataset_manifest: str | None
    run_id: str | None
    artifacts: list[str]


class EvaluationReport(ApiModel):
    model_version: str
    task: str
    status: Literal["complete", "pending", "unavailable"]
    status_reason: str | None
    run_id: str | None
    run_time: str | None
    dataset_version: str | None
    split: str | None
    artifact_uri: str | None
    scope: EvaluationScope | None
    trajectory: TrajectoryMetrics | None
    error_by_horizon: ErrorByHorizon | None
    uncertainty: UncertaintyEvaluation | None
    retrieval: None = None
    system: SystemMetrics | None
    slices: SliceMetrics | None
    failure_modes: list[str]
    reproducibility: Reproducibility | None
