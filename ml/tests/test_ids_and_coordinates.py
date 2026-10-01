import math

import polars as pl
import pytest
from playlens_ml.data.coordinates import (
    FIELD_LENGTH_YD,
    FIELD_WIDTH_YD,
    canonical_angle,
    canonical_angle_expr,
    canonical_x,
    canonical_x_expr,
    canonical_y,
    canonical_y_expr,
    raw_angle,
    raw_x,
    raw_y,
)
from playlens_ml.data.ids import (
    InvalidPlayIdError,
    decode_play_id,
    encode_play_id,
    is_play_id,
    play_id_expr,
)


def test_play_id_round_trip() -> None:
    assert encode_play_id(2023090700, 101) == "2023090700-101"
    assert decode_play_id("2023090700-101") == (2023090700, 101)


@pytest.mark.parametrize(
    "bad", ["101", "2023090700_101", "2023090700-", "-101", "a-1", "1-2-3", " 1-2", ""]
)
def test_play_id_rejects_malformed(bad: str) -> None:
    assert not is_play_id(bad)
    with pytest.raises(InvalidPlayIdError):
        decode_play_id(bad)


def test_play_id_rejects_negative_parts() -> None:
    with pytest.raises(InvalidPlayIdError):
        encode_play_id(-1, 5)


def test_play_id_expr_matches_python() -> None:
    df = pl.DataFrame({"game_id": [2023090700, 1], "play_id": [101, 7]})
    assert df.select(play_id_expr()).to_series().to_list() == [
        encode_play_id(2023090700, 101),
        "1-7",
    ]


def test_right_moving_play_is_unchanged() -> None:
    assert canonical_x(52.33, "right") == 52.33
    assert canonical_y(36.94, "right") == 36.94
    assert canonical_angle(322.4, "right") == 322.4


def test_left_moving_play_rotates_180_degrees() -> None:
    assert canonical_x(52.33, "left") == pytest.approx(FIELD_LENGTH_YD - 52.33)
    assert canonical_y(36.94, "left") == pytest.approx(FIELD_WIDTH_YD - 36.94)
    assert canonical_angle(90.0, "left") == 270.0
    assert canonical_angle(270.0, "left") == 90.0
    assert canonical_angle(322.4, "left") == pytest.approx(142.4)


def test_transform_is_its_own_inverse() -> None:
    for direction in ("left", "right"):
        assert raw_x(canonical_x(17.25, direction), direction) == pytest.approx(17.25)
        assert raw_y(canonical_y(3.5, direction), direction) == pytest.approx(3.5)
        assert raw_angle(canonical_angle(12.5, direction), direction) == pytest.approx(
            12.5
        )


def test_angle_rotation_matches_position_rotation() -> None:
    # Rotating a step along the raw direction equals stepping along the rotated one.
    x, y, s, deg = 30.0, 20.0, 2.0, 63.0
    nx, ny = x + s * math.sin(math.radians(deg)), y + s * math.cos(math.radians(deg))
    cdeg = canonical_angle(deg, "left")
    cx, cy = canonical_x(x, "left"), canonical_y(y, "left")
    assert canonical_x(nx, "left") == pytest.approx(
        cx + s * math.sin(math.radians(cdeg))
    )
    assert canonical_y(ny, "left") == pytest.approx(
        cy + s * math.cos(math.radians(cdeg))
    )


def test_line_of_scrimmage_and_ball_landing_use_the_same_transform() -> None:
    # Offense on its own 30 attacking left: raw x 90 becomes canonical 30.
    assert canonical_x(90, "left") == 30
    # A landing point beyond the sideline stays beyond it after rotation.
    assert canonical_y(-0.22, "left") == pytest.approx(FIELD_WIDTH_YD + 0.22)


def test_invalid_direction_is_rejected() -> None:
    with pytest.raises(ValueError):
        canonical_x(10.0, "up")


def test_polars_expressions_match_scalar_functions() -> None:
    df = pl.DataFrame(
        {
            "play_direction": ["left", "right"],
            "x": [10.0, 10.0],
            "y": [5.0, 5.0],
            "dir": [350.0, 350.0],
        }
    )
    out = df.select(
        canonical_x_expr("x"), canonical_y_expr("y"), canonical_angle_expr("dir")
    )
    assert out["x"].to_list() == [canonical_x(10.0, "left"), canonical_x(10.0, "right")]
    assert out["y"].to_list() == [canonical_y(5.0, "left"), canonical_y(5.0, "right")]
    assert out["dir"].to_list() == [
        canonical_angle(350.0, "left"),
        canonical_angle(350.0, "right"),
    ]
