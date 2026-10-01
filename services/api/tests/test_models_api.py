"""Model registry, trajectory inference, and evaluation endpoints with a tiny trained
model."""

import shutil
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient
from playlens_api.config import Settings
from playlens_api.main import create_app
from playlens_ml.data import canonical_schema as cs
from playlens_ml.data.artifacts import ProcessedLayout, load_processed
from playlens_ml.training.train import TrainingResult


def _post(client: TestClient, body: dict[str, Any], status: int = 200) -> Any:
    r = client.post("/api/v1/predict/trajectory", json=body)
    assert r.status_code == status, r.text
    return r.json()


def _plays(root: Path):  # type: ignore[no-untyped-def]
    return load_processed(
        ProcessedLayout.for_subset(root / "processed", "nfl_bdb_2026_analytics", "full")
    )


def test_models_endpoint_reports_the_trained_artifact(
    model_client: TestClient, model_run: tuple[Path, TrainingResult]
) -> None:
    _, result = model_run
    health = model_client.get("/health").json()
    assert health["models"] == {"loaded": ["trajectory-test-v1"], "errors": {}}
    models = model_client.get("/api/v1/models").json()
    assert len(models) == 1
    m = models[0]
    assert (
        m["model_version"] == "trajectory-test-v1"
        and m["kind"] == "learned"
        and m["served"]
    )
    assert (
        m["trajectory"]["origin"] == "last_observed_frame"
        and m["trajectory"]["uncertainty"] == "none"
    )
    assert m["provenance"]["run_id"] == result.run_id
    assert m["provenance"]["dataset_version"].startswith("nfl_bdb_2026_analytics@full-")
    assert {x["split"] for x in m["metrics"]} == {"validation", "test"}
    val = next(x for x in m["metrics"] if x["split"] == "validation")
    assert val["ade_yd"] == pytest.approx(
        result.summary["metrics"]["validation"]["model"]["ade_yd"]
    )


def test_prediction_is_real_aligned_and_versioned(
    model_client: TestClient, model_run: tuple[Path, TrainingResult]
) -> None:
    root, _ = model_run
    data = _plays(root)
    play = data.plays.filter(pl.col("play_id") == 900).row(
        0, named=True
    )  # supplied future: 5 frames
    body = _post(model_client, {"play_id": play["id"]})
    assert body["model_version"] == "trajectory-test-v1" and body["latency_ms"] > 0
    assert body["origin_frame_id"] == play["observed_last_frame_id"]
    assert (
        body["future_frame_ids"] == list(range(1, 9))
        and body["step_s"] == 0.1
        and body["horizon_s"] == 0.8
    )
    assert body["target_horizon_frames"] == 5 and body["play_split"] == "train"
    assert body["uncertainty"]["kind"] == "none" and all(
        p["samples"] is None for p in body["players"]
    )
    targets = data.players.filter(
        (pl.col("play_id") == 900) & pl.col("player_to_predict")
    )
    assert {p["player_id"] for p in body["players"]} == {
        str(i) for i in targets["nfl_id"]
    }
    for p in body["players"]:
        assert p["valid"] == [True] * 5 + [False] * 3 and len(p["path"]) == 8
    assert any("supplies 5 future frames" in w for w in body["warnings"])


def test_first_predicted_step_follows_the_last_observed_frame(
    model_client: TestClient, model_run: tuple[Path, TrainingResult]
) -> None:
    """Step 1 is one 0.1 s step after the origin: close to the actual frame_id 1, never
    the origin itself."""
    root, _ = model_run
    data = _plays(root)
    play = data.plays.filter(pl.col("play_id") == 101).row(0, named=True)
    key = (pl.col("game_id") == play["game_id"]) & (pl.col("play_id") == 101)
    future = data.scan(cs.FUTURE_TRAJECTORIES).filter(key).collect()
    last = (
        data.scan(cs.OBSERVED_TRACKING)
        .filter(key & (pl.col("frame_id") == play["observed_last_frame_id"]))
        .collect()
    )
    body = _post(model_client, {"play_id": play["id"]})
    for p in body["players"]:
        nfl = int(p["player_id"])
        actual1 = (
            future.filter((pl.col("nfl_id") == nfl) & (pl.col("frame_id") == 1))
            .select("x", "y")
            .row(0)
        )
        origin = last.filter(pl.col("nfl_id") == nfl).select("x", "y").row(0)
        pred1 = (p["path"][0]["x"], p["path"][0]["y"])
        err1 = float(np.hypot(pred1[0] - actual1[0], pred1[1] - actual1[1]))
        assert err1 < 0.5  # synthetic straight lines: step 1 lands on frame_id 1
        assert (
            np.hypot(pred1[0] - origin[0], pred1[1] - origin[1]) > 0.01
        )  # and is not the origin repeated


