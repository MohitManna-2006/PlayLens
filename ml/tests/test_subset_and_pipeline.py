import json
from pathlib import Path

import polars as pl
import pytest
from playlens_ml.data import canonical_schema as cs
from playlens_ml.data.artifacts import (
    ProcessedDatasetError,
    ProcessedLayout,
    load_processed,
)
from playlens_ml.data.availability import (
    Availability,
    LeakageError,
    check_feature_columns,
)
from playlens_ml.data.bdb2026.discovery import RawDataError
from playlens_ml.data.preprocess import PreprocessOptions, RunSummary, main, run
from playlens_ml.data.subset import DevSubsetRule, eligibility, select_dev_plays
from playlens_ml.data.testing import SyntheticPlay, default_plays, write_raw_dataset

RULE = DevSubsetRule(plays_per_week=2)


def _candidates(rows: list[dict[str, object]]) -> pl.DataFrame:
    base = {
        "valid": True,
        "play_nullified_by_penalty": "N",
        "observed_frame_count": 25,
        "passer_count": 1,
        "offense_player_count": 5,
        "defense_player_count": 6,
        "predicted_player_count": 3,
        "observed_in_field": True,
        "down": 1,
        "yards_to_go": 10,
        "game_clock": "10:00",
        "offense_formation": "SHOTGUN",
        "receiver_alignment": "2x2",
        "team_coverage_man_zone": "ZONE_COVERAGE",
        "team_coverage_type": "COVER_3_ZONE",
        "route_of_targeted_receiver": "GO",
        "dropback_type": "TRADITIONAL",
        "pass_result": "C",
        "possession_team": "A",
        "defensive_team": "B",
    }
    return pl.DataFrame([{**base, **r} for r in rows])


def test_eligibility_names_every_reason() -> None:
    frame = eligibility(
        _candidates(
            [
                {"id": "1-1", "game_id": 1, "play_id": 1, "week": 1},
                {
                    "id": "1-2",
                    "game_id": 1,
                    "play_id": 2,
                    "week": 1,
                    "observed_frame_count": 5,
                    "team_coverage_type": None,
                },
                {
                    "id": "1-3",
                    "game_id": 1,
                    "play_id": 3,
                    "week": 1,
                    "play_nullified_by_penalty": "Y",
                    "valid": False,
                },
            ]
        ),
        RULE,
    )
    reasons = dict(
        zip(frame["id"], frame["dev_ineligible_reasons"].to_list(), strict=True)
    )
    assert reasons == {
        "1-1": [],
        "1-2": ["too_few_frames", "missing_team_coverage_type"],
        "1-3": ["failed_validation", "nullified_by_penalty"],
    }


def test_selection_is_deterministic_diverse_and_one_play_per_game() -> None:
    rows = [
        {
            "id": f"{g}-{p}",
            "game_id": g,
            "play_id": p,
            "week": 1 + g % 2,
            "team_coverage_type": ["COVER_1_MAN", "COVER_3_ZONE"][p % 2],
            "possession_team": f"T{g}",
        }
        for g in range(1, 7)
        for p in range(1, 5)
    ]
    frame = _candidates(rows)
    first = select_dev_plays(frame, RULE)
    shuffled = select_dev_plays(frame.sample(fraction=1.0, shuffle=True, seed=11), RULE)
    assert first.equals(shuffled)
    assert first.height == 4
    assert first.group_by("week").len()["len"].to_list() == [2, 2]
    assert first["game_id"].n_unique() == 4
    picked = frame.join(first, on=["game_id", "play_id"])
    assert picked["team_coverage_type"].n_unique() == 2  # diversity beats hash order


def test_rule_description_is_recorded() -> None:
    described = RULE.describe()
    assert (
        described["plays_per_week"] == 2
        and "ordering" in described
        and described["eligibility"]
    )


