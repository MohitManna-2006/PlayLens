from pathlib import Path
from typing import Any

import polars as pl
import pytest
from fastapi.testclient import TestClient
from playlens_ml.data.coordinates import FIELD_LENGTH_YD
from playlens_ml.data.preprocess import RunSummary
from playlens_ml.data.testing import default_plays, player_rows

PLAYS = {f"{p.game_id}-{p.play_id}": p for p in default_plays()}


def _get(client: TestClient, url: str, **params: Any) -> Any:
    r = client.get(url, params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _left_play_id(summary: RunSummary) -> str:
    return next(i for i in summary.selected_ids if PLAYS[i].direction == "left")


def test_health_reports_the_loaded_dataset(
    client: TestClient, synthetic_run: tuple[Path, RunSummary]
) -> None:
    body = _get(client, "/health")
    assert body["status"] == "ok"
    assert body["dataset"] == {
        "loaded": True,
        "dataset_version": synthetic_run[1].dataset_version,
        "subset": "dev",
        "play_count": 6,
        "error": None,
    }
    assert body["models"] == {"loaded": [], "errors": {}}


def test_missing_dataset_degrades_honestly(empty_client: TestClient) -> None:
    health = empty_client.get("/health").json()
    assert health["status"] == "degraded" and not health["dataset"]["loaded"]
    assert "pnpm data:dev" in health["dataset"]["error"]
    r = empty_client.get("/api/v1/plays")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "dataset_unavailable"
    assert "pnpm data:dev" in r.json()["error"]["message"]


def test_list_plays_paginates_newest_game_first(client: TestClient) -> None:
    first = _get(client, "/api/v1/plays", page_size=4)
    assert (
        first["total"] == 6 and len(first["items"]) == 4 and first["sort"] == "recent"
    )
    assert first["similarity"] is None and first["dataset"]["synthetic"] is False
    second = _get(client, "/api/v1/plays", page=2, page_size=4)
    ids = [p["id"] for p in first["items"] + second["items"]]
    assert len(set(ids)) == 6
    dates = [p["game_date"] for p in first["items"] + second["items"]]
    assert dates == sorted(dates, reverse=True)
    assert _get(client, "/api/v1/plays", page=9, page_size=4)["items"] == []


def test_list_items_are_lightweight_and_grouped(client: TestClient) -> None:
    item = _get(client, "/api/v1/plays", page_size=1)["items"][0]
    assert "players" not in item and "frames" not in item
    assert set(item["context"]) >= {"offense_formation", "receiver_alignment"}
    assert set(item["annotations"]) >= {"coverage_type", "target_route"}
    assert set(item["outcome"]) >= {"pass_result", "yards_gained"}
    assert item["tracking"]["ball_tracked"] is False
    assert item["id"] == f"{item['game_id']}-{item['play_id']}"


@pytest.mark.parametrize(
    ("params", "check"),
    [
        ({"week": 2}, lambda p: p["week"] == 2),
        ({"offense": "AAA"}, lambda p: p["offense"] == "AAA"),
        (
            {"formation": "SHOTGUN"},
            lambda p: p["context"]["offense_formation"] == "SHOTGUN",
        ),
        (
            {"coverage": "COVER_3_ZONE"},
            lambda p: p["annotations"]["coverage_type"] == "COVER_3_ZONE",
        ),
        (
            {"down": 2, "distance": "medium"},
            lambda p: p["down"] == 2 and 4 <= p["yards_to_go"] <= 7,
        ),
        ({"outcome": "gain"}, lambda p: p["outcome"]["yards_gained"] > 0),
    ],
)
def test_filters(client: TestClient, params: dict[str, Any], check: Any) -> None:
    page = _get(client, "/api/v1/plays", **params)
    assert page["total"] > 0 and all(check(p) for p in page["items"])


def test_search_and_empty_results(
    client: TestClient, synthetic_run: tuple[Path, RunSummary]
) -> None:
    target = synthetic_run[1].selected_ids[0]
    assert [p["id"] for p in _get(client, "/api/v1/plays", q=target)["items"]] == [
        target
    ]
    assert _get(client, "/api/v1/plays", offense="ZZZ")["total"] == 0


def test_similarity_sort_is_unavailable_not_faked(client: TestClient) -> None:
    r = client.get("/api/v1/plays", params={"sort": "similarity", "similar_to": "1-1"})
    assert (
        r.status_code == 422 and r.json()["error"]["code"] == "capability_unavailable"
    )


def test_facets_come_from_the_data(client: TestClient) -> None:
    facets = _get(client, "/api/v1/plays/facets")
    assert facets["weeks"] == [1, 2, 3] and facets["play_types"] == ["pass"]
    assert "AAA" in facets["teams"] and facets["coverages"] == ["COVER_3_ZONE"]


def test_play_detail(
    client: TestClient, synthetic_run: tuple[Path, RunSummary]
) -> None:
    pid = _left_play_id(synthetic_run[1])
    play = PLAYS[pid]
    detail = _get(client, f"/api/v1/plays/{pid}")
    assert (
        detail["id"] == pid
        and detail["play_id"] == play.play_id
        and detail["game_id"] == play.game_id
    )
    assert detail["play_direction"] == "left"
    assert detail["coordinates"]["raw_transform"] == "rotate_180"
    assert detail["line_of_scrimmage_x"] == play.los_x
    assert detail["first_down_x"] == play.los_x + 6
    assert detail["ball_landing"]["x"] == pytest.approx(play.los_x + 12.0)
    assert detail["ball_landing"]["x_raw"] == pytest.approx(
        FIELD_LENGTH_YD - play.los_x - 12.0
    )
    assert detail["events"] == [] and detail["frame_rate_hz"] == 10.0
    sides = [p["side"] for p in detail["players"]]
    assert sides == sorted(sides, key=lambda s: s != "offense")
    assert (
        detail["players"][0]["role"] == "Passer"
        and detail["players"][0]["jersey"] is None
    )
    assert detail["provenance"]["synthetic"] is False
    assert (
        sum(p["player_to_predict"] for p in detail["players"])
        == detail["tracking"]["predicted_player_count"]
    )


def test_unknown_and_malformed_ids(client: TestClient) -> None:
    missing = client.get("/api/v1/plays/2099090010-999")
    assert (
        missing.status_code == 404
        and missing.json()["error"]["code"] == "play_not_found"
    )
    malformed = client.get("/api/v1/plays/101")
    assert (
        malformed.status_code == 422
        and malformed.json()["error"]["code"] == "invalid_play_id"
    )
    assert client.get("/api/v1/plays/101/frames").status_code == 422


def test_frames_are_ordered_canonical_and_observed_only(
    client: TestClient, synthetic_run: tuple[Path, RunSummary]
) -> None:
    pid = _left_play_id(synthetic_run[1])
    play = PLAYS[pid]
    detail = _get(client, f"/api/v1/plays/{pid}")
    payload = _get(client, f"/api/v1/plays/{pid}/frames")
    frames = payload["frames"]
    assert payload["coordinate_system"] == "playlens-canonical-v1"
    assert [f["frame_id"] for f in frames] == list(range(1, play.frames + 1))
    assert [f["frame_index"] for f in frames] == list(range(play.frames))
    assert [f["time_s"] for f in frames] == pytest.approx(
        [i / 10 for i in range(play.frames)]
    )
    assert all(f["ball"] is None for f in frames)
    roster = [p["player_id"] for p in detail["players"]]
    for f in frames:
        assert sorted(p["player_id"] for p in f["players"]) == sorted(roster)
    expected = {(str(r["nfl_id"]), r["frame"]): r for r in player_rows(play)}
    for f in frames:
        for p in f["players"]:
            e = expected[(p["player_id"], f["frame_id"])]
            assert p["x"] == pytest.approx(e["cx"], abs=2e-3) and p[
                "y"
            ] == pytest.approx(e["cy"], abs=2e-3)
    # Observed payload ends at the last observed frame: no future rows mixed in.
    assert frames[-1]["frame_id"] == detail["tracking"]["last_frame_id"]


def test_frame_range_parameters(
    client: TestClient, synthetic_run: tuple[Path, RunSummary]
) -> None:
    pid = synthetic_run[1].selected_ids[0]
    ranged = _get(client, f"/api/v1/plays/{pid}/frames", start_frame=3, end_frame=5)
    assert [f["frame_id"] for f in ranged["frames"]] == [3, 4, 5]
    assert (
        client.get(
            f"/api/v1/plays/{pid}/frames", params={"start_frame": 5, "end_frame": 3}
        ).status_code
        == 422
    )


def test_future_is_separate_ground_truth(
    client: TestClient, synthetic_run: tuple[Path, RunSummary]
) -> None:
    pid = _left_play_id(synthetic_run[1])
    play = PLAYS[pid]
    detail = _get(client, f"/api/v1/plays/{pid}")
    future = _get(client, f"/api/v1/plays/{pid}/future")
    assert (
        future["kind"] == "actual_future"
        and "not a model prediction" in future["description"]
    )
    assert (
        future["origin_frame_id"] == play.frames
        and future["horizon_frames"] == play.future_frames
    )
    predicted = {p["player_id"] for p in detail["players"] if p["player_to_predict"]}
    assert {t["player_id"] for t in future["trajectories"]} == predicted
    for t in future["trajectories"]:
        assert [pt["frame_id"] for pt in t["points"]] == list(
            range(1, play.future_frames + 1)
        )
        assert t["points"][0]["frame_index"] == play.frames
        assert t["points"][0]["time_s"] == pytest.approx(play.frames / 10)
    assert client.get("/api/v1/plays/2099090010-999/future").status_code == 404


def test_model_registry_is_empty_without_artifacts(client: TestClient) -> None:
    assert _get(client, "/api/v1/models") == []
    r = client.post("/api/v1/predict/trajectory", json={"play_id": "2099090010-101"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "model_unavailable"
    assert "pnpm ml:train" in r.json()["error"]["message"]
    assert client.get("/api/v1/evaluation/summary").status_code == 503


def test_no_fake_ml_endpoints(client: TestClient) -> None:
    for path in ("/api/v1/search/similar", "/api/v1/playlab/counterfactual"):
        assert client.post(path, json={}).status_code in (404, 405)
    assert client.get("/api/v1/plays/1-1/embedding").status_code == 404


def test_cors_and_request_id_headers(client: TestClient) -> None:
    r = client.get(
        "/health", headers={"Origin": "http://localhost:3000", "X-Request-ID": "abc123"}
    )
    assert r.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert r.headers["x-request-id"] == "abc123"
    assert r.headers["server-timing"].startswith("app;dur=")


def test_openapi_documents_every_route(client: TestClient) -> None:
    spec = _get(client, "/openapi.json")
    assert {
        "/health",
        "/api/v1/plays",
        "/api/v1/plays/facets",
        "/api/v1/plays/{play_id}",
        "/api/v1/plays/{play_id}/frames",
        "/api/v1/plays/{play_id}/future",
        "/api/v1/models",
        "/api/v1/dataset",
    } <= set(spec["paths"])
    assert "ErrorEnvelope" in spec["components"]["schemas"]


def test_repository_counts_match_processed_artifacts(
    client: TestClient, synthetic_run: tuple[Path, RunSummary]
) -> None:
    root, summary = synthetic_run
    tracking = pl.read_parquet(summary.processed_dir / "observed" / "tracking.parquet")
    total_rows = 0
    for pid in summary.selected_ids:
        frames = _get(client, f"/api/v1/plays/{pid}/frames")["frames"]
        total_rows += sum(len(f["players"]) for f in frames)
    assert total_rows == tracking.height == summary.counts["observed_tracking_rows"]
