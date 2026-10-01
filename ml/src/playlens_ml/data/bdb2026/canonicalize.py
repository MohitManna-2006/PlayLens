"""Raw BDB 2026 tables -> canonical PlayLens tables for a chosen set of plays.

Pure DataFrame transforms: no I/O, no filtering beyond the requested keys, no
interpolation. Raw values are kept next to canonical ones.
"""

from __future__ import annotations

from dataclasses import dataclass

import polars as pl

from .. import canonical_schema as cs
from ..artifacts import conform
from ..coordinates import (
    END_ZONE_YD,
    FIELD_LENGTH_YD,
    canonical_angle_expr,
    canonical_x_expr,
    canonical_y_expr,
)
from ..ids import play_id_expr
from . import spec

KEY = ["game_id", "play_id"]
ROLE_ORDER = {role: i for i, role in enumerate(spec.PLAYER_ROLES)}


@dataclass(frozen=True)
class CanonicalTables:
    plays: pl.DataFrame
    players: pl.DataFrame
    observed_tracking: pl.DataFrame
    future_trajectories: pl.DataFrame
    annotations: pl.DataFrame
    outcomes: pl.DataFrame

    def by_artifact(self) -> dict[str, pl.DataFrame]:
        return {
            cs.PLAYS.name: self.plays,
            cs.PLAYERS.name: self.players,
            cs.OBSERVED_TRACKING.name: self.observed_tracking,
            cs.FUTURE_TRAJECTORIES.name: self.future_trajectories,
            cs.ANNOTATIONS.name: self.annotations,
            cs.OUTCOMES.name: self.outcomes,
        }


def _frame_bounds(inp: pl.DataFrame) -> pl.DataFrame:
    return inp.group_by(KEY).agg(
        pl.col("play_direction").first(),
        pl.col("frame_id").min().alias("observed_first_frame_id"),
        pl.col("frame_id").max().alias("observed_last_frame_id"),
    )


def canonical_tracking(inp: pl.DataFrame, bounds: pl.DataFrame) -> pl.DataFrame:
    frame = inp.join(
        bounds.select([*KEY, "observed_first_frame_id"]), on=KEY
    ).with_columns(
        (pl.col("frame_id") - pl.col("observed_first_frame_id")).alias("frame_index"),
    )
    return conform(
        frame.with_columns(
            (pl.col("frame_index") / spec.FRAME_RATE_HZ).alias("time_s"),
            pl.col("x").alias("x_raw"),
            pl.col("y").alias("y_raw"),
            pl.col("dir").alias("dir_raw"),
            pl.col("o").alias("o_raw"),
            canonical_x_expr("x").alias("x"),
            canonical_y_expr("y").alias("y"),
            canonical_angle_expr("dir").alias("dir"),
            canonical_angle_expr("o").alias("o"),
        ),
        cs.OBSERVED_TRACKING,
    )


def canonical_future(out: pl.DataFrame, bounds: pl.DataFrame) -> pl.DataFrame:
    frame = out.join(bounds, on=KEY).with_columns(
        (
            pl.col("observed_last_frame_id")
            - pl.col("observed_first_frame_id")
            + pl.col("frame_id")
        ).alias("frame_index"),
    )
    return conform(
        frame.with_columns(
            (pl.col("frame_index") / spec.FRAME_RATE_HZ).alias("time_s"),
            pl.col("x").alias("x_raw"),
            pl.col("y").alias("y_raw"),
            canonical_x_expr("x").alias("x"),
            canonical_y_expr("y").alias("y"),
        ),
        cs.FUTURE_TRAJECTORIES,
    )


def canonical_players(inp: pl.DataFrame) -> pl.DataFrame:
    first = inp.sort([*KEY, "nfl_id", "frame_id"]).unique(
        [*KEY, "nfl_id"], keep="first"
    )
    frame = first.with_columns(
        pl.col("player_side").str.to_lowercase().alias("side"),
        pl.col("player_birth_date").str.to_date("%Y-%m-%d", strict=True),
        pl.col("player_role")
        .replace_strict(ROLE_ORDER, return_dtype=pl.Int64)
        .alias("_role_rank"),
    ).with_columns(
        # Offense first, then role, then nfl_id: deterministic roster order.
        # nfl_id < 1e7, so the composite key cannot collide.
        (
            (pl.col("side") != "offense").cast(pl.Int64) * 10**9
            + pl.col("_role_rank") * 10**7
            + pl.col("nfl_id")
        )
        .rank("ordinal")
        .over(KEY)
        .cast(pl.Int64)
        .sub(1)
        .alias("roster_order"),
    )
    return conform(frame, cs.PLAYERS)


