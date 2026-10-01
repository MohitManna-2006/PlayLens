"""Synthetic end-to-end ML fixtures for tests (no NFL data, CPU, seconds)."""

from __future__ import annotations

from pathlib import Path

from ..data.preprocess import PreprocessOptions, run
from ..data.testing import SyntheticPlay, default_plays, write_raw_dataset
from ..training.config import (
    DataConfig,
    ModelSection,
    TrackingSection,
    TrainingConfig,
    TrainSection,
)
from .splits import SplitPolicy, write_splits

# default_plays() spans weeks 1-3, so tests split one week per partition.
TEST_POLICY = SplitPolicy(
    name="synthetic-weeks-v1", train_weeks=(1,), validation_weeks=(2,), test_weeks=(3,)
)


def synthetic_plays() -> list[SyntheticPlay]:
    plays = default_plays()
    # A short play (fewer observed frames than the model window) exercises front
    # padding.
    plays.append(
        SyntheticPlay(
            game_id=2099090010,
            play_id=900,
            week=1,
            direction="left",
            frames=9,
            future_frames=5,
            offense="AAA",
            defense="BBB",
        )
    )
    return plays


def build_synthetic_ml_root(root: Path) -> Path:
    """Raw synthetic files -> canonical 'full' subset -> synthetic split policy.
    Returns the data root."""
    raw = write_raw_dataset(root / "raw" / "release", synthetic_plays())
    run(PreprocessOptions(subset="full", data_root=root, raw_dir=raw))
    write_splits("full", TEST_POLICY, data_root=root)
    return root


def tiny_config(
    window: int = 12, epochs: int = 2, export: bool = True
) -> TrainingConfig:
    return TrainingConfig(
        model_name="trajectory-test",
        model_version="trajectory-test-v1",
        seed=3,
        export=export,
        data=DataConfig(subset="full", window=window, horizon=8),
        model=ModelSection(
            hidden=16,
            categorical_dim=4,
            knn=3,
            gnn_layers=1,
            gnn_heads=2,
            transformer_layers=1,
            transformer_heads=2,
            ff_mult=2,
            dropout=0.0,
            embedding_dim=8,
            head_hidden=16,
        ),
        train=TrainSection(
            batch_size=4,
            lr=3e-3,
            epochs=epochs,
            patience=10,
            warmup_epochs=0.0,
            device="cpu",
            mirror_probability=0.5,
        ),
        tracking=TrackingSection(mlflow=False),
    )
