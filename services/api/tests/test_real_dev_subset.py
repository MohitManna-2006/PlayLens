"""Regression checks against the real development subset.

Skipped when the licensed raw data has not been preprocessed on this machine
(CI never has it). Expected values come from the run's own manifest and
Parquet artifacts, not from hardcoded numbers.
"""

import json
from collections.abc import Iterator
from typing import Any

import polars as pl
import pytest
from fastapi.testclient import TestClient
from playlens_api.config import Settings
from playlens_api.main import create_app
from playlens_ml.data.paths import data_layout

LAYOUT = data_layout()
MANIFEST = LAYOUT.manifests / "nfl_bdb_2026_analytics.dev.manifest.json"
PROCESSED = LAYOUT.processed / "nfl_bdb_2026_analytics" / "dev"

pytestmark = pytest.mark.skipif(
    not (MANIFEST.is_file() and (PROCESSED / "dataset.json").is_file()),
    reason="Real dev subset not preprocessed (run `pnpm data:dev`).",
)


@pytest.fixture(scope="module")
def manifest() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(MANIFEST.read_text())
    return data


@pytest.fixture(scope="module")
def real_client() -> Iterator[TestClient]:
    with TestClient(create_app(Settings(log_level="WARNING"))) as c:
        yield c


def test_serves_every_selected_play(
    real_client: TestClient, manifest: dict[str, Any]
) -> None:
    page = real_client.get("/api/v1/plays", params={"page_size": 200}).json()
    assert page["dataset"]["dataset_version"] == manifest["dataset_version"]
    assert sorted(p["id"] for p in page["items"]) == sorted(
        manifest["selected_play_ids"]
    )


def test_first_selected_play_matches_processed_rows(
    real_client: TestClient, manifest: dict[str, Any]
) -> None:
    pid = manifest["selected_play_ids"][0]
    game_id, play_id = (int(v) for v in pid.split("-"))
    plays = (
        pl.read_parquet(PROCESSED / "observed" / "plays.parquet")
        .filter((pl.col("game_id") == game_id) & (pl.col("play_id") == play_id))
        .row(0, named=True)
    )
    detail = real_client.get(f"/api/v1/plays/{pid}").json()
    frames = real_client.get(f"/api/v1/plays/{pid}/frames").json()["frames"]
    future = real_client.get(f"/api/v1/plays/{pid}/future").json()
    assert (
        len(frames)
        == plays["observed_frame_count"]
        == detail["tracking"]["observed_frame_count"]
    )
    assert all(len(f["players"]) == plays["player_count"] for f in frames)
    assert detail["line_of_scrimmage_x"] == plays["line_of_scrimmage_x"]
    assert len(future["trajectories"]) == plays["predicted_player_count"]
    assert future["origin_frame_id"] == frames[-1]["frame_id"]
    # Canonical frame: the passer starts behind the line of scrimmage on every play.
    passer = next(p["player_id"] for p in detail["players"] if p["role"] == "Passer")
    start = next(p for p in frames[0]["players"] if p["player_id"] == passer)
    assert start["x"] < detail["line_of_scrimmage_x"]


def test_total_rows_match_manifest(
    real_client: TestClient, manifest: dict[str, Any]
) -> None:
    observed = future = 0
    for pid in manifest["selected_play_ids"]:
        observed += sum(
            len(f["players"])
            for f in real_client.get(f"/api/v1/plays/{pid}/frames").json()["frames"]
        )
        future += sum(
            len(t["points"])
            for t in real_client.get(f"/api/v1/plays/{pid}/future").json()[
                "trajectories"
            ]
        )
    assert observed == manifest["counts"]["observed_tracking_rows"]
    assert future == manifest["counts"]["future_trajectory_rows"]
