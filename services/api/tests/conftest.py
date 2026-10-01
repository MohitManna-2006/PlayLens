"""Shared fixtures: a tiny synthetic raw dataset, preprocessed exactly like real
data."""

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from playlens_api.config import Settings
from playlens_api.main import create_app
from playlens_ml.data.preprocess import PreprocessOptions, RunSummary, run
from playlens_ml.data.subset import DevSubsetRule
from playlens_ml.data.testing import default_plays, write_raw_dataset
from playlens_ml.datasets.testing import build_synthetic_ml_root, tiny_config
from playlens_ml.training.train import TrainingResult, run_training


@pytest.fixture(scope="session")
def synthetic_run(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, RunSummary]:
    root = tmp_path_factory.mktemp("data")
    raw = write_raw_dataset(root / "raw" / "release", default_plays())
    summary = run(
        PreprocessOptions(
            data_root=root, raw_dir=raw, rule=DevSubsetRule(plays_per_week=2)
        )
    )
    return root, summary


@pytest.fixture(scope="session")
def client(synthetic_run: tuple[Path, RunSummary]) -> Iterator[TestClient]:
    root, _ = synthetic_run
    # model_dir points at an empty folder: these tests cover the no-model state.
    settings = Settings(
        data_root=root, model_dir=root / "no-models", log_level="WARNING"
    )
    with TestClient(create_app(settings)) as c:
        yield c


@pytest.fixture()
def empty_client(tmp_path: Path) -> Iterator[TestClient]:
    settings = Settings(
        data_root=tmp_path, model_dir=tmp_path / "no-models", log_level="WARNING"
    )
    with TestClient(create_app(settings)) as c:
        yield c


@pytest.fixture(scope="session")
def model_run(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, TrainingResult]:
    """Synthetic full subset + splits + a tiny model trained on CPU in seconds."""
    root = build_synthetic_ml_root(tmp_path_factory.mktemp("mldata"))
    result = run_training(
        tiny_config(epochs=2), data_root=root, artifacts_root=root / "artifacts"
    )
    return root, result


@pytest.fixture(scope="session")
def model_client(model_run: tuple[Path, TrainingResult]) -> Iterator[TestClient]:
    root, _ = model_run
    settings = Settings(
        data_root=root,
        subset="full",
        model_dir=root / "artifacts" / "models",
        log_level="WARNING",
    )
    with TestClient(create_app(settings)) as c:
        yield c
