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
from pathlib import Path
from typing import Any

from playlens_ml.data.paths import find_repo_root
from playlens_ml.data.preprocess import PreprocessOptions, run
from playlens_ml.data.subset import DevSubsetRule
from playlens_ml.data.testing import default_plays, write_raw_dataset

from .config import Settings
from .main import create_app

FIXED_TIME = "2026-01-01T00:00:00+00:00"
HEADERS = {"X-Request-ID": "example"}


def _normalize(value: Any) -> Any:
    """Replace run-specific values so regenerated files are byte-stable."""
    if isinstance(value, dict):
        return {
            k: FIXED_TIME if k == "generated_at" and v else _normalize(v)
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_normalize(v) for v in value]
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
        app = create_app(Settings(data_root=root, log_level="WARNING"))
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
                "models.json": get("/api/v1/models"),
                "error-play-not-found.json": get("/api/v1/plays/2099090010-999"),
                "error-invalid-play-id.json": get("/api/v1/plays/101"),
            }
            openapi = app.openapi()
    return {
        **{f"examples/{k}": _normalize(v) for k, v in examples.items()},
        "openapi.json": openapi,
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