def test_prediction_options_and_errors(
    model_client: TestClient, model_run: tuple[Path, TrainingResult]
) -> None:
    root, _ = model_run
    play = _plays(root).plays.filter(pl.col("play_id") == 101).row(0, named=True)
    short = _post(model_client, {"play_id": play["id"], "horizon_s": 0.3})
    assert short["future_frame_ids"] == [1, 2, 3] and all(
        len(p["path"]) == 3 for p in short["players"]
    )
    one = short["players"][0]["player_id"]
    subset = _post(model_client, {"play_id": play["id"], "player_ids": [one, "99999"]})
    assert [p["player_id"] for p in subset["players"]] == [one] and any(
        "99999" in w for w in subset["warnings"]
    )
    bad_origin = _post(model_client, {"play_id": play["id"], "origin_frame_id": 1}, 422)
    assert bad_origin["error"]["code"] == "unsupported_prediction"
    assert bad_origin["error"]["details"]["reason"] == "unsupported_origin"
    assert (
        _post(model_client, {"play_id": play["id"], "horizon_s": 9.9}, 422)["error"][
            "code"
        ]
        == "invalid_query"
    )
    assert (
        _post(model_client, {"play_id": "101"}, 422)["error"]["code"]
        == "invalid_play_id"
    )
    assert (
        _post(model_client, {"play_id": "2099090010-999"}, 404)["error"]["code"]
        == "play_not_found"
    )
    assert (
        _post(model_client, {"play_id": play["id"], "model_version": "nope"}, 404)[
            "error"
        ]["code"]
        == "model_not_found"
    )
    assert _post(model_client, {}, 422)["error"]["code"] == "invalid_request"


def test_evaluation_summary_is_built_from_recorded_runs(
    model_client: TestClient, model_run: tuple[Path, TrainingResult]
) -> None:
    _, result = model_run
    r = model_client.get(
        "/api/v1/evaluation/summary", params={"model_version": "trajectory-test-v1"}
    ).json()
    assert r["status"] == "complete" and r["run_id"] == result.run_id
    test_rows = r["trajectory"]["condition_groups"][0]["rows"]
    assert [row["kind"] for row in test_rows] == ["learned", "baseline", "baseline"]
    assert test_rows[0]["ade_yd"] == pytest.approx(
        result.summary["metrics"]["test"]["model"]["ade_yd"]
    )
    assert (
        test_rows[0]["ade_interval"]["lo"]
        <= test_rows[0]["ade_yd"]
        <= test_rows[0]["ade_interval"]["hi"]
    )
    assert r["uncertainty"]["supported"] is False and r["retrieval"] is None
    assert r["system"] is None  # no benchmark has been run for this artifact
    assert len(r["error_by_horizon"]["series"]) == 3 and r["slices"]["rows"]
    assert (
        model_client.get(
            "/api/v1/evaluation/summary", params={"model_version": "nope"}
        ).status_code
        == 404
    )


def test_a_corrupted_artifact_is_reported_and_never_served(
    model_run: tuple[Path, TrainingResult], tmp_path: Path
) -> None:
    root, result = model_run
    assert result.artifact_dir is not None
    bad = tmp_path / "models" / "trajectory-test-v1"
    shutil.copytree(result.artifact_dir, bad)
    weights = bad / "model.pt"
    weights.write_bytes(weights.read_bytes()[:-8] + b"tampered")
    settings = Settings(
        data_root=root,
        subset="full",
        model_dir=tmp_path / "models",
        log_level="WARNING",
    )
    with TestClient(create_app(settings)) as c:
        health = c.get("/health").json()
        assert health["models"]["loaded"] == []
        assert "checksum" in health["models"]["errors"]["trajectory-test-v1"]
        assert c.get("/api/v1/models").json() == []
        play_id = _plays(root).plays["id"][0]
        err = _post(c, {"play_id": play_id}, status=503)
        assert err["error"]["code"] == "model_unavailable"
