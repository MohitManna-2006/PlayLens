"""Splits, features, leakage guards, encoders, and baselines on synthetic data."""

from pathlib import Path

import numpy as np
import polars as pl
import pytest
from playlens_ml.data import canonical_schema as cs
from playlens_ml.data.artifacts import ProcessedDataset, ProcessedLayout, load_processed
from playlens_ml.data.availability import LeakageError
from playlens_ml.datasets.splits import (
    SplitError,
    SplitPolicy,
    assign_splits,
    load_splits,
    split_version,
)
from playlens_ml.datasets.testing import TEST_POLICY, build_synthetic_ml_root
from playlens_ml.datasets.trajectory import collate, load_trajectory_data, mirror_y
from playlens_ml.evaluation.report import target_rows
from playlens_ml.features import spec
from playlens_ml.features.encoding import fit_encoders
from playlens_ml.features.samples import build_samples
from playlens_ml.models.baselines import (
    constant_velocity,
    finite_difference_velocity,
    predict_constant_velocity,
)

WINDOW, HORIZON = 12, 8


@pytest.fixture(scope="module")
def root(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return build_synthetic_ml_root(tmp_path_factory.mktemp("ml"))


@pytest.fixture(scope="module")
def processed(root: Path) -> ProcessedDataset:
    return load_processed(
        ProcessedLayout.for_subset(root / "processed", "nfl_bdb_2026_analytics", "full")
    )


# ---------------- splits ----------------


def _plays(rows: list[tuple[int, int, int]]) -> pl.DataFrame:
    return pl.DataFrame(
        {
            "id": [f"{g}-{p}" for g, p, _ in rows],
            "game_id": [g for g, _, _ in rows],
            "play_id": [p for _, p, _ in rows],
            "week": [w for _, _, w in rows],
        }
    )


def test_split_is_by_week_and_never_fragments_a_game() -> None:
    plays = _plays([(1, 1, 1), (1, 2, 1), (2, 1, 15), (3, 1, 17), (3, 2, 17)])
    out = assign_splits(plays, SplitPolicy())
    assert dict(zip(out["id"], out["split"], strict=True)) == {
        "1-1": "train",
        "1-2": "train",
        "2-1": "validation",
        "3-1": "test",
        "3-2": "test",
    }
    assert out.group_by("game_id").agg(pl.col("split").n_unique())["split"].max() == 1


def test_split_rejects_unmapped_weeks_and_split_games() -> None:
    with pytest.raises(SplitError, match="not covered"):
        assign_splits(_plays([(1, 1, 19)]), SplitPolicy())
    with pytest.raises(SplitError, match="span more than one split"):
        assign_splits(_plays([(1, 1, 14), (1, 2, 15)]), SplitPolicy())
    with pytest.raises(SplitError, match="two splits"):
        SplitPolicy(
            train_weeks=(1, 2), validation_weeks=(2,), test_weeks=(3,)
        ).split_of_week()


def test_split_version_is_deterministic_and_content_addressed() -> None:
    plays = _plays([(1, 1, 1), (2, 1, 15), (3, 1, 17)])
    a = split_version(assign_splits(plays, SplitPolicy()), SplitPolicy())
    b = split_version(assign_splits(plays.reverse(), SplitPolicy()), SplitPolicy())
    other = SplitPolicy(
        name="x", train_weeks=(1, 15), validation_weeks=(), test_weeks=(17,)
    )
    assert a == b and a.startswith("temporal-weeks-v1-")
    assert split_version(assign_splits(plays, other), other) != a


def test_written_splits_have_no_game_or_play_overlap(root: Path) -> None:
    splits, info = load_splits(
        ProcessedLayout.for_subset(root / "processed", "nfl_bdb_2026_analytics", "full")
    )
    assert splits["id"].n_unique() == splits.height
    games = {
        s: set(splits.filter(pl.col("split") == s)["game_id"])
        for s in ("train", "validation", "test")
    }
    assert not (games["train"] & games["validation"]) and not (
        games["train"] & games["test"]
    )
    assert not (games["validation"] & games["test"])
    assert info["policy"]["name"] == TEST_POLICY.name
    assert {k: sorted(v) for k, v in info["games_by_split"].items()} == {
        k: sorted(v) for k, v in games.items()
    }


# ---------------- leakage guard ----------------


def test_feature_allowlist_passes_the_availability_guard() -> None:
    spec.assert_allowlist_is_safe()


@pytest.mark.parametrize(
    ("artifact", "column"),
    [
        (cs.PLAYS.name, "ball_land_x"),
        (cs.PLAYS.name, "future_frame_count"),
        (cs.OUTCOMES.name, "yards_gained"),
        (cs.ANNOTATIONS.name, "team_coverage_type"),
        (cs.FUTURE_TRAJECTORIES.name, "x"),
        (cs.OUTCOMES.name, "pass_result"),
    ],
)
def test_forbidden_fields_fail_the_guard(
    monkeypatch: pytest.MonkeyPatch, artifact: str, column: str
) -> None:
    patched = {
        **spec.SOURCE_COLUMNS,
        artifact: (*spec.SOURCE_COLUMNS.get(artifact, ()), column),
    }
    monkeypatch.setattr(spec, "SOURCE_COLUMNS", patched)
    with pytest.raises(LeakageError):
        spec.assert_allowlist_is_safe()


def test_extra_columns_never_reach_model_inputs(processed: ProcessedDataset) -> None:
    tracking = processed.scan(cs.OBSERVED_TRACKING).collect()
    base = build_samples(
        processed.plays, processed.players, tracking, None, WINDOW, HORIZON
    )
    poisoned_plays = processed.plays.with_columns(
        pl.lit(99.0).alias("yards_gained"),
        (pl.col("ball_land_x") + 50).alias("ball_land_x"),
    )
    poisoned_tracking = tracking.with_columns(
        pl.lit(7.0).alias("expected_points_added")
    )
    other = build_samples(
        poisoned_plays, processed.players, poisoned_tracking, None, WINDOW, HORIZON
    )
    assert np.array_equal(base.numeric, other.numeric) and np.array_equal(
        base.xy, other.xy
    )


def test_future_rows_change_targets_only(processed: ProcessedDataset) -> None:
    tracking = processed.scan(cs.OBSERVED_TRACKING).collect()
    future = processed.scan(cs.FUTURE_TRAJECTORIES).collect()
    without = build_samples(
        processed.plays, processed.players, tracking, None, WINDOW, HORIZON
    )
    with_future = build_samples(
        processed.plays, processed.players, tracking, future, WINDOW, HORIZON
    )
    for name in ("numeric", "xy", "vel", "mask"):
        assert np.array_equal(getattr(without, name), getattr(with_future, name))
    assert not without.target_mask.any() and with_future.target_mask.any()


# ---------------- samples ----------------


def test_window_is_right_aligned_and_short_plays_are_front_padded(root: Path) -> None:
    data = load_trajectory_data("full", WINDOW, HORIZON, data_root=root, rebuild=True)
    s = data.samples
    short = int(np.flatnonzero(s.play_id == 900)[0])
    rows = s.play_slice(short)
    assert s.mask[rows, -1].all()  # the origin frame is always observed
    assert s.mask[rows].sum(axis=1).tolist() == [9] * (
        rows.stop - rows.start
    )  # 9 observed frames < window 12
    assert not s.mask[rows, :3].any()
    full = int(np.flatnonzero(s.play_id != 900)[0])
    assert s.mask[s.play_slice(full)].all()
    t_rel = s.numeric[..., spec.NUMERIC_FEATURES.index("t_rel")]
    assert np.allclose(t_rel[s.mask][-1:], 0.0) and (t_rel[s.mask] <= 0).all()


def test_targets_align_with_output_frames_and_mask_beyond_supplied_horizon(
    root: Path, processed: ProcessedDataset
) -> None:
    s = load_trajectory_data("full", WINDOW, HORIZON, data_root=root).samples
    future = processed.scan(cs.FUTURE_TRAJECTORIES).collect()
    i = int(np.flatnonzero(s.play_id == 900)[0])  # supplied horizon 5 < H 8
    r = s.play_slice(i).start + int(np.flatnonzero(s.to_predict[s.play_slice(i)])[0])
    rows = future.filter(
        (pl.col("play_id") == 900) & (pl.col("nfl_id") == int(s.nfl_id[r]))
    ).sort("frame_id")
    assert s.target_mask[r].tolist() == [True] * 5 + [False] * 3
    assert np.allclose(s.target[r, :5], rows.select("x", "y").to_numpy(), atol=1e-4)
    assert s.target_horizon[i] == 5
    assert not s.target_mask[~s.to_predict].any()


def test_encoders_use_train_only_and_handle_unknown_categories(root: Path) -> None:
    data = load_trajectory_data("full", WINDOW, HORIZON, data_root=root)
    train, everything = data.subset("train"), data.samples
    enc = fit_encoders(train)
    expected_mean = train.numeric[train.mask].mean(axis=0)
    assert np.allclose(enc.mean, expected_mean, atol=1e-5)
    assert not np.allclose(
        enc.mean, everything.numeric[everything.mask].mean(axis=0), atol=1e-6
    )
    codes = enc.vocabs["position"].encode(np.array(["CB", "NEVER_SEEN", ""]))
    assert codes[0] > 0 and codes[1] == 0 and codes[2] == 0


def test_mirror_augmentation_is_an_involution(root: Path) -> None:
    s = load_trajectory_data("full", WINDOW, HORIZON, data_root=root).samples
    numeric, xy, vel, target = (
        s.numeric[:5].copy(),
        s.xy[:5].copy(),
        s.vel[:5].copy(),
        s.target[:5].copy(),
    )
    mirror_y(numeric, xy, vel, target)
    assert np.allclose(xy[..., 0], s.xy[:5, ..., 0]) and not np.allclose(
        xy[..., 1], s.xy[:5, ..., 1]
    )
    mirror_y(numeric, xy, vel, target)
    assert np.allclose(numeric, s.numeric[:5], atol=1e-5) and np.allclose(
        target, s.target[:5], atol=1e-5
    )


def test_collate_pads_players_and_keeps_masks(root: Path) -> None:
    s = load_trajectory_data("full", WINDOW, HORIZON, data_root=root).samples
    enc = fit_encoders(s)
    batch = collate(s, enc.categorical(s), np.array([0, 1, 2]))
    counts = s.offsets[1:4] - s.offsets[0:3]
    assert batch.numeric.shape[1] == counts.max()
    assert batch.player_mask.sum(dim=1).tolist() == counts.tolist()
    assert (
        not batch.mask[~batch.player_mask].any()
        and not batch.target_mask[~batch.player_mask].any()
    )


# ---------------- constant velocity ----------------


def test_constant_velocity_extrapolates_by_frame_duration() -> None:
    pred = constant_velocity(np.array([[10.0, 20.0]]), np.array([[5.0, -2.0]]), 3)
    assert np.allclose(pred[0], [[10.5, 19.8], [11.0, 19.6], [11.5, 19.4]])


def test_finite_difference_velocity_and_short_history() -> None:
    xy = np.zeros((2, 3, 2), np.float32)
    xy[0, -2:] = [[1.0, 1.0], [1.3, 0.9]]
    mask = np.array([[True, True, True], [False, False, True]])
    v = finite_difference_velocity(xy, mask)
    assert np.allclose(v[0], [3.0, -1.0]) and np.allclose(v[1], 0.0)


def test_cv_baseline_matches_synthetic_straight_lines(root: Path) -> None:
    s = load_trajectory_data("full", WINDOW, HORIZON, data_root=root).samples
    rows = target_rows(s)
    pred = predict_constant_velocity(s.xy[rows], s.vel[rows], s.mask[rows], s.horizon)
    err = np.linalg.norm(pred - s.target[rows], axis=-1)[s.target_mask[rows]]
    assert (
        err.max() < 1e-2
    )  # synthetic players move in straight lines at constant velocity
