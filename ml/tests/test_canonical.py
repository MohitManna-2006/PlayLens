import polars as pl
import pytest
from playlens_ml.data import canonical_schema as cs
from playlens_ml.data.availability import Availability
from playlens_ml.data.bdb2026.canonicalize import CanonicalTables, canonicalize
from playlens_ml.data.bdb2026.discovery import discover
from playlens_ml.data.bdb2026.load import read_supplementary, read_tracking
from playlens_ml.data.coordinates import FIELD_LENGTH_YD, FIELD_WIDTH_YD
from playlens_ml.data.preprocess import LeakageCheckError, assert_temporal_separation
from playlens_ml.data.testing import SyntheticPlay, player_rows, write_raw_dataset

LEFT = SyntheticPlay(
    game_id=2099091000,
    play_id=55,
    week=1,
    direction="left",
    los_x=35,
    frames=21,
    future_frames=5,
)
RIGHT = SyntheticPlay(
    game_id=2099091000,
    play_id=77,
    week=1,
    direction="right",
    los_x=62,
    frames=20,
    future_frames=7,
    supplementary={"team_coverage_type": None, "route_of_targeted_receiver": None},
)


@pytest.fixture(scope="module")
def tables(tmp_path_factory: pytest.TempPathFactory) -> CanonicalTables:
    raw = write_raw_dataset(tmp_path_factory.mktemp("raw"), [LEFT, RIGHT])
    files = discover(raw)
    inp, out = read_tracking(files.weeks, "input"), read_tracking(files.weeks, "output")
    sup = read_supplementary(files.supplementary)
    # Shuffle rows: canonical output order must not depend on input order.
    inp = inp.sample(fraction=1.0, shuffle=True, seed=3)
    return canonicalize(inp, out, sup, inp.select("game_id", "play_id").unique())


def _one(frame: pl.DataFrame, play: SyntheticPlay) -> pl.DataFrame:
    return frame.filter(
        (pl.col("game_id") == play.game_id) & (pl.col("play_id") == play.play_id)
    )


def test_every_artifact_matches_its_canonical_schema(tables: CanonicalTables) -> None:
    for spec in cs.ARTIFACTS:
        assert dict(tables.by_artifact()[spec.name].schema) == spec.schema


def test_left_play_positions_are_rotated_and_raw_values_kept(
    tables: CanonicalTables,
) -> None:
    expected = {
        (r["nfl_id"], r["frame"]): r
        for r in player_rows(LEFT)
        if r["frame"] <= LEFT.frames
    }
    track = _one(tables.observed_tracking, LEFT)
    assert track.height == len(expected)
    for row in track.iter_rows(named=True):
        e = expected[(row["nfl_id"], row["frame_id"])]
        assert row["x"] == pytest.approx(e["cx"], abs=1e-3)
        assert row["y"] == pytest.approx(e["cy"], abs=1e-3)
        assert row["dir"] == pytest.approx(e["cdir"], abs=1e-3)
        assert row["x_raw"] == pytest.approx(FIELD_LENGTH_YD - e["cx"], abs=1e-3)
        assert row["y_raw"] == pytest.approx(FIELD_WIDTH_YD - e["cy"], abs=1e-3)


def test_right_play_is_identity(tables: CanonicalTables) -> None:
    track = _one(tables.observed_tracking, RIGHT)
    assert (track["x"] == track["x_raw"]).all() and (track["y"] == track["y_raw"]).all()
    assert (track["dir"] == track["dir_raw"]).all() and (
        track["o"] == track["o_raw"]
    ).all()


def test_frames_are_ordered_and_timed(tables: CanonicalTables) -> None:
    track = _one(tables.observed_tracking, LEFT)
    assert track["frame_id"].is_sorted()
    frames = track.unique("frame_id").sort("frame_id")
    assert frames["frame_index"].to_list() == list(range(LEFT.frames))
    assert frames["time_s"].to_list() == pytest.approx(
        [i / 10 for i in range(LEFT.frames)]
    )
    per_frame = track.group_by("frame_id").agg(pl.col("nfl_id"))
    assert per_frame["nfl_id"].list.len().unique().to_list() == [11]
    assert all(
        ids == sorted(ids)
        for ids in track.group_by("frame_id", maintain_order=True)
        .agg(pl.col("nfl_id"))["nfl_id"]
        .to_list()
    )


