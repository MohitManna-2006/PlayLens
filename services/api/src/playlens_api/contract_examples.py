"""Generate the shared contract artifacts in packages/contracts.

    uv run python -m playlens_api.contract_examples

Example payloads come from the real API code serving a tiny synthetic dataset
(no NFL data is committed). The web test suite parses every example with its
zod schemas, and an API test fails when these files drift from the code.
"""

from __future__ import annotations

import json
import sys
import tempfile
import warnings
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl
from playlens_ml.data.paths import find_repo_root
from playlens_ml.data.preprocess import PreprocessOptions, run
from playlens_ml.data.subset import DevSubsetRule
from playlens_ml.data.testing import default_plays, write_raw_dataset
from playlens_ml.datasets.testing import build_synthetic_ml_root, tiny_config
from playlens_ml.embeddings.export import export_embeddings
from playlens_ml.training.train import run_training

from .config import Settings
from .main import create_app
from .retrieval.artifact import EmbeddingArtifact, load_artifact
from .retrieval.memory import InMemoryVectorStore

FIXED_TIME = "2026-01-01T00:00:00+00:00"
HEADERS = {"X-Request-ID": "example"}
# Run-specific values replaced so regenerated files are stable across runs and machines.
VOLATILE = {
    "generated_at": FIXED_TIME,
    "created_at": FIXED_TIME,
    "run_time": FIXED_TIME,
    "run_id": "trajectory-test-example-run",
    "request_id": "example",
    "latency_ms": 1.0,
    "database_ms": 1.0,
    "search_ms": 1.0,
    "git_commit": "0000000000000000000000000000000000000000",
}
FLOAT_DIGITS = 4


def _normalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            k: (VOLATILE[k] if k in VOLATILE and v is not None else _normalize(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    if isinstance(value, float):
        return round(value, FLOAT_DIGITS)
    return value


def build() -> dict[str, Any]:
    with warnings.catch_warnings():
        # Starlette's test client warns about its httpx transport; irrelevant here.
        warnings.simplefilter("ignore")
        from fastapi.testclient import TestClient
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        raw = write_raw_dataset(root / "raw" / "release", default_plays())
        summary = run(
            PreprocessOptions(
                data_root=root, raw_dir=raw, rule=DevSubsetRule(plays_per_week=2)
            )
        )
        plays = {f"{p.game_id}-{p.play_id}": p for p in default_plays()}
        left = next(i for i in summary.selected_ids if plays[i].direction == "left")
        app = create_app(
            Settings(
                data_root=root,
                model_dir=root / "no-models",
                database_url=None,
                log_level="WARNING",
            )
        )
        with TestClient(app, headers=HEADERS) as c:

            def get(path: str, **params: Any) -> Any:
                return c.get(path, params=params).json()

            examples = {
                "health.json": get("/health"),
                "dataset.json": get("/api/v1/dataset"),
                "play-page.json": get("/api/v1/plays", page_size=3),
                "facets.json": get("/api/v1/plays/facets"),
                "play-detail.json": get(f"/api/v1/plays/{left}"),
                "frames.json": get(f"/api/v1/plays/{left}/frames"),
                "future.json": get(f"/api/v1/plays/{left}/future"),
                "models-empty.json": get("/api/v1/models"),
                "error-play-not-found.json": get("/api/v1/plays/2099090010-999"),
                "error-invalid-play-id.json": get("/api/v1/plays/101"),
                "error-model-unavailable.json": c.post(
                    "/api/v1/predict/trajectory", json={"play_id": left}
                ).json(),
                "error-retrieval-unavailable.json": c.post(
                    "/api/v1/search/similar", json={"play_id": left}
                ).json(),
            }
            openapi = app.openapi()
        examples.update(_model_examples(root / "ml", left, TestClient))
    return {
        **{f"examples/{k}": _normalize(v) for k, v in examples.items()},
        "openapi.json": openapi,
    }


def _spread(art: EmbeddingArtifact) -> EmbeddingArtifact:
    """Replace the export's vectors with unit vectors on a cone at unevenly spaced
    angles, so no two neighbours tie."""
    n, dim = art.table.height, art.dimension
    i = np.arange(n)
    angles = 0.2 * i + 0.02 * i**2
    v = np.zeros((n, dim), np.float64)
    v[:, 0], v[:, 1], v[:, 2] = np.cos(angles), np.sin(angles), 0.5
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    column = pl.Series(
        "embedding", v.astype(np.float32), dtype=pl.Array(pl.Float32, dim)
    )
    return replace(art, table=art.table.with_columns(column))


def _model_examples(root: Path, play_id: str, client_cls: Any) -> dict[str, Any]:
    """A tiny model trained for two epochs on synthetic data (CPU), served by the real
    routes. Similarity examples run the real search and compare services over the
    in-memory reference store (the served store is PostgreSQL + pgvector, with the
    same contract). Their vectors are deterministic and well separated instead of
    the two-epoch model's, which are nearly identical, so the example ranking does
    not depend on CPU floating-point details."""
    build_synthetic_ml_root(root)
    result = run_training(
        tiny_config(epochs=2),
        data_root=root,
        artifacts_root=root / "artifacts",
        config_path="playlens_ml.datasets.testing.tiny_config",
    )
    assert result.artifact_dir is not None
    export_embeddings(result.artifact_dir, subset="full", data_root=root)
    store = InMemoryVectorStore.from_artifact(
        _spread(load_artifact("trajectory-test-v1", "full", data_root=root)), root
    )
    settings = Settings(
        data_root=root,
        subset="full",
        model_dir=root / "artifacts" / "models",
        database_url=None,
        embedding_model_version="trajectory-test-v1",
        log_level="WARNING",
    )
    similar = "/api/v1/search/similar"
    with client_cls(create_app(settings, retrieval_store=store), headers=HEADERS) as c:
        neighbours = c.post(
            similar, json={"play_id": play_id, "k": 3, "mode": "exact"}
        ).json()
        right = neighbours["results"][0]["play_id"]
        return {
            "similar-plays.json": neighbours,
            "similar-plays-empty.json": c.post(
                similar,
                json={"play_id": play_id, "mode": "exact", "filters": {"down": 4}},
            ).json(),
            "compare.json": c.post(
                "/api/v1/compare",
                json={"left_play_id": play_id, "right_play_id": right},
            ).json(),
            "error-invalid-filters.json": c.post(
                similar,
                json={
                    "play_id": play_id,
                    "filters": {"yards_to_go_min": 9, "yards_to_go_max": 3},
                },
            ).json(),
            "models.json": c.get("/api/v1/models").json(),
            "trajectory-prediction.json": c.post(
                "/api/v1/predict/trajectory", json={"play_id": play_id}
            ).json(),
            "evaluation-summary.json": c.get("/api/v1/evaluation/summary").json(),
            "error-unsupported-origin.json": c.post(
                "/api/v1/predict/trajectory",
                json={"play_id": play_id, "origin_frame_id": 1},
            ).json(),
        }


def render(payload: Any) -> str:
    return json.dumps(payload, indent=2, sort_keys=True) + "\n"


def contracts_dir() -> Path:
    return find_repo_root() / "packages" / "contracts"


def main() -> int:
    out = contracts_dir()
    for name, payload in build().items():
        path = out / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(render(payload))
        print(f"wrote {path.relative_to(find_repo_root())}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
