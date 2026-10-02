"""Similarity search and Compare through the real routes and services.

These run without PostgreSQL: the tiny model's real exported embeddings are
searched exactly by the in-memory reference store. The pgvector store (exact,
HNSW, filters, concurrency, ingestion) is covered in test_retrieval_db.py.
"""

from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient
from playlens_api.config import Settings
from playlens_api.main import create_app
from playlens_api.retrieval.artifact import EmbeddingArtifact
from playlens_api.retrieval.memory import InMemoryVectorStore
from playlens_api.retrieval.reference import topk
from playlens_ml.training.train import TrainingResult

SettingsFactory = Callable[[Path], Settings]

SIMILAR = "/api/v1/search/similar"
COMPARE = "/api/v1/compare"


def _post(
    client: TestClient, path: str, body: dict[str, Any], status: int = 200
) -> Any:
    r = client.post(path, json=body)
    assert r.status_code == status, r.text
    return r.json()


def _exact(client: TestClient, play_id: str, k: int = 5, **extra: Any) -> Any:
    return _post(
        client, SIMILAR, {"play_id": play_id, "k": k, "mode": "exact", **extra}
    )


@pytest.fixture(scope="module")
def ids(embedding_export: EmbeddingArtifact) -> list[str]:
    return embedding_export.ids


def test_exact_search_matches_brute_force_and_excludes_self(
    retrieval_client: TestClient, embedding_export: EmbeddingArtifact, ids: list[str]
) -> None:
    v = embedding_export.vectors.astype(np.float64)
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    for qi in (0, 5, len(ids) - 1):
        body = _exact(retrieval_client, ids[qi], k=6)
        got = [r["play_id"] for r in body["results"]]
        sims = v @ v[qi]
        sims[qi] = -np.inf
        expected = [
            ids[j]
            for j in sorted(range(len(ids)), key=lambda j: (-sims[j], ids[j]))[:6]
        ]
        assert got == expected
        assert ids[qi] not in got
        assert [r["rank"] for r in body["results"]] == list(range(1, len(got) + 1))
        for r in body["results"]:
            assert r["cosine_similarity"] == pytest.approx(
                1 - r["cosine_distance"], abs=1e-6
            )
            assert r["cosine_similarity"] == pytest.approx(
                sims[ids.index(r["play_id"])], abs=1e-5
            )
        distances = [r["cosine_distance"] for r in body["results"]]
        assert distances == sorted(distances)


def test_results_carry_summaries_evidence_and_provenance(
    retrieval_client: TestClient, ids: list[str]
) -> None:
    body = _exact(retrieval_client, ids[0])
    health = retrieval_client.get("/health").json()
    q, p = body["query"], body["retrieval"]
    assert q["play_id"] == ids[0] and q["mode"] == "exact" and q["k"] == 5
    assert q["split"] in ("train", "validation", "test")
    assert p["metric"] == "cosine" and p["representation"] == "learned_embedding"
    assert p["plan"] == "exact_scan" and p["hnsw"] is None and p["backend"] == "memory"
    assert p["self_match_excluded"] is True
    assert p["model_version"] == "trajectory-test-v1"
    assert p["dataset_version"] == health["dataset"]["dataset_version"]
    assert p["split_version"].startswith("synthetic-weeks-v1")
    assert p["corpus_size"] == len(ids) and p["candidates"] == len(ids) - 1
    ref = p["cosine_reference"]
    assert ref["nearest_neighbor_p50"] >= ref["random_pair_p50"]
    assert "not probabilities" in ref["description"]
    assert (
        body["request_id"] and "None of them is a model input" in body["evidence_note"]
    )

    result = body["results"][0]
    assert result["play"]["id"] == result["play_id"]
    evidence = result["evidence"]
    assert len({e["id"] for e in evidence}) == len(evidence)
    assert all(e["id"].startswith(f"{result['play_id']}.") for e in evidence)
    by_key = {e["id"].split(".", 1)[1]: e for e in evidence}
    down = by_key["metadata.down"]
    assert down["source"] == "pre_snap_context" and down["relation"] in (
        "same",
        "different",
    )
    assert by_key["metadata.coverage_type"]["source"] == "charted_label"
    sep = by_key["structure.target_separation.last_observed_frame"]
    assert sep["kind"] == "structural_metric" and sep["unit"] == "yd"
    assert sep["relation"] is None and sep["delta"] == pytest.approx(
        sep["right_value"] - sep["left_value"], abs=1e-3
    )
    assert sep["frame_reference"]["anchor"] == "last_observed_frame"
    speed = by_key["structure.mean_speed.last_2s_window"]
    assert len(speed["frame_reference"]["left_frame_ids"]) == 2


