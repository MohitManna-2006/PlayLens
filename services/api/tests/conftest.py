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
    with TestClient(create_app(Settings(data_root=root, log_level="WARNING"))) as c:
        yield c


@pytest.fixture()
def empty_client(tmp_path: Path) -> Iterator[TestClient]:
    with TestClient(create_app(Settings(data_root=tmp_path, log_level="WARNING"))) as c:
        yield c
