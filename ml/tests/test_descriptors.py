"""Structural descriptors: toy geometry, missing roles, windows, and invariance."""

import math
from pathlib import Path
from typing import Any

import polars as pl
import pytest
from playlens_ml.data import canonical_schema as cs
from playlens_ml.data.artifacts import ProcessedLayout, load_processed
from playlens_ml.data.preprocess import PreprocessOptions, run
from playlens_ml.data.testing import SyntheticPlay, write_raw_dataset
from playlens_ml.descriptors import (
    DESCRIPTORS,
    WINDOW_FRAMES,
    structural_descriptors,
)

Player = tuple[int, str, str]  # nfl_id, side, role
Track = list[tuple[float, float, float | None]]  # x, y, speed per frame


def _play(
    play_id: int,
    players: list[Player],
    positions: dict[int, Track],
    los_x: float = 40.0,
) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame]:
    """A hand-built play: ``positions[nfl_id]`` is (x, y, speed) per frame."""
    n = len(next(iter(positions.values())))
    plays = pl.DataFrame(
        {
            "game_id": [1],
            "play_id": [play_id],
            "line_of_scrimmage_x": [los_x],
            "observed_frame_count": [n],
            "observed_last_frame_id": [n],
        }
    )
    roster = pl.DataFrame(
        {
            "game_id": [1] * len(players),
            "play_id": [play_id] * len(players),
            "nfl_id": [p[0] for p in players],
            "side": [p[1] for p in players],
            "player_role": [p[2] for p in players],
        }
    )
    rows: list[dict[str, Any]] = []
    for nfl_id, track in positions.items():
        for i, (x, y, s) in enumerate(track):
            rows.append(
                {
                    "game_id": 1,
                    "play_id": play_id,
                    "nfl_id": nfl_id,
                    "frame_id": i + 1,
                    "frame_index": i,
                    "x": x,
                    "y": y,
                    "s": s,
                }
            )
    tracking = pl.DataFrame(rows, schema_overrides={"s": pl.Float64})
    return plays, roster, tracking


FULL_ROSTER: list[Player] = [
    (10, "offense", "Passer"),
    (11, "offense", "Targeted Receiver"),
    (12, "offense", "Other Route Runner"),
    (20, "defense", "Defensive Coverage"),
    (21, "defense", "Defensive Coverage"),
]


def _toy(play_id: int = 1) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame]:
    # Three frames; the last one is the origin. Earlier frames are deliberately
    # different so a descriptor that read the wrong frame would fail.
    return _play(
        play_id,
        FULL_ROSTER,
        {
            10: [(30, 26, 1.0), (33, 26, 2.0), (35, 26, 3.0)],
            11: [(42, 20, 1.0), (46, 14, 2.0), (50, 10, 3.0)],
            12: [(41, 30, 1.0), (43, 35, 2.0), (45, 40, 3.0)],
            20: [(45, 20, 1.0), (49, 16, 2.0), (52, 12, 3.0)],
            21: [(50, 26, 1.0), (55, 26, 2.0), (60, 26, 3.0)],
        },
    )


def _row(frame: pl.DataFrame, play_id: int = 1) -> dict[str, Any]:
    return frame.filter(pl.col("play_id") == play_id).row(0, named=True)


def test_toy_geometry_at_the_last_observed_frame() -> None:
    r = _row(structural_descriptors(*_toy()))
    assert r["origin_frame_id"] == 3 and r["window_start_frame_id"] == 1
    assert r["offense_players_at_origin"] == 3 and r["defense_players_at_origin"] == 2
    assert r["offense_width"] == pytest.approx(40 - 10)
    assert r["deepest_defender_depth"] == pytest.approx(60 - 40)
    assert r["target_depth"] == pytest.approx(50 - 40)
    assert r["target_separation"] == pytest.approx(math.hypot(52 - 50, 12 - 10))
    assert r["mean_speed"] == pytest.approx(2.0)  # mean of 1, 2, 3 over 5 players


def test_columns_cover_every_declared_descriptor() -> None:
    out = structural_descriptors(*_toy())
    assert {d.key for d in DESCRIPTORS} <= set(out.columns)
    assert len({d.key for d in DESCRIPTORS}) == len(DESCRIPTORS)
    assert all(d.unit in ("yd", "yd/s") and d.definition for d in DESCRIPTORS)