def test_filters_are_applied_by_retrieval(
    retrieval_client: TestClient, embedding_export: EmbeddingArtifact, ids: list[str]
) -> None:
    splits = dict(zip(ids, embedding_export.table["split"].to_list(), strict=True))
    body = _exact(retrieval_client, ids[0], k=50, filters={"splits": ["train"]})
    got = [r["play_id"] for r in body["results"]]
    expected = [i for i in ids if splits[i] == "train" and i != ids[0]]
    assert sorted(got) == sorted(expected)
    assert body["retrieval"]["candidates"] == len(expected)
    assert body["query"]["filters"]["splits"] == ["train"]

    offense = body["results"][0]["play"]["offense"]
    same_team = _exact(retrieval_client, ids[0], k=50, filters={"offense": offense})
    assert same_team["results"]
    assert {r["play"]["offense"] for r in same_team["results"]} == {offense}

    weeks = _exact(
        retrieval_client, ids[0], k=50, filters={"week_min": 2, "week_max": 3}
    )
    assert weeks["results"] and all(
        2 <= r["play"]["week"] <= 3 for r in weeks["results"]
    )


def test_zero_matching_plays_is_an_empty_result_with_a_reason(
    retrieval_client: TestClient, ids: list[str]
) -> None:
    body = _exact(retrieval_client, ids[0], filters={"offense": "ZZZ", "down": 4})
    assert body["results"] == []
    assert body["retrieval"]["candidates"] == 0
    assert body["warnings"] == ["Only 0 plays match these filters."]


@pytest.mark.parametrize(
    ("body", "status", "code"),
    [
        ({"k": 0}, 422, "invalid_k"),
        ({"k": 51}, 422, "invalid_k"),
        (
            {"filters": {"yards_to_go_min": 9, "yards_to_go_max": 3}},
            422,
            "invalid_filters",
        ),
        ({"filters": {"week_min": 5, "week_max": 2}}, 422, "invalid_filters"),
        ({"filters": {"down": 5}}, 422, "invalid_filters"),
        ({"filters": {"unknown_column": 1}}, 422, "invalid_filters"),
        ({"filters": {"offense": "kc'; drop table plays; --"}}, 422, "invalid_filters"),
        ({"filters": {"splits": []}}, 422, "invalid_filters"),
        ({"mode": "fuzzy"}, 422, "invalid_request"),
        ({"model_version": "not-loaded-v9"}, 404, "model_version_unavailable"),
        ({"mode": "approximate"}, 422, "unsupported_mode"),
    ],
)
def test_invalid_requests_are_typed_errors(
    retrieval_client: TestClient,
    ids: list[str],
    body: dict[str, Any],
    status: int,
    code: str,
) -> None:
    err = _post(retrieval_client, SIMILAR, {"play_id": ids[0], **body}, status)["error"]
    assert err["code"] == code and err["status"] == status and err["request_id"]


def test_unknown_and_malformed_plays(retrieval_client: TestClient) -> None:
    assert (
        _post(retrieval_client, SIMILAR, {"play_id": "101"}, 422)["error"]["code"]
        == "invalid_play_id"
    )
    assert (
        _post(retrieval_client, SIMILAR, {"play_id": "2099090099-1"}, 404)["error"][
            "code"
        ]
        == "play_not_found"
    )


def test_pair_ranks_agree_with_exact_search_for_every_pair(
    memory_store: InMemoryVectorStore,
) -> None:
    """Regression: the pair distance came from a separate dot product, whose
    rounding could count the right play as closer than itself (rank one too high)."""
    store, n = memory_store, len(memory_store.ids)
    for q in range(n):
        found = topk(store.unit, store.ids, q, n - 1, np.arange(n) != q)
        for nb in found:
            pair = store.pair(store.ids[q], nb.play_id, store.set.model_version)
            closer = sum(other.distance < nb.distance for other in found)
            assert pair.right_rank_from_left == closer + 1, (store.ids[q], nb.play_id)


def test_compare_reports_similarity_ranks_evidence_and_roles(
    retrieval_client: TestClient, ids: list[str]
) -> None:
    neighbours = _exact(retrieval_client, ids[0], k=len(ids) - 1)["results"]
    third = neighbours[2]
    body = _post(
        retrieval_client,
        COMPARE,
        {"left_play_id": ids[0], "right_play_id": third["play_id"]},
    )
    sim = body["similarity"]
    assert sim["cosine_similarity"] == pytest.approx(
        third["cosine_similarity"], abs=1e-6
    )
    assert sim["right_rank_from_left"] == 3
    assert sim["rank_pool"] == len(ids) - 1
    assert body["similarity_unavailable_reason"] is None
    assert (
        body["left"]["play_id"] == ids[0]
        and body["right"]["play_id"] == third["play_id"]
    )
    assert (
        body["left"]["last_frame_id"]
        == body["left"]["play"]["tracking"]["last_frame_id"]
    )
    assert all(e["id"].startswith("comparison.") for e in body["evidence"])
    kinds = {e["kind"] for e in body["evidence"]}
    assert kinds == {"metadata", "structural_metric"}
    roles = {p["basis"] for p in body["correspondence"]["pairs"]}
    assert roles == {"Passer", "Targeted Receiver"}
    assert "Not an assignment" in body["correspondence"]["method"]

    err = _post(
        retrieval_client,
        COMPARE,
        {"left_play_id": ids[0], "right_play_id": ids[0]},
        422,
    )
    assert err["error"]["code"] == "invalid_comparison"
    err = _post(
        retrieval_client,
        COMPARE,
        {"left_play_id": ids[0], "right_play_id": "2099090099-1"},
        404,
    )
    assert err["error"]["code"] == "play_not_found"


