"""Training configuration, loaded from YAML. Experiment values live in configs/, not in
code."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any, Literal

import yaml

from ..models.trajectory import TargetRepresentation
from .runtime import DeviceChoice


@dataclass
class DataConfig:
    subset: str = "full"
    window: int = 20
    """Observed frames per player (right-aligned at the last observed frame)."""
    horizon: int | Literal["auto_q95"] = "auto_q95"
    """Future steps; auto_q95 = smallest H covering 95% of train target players'
    futures."""


@dataclass
class ModelSection:
    hidden: int = 96
    categorical_dim: int = 8
    knn: int = 4
    gnn_layers: int = 2
    gnn_heads: int = 4
    transformer_layers: int = 2
    transformer_heads: int = 4
    ff_mult: int = 2
    dropout: float = 0.1
    embedding_dim: int = 128
    interaction_layer: bool = True
    head_hidden: int = 192
    target_representation: TargetRepresentation = "residual_cv"


@dataclass
class TrainSection:
    batch_size: int = 64
    lr: float = 1e-3
    weight_decay: float = 1e-4
    epochs: int = 30
    patience: int = 6
    warmup_epochs: float = 1.0
    grad_clip: float = 1.0
    mirror_probability: float = 0.5
    device: DeviceChoice = "auto"
    num_workers: int = 0
    max_train_plays: int | None = None
    """Cap for quick runs; None trains on the whole train split."""


@dataclass
class TrackingSection:
    mlflow: bool = True
    experiment: str = "playlens-trajectory"
    tracking_uri: str | None = None
    """None = sqlite database under <repo>/mlruns."""


@dataclass
class TrainingConfig:
    model_name: str = "trajectory-gnn-transformer"
    model_version: str = "trajectory-gnn-transformer-v1"
    seed: int = 7
    export: bool = True
    evaluate_test: bool = True
    """False for ablations: compare on validation only and leave test untouched."""
    data: DataConfig = field(default_factory=DataConfig)
    model: ModelSection = field(default_factory=ModelSection)
    train: TrainSection = field(default_factory=TrainSection)
    tracking: TrackingSection = field(default_factory=TrackingSection)

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def _build(cls: type[Any], data: dict[str, Any] | None) -> Any:
    data = dict(data or {})
    known = {f.name for f in fields(cls)}
    unknown = set(data) - known
    if unknown:
        raise ValueError(f"Unknown {cls.__name__} keys: {sorted(unknown)}")
    return cls(**data)


def load_config(path: Path, overrides: dict[str, Any] | None = None) -> TrainingConfig:
    raw: dict[str, Any] = yaml.safe_load(path.read_text()) or {}
    for dotted, value in (overrides or {}).items():
        section, _, key = dotted.partition(".")
        if key:
            raw.setdefault(section, {})[key] = value
        else:
            raw[section] = value
    sections = {
        "data": DataConfig,
        "model": ModelSection,
        "train": TrainSection,
        "tracking": TrackingSection,
    }
    top = {k: v for k, v in raw.items() if k not in sections}
    cfg: TrainingConfig = _build(TrainingConfig, top)
    for name, cls in sections.items():
        setattr(cfg, name, _build(cls, raw.get(name)))
    return cfg
