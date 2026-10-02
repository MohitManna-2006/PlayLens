"""Shared fixtures: a tiny synthetic raw dataset, preprocessed exactly like real
data."""

from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from playlens_api.config import Settings
from playlens_api.main import create_app
from playlens_api.retrieval.artifact import EmbeddingArtifact, load_artifact
from playlens_api.retrieval.memory import InMemoryVectorStore
from playlens_ml.data.preprocess import PreprocessOptions, RunSummary, run
from playlens_ml.data.subset import DevSubsetRule
from playlens_ml.data.testing import default_plays, write_raw_dataset
from playlens_ml.datasets.testing import build_synthetic_ml_root, tiny_config
from playlens_ml.embeddings.export import export_embeddings
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
        data_root=root,
        model_dir=root / "no-models",
        database_url=None,
        log_level="WARNING",
    )
    with TestClient(create_app(settings)) as c:
        yield c


@pytest.fixture()
def empty_client(tmp_path: Path) -> Iterator[TestClient]:
    settings = Settings(
        data_root=tmp_path,
        model_dir=tmp_path / "no-models",
        database_url=None,
        log_level="WARNING",
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
        database_url=None,
        log_level="WARNING",
    )
    with TestClient(create_app(settings)) as c:
        yield c


@pytest.fixture(scope="session")
def embedding_export(model_run: tuple[Path, TrainingResult]) -> EmbeddingArtifact:
    """The tiny model's real exported play embeddings (8-d) for the synthetic
    'full' subset."""
    root, result = model_run
    assert result.artifact_dir is not None
    export_embeddings(result.artifact_dir, subset="full", data_root=root)
    return load_artifact("trajectory-test-v1", "full", data_root=root)


@pytest.fixture(scope="session")
def memory_store(
    model_run: tuple[Path, TrainingResult], embedding_export: EmbeddingArtifact
) -> InMemoryVectorStore:
    return InMemoryVectorStore.from_artifact(embedding_export, model_run[0])


def retrieval_settings(root: Path) -> Settings:
    return Settings(
        data_root=root,
        subset="full",
        model_dir=root / "artifacts" / "models",
        database_url=None,
        embedding_model_version="trajectory-test-v1",
        log_level="WARNING",
    )


@pytest.fixture(scope="session")
def make_retrieval_settings() -> Callable[[Path], Settings]:
    return retrieval_settings


@pytest.fixture(scope="session")
def retrieval_client(
    model_run: tuple[Path, TrainingResult], memory_store: InMemoryVectorStore
) -> Iterator[TestClient]:
    """Real API routes and services; exact search over the in-memory reference
    store (the PostgreSQL store is covered in test_retrieval_db.py)."""
    app = create_app(retrieval_settings(model_run[0]), retrieval_store=memory_store)
    with TestClient(app) as c:
        yield c