def test_health_and_models_report_retrieval(
    retrieval_client: TestClient, ids: list[str]
) -> None:
    health = retrieval_client.get("/health").json()
    assert health["status"] == "ok"
    r = health["retrieval"]
    assert r["status"] == "ready" and r["backend"] == "memory"
    assert (
        r["embedding_count"] == len(ids) and r["model_version"] == "trajectory-test-v1"
    )
    models = retrieval_client.get("/api/v1/models").json()
    info = next(m for m in models if m["model_version"] == "trajectory-test-v1")
    assert info["retrieval"]["distance"] == "cosine"
    assert info["retrieval"]["corpus_size"] == len(ids)


def test_retrieval_disabled_leaves_replay_and_compare_working(
    client: TestClient,
) -> None:
    play_id = client.get("/api/v1/plays", params={"page_size": 2}).json()["items"]
    left, right = play_id[0]["id"], play_id[1]["id"]
    health = client.get("/health").json()
    assert health["status"] == "ok" and health["retrieval"]["status"] == "disabled"
    err = _post(client, SIMILAR, {"play_id": left}, 503)["error"]
    assert (
        err["code"] == "retrieval_unavailable"
        and "PLAYLENS_DATABASE_URL" in err["message"]
    )
    body = _post(client, COMPARE, {"left_play_id": left, "right_play_id": right})
    assert body["similarity"] is None
    assert body["similarity_unavailable_code"] == "retrieval_unavailable"
    assert len(body["evidence"]) == 13
    assert client.get(f"/api/v1/plays/{left}/frames").status_code == 200


def test_unreachable_database_degrades_health_without_breaking_replay(
    synthetic_run: tuple[Path, Any],
) -> None:
    root, _ = synthetic_run
    settings = Settings(
        data_root=root,
        model_dir=root / "no-models",
        # Nothing listens on port 1; the pool must not block startup.
        database_url="postgresql://nobody:nothing@127.0.0.1:1/none",
        db_timeout_s=0.5,
        log_level="WARNING",
    )
    with TestClient(create_app(settings)) as c:
        play = c.get("/api/v1/plays", params={"page_size": 1}).json()["items"][0]["id"]
        err = _post(c, SIMILAR, {"play_id": play}, 503)["error"]
        assert err["code"] == "database_unavailable"
        health = c.get("/health").json()
        assert health["status"] == "degraded"
        assert health["retrieval"]["status"] == "unavailable"
        assert health["retrieval"]["database_reachable"] is False
        assert (
            "***" in health["retrieval"]["reason"]
            and "nothing" not in health["retrieval"]["reason"]
        )
        assert c.get(f"/api/v1/plays/{play}/frames").status_code == 200


def test_missing_embedding_is_reported_not_substituted(
    model_run: tuple[Path, TrainingResult],
    embedding_export: EmbeddingArtifact,
    make_retrieval_settings: SettingsFactory,
) -> None:
    root, _ = model_run
    missing = embedding_export.ids[0]
    table = embedding_export.table.filter(pl.col("id") != missing)
    store = InMemoryVectorStore.from_artifact(
        replace(embedding_export, table=table), root
    )
    with TestClient(
        create_app(make_retrieval_settings(root), retrieval_store=store)
    ) as c:
        err = _post(c, SIMILAR, {"play_id": missing, "mode": "exact"}, 404)["error"]
        assert err["code"] == "embedding_unavailable"
        assert err["details"] == {
            "play_id": missing,
            "model_version": "trajectory-test-v1",
        }
        other = embedding_export.ids[1]
        body = _post(c, COMPARE, {"left_play_id": missing, "right_play_id": other})
        assert body["similarity"] is None
        assert body["similarity_unavailable_code"] == "embedding_unavailable"
        results = _post(c, SIMILAR, {"play_id": other, "k": 50, "mode": "exact"})[
            "results"
        ]
        assert missing not in [r["play_id"] for r in results]


def test_embeddings_from_another_dataset_are_refused(
    model_run: tuple[Path, TrainingResult],
    memory_store: InMemoryVectorStore,
    make_retrieval_settings: SettingsFactory,
) -> None:
    root, _ = model_run
    store = InMemoryVectorStore(
        memory_store.rows,
        memory_store.unit.astype(np.float32),
        replace(memory_store.set, dataset_version="nfl_bdb_2026_analytics@full-other"),
    )
    with TestClient(
        create_app(make_retrieval_settings(root), retrieval_store=store)
    ) as c:
        err = _post(c, SIMILAR, {"play_id": memory_store.ids[0], "mode": "exact"}, 503)[
            "error"
        ]
        assert (
            err["code"] == "retrieval_unavailable"
            and "PLAYLENS_SUBSET" in err["message"]
        )
        assert c.get("/health").json()["retrieval"]["status"] == "unavailable"
