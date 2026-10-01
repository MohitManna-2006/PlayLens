"""PlayLens canonical coordinate system (Masterbrain §9.1).

Raw tracking frame (NFL Next Gen Stats convention, verified against the data):

* Units are yards. ``x`` runs along the long axis, 0 to 120 including both
  10-yard end zones. ``y`` runs across the field, 0 to 160/3 (53 1/3 yd).
* ``dir`` (movement direction) and ``o`` (orientation) are degrees in [0, 360]
  with 0 deg pointing along +y and angles increasing clockwise, so a velocity
  of speed ``s`` has components ``(s * sin(dir), s * cos(dir))``.
* ``play_direction`` says which way the offense attacks: ``right`` (+x) or
  ``left`` (-x).

Canonical frame: the same field and units, rotated 180 deg about the field
center for ``left`` plays so the offense always attacks toward +x. For
``right`` plays every value is unchanged. The rotation maps

    x' = 120 - x,   y' = 160/3 - y,   angle' = (angle + 180) mod 360

It preserves handedness (no mirror) and is its own inverse, so the same
function recovers raw values from canonical ones (angles modulo 360).
"""

from __future__ import annotations

from typing import Literal

import polars as pl

FIELD_LENGTH_YD = 120.0
FIELD_WIDTH_YD = 160.0 / 3.0
END_ZONE_YD = 10.0

PlayDirection = Literal["left", "right"]
PLAY_DIRECTIONS: tuple[PlayDirection, ...] = ("left", "right")

COORDINATE_SYSTEM = "playlens-canonical-v1"
COORDINATE_DESCRIPTION = (
    "Yards. x 0-120 along the field including end zones, y 0-53.33 across it. "
    "Offense attacks toward +x on every play (left-moving plays rotated 180 deg). "
    "Angles in degrees, 0 = +y, clockwise."
)


def _check(direction: str) -> bool:
    if direction not in PLAY_DIRECTIONS:
        raise ValueError(f"play_direction must be 'left' or 'right', got {direction!r}")
    return direction == "left"


def canonical_x(x: float, direction: str) -> float:
    return FIELD_LENGTH_YD - x if _check(direction) else x


def canonical_y(y: float, direction: str) -> float:
    return FIELD_WIDTH_YD - y if _check(direction) else y


def canonical_angle(deg: float, direction: str) -> float:
    return (deg + 180.0) % 360.0 if _check(direction) else deg


# The rotation is an involution: applying it to canonical values yields raw ones.
raw_x = canonical_x
raw_y = canonical_y
raw_angle = canonical_angle


def _is_left(direction_col: str) -> pl.Expr:
    return pl.col(direction_col) == "left"


def canonical_x_expr(col: str, direction_col: str = "play_direction") -> pl.Expr:
    return (
        pl.when(_is_left(direction_col))
        .then(FIELD_LENGTH_YD - pl.col(col))
        .otherwise(pl.col(col))
        .alias(col)
    )


def canonical_y_expr(col: str, direction_col: str = "play_direction") -> pl.Expr:
    return (
        pl.when(_is_left(direction_col))
        .then(FIELD_WIDTH_YD - pl.col(col))
        .otherwise(pl.col(col))
        .alias(col)
    )


def canonical_angle_expr(col: str, direction_col: str = "play_direction") -> pl.Expr:
    return (
        pl.when(_is_left(direction_col))
        .then((pl.col(col) + 180.0) % 360.0)
        .otherwise(pl.col(col))
        .alias(col)
    )