def canonical_plays(
    inp: pl.DataFrame, sup: pl.DataFrame, bounds: pl.DataFrame
) -> pl.DataFrame:
    stats = inp.group_by(KEY).agg(
        pl.col("absolute_yardline_number").first(),
        pl.col("num_frames_output").first().alias("future_frame_count"),
        pl.col("ball_land_x").first(),
        pl.col("ball_land_y").first(),
        pl.col("source_file").first(),
        pl.col("frame_id").n_unique().alias("observed_frame_count"),
        pl.col("nfl_id").n_unique().alias("player_count"),
        pl.col("nfl_id")
        .filter(pl.col("player_side") == "Offense")
        .n_unique()
        .alias("offense_player_count"),
        pl.col("nfl_id")
        .filter(pl.col("player_side") == "Defense")
        .n_unique()
        .alias("defense_player_count"),
        pl.col("nfl_id")
        .filter(pl.col("player_to_predict"))
        .n_unique()
        .alias("predicted_player_count"),
    )
    goal_line = FIELD_LENGTH_YD - END_ZONE_YD
    frame = (
        stats.join(bounds, on=KEY)
        .join(sup, on=KEY, how="left")
        .with_columns(
            play_id_expr().alias("id"),
            pl.col("game_date").str.to_date("%m/%d/%Y", strict=True),
            pl.col("home_team_abbr").alias("home_team"),
            pl.col("visitor_team_abbr").alias("visitor_team"),
            pl.col("play_direction").alias("play_direction_raw"),
            pl.col("absolute_yardline_number").alias("absolute_yardline_number_raw"),
            canonical_x_expr("absolute_yardline_number").alias("line_of_scrimmage_x"),
            pl.lit(spec.FRAME_RATE_HZ).alias("frame_rate_hz"),
            pl.col("ball_land_x").alias("ball_land_x_raw"),
            pl.col("ball_land_y").alias("ball_land_y_raw"),
            canonical_x_expr("ball_land_x").alias("ball_land_x"),
            canonical_y_expr("ball_land_y").alias("ball_land_y"),
        )
        .with_columns(
            # Goal-to-go distances end at the goal line; anything beyond it is unknown.
            pl.when(pl.col("line_of_scrimmage_x") + pl.col("yards_to_go") <= goal_line)
            .then(pl.col("line_of_scrimmage_x") + pl.col("yards_to_go"))
            .otherwise(None)
            .alias("first_down_x"),
        )
    )
    return conform(frame, cs.PLAYS)


def canonical_annotations(sup: pl.DataFrame) -> pl.DataFrame:
    return conform(sup, cs.ANNOTATIONS)


def canonical_outcomes(sup: pl.DataFrame) -> pl.DataFrame:
    frame = sup.with_columns(
        pl.col("play_nullified_by_penalty").replace_strict(
            {"Y": True, "N": False}, default=None, return_dtype=pl.Boolean
        ),
        pl.col("visitor_team_win_probility_added").alias(
            "visitor_team_win_probability_added"
        ),
    )
    return conform(frame, cs.OUTCOMES)


def canonicalize(
    inp: pl.DataFrame, out: pl.DataFrame, sup: pl.DataFrame, keys: pl.DataFrame
) -> CanonicalTables:
    """Build every canonical table for exactly the plays in ``keys``."""
    keys = keys.select(KEY).unique()
    inp = inp.join(keys, on=KEY, how="semi")
    out = out.join(keys, on=KEY, how="semi")
    sup = sup.join(keys, on=KEY, how="semi")
    bounds = _frame_bounds(inp)
    return CanonicalTables(
        plays=canonical_plays(inp, sup, bounds),
        players=canonical_players(inp),
        observed_tracking=canonical_tracking(inp, bounds),
        future_trajectories=canonical_future(out, bounds),
        annotations=canonical_annotations(sup),
        outcomes=canonical_outcomes(sup),
    )
