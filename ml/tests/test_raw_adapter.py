from pathlib import Path

import polars as pl
import pytest
from playlens_ml.data.bdb2026 import spec
from playlens_ml.data.bdb2026.discovery import RawDataError, check_all_headers, discover
from playlens_ml.data.bdb2026.load import read_supplementary, read_tracking
from playlens_ml.data.bdb2026.validate import validate
from playlens_ml.data.testing import SyntheticPlay, default_plays, write_raw_dataset


def _load(raw: Path) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame]:
    files = discover(raw)
    return (
        read_tracking(files.weeks, "input"),
        read_tracking(files.weeks, "output"),
        read_supplementary(files.supplementary),
    )


def test_discovers_weekly_pairs_in_order(tmp_path: Path) -> None:
    raw = write_raw_dataset(tmp_path, default_plays())
    files = discover(raw)
    assert [w.week for w in files.weeks] == [1, 2, 3]
    assert all(
        w.input_path.name == f"input_2023_w{w.week:02d}.csv" for w in files.weeks
    )
    assert check_all_headers(files) == {}


def test_missing_raw_root_explains_what_to_do(tmp_path: Path) -> None:
    with pytest.raises(RawDataError, match="Raw dataset not found"):
        discover(tmp_path / "nope")


def test_unpaired_week_fails(tmp_path: Path) -> None:
    raw = write_raw_dataset(tmp_path, default_plays())
    (raw / "train" / "output_2023_w02.csv").unlink()
    with pytest.raises(RawDataError, match="not paired"):
        discover(raw)


def test_missing_required_column_fails_loudly(tmp_path: Path) -> None:
    raw = write_raw_dataset(tmp_path, default_plays())
    path = raw / "train" / "input_2023_w01.csv"
    lines = path.read_text().splitlines()
    header = lines[0].split(",")
    drop = header.index("x")
    path.write_text(
        "\n".join(
            ",".join(v for i, v in enumerate(line.split(",")) if i != drop)
            for line in lines
        )
        + "\n"
    )
    with pytest.raises(RawDataError, match=r"missing required columns \['x'\]"):
        check_all_headers(discover(raw))


def test_extra_columns_are_recorded_not_fatal(tmp_path: Path) -> None:
    raw = write_raw_dataset(tmp_path, default_plays())
    path = raw / "train" / "output_2023_w01.csv"
    lines = path.read_text().splitlines()
    path.write_text(
        "\n".join([lines[0] + ",note", *(line + ",x" for line in lines[1:])]) + "\n"
    )
    assert check_all_headers(discover(raw)) == {"output_2023_w01.csv": ["note"]}
    assert list(read_tracking(discover(raw).weeks, "output").columns[:6]) == list(
        spec.OUTPUT_SCHEMA
    )


def test_loader_applies_explicit_types_and_nulls(tmp_path: Path) -> None:
    raw = write_raw_dataset(
        tmp_path, [SyntheticPlay(1, 1, 1, supplementary={"team_coverage_type": None})]
    )
    inp, out, sup = _load(raw)
    assert inp.schema["player_to_predict"] == pl.Boolean
    assert sup.schema["play_action"] == pl.Boolean
    assert sup["team_coverage_type"].to_list() == [None]
    assert sup["penalty_yards"].to_list() == [None]
    assert set(inp["source_file"]) == {"input_2023_w01.csv"}


def test_clean_synthetic_dataset_passes_every_error_check(tmp_path: Path) -> None:
    result = validate(*_load(write_raw_dataset(tmp_path, default_plays())))
    failed = [c.name for c in result.checks if not c.passed]
    assert failed == []
    assert result.play_index["valid"].all()
    assert result.exclusion_counts() == {}


def test_supplementary_join_is_checked(tmp_path: Path) -> None:
    inp, out, sup = _load(write_raw_dataset(tmp_path, default_plays()))
    first = sup.row(0, named=True)
    sup = sup.filter(
        ~(
            (pl.col("game_id") == first["game_id"])
            & (pl.col("play_id") == first["play_id"])
        )
    )
    result = validate(inp, out, sup)
    assert result.exclusion_counts() == {"supplementary_missing_for_tracking": 1}


def test_duplicate_and_missing_frames_exclude_the_play_with_a_reason(
    tmp_path: Path,
) -> None:
    inp, out, sup = _load(write_raw_dataset(tmp_path, default_plays()))
    keys = inp.select("game_id", "play_id").unique().sort("game_id", "play_id").rows()
    (g1, p1), (g2, p2) = keys[0], keys[1]
    dup = inp.filter((pl.col("game_id") == g1) & (pl.col("play_id") == p1)).head(1)
    gap = (
        (pl.col("game_id") == g2)
        & (pl.col("play_id") == p2)
        & (pl.col("frame_id") == 5)
    )
    result = validate(pl.concat([inp.filter(~gap), dup]), out, sup)
    index = result.play_index.filter(~pl.col("valid"))
    reasons = {
        (r["game_id"], r["play_id"]): r["exclusion_reasons"]
        for r in index.iter_rows(named=True)
    }
    assert reasons == {
        (g1, p1): ["input_duplicate_frame_rows"],
        (g2, p2): ["input_non_contiguous_frames"],
    }


def test_future_rows_must_match_players_to_predict(tmp_path: Path) -> None:
    inp, out, sup = _load(write_raw_dataset(tmp_path, default_plays()))
    victim = out.row(0, named=True)
    out = out.filter(
        ~(
            (pl.col("game_id") == victim["game_id"])
            & (pl.col("play_id") == victim["play_id"])
            & (pl.col("nfl_id") == victim["nfl_id"])
        )
    )
    result = validate(inp, out, sup)
    assert result.exclusion_counts() == {"output_players_match_player_to_predict": 1}


def test_unusual_composition_warns_without_excluding(tmp_path: Path) -> None:
    inp, out, sup = _load(write_raw_dataset(tmp_path, default_plays()))
    inp = inp.with_columns(
        pl.when(pl.col("player_role") == "Passer")
        .then(pl.lit("Other Route Runner"))
        .otherwise(pl.col("player_role"))
        .alias("player_role")
    )
    result = validate(inp, out, sup)
    passer = next(c for c in result.checks if c.name == "input_passer_count")
    assert passer.count == 12 and not passer.passed
    assert result.play_index["valid"].all()


def test_unknown_categories_are_excluded_not_coerced(tmp_path: Path) -> None:
    inp, out, sup = _load(write_raw_dataset(tmp_path, default_plays()))
    inp = inp.with_columns(
        pl.when(pl.col("play_id") == 101)
        .then(pl.lit("north"))
        .otherwise(pl.col("play_direction"))
        .alias("play_direction")
    )
    result = validate(inp, out, sup)
    assert result.exclusion_counts()["input_unknown_play_direction"] == 2
