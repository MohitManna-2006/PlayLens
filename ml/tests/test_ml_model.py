"""Graph construction, model, loss, metrics, training, artifacts, and embeddings."""

import json
from pathlib import Path

import numpy as np
import polars as pl
import pytest
import torch
from playlens_ml.data import canonical_schema as cs
from playlens_ml.data.artifacts import ProcessedLayout, load_processed
from playlens_ml.datasets.testing import build_synthetic_ml_root, tiny_config
from playlens_ml.datasets.trajectory import collate, load_trajectory_data
from playlens_ml.embeddings.export import export_embeddings
from playlens_ml.embeddings.sanity import cosine_topk
from playlens_ml.evaluation.metrics import (
    horizon_curve,
    player_errors,
    slice_metrics,
    summarize,
)
from playlens_ml.features.encoding import fit_encoders
from playlens_ml.graphs.knn import EDGE_FEATURES, knn_graph
from playlens_ml.inference.artifact import TrajectoryArtifact
from playlens_ml.inference.predictor import TrajectoryPredictor, Unsupported
from playlens_ml.models.baselines import predict_constant_velocity
from playlens_ml.models.trajectory import masked_displacement_loss
from playlens_ml.training.train import TrainingResult, build_model, run_training

# ---------------- graphs ----------------


