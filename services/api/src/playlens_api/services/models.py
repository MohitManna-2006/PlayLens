"""Model registry, trajectory inference, and evaluation reports.

Models are loaded from deployable artifacts (artifacts/models/<version>/). If
none exists the registry is empty and prediction routes answer 503; the API
never substitutes another source.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import polars as pl
from playlens_ml.inference.artifact import ArtifactError
from playlens_ml.inference.predictor import TrajectoryPredictor, Unsupported

from ..errors import ApiError, InvalidQuery
from ..repository.base import PlayRecord, TrackingRow
from ..schemas.models import (
    ConditionGroup,
    ErrorByHorizon,
    EvaluationReport,
    EvaluationScope,
    HorizonPoint,
    HorizonSeries,
    InputWindow,
    Interval,
    LatencyConditions,
    LatencyRow,
    ModelInfo,
    ModelMetric,
    ModelProvenance,
    PathPoint,
    PredictedPlayer,
    Reproducibility,
    SliceMetrics,
    SliceRow,
    SystemMetrics,
    TrajectoryMetrics,
    TrajectoryModelInfo,
    TrajectoryPrediction,
    TrajectoryRequest,
    TrajectoryRow,
    TrajectoryUncertainty,
    UncertaintyEvaluation,
)
from .plays import PlayService

PlaySplit = Literal["train", "validation", "test", "unknown"]

log = logging.getLogger("playlens.api.models")
BASELINES = {
    "cv": (
        "trajectory-cv-baseline-v1",
        "Constant velocity (supplied speed and direction)",
    ),
    "cv-fd": ("trajectory-cv-fd-baseline-v1", "Constant velocity (finite difference)"),
}
NO_UNCERTAINTY = (
    "Deterministic point forecast. The model outputs no uncertainty, so none is drawn."
)


class ModelUnavailable(ApiError):
    status = 503
    code = "model_unavailable"


class ModelNotFound(ApiError):
    status = 404
    code = "model_not_found"


class UnsupportedPrediction(ApiError):
    status = 422
    code = "unsupported_prediction"


@dataclass
class LoadedModel:
    predictor: TrajectoryPredictor
    directory: Path
    evaluation: dict[str, Any] | None
    benchmark: dict[str, Any] | None
    game_split: dict[int, PlaySplit] = field(default_factory=dict)

    @property
    def meta(self) -> dict[str, Any]:
        return self.predictor.artifact.metadata

    @property
    def version(self) -> str:
        return self.predictor.artifact.model_version


def _read_json(path: Path) -> dict[str, Any] | None:
    return json.loads(path.read_text()) if path.is_file() else None


@dataclass
class ModelRegistry:
    models: list[LoadedModel]
    errors: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls, directory: Path, device: str = "cpu") -> ModelRegistry:
        models: list[LoadedModel] = []
        errors: dict[str, str] = {}
        if directory.is_dir():
            for sub in sorted(
                p for p in directory.iterdir() if (p / "model.json").is_file()
            ):
                try:
                    predictor = TrajectoryPredictor.load(sub, device)
                except (ArtifactError, KeyError, RuntimeError) as err:
                    errors[sub.name] = str(err)
                    log.error(
                        "model.load_failed",
                        extra={"model": sub.name, "reason": str(err)},
                    )
                    continue
                meta = predictor.artifact.metadata
                game_split = {
                    int(g): s
                    for s, games in meta.get("games_by_split", {}).items()
                    for g in games
                }
                models.append(
                    LoadedModel(
                        predictor,
                        sub,
                        _read_json(sub / "evaluation.json"),
                        _read_json(sub / "benchmark.json"),
                        game_split,
                    )
                )
                log.info(
                    "model.loaded",
                    extra={
                        "model_version": predictor.artifact.model_version,
                        "device": device,
                    },
                )
        return cls(models, errors)

    def get(self, version: str | None) -> LoadedModel:
        if not self.models:
            detail = f" Load errors: {self.errors}." if self.errors else ""
            raise ModelUnavailable(
                "No trajectory model is loaded. Train one with `pnpm ml:train`, "
                "which exports "
                f"artifacts/models/<version>/, then restart the API.{detail}"
            )
        if version is None:
            return self.models[0]
        for m in self.models:
            if m.version == version:
                return m
        raise ModelNotFound(
            f"Model {version} is not loaded. Loaded: "
            f"{[m.version for m in self.models]}."
        )

    def infos(self) -> list[ModelInfo]:
        return [model_info(m) for m in self.models]


def model_info(m: LoadedModel) -> ModelInfo:
    meta, art = m.meta, m.predictor.artifact
    metrics: list[ModelMetric] = []
    for split in ("validation", "test"):
        s = (meta.get("metrics") or {}).get(split)
        if s:
            metrics.append(
                ModelMetric(
                    split=split,
                    ade_yd=s["model"]["ade_yd"],
                    fde_yd=s["model"]["fde_yd"],
                    players=s["model"]["players"],
                    baseline_model_version=BASELINES["cv"][0],
                    baseline_ade_yd=s["cv"]["ade_yd"],
                    baseline_fde_yd=s["cv"]["fde_yd"],
                )
            )
    enc = meta["encoder"]
    return ModelInfo(
        model_version=art.model_version,
        task="trajectory",
        kind="learned",
        name="Spatial-temporal trajectory model (GATv2 + Transformer)",
        description=(
            f"Encodes the last {art.window} observed frames as per-frame kNN player "
            f"graphs (k={enc['knn']}, "
            f"{enc['gnn_layers']} GATv2 layers) and per-player temporal Transformers "
            f"({enc['transformer_layers']} layers), "
            f"then predicts {art.horizon} future steps for each target player as a "
            "correction to constant velocity. "
            "Inputs exclude the ball landing point, charted labels, and outcomes."
        ),
        served=True,
        evaluation_status="evaluated" if metrics else "pending",
        trajectory=TrajectoryModelInfo(
            horizons_s=[round(art.horizon / meta["frame_rate_hz"], 3)],
            input_window_frames=art.window,
            uncertainty="none",
            uncertainty_note=NO_UNCERTAINTY,
            origin_rule=(
                "Forecasts start at the play's last observed frame, where the "
                "dataset's input window ends."
            ),
            origin_after_snap=False,
            origin="last_observed_frame",
        ),
        retrieval=None,
        provenance=ModelProvenance(
            model_name=meta["model_name"],
            run_id=meta.get("run_id"),
            mlflow_run_id=meta.get("mlflow_run_id"),
            dataset_version=meta["dataset_version"],
            split_version=meta["split_version"],
            created_at=meta.get("created_at"),
            parameters=int(meta["parameters"]),
            weights_bytes=int(meta["weights_bytes"]),
            git_commit=(meta.get("git") or {}).get("commit"),
        ),
        metrics=metrics,
    )


def _weeks(weeks: list[int]) -> str:
    return f"weeks {weeks[0]}-{weeks[-1]}" if weeks else "no weeks"


def _frames(
    record: PlayRecord, tracking: list[TrackingRow]
) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame]:
    play = pl.DataFrame([dict(record.play)])
    players = pl.DataFrame([dict(r) for r in record.players])
    trk = pl.DataFrame(
        tracking,
        schema_overrides={
            "s": pl.Float64,
            "a": pl.Float64,
            "dir": pl.Float64,
            "o": pl.Float64,
        },
    )
    trk = trk.with_columns(
        pl.lit(record.game_id).alias("game_id"), pl.lit(record.play_id).alias("play_id")
    )
    return play, players, trk


class PredictionService:
    def __init__(self, registry: ModelRegistry, plays: PlayService) -> None:
        self.registry = registry
        self.plays = plays

    def predict(self, req: TrajectoryRequest) -> TrajectoryPrediction:
        start = time.perf_counter()
        loaded = self.registry.get(req.model_version)
        art = loaded.predictor.artifact
        record = self.plays.record(req.play_id)
        tracking = self.plays.repo.observed_tracking(record.game_id, record.play_id)
        last_frame = int(record.play["observed_last_frame_id"])
        if req.origin_frame_id is not None and req.origin_frame_id != last_frame:
            raise UnsupportedPrediction(
                f"{art.model_version} forecasts only from the last observed frame "
                f"({last_frame}); "
                f"frame {req.origin_frame_id} was requested.",
                {"reason": "unsupported_origin", "origin_frame_id": last_frame},
            )
        rate = float(art.metadata["frame_rate_hz"])
        steps = art.horizon
        if req.horizon_s is not None:
            steps = round(req.horizon_s * rate)
            if steps < 1 or steps > art.horizon:
                raise InvalidQuery(
                    f"horizon_s must be between {1 / rate:.1f} and "
                    f"{art.horizon / rate:.1f} s."
                )
        result = loaded.predictor.predict_play(*_frames(record, tracking))
        if isinstance(result, Unsupported):
            raise UnsupportedPrediction(result.message, {"reason": result.reason})
        supplied = (
            int(record.play["future_frame_count"])
            if record.play.get("future_frame_count") is not None
            else None
        )
        wanted = set(req.player_ids) if req.player_ids else None
        warnings: list[str] = []
        players = []
        for p in result.players:
            pid = str(p.nfl_id)
            if wanted is not None and pid not in wanted:
                continue
            players.append(
                PredictedPlayer(
                    player_id=pid,
                    path=[
                        PathPoint(x=round(float(x), 3), y=round(float(y), 3))
                        for x, y in p.positions[:steps]
                    ],
                    valid=[supplied is None or k < supplied for k in range(steps)],
                    samples=None,
                )
            )
        if wanted is not None:
            missing = sorted(wanted - {pl_.player_id for pl_ in players})
            if missing:
                warnings.append(
                    "Not forecast (not a target player in this play): "
                    f"{', '.join(missing)}."
                )
        if supplied is not None and supplied < steps:
            warnings.append(
                f"The dataset supplies {supplied} future frames for this play; later "
                "steps have no actual position to compare."
            )
        split = loaded.game_split.get(record.game_id, "unknown")
        return TrajectoryPrediction(
            request_id=uuid.uuid4().hex[:12],
            play_id=record.id,
            model_name=art.metadata["model_name"],
            model_version=art.model_version,
            dataset_version=art.metadata["dataset_version"],
            split_version=art.metadata["split_version"],
            play_split=split,
            origin_frame_id=result.origin_frame_id,
            input_window=InputWindow(
                start_frame_id=result.input_start_frame_id,
                end_frame_id=result.origin_frame_id,
            ),
            horizon_s=round(steps / rate, 3),
            step_s=round(1 / rate, 3),
            future_frame_ids=list(range(1, steps + 1)),
            target_horizon_frames=supplied,
            players=players,
            uncertainty=TrajectoryUncertainty(
                kind="none", calibration=None, description=NO_UNCERTAINTY
            ),
            latency_ms=round((time.perf_counter() - start) * 1000, 2),
            latency_scope=(
                "Server side: data access, feature build, and forward pass on CPU; "
                "excludes network"
            ),
            warnings=warnings,
        )


def evaluation_report(
    m: LoadedModel, repo_root: Path | None = None
) -> EvaluationReport:
    meta, ev, art = m.meta, m.evaluation, m.predictor.artifact
    base = dict(
        model_version=m.version,
        task="trajectory",
        run_id=meta.get("run_id"),
        run_time=meta.get("created_at"),
        dataset_version=meta.get("dataset_version"),
        retrieval=None,
    )
    if not ev:
        return EvaluationReport(
            **base,
            status="pending",
            status_reason="No evaluation.json is stored with this artifact.",
            split=None,
            artifact_uri=None,
            scope=None,
            trajectory=None,
            error_by_horizon=None,
            uncertainty=None,
            system=None,
            slices=None,
            failure_modes=[],
            reproducibility=None,
        )
    rate = float(meta["frame_rate_hz"])
    horizon_s = round(art.horizon / rate, 3)
    policy = meta.get("split_policy", {})
    test = ev["splits"]["test"]
    labels: dict[str, tuple[str, str, Literal["learned", "baseline"], bool]] = {
        "model": (m.version, "Learned model", "learned", True),
        "cv": (*BASELINES["cv"], "baseline", False),
        "cv-fd": (*BASELINES["cv-fd"], "baseline", False),
    }

    def row(split: str, key: str) -> TrajectoryRow:
        e = ev["splits"][split][key]
        version, label, kind, served = labels[key]
        return TrajectoryRow(
            model_version=version,
            label=label,
            is_served=served,
            kind=kind,
            ade_yd=e["summary"]["ade_yd"],
            fde_yd=e["summary"]["fde_yd"],
            ade_interval=Interval(**e["ade_interval"]),
            fde_interval=Interval(**e["fde_interval"]),
            horizon_s=horizon_s,
            n=e["summary"]["players"],
        )

    groups = [
        ConditionGroup(
            conditions=(
                f"Test split ({_weeks(policy.get('test_weeks', []))}) · horizon up to "
                f"{horizon_s} s · same target players and masks for every row"
            ),
            rows=[row("test", k) for k in labels],
        ),
        ConditionGroup(
            conditions=(
                f"Validation split ({_weeks(policy.get('validation_weeks', []))}), "
                "used for checkpoint selection"
            ),
            rows=[row("validation", k) for k in labels],
        ),
    ]
    series = [
        HorizonSeries(
            model_version=labels[k][0],
            label=labels[k][1],
            is_served=labels[k][3],
            points=[
                HorizonPoint(
                    horizon_s=p["horizon_s"],
                    value=p["error_yd"],
                    lo=None,
                    hi=None,
                    n=p["players"],
                )
                for p in test[k]["horizon"]
            ],
        )
        for k in labels
    ]
    cv_slices = {(s["slice"], s["value"]): s for s in test["cv"]["slices"]}
    slice_rows = []
    for s in test["model"]["slices"]:
        cv = cv_slices.get((s["slice"], s["value"]))
        slice_rows.append(
            SliceRow(
                slice=f"{s['slice'].replace('_', ' ')}: {s['value']}",
                n=s["players"],
                ade_yd=s["ade_yd"],
                fde_yd=s["fde_yd"],
                coverage=None,
                sufficient=s["sufficient"],
                note=(
                    f"Constant velocity ADE {cv['ade_yd']:.2f} / FDE "
                    f"{cv['fde_yd']:.2f} yd"
                )
                if cv
                else None,
            )
        )
    worse = [
        f"{s['slice']}: {s['value']}"
        for s in test["model"]["slices"]
        if s["sufficient"]
        and (cv := cv_slices.get((s["slice"], s["value"])))
        and s["ade_yd"] > cv["ade_yd"]
    ]
    curve = test["model"]["horizon"]
    first, last = curve[0], curve[-1]
    failure_modes = [
        f"Error grows with horizon: {first['error_yd']:.2f} yd at "
        f"{first['horizon_s']} s to {last['error_yd']:.2f} yd at "
        f"{last['horizon_s']} s (n = {last['players']} players still in view at the "
        "last step).",
        "Inputs cover only the tracked subset of players (no offensive linemen or "
        "pass rushers) and no ball track.",
        "The ball landing point is excluded from inputs, so the model infers where "
        "the pass goes from player motion only.",
    ]
    failure_modes.extend(f"Slice worse than constant velocity: {w}" for w in worse)
    system = None
    if m.benchmark:
        rows, conditions = [], None
        for device, b in sorted(m.benchmark.items()):
            rows.append(
                LatencyRow(
                    operation=f"Predict one play on {device} (feature build + forward)",
                    p50_ms=b["p50_ms"],
                    p95_ms=b["p95_ms"],
                    p99_ms=b["p99_ms"],
                    n=b["plays"],
                )
            )
            if conditions is None or device == "cpu":
                conditions = LatencyConditions(
                    hardware=b["hardware"],
                    dataset_size=f"{b['plays']} test-split plays",
                    index_size=None,
                    batch_size=b["batch_size"],
                    warm=True,
                    timing_scope="model_only",
                )
        assert conditions is not None
        system = SystemMetrics(rows=rows, conditions=conditions)
    root = repo_root or m.directory.parents[2]

    def rel(p: Path) -> str:
        return str(p.relative_to(root)) if p.is_relative_to(root) else str(p)

    return EvaluationReport(
        **base,
        status="complete",
        status_reason=None,
        split=(
            f"test ({_weeks(policy.get('test_weeks', []))}); checkpoint selected on "
            f"validation ({_weeks(policy.get('validation_weeks', []))})"
        ),
        artifact_uri=rel(m.directory),
        scope=EvaluationScope(
            predicted=(
                "Future canonical x/y of each player flagged player_to_predict (the "
                "targeted receiver and flagged coverage defenders)"
            ),
            observation_window=(
                f"the last {art.window} observed frames ({art.window / rate:.1f} s) "
                "before the prediction origin; shorter plays padded and masked"
            ),
            horizon=(
                f"{art.horizon} steps ({horizon_s} s) after the last observed frame; "
                "steps beyond a play's supplied future are masked"
            ),
            population=(
                "Tracked passing plays from the NFL Big Data Bowl 2026 Analytics "
                "release, 2023 season"
            ),
            sample_unit="target player",
            sample_count=int(test["model"]["summary"]["players"]),
            exclusions=(
                "none; every test-split target player with at least one supplied "
                "future frame is scored"
            ),
            split_policy=(
                f"{policy.get('name', 'unknown')}: train "
                f"{_weeks(policy.get('train_weeks', []))}, validation "
                f"{_weeks(policy.get('validation_weeks', []))}, test "
                f"{_weeks(policy.get('test_weeks', []))}; whole games stay in one split"
            ),
            limitations=[
                "Passing plays only; 1-17 tracked players per play, no offensive "
                "linemen or pass rushers.",
                "No frame-level ball track; the ball landing point is deliberately "
                "not an input.",
                "Future positions exist only for flagged target players.",
                "Deterministic point forecasts without uncertainty.",
                "One season (2023); test weeks 17-18 may include rested starters.",
            ],
        ),
        trajectory=TrajectoryMetrics(
            aggregation=(
                "mean over target players of per-player ADE (mean error over valid "
                "steps) and FDE (error at the last valid step); 95% intervals from "
                "1,000 bootstrap resamples of plays"
            ),
            masks=(
                "steps beyond min(horizon, supplied future) are excluded; non-target "
                "players are never scored"
            ),
            condition_groups=groups,
        ),
        error_by_horizon=ErrorByHorizon(
            definition=(
                "Mean Euclidean error (yd) at each future step on the test split, "
                "over target players with a supplied position at that step."
            ),
            series=series,
        ),
        uncertainty=UncertaintyEvaluation(
            calibration=None,
            supported=False,
            unsupported_reason=NO_UNCERTAINTY,
            definition="Coverage of nominal prediction regions.",
            coverage=[],
        ),
        system=system,
        slices=SliceMetrics(
            reporting_rule=(
                "Test split. Slices with fewer than "
                f"{ev.get('min_slice_players', 100)} target players are marked "
                "insufficient."
            ),
            rows=slice_rows,
        ),
        failure_modes=failure_modes,
        reproducibility=Reproducibility(
            git_commit=(meta.get("git") or {}).get("commit"),
            config=meta.get("config_path")
            or (
                f"artifacts/runs/{meta['run_id']}/config.json"
                if meta.get("run_id")
                else None
            ),
            dataset_manifest=meta.get("dataset_version"),
            run_id=meta.get("run_id"),
            artifacts=[
                rel(m.directory / "model.json"),
                rel(m.directory / "evaluation.json"),
            ],
        ),
    )