def test_roster_order_is_offense_first_by_role(tables: CanonicalTables) -> None:
    players = _one(tables.players, LEFT).sort("roster_order")
    assert players["roster_order"].to_list() == list(range(11))
    assert players["side"].to_list() == ["offense"] * 5 + ["defense"] * 6
    assert players["player_role"].to_list()[:2] == ["Passer", "Targeted Receiver"]


def test_observed_frames_contain_no_future_rows(tables: CanonicalTables) -> None:
    track = _one(tables.observed_tracking, LEFT)
    future = _one(tables.future_trajectories, LEFT)
    assert track["frame_id"].max() == LEFT.frames
    assert (
        future["frame_index"].min() == LEFT.frames
    )  # the first index after the observed window
    assert (
        future["frame_id"].min() == 1 and future["frame_id"].max() == LEFT.future_frames
    )
    assert_temporal_separation(tables)


def test_temporal_guard_rejects_overlap(tables: CanonicalTables) -> None:
    bad = CanonicalTables(
        **{
            **tables.__dict__,
            "future_trajectories": tables.future_trajectories.with_columns(
                pl.col("frame_index") - 3
            ),
        }
    )
    with pytest.raises(LeakageCheckError):
        assert_temporal_separation(bad)


def test_future_trajectories_map_to_predicted_players(tables: CanonicalTables) -> None:
    predicted = set(
        _one(tables.players, LEFT).filter(pl.col("player_to_predict"))["nfl_id"]
    )
    future = _one(tables.future_trajectories, LEFT)
    assert set(future["nfl_id"]) == predicted
    expected = {
        (r["nfl_id"], r["frame"] - LEFT.frames): r
        for r in player_rows(LEFT)
        if r["frame"] > LEFT.frames
    }
    for row in future.iter_rows(named=True):
        assert row["x"] == pytest.approx(
            expected[(row["nfl_id"], row["frame_id"])]["cx"], abs=1e-3
        )


def test_play_geometry_is_canonical(tables: CanonicalTables) -> None:
    left = _one(tables.plays, LEFT).row(0, named=True)
    assert left["id"] == f"{LEFT.game_id}-{LEFT.play_id}"
    assert left["line_of_scrimmage_x"] == LEFT.los_x
    assert left["absolute_yardline_number_raw"] == FIELD_LENGTH_YD - LEFT.los_x
    assert left["first_down_x"] == LEFT.los_x + 6
    assert left["ball_land_x"] == pytest.approx(LEFT.los_x + 12.0)
    assert left["ball_land_y"] == pytest.approx(20.0)
    assert (
        left["observed_frame_count"] == LEFT.frames
        and left["future_frame_count"] == LEFT.future_frames
    )
    assert left["predicted_player_count"] == 3
    assert left["play_direction_raw"] == "left"


def test_missing_optional_metadata_stays_null(tables: CanonicalTables) -> None:
    ann = _one(tables.annotations, RIGHT).row(0, named=True)
    assert (
        ann["team_coverage_type"] is None and ann["route_of_targeted_receiver"] is None
    )
    assert _one(tables.outcomes, RIGHT)["penalty_yards"].to_list() == [None]


def test_outcomes_and_annotations_are_kept_out_of_observed_artifacts(
    tables: CanonicalTables,
) -> None:
    for spec in (cs.PLAYS, cs.PLAYERS, cs.OBSERVED_TRACKING):
        classes = {c.availability for c in spec.columns.values()}
        assert not classes & {
            Availability.POST_PLAY_OUTCOME,
            Availability.FUTURE_TARGET,
            Availability.IN_PLAY_ANNOTATION,
        }
        assert "yards_gained" not in tables.by_artifact()[spec.name].columns
    assert {c.availability for c in cs.OUTCOMES.columns.values()} <= {
        Availability.IDENTITY,
        Availability.POST_PLAY_OUTCOME,
    }
    assert {c.availability for c in cs.FUTURE_TRAJECTORIES.columns.values()} <= {
        Availability.IDENTITY,
        Availability.FUTURE_TARGET,
    }