def _frame(
    points: list[tuple[float, float]], valid: list[bool] | None = None
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    xy = torch.tensor([points], dtype=torch.float32)
    p = xy.shape[1]
    vel = torch.zeros_like(xy)
    side = torch.tensor([[1 if i % 2 else 2 for i in range(p)]])
    mask = torch.tensor([valid or [True] * p])
    return xy, vel, side, mask


def test_knn_edges_shape_distance_and_direction() -> None:
    xy, vel, side, mask = _frame([(0, 0), (3, 4), (10, 0), (0, 1)])
    g = knn_graph(xy, vel, side, mask, k=2)
    assert g.edge_index.shape == (2, 8) and g.edge_attr.shape == (8, len(EDGE_FEATURES))
    src, dst = g.edge_index
    assert not (src == dst).any()
    nbrs_of_0 = sorted(src[dst == 0].tolist())
    assert nbrs_of_0 == [1, 3]  # distances 5 and 1, not 10
    e = int(torch.nonzero((src == 1) & (dst == 0))[0])
    assert torch.allclose(
        g.edge_attr[e, :3], torch.tensor([0.3, 0.4, 0.5])
    )  # dx, dy, dist in yards / 10
    assert g.edge_attr[e, 5] == 0.0  # slots 0 and 1 are on different sides


def test_knn_is_deterministic_and_finite() -> None:
    xy, vel, side, mask = _frame([(1, 1), (2, 2), (3, 3), (2, 2)])  # ties
    a, b = knn_graph(xy, vel, side, mask, 2), knn_graph(xy, vel, side, mask, 2)
    assert torch.equal(a.edge_index, b.edge_index) and torch.isfinite(a.edge_attr).all()


def test_padded_players_get_no_edges_and_small_frames_are_safe() -> None:
    xy, vel, side, mask = _frame([(0, 0), (1, 0), (99, 99)], [True, True, False])
    g = knn_graph(xy, vel, side, mask, k=4)
    assert 2 not in g.edge_index.tolist()[0] and 2 not in g.edge_index.tolist()[1]
    assert g.edge_index.shape[1] == 2  # k shrinks to n-1 = 1 per valid node
    single = knn_graph(*_frame([(5, 5)]), k=4)
    assert single.edge_index.shape == (2, 0)
    lonely = knn_graph(*_frame([(5, 5), (0, 0)], [True, False]), k=4)
    assert lonely.edge_index.shape == (2, 0)


# ---------------- metrics ----------------


def test_ade_fde_known_example_with_masks_and_varying_horizon() -> None:
    target = np.zeros((2, 3, 2), np.float32)
    pred = target.copy()
    pred[0, :, 0] = [1, 2, 3]  # errors 1, 2, 3 -> ADE 2, FDE 3
    pred[1, :, 1] = [4, 6, 100]  # third step padded -> ADE 5, FDE 6
    mask = np.array([[True, True, True], [True, True, False]])
    e = player_errors(pred, target, mask)
    assert np.allclose(e.ade, [2, 5]) and np.allclose(e.fde, [3, 6])
    s = summarize(e)
    assert (
        s["ade_yd"] == pytest.approx(3.5)
        and s["fde_yd"] == pytest.approx(4.5)
        and s["frames"] == 5
    )
    curve = horizon_curve(e)
    assert [c["players"] for c in curve] == [2, 2, 1] and curve[2][
        "error_yd"
    ] == pytest.approx(3.0)
    rows = slice_metrics(e, {"side": np.array(["offense", "defense"])})
    assert {r["value"]: r["ade_yd"] for r in rows} == {"defense": 5.0, "offense": 2.0}


def test_players_without_valid_steps_are_not_scored() -> None:
    e = player_errors(
        np.ones((2, 2, 2)),
        np.zeros((2, 2, 2)),
        np.array([[True, False], [False, False]]),
    )
    assert summarize(e)["players"] == 1 and np.isnan(e.ade[1])


def test_masked_loss_ignores_padding_and_non_targets() -> None:
    pred = torch.zeros(1, 2, 2, 2)
    target = torch.zeros(1, 2, 2, 2)
    target[0, 0, 0] = torch.tensor([3.0, 4.0])  # valid: error 5
    target[0, 0, 1] = torch.tensor([100.0, 0.0])  # padded step
    target[0, 1, :] = 50.0  # non-target player
    mask = torch.tensor([[[True, False], [True, True]]])
    loss = masked_displacement_loss(pred, target, mask, torch.tensor([[True, False]]))
    assert loss.item() == pytest.approx(5.0, abs=1e-3)


# ---------------- model, training, artifacts ----------------


@pytest.fixture(scope="module")
def root(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return build_synthetic_ml_root(tmp_path_factory.mktemp("mlmodel"))


@pytest.fixture(scope="module")
def trained(root: Path, tmp_path_factory: pytest.TempPathFactory) -> TrainingResult:
    return run_training(
        tiny_config(epochs=3),
        data_root=root,
        artifacts_root=tmp_path_factory.mktemp("artifacts"),
    )


def _batch(root: Path):  # type: ignore[no-untyped-def]
    s = load_trajectory_data("full", 12, 8, data_root=root).samples
    enc = fit_encoders(s)
    return s, enc, collate(s, enc.categorical(s), np.arange(s.n_plays))


def test_forward_shapes_and_untrained_model_equals_constant_velocity(
    root: Path,
) -> None:
    s, enc, batch = _batch(root)
    model = build_model(tiny_config(), enc, 12, 8).eval()
    with torch.no_grad():
        out = model(
            batch.numeric,
            batch.xy,
            batch.vel,
            batch.mask,
            batch.categorical,
            batch.to_predict,
            batch.player_mask,
        )
    b, p = batch.player_mask.shape
    assert out.positions.shape == (b, p, 8, 2) and out.encoder.play_embedding.shape == (
        b,
        8,
    )
    assert (
        torch.isfinite(out.positions).all()
        and torch.isfinite(out.encoder.play_embedding).all()
    )
    rows = np.flatnonzero(s.to_predict)
    cv = predict_constant_velocity(s.xy, s.vel, s.mask, 8)
    flat = out.positions[batch.player_mask].numpy()
    assert np.allclose(flat[rows], cv[rows], atol=1e-4)


def test_padded_players_and_frames_do_not_change_real_outputs(root: Path) -> None:
    s, enc, batch = _batch(root)
    model = build_model(tiny_config(), enc, 12, 8).eval()
    args = [
        batch.numeric.clone(),
        batch.xy.clone(),
        batch.vel.clone(),
        batch.mask,
        batch.categorical,
        batch.to_predict,
        batch.player_mask,
    ]
    with torch.no_grad():
        ref = model(*args)
        noisy = [a.clone() for a in args]
        pad = ~batch.mask
        for k in (0, 1, 2):
            noisy[k][pad] = 1e3  # garbage in padded players and padded frames
        out = model(*noisy)
    real = batch.player_mask
    assert torch.allclose(ref.positions[real], out.positions[real], atol=1e-4)
    assert torch.allclose(
        ref.encoder.play_embedding, out.encoder.play_embedding, atol=1e-4
    )


def test_tiny_batch_overfits(root: Path) -> None:
    torch.manual_seed(0)
    s, enc, batch = _batch(root)
    model = build_model(tiny_config(), enc, 12, 8)
    opt = torch.optim.Adam(model.parameters(), lr=5e-3)
    # Synthetic targets are straight lines; perturb them so constant velocity alone
    # cannot fit.
    target = batch.target + torch.randn_like(batch.target) * 0.5
    losses = []
    for _ in range(250):
        out = model(
            batch.numeric,
            batch.xy,
            batch.vel,
            batch.mask,
            batch.categorical,
            batch.to_predict,
            batch.player_mask,
        )
        loss = masked_displacement_loss(
            out.positions, target, batch.target_mask, batch.to_predict
        )
        opt.zero_grad()
        loss.backward()  # type: ignore[no-untyped-call]
        opt.step()
        losses.append(loss.item())
    assert (
        losses[-1] < 0.5 * losses[0]
    )  # memorizes noise that no extrapolation could predict


def test_training_run_selects_on_validation_and_exports(
    trained: TrainingResult,
) -> None:
    summary = trained.summary
    assert summary["best_epoch"] >= 1
    best_val = min(h["val_ade"] for h in summary["history"][1:])
    assert summary["metrics"]["validation"]["model"]["ade_yd"] == pytest.approx(
        best_val, abs=1e-6
    )
    assert set(summary["metrics"]) == {"validation", "test"}
    assert (
        trained.artifact_dir is not None
        and (trained.artifact_dir / "evaluation.json").is_file()
    )
    meta = json.loads((trained.artifact_dir / "model.json").read_text())
    for key in (
        "dataset_version",
        "split_version",
        "encoders",
        "encoder",
        "head",
        "features",
        "weights_sha256",
    ):
        assert key in meta
    assert meta["encoders"]["mean"] and meta["features"]["excluded"]


def test_artifact_round_trip_is_equivalent_and_deterministic(
    trained: TrainingResult, root: Path
) -> None:
    assert trained.artifact_dir is not None
    a = TrajectoryPredictor.load(trained.artifact_dir)
    b = TrajectoryPredictor.load(trained.artifact_dir)
    s = load_trajectory_data(
        "full", a.artifact.window, a.artifact.horizon, data_root=root
    ).samples
    pa, ea = a.predict_samples(s)
    pb, eb = b.predict_samples(s)
    pa2, _ = a.predict_samples(s, batch_size=2)
    assert np.array_equal(pa, pb) and np.array_equal(ea, eb)
    assert np.allclose(
        pa, pa2, atol=1e-5
    )  # batch composition does not change predictions


def test_artifact_rejects_tampered_weights(
    trained: TrainingResult, tmp_path: Path
) -> None:
    assert trained.artifact_dir is not None
    import shutil

    copy = tmp_path / "copy"
    shutil.copytree(trained.artifact_dir, copy)
    (copy / "model.pt").write_bytes(b"not a checkpoint")
    with pytest.raises(Exception, match="checksum"):
        TrajectoryArtifact.load(copy)


def test_predict_play_matches_batch_inference_and_reports_unsupported(
    trained: TrainingResult, root: Path
) -> None:
    assert trained.artifact_dir is not None
    predictor = TrajectoryPredictor.load(trained.artifact_dir)
    data = load_processed(
        ProcessedLayout.for_subset(root / "processed", "nfl_bdb_2026_analytics", "full")
    )
    play = data.plays.filter(pl.col("play_id") == 900)
    key = (pl.col("game_id") == play["game_id"][0]) & (pl.col("play_id") == 900)
    tracking = data.scan(cs.OBSERVED_TRACKING).filter(key).collect()
    players = data.players.filter(key)
    result = predictor.predict_play(play, players, tracking)
    assert not isinstance(result, Unsupported)
    assert (
        result.origin_frame_id == tracking["frame_id"].max()
        and result.horizon == predictor.artifact.horizon
    )
    assert {p.nfl_id for p in result.players} == set(
        players.filter(pl.col("player_to_predict"))["nfl_id"]
    )
    s = load_trajectory_data(
        "full", predictor.artifact.window, predictor.artifact.horizon, data_root=root
    ).samples
    pos, _ = predictor.predict_samples(s)
    i = int(np.flatnonzero(s.play_id == 900)[0])
    batch_rows = {
        int(s.nfl_id[r]): pos[r]
        for r in range(s.play_slice(i).start, s.play_slice(i).stop)
    }
    for p in result.players:
        assert np.allclose(p.positions, batch_rows[p.nfl_id], atol=1e-4)
    none = predictor.predict_play(
        play, players.with_columns(pl.lit(False).alias("player_to_predict")), tracking
    )
    assert isinstance(none, Unsupported) and none.reason == "no_target_players"
    empty = predictor.predict_play(play, players, tracking.head(0))
    assert isinstance(empty, Unsupported) and empty.reason == "no_observed_frames"


def test_embedding_export_is_valid_and_deterministic(
    trained: TrainingResult, root: Path
) -> None:
    assert trained.artifact_dir is not None
    out = export_embeddings(trained.artifact_dir, "full", data_root=root)
    emb = np.asarray(out.table["embedding"].to_numpy())
    assert out.table.height == out.manifest["checks"]["expected_rows"]
    assert emb.shape[1] == 8 and np.isfinite(emb).all()
    assert np.allclose(np.linalg.norm(emb, axis=1), 1.0, atol=1e-5)
    assert out.manifest["checks"]["determinism_max_abs_diff"] < 1e-4
    assert out.table.select("id", "model_version").unique().height == out.table.height


def test_cosine_search_excludes_self() -> None:
    v = np.eye(3, dtype=np.float32)
    v[2] = v[0]
    nn = cosine_topk(v, v, 1, exclude=np.arange(3))
    assert nn[:, 0].tolist() == [2, 0, 0]