def test_feature_guard_blocks_targets_outcomes_and_annotations() -> None:
    registry = {
        **cs.PLAYS.availability,
        **cs.OUTCOMES.availability,
        **cs.ANNOTATIONS.availability,
        **{f"future_{k}": v for k, v in cs.FUTURE_TRAJECTORIES.availability.items()},
    }
    check_feature_columns(
        ["down", "yards_to_go", "offense_formation", "observed_frame_count"], registry
    )
    for col in (
        "yards_gained",
        "pass_result",
        "play_description",
        "expected_points_added",
        "team_coverage_type",
        "future_x",
    ):
        with pytest.raises(LeakageError, match=col):
            check_feature_columns(["down", col], registry)
    with pytest.raises(LeakageError, match="ball_land_x"):
        check_feature_columns(["ball_land_x"], registry)
    check_feature_columns(
        ["ball_land_x", "future_frame_count"], registry, allow_task_inputs=True
    )
    with pytest.raises(LeakageError, match="unregistered"):
        check_feature_columns(["mystery"], registry)


def test_every_canonical_column_has_an_availability_class() -> None:
    for spec in cs.ARTIFACTS:
        assert all(
            isinstance(c.availability, Availability) for c in spec.columns.values()
        )
        assert all(c.description for c in spec.columns.values())


@pytest.fixture(scope="module")
def synthetic_root(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("data")
    write_raw_dataset(root / "raw" / "release", default_plays())
    return root


def _run(root: Path, subset: str = "dev") -> RunSummary:
    return run(
        PreprocessOptions(
            subset=subset, data_root=root, raw_dir=root / "raw" / "release", rule=RULE
        )
    )


def test_pipeline_writes_loadable_artifacts_and_manifest(synthetic_root: Path) -> None:
    summary = _run(synthetic_root)
    layout = ProcessedLayout.for_subset(
        synthetic_root / "processed", "nfl_bdb_2026_analytics", "dev"
    )
    data = load_processed(layout)
    assert data.plays.height == 6 == summary.counts["selected_plays"]
    assert data.dataset_version == summary.dataset_version
    manifest = json.loads(summary.manifest_path.read_text())
    assert manifest["dataset_title"] == "NFL Big Data Bowl 2026 Analytics"
    assert {f["kind"] for f in manifest["raw_files"]} == {
        "supplementary",
        "input",
        "output",
    }
    assert all(
        len(f["sha256"]) == 64 and f["rows"] > 0 and f["bytes"] > 0
        for f in manifest["raw_files"]
    )
    assert manifest["selection"]["rule"]["plays_per_week"] == 2
    assert len(manifest["selected_play_ids"]) == 6
    assert (
        manifest["counts"]["observed_tracking_rows"]
        == data.scan(cs.OBSERVED_TRACKING).collect().height
    )
    assert (
        synthetic_root / "interim" / "nfl_bdb_2026_analytics" / "play_index.dev.parquet"
    ).is_file()


def test_rerun_is_byte_for_byte_stable(synthetic_root: Path) -> None:
    a = _run(synthetic_root)
    b = _run(synthetic_root)
    assert a.dataset_version == b.dataset_version
    assert a.artifacts == b.artifacts
    assert a.selected_ids == b.selected_ids


def test_full_subset_keeps_every_valid_play(synthetic_root: Path) -> None:
    summary = _run(synthetic_root, "full")
    assert summary.counts["selected_plays"] == 12
    assert "@full-" in summary.dataset_version


def test_loader_rejects_missing_or_corrupt_artifacts(
    synthetic_root: Path, tmp_path: Path
) -> None:
    with pytest.raises(ProcessedDatasetError, match="pnpm data:dev"):
        load_processed(ProcessedLayout(tmp_path / "empty"))
    _run(synthetic_root)
    layout = ProcessedLayout.for_subset(
        synthetic_root / "processed", "nfl_bdb_2026_analytics", "dev"
    )
    path = layout.path(cs.OUTCOMES)
    pl.read_parquet(path).drop("yards_gained").write_parquet(path)
    with pytest.raises(ProcessedDatasetError, match="canonical schema"):
        load_processed(layout)


def test_cli_fails_with_a_message_on_broken_schema(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    raw = write_raw_dataset(tmp_path / "raw" / "release", [SyntheticPlay(1, 1, 1)])
    sup = raw / "supplementary_data.csv"
    sup.write_text(sup.read_text().replace('"yards_gained"', '"yards"'))
    code = main(["--data-root", str(tmp_path), "--raw-dir", str(raw)])
    assert code == 1
    assert "missing required columns ['yards_gained']" in capsys.readouterr().err


def test_unknown_subset_is_rejected(synthetic_root: Path) -> None:
    with pytest.raises(RawDataError, match="Unknown subset"):
        _run(synthetic_root, "huge")