def test_no_defenders_leaves_defensive_measures_null() -> None:
    plays, roster, tracking = _play(
        2,
        FULL_ROSTER[:3],
        {10: [(35, 26, 1.0)] * 2, 11: [(50, 10, 1.0)] * 2, 12: [(45, 40, 1.0)] * 2},
    )
    r = _row(structural_descriptors(plays, roster, tracking), 2)
    assert r["defense_players_at_origin"] == 0
    assert r["deepest_defender_depth"] is None and r["target_separation"] is None
    assert r["offense_width"] == pytest.approx(30)
    assert r["target_depth"] == pytest.approx(10)


def test_one_offensive_player_has_no_width_and_no_target() -> None:
    plays, roster, tracking = _play(
        3,
        [(10, "offense", "Passer"), (20, "defense", "Defensive Coverage")],
        {10: [(35, 26, 1.0)], 20: [(45, 20, 1.0)]},
    )
    r = _row(structural_descriptors(plays, roster, tracking), 3)
    assert r["offense_players_at_origin"] == 1
    assert r["offense_width"] is None
    assert r["target_depth"] is None and r["target_separation"] is None
    assert r["deepest_defender_depth"] == pytest.approx(5)


def test_window_is_the_last_twenty_frames_or_the_whole_short_play() -> None:
    n = WINDOW_FRAMES + 10
    # Speed 100 in the first 10 frames (outside the window), 1 afterwards.
    long_track: Track = [(40.0, 20.0, 100.0 if i < 10 else 1.0) for i in range(n)]
    plays, roster, tracking = _play(
        4, [(11, "offense", "Targeted Receiver")], {11: long_track}
    )
    r = _row(structural_descriptors(plays, roster, tracking), 4)
    assert r["mean_speed"] == pytest.approx(1.0)
    assert r["window_start_frame_id"] == n - WINDOW_FRAMES + 1

    short: Track = [(40.0, 20.0, float(i)) for i in range(8)]
    plays, roster, tracking = _play(
        5, [(11, "offense", "Targeted Receiver")], {11: short}
    )
    r = _row(structural_descriptors(plays, roster, tracking), 5)
    assert r["window_start_frame_id"] == 1
    assert r["mean_speed"] == pytest.approx(sum(range(8)) / 8)


def test_missing_speeds_are_skipped_not_counted_as_zero() -> None:
    plays, roster, tracking = _play(
        6,
        [(11, "offense", "Targeted Receiver"), (12, "offense", "Other Route Runner")],
        {11: [(40, 20, 4.0)], 12: [(41, 30, None)]},
    )
    assert _row(structural_descriptors(plays, roster, tracking), 6)[
        "mean_speed"
    ] == pytest.approx(4.0)


def test_batch_equals_one_play_at_a_time() -> None:
    a = _toy(1)
    b = _play(
        7,
        FULL_ROSTER,
        {
            10: [(30, 20, 1.5)] * 4,
            11: [(55, 5, 6.0)] * 4,
            12: [(48, 49, 5.0)] * 4,
            20: [(57, 7, 4.0)] * 4,
            21: [(70, 30, 2.0)] * 4,
        },
        los_x=45.0,
    )
    both = structural_descriptors(
        *(pl.concat([x, y]) for x, y in zip(a, b, strict=True))
    )
    assert both.height == 2
    for single, play_id in (
        (structural_descriptors(*a), 1),
        (structural_descriptors(*b), 7),
    ):
        assert _row(both, play_id) == _row(single, play_id)


def test_canonical_frame_makes_descriptors_direction_invariant(tmp_path: Path) -> None:
    """The same motion recorded in both directions yields identical descriptors,
    because preprocessing rotates left-moving plays into the canonical frame."""
    plays = [
        SyntheticPlay(game_id=2099090010, play_id=101, week=1, direction="right"),
        SyntheticPlay(game_id=2099090011, play_id=101, week=1, direction="left"),
    ]
    raw = write_raw_dataset(tmp_path / "raw" / "release", plays)
    run(PreprocessOptions(subset="full", data_root=tmp_path, raw_dir=raw))
    data = load_processed(
        ProcessedLayout.for_subset(
            tmp_path / "processed", "nfl_bdb_2026_analytics", "full"
        )
    )
    out = structural_descriptors(
        data.plays, data.players, data.scan(cs.OBSERVED_TRACKING)
    )
    right, left = (out.row(i, named=True) for i in range(2))
    for d in DESCRIPTORS:
        assert right[d.key] is not None
        assert left[d.key] == pytest.approx(right[d.key], abs=1e-6), d.key
    # Offense attacks +x in the canonical frame: receivers are downfield of the
    # passer, defenders downfield of the line.
    assert right["deepest_defender_depth"] > 0
