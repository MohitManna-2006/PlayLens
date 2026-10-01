"""Integrity checks over the full raw dataset, run before canonicalization.

Every check is recorded with a count, whether or not it fails. A play that
fails an ``error`` check is excluded from the canonical tables with a named
reason; nothing is dropped silently and nothing is repaired in place.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

import polars as pl

from ..coordinates import FIELD_LENGTH_YD, FIELD_WIDTH_YD, canonical_x_expr
from ..ids import play_id_expr
from . import spec

Severity = Literal["error", "warning", "info"]
KEY = ["game_id", "play_id"]
# Largest last-observed to first-future displacement treated as continuous.
# One frame at the dataset's top speed (12.5 yd/s) is 1.25 yd.
CONTINUITY_LIMIT_YD = 3.0


@dataclass
class Check:
    name: str
    severity: Severity
    description: str
    unit: str
    count: int
    examples: list[str] = field(default_factory=list)
    details: dict[str, float | int | str] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return self.severity == "info" or self.count == 0

    def to_dict(self) -> dict[str, object]:
        return {**asdict(self), "passed": self.passed}


@dataclass
class ValidationResult:
    checks: list[Check]
    play_index: pl.DataFrame
    """One row per input play: structure, supplementary presence, exclusion reasons."""
    dropped_rows: int
    """Input rows without a play key; they cannot be attributed to any play."""

    @property
    def valid_keys(self) -> pl.DataFrame:
        return self.play_index.filter(pl.col("valid")).select(KEY)

    def exclusion_counts(self) -> dict[str, int]:
        exploded = self.play_index.select("exclusion_reasons").explode(
            "exclusion_reasons", empty_as_null=False
        )
        counts = exploded.group_by("exclusion_reasons").len().sort("exclusion_reasons")
        return {str(r): int(n) for r, n in counts.iter_rows()}


class _Collector:
    def __init__(self) -> None:
        self.checks: list[Check] = []
        self.reasons: list[pl.DataFrame] = []

    def add(
        self,
        name: str,
        severity: Severity,
        description: str,
        offenders: pl.DataFrame | None = None,
        *,
        unit: str = "plays",
        count: int | None = None,
        details: dict[str, float | int | str] | None = None,
    ) -> None:
        """Record a check; for ``error`` checks the offending plays get ``name`` as
        a reason."""
        examples: list[str] = []
        n = count if count is not None else 0
        if offenders is not None:
            keys = offenders.select(KEY).unique().sort(KEY)
            n = count if count is not None else keys.height
            examples = keys.head(5).select(play_id_expr()).to_series().to_list()
            if severity == "error" and keys.height:
                self.reasons.append(keys.with_columns(pl.lit(name).alias("reason")))
        self.checks.append(
            Check(name, severity, description, unit, n, examples, details or {})
        )


def _plays_where(frame: pl.DataFrame, condition: pl.Expr) -> pl.DataFrame:
    return frame.filter(condition).select(KEY).unique()


def validate(
    inp: pl.DataFrame, out: pl.DataFrame, sup: pl.DataFrame
) -> ValidationResult:
    c = _Collector()

    keyless = inp.filter(pl.col("game_id").is_null() | pl.col("play_id").is_null())
    c.add(
        "input_rows_without_play_key",
        "error",
        "Input rows with a null game_id or play_id; they are dropped and counted.",
        unit="rows",
        count=keyless.height,
    )
    inp = inp.drop_nulls(KEY)

    required = [
        "nfl_id",
        "frame_id",
        "play_direction",
        "player_side",
        "player_role",
        "player_to_predict",
        "x",
        "y",
        "num_frames_output",
    ]
    c.add(
        "input_required_nulls",
        "error",
        f"Plays with a null in a required input column ({', '.join(required)}).",
        _plays_where(inp, pl.any_horizontal(pl.col(required).is_null())),
    )

    dup = inp.filter(pl.struct([*KEY, "nfl_id", "frame_id"]).is_duplicated())
    c.add(
        "input_duplicate_frame_rows",
        "error",
        "Plays with more than one row for the same (nfl_id, frame_id).",
        dup,
    )

    c.add(
        "input_unknown_play_direction",
        "error",
        "play_direction is not 'left' or 'right'.",
        _plays_where(inp, ~pl.col("play_direction").is_in(["left", "right"])),
    )
    c.add(
        "input_unknown_player_side",
        "error",
        f"player_side outside {list(spec.PLAYER_SIDES)}.",
        _plays_where(inp, ~pl.col("player_side").is_in(list(spec.PLAYER_SIDES))),
    )
    c.add(
        "input_unknown_player_role",
        "error",
        f"player_role outside {list(spec.PLAYER_ROLES)}.",
        _plays_where(inp, ~pl.col("player_role").is_in(list(spec.PLAYER_ROLES))),
    )

    kinematic = ["x", "y", "s", "a", "dir", "o"]
    c.add(
        "input_non_finite_values",
        "error",
        "Plays with NaN or infinite x, y, s, a, dir, or o.",
        _plays_where(
            inp,
            pl.any_horizontal(
                [pl.col(k).is_nan() | pl.col(k).is_infinite() for k in kinematic]
            ),
        ),
    )
    c.add(
        "input_angle_out_of_range",
        "error",
        "dir or o outside [0, 360] degrees.",
        _plays_where(
            inp, ~pl.col("dir").is_between(0, 360) | ~pl.col("o").is_between(0, 360)
        ),
    )
    c.add(
        "input_negative_speed_or_acceleration",
        "error",
        "s or a below zero.",
        _plays_where(inp, (pl.col("s") < 0) | (pl.col("a") < 0)),
    )

    null_rates = {
        k: round(inp[k].null_count() / max(inp.height, 1), 6)
        for k in ("s", "a", "dir", "o")
    }
    c.add(
        "input_kinematic_null_rate",
        "info",
        "Share of input rows with null s, a, dir, o.",
        unit="rows",
        count=int(
            inp.select(pl.any_horizontal(pl.col(["s", "a", "dir", "o"]).is_null()))
            .sum()
            .item()
        ),
        details={f"{k}_null_rate": v for k, v in null_rates.items()},
    )

    outside = inp.filter(
        ~pl.col("x").is_between(0, FIELD_LENGTH_YD)
        | ~pl.col("y").is_between(0, FIELD_WIDTH_YD)
    )
    c.add(
        "input_positions_outside_field",
        "warning",
        "Observed rows with x outside [0, 120] or y outside [0, 53.33]. Kept: "
        "players can be out of bounds.",
        unit="rows",
        count=outside.height,
    )

    constants = [
        "play_direction",
        "absolute_yardline_number",
        "num_frames_output",
        "ball_land_x",
        "ball_land_y",
    ]
    per_play_const = inp.group_by(KEY).agg(
        [pl.col(k).n_unique().alias(k) for k in constants]
    )
    c.add(
        "input_inconsistent_play_constants",
        "error",
        f"Plays where a per-play value ({', '.join(constants)}) varies across rows.",
        per_play_const.filter(pl.any_horizontal([pl.col(k) > 1 for k in constants])),
    )

    identity = [
        "player_name",
        "player_position",
        "player_side",
        "player_role",
        "player_to_predict",
    ]
    per_player = inp.group_by([*KEY, "nfl_id"]).agg(
        *[pl.col(k).n_unique().alias(k) for k in identity],
        pl.col("frame_id").n_unique().alias("frames"),
    )
    c.add(
        "input_unstable_player_identity",
        "error",
        "Plays where a player's name, position, side, role, or prediction flag "
        "changes between frames.",
        per_player.filter(pl.any_horizontal([pl.col(k) > 1 for k in identity])),
    )

    plays = inp.group_by(KEY).agg(
        pl.col("source_week").first(),
        pl.col("play_direction").first(),
        pl.col("absolute_yardline_number").first(),
        pl.col("num_frames_output").first().alias("future_frame_count"),
        pl.col("ball_land_x").first(),
        pl.col("ball_land_y").first(),
        pl.col("frame_id").min().alias("first_frame_id"),
        pl.col("frame_id").max().alias("last_frame_id"),
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
        .filter(pl.col("player_role") == "Passer")
        .n_unique()
        .alias("passer_count"),
        pl.col("nfl_id")
        .filter(pl.col("player_to_predict"))
        .n_unique()
        .alias("predicted_player_count"),
        (
            pl.col("x").is_between(0, FIELD_LENGTH_YD)
            & pl.col("y").is_between(0, FIELD_WIDTH_YD)
        )
        .all()
        .alias("observed_in_field"),
    )
    c.add(
        "input_non_contiguous_frames",
        "error",
        "Plays whose frame_id values are not a gap-free run.",
        plays.filter(
            pl.col("last_frame_id") - pl.col("first_frame_id") + 1
            != pl.col("observed_frame_count")
        ),
    )
    incomplete = per_player.join(
        plays.select([*KEY, "observed_frame_count"]), on=KEY
    ).filter(pl.col("frames") != pl.col("observed_frame_count"))
    c.add(
        "input_incomplete_player_frames",
        "error",
        "Plays where some player is missing from some observed frames.",
        incomplete,
    )

    c.add(
        "input_passer_count",
        "warning",
        "Plays without exactly one Passer. Kept; excluded from the development subset.",
        plays.filter(pl.col("passer_count") != 1),
    )
    c.add(
        "input_missing_side",
        "warning",
        "Plays with no offensive or no defensive player. Kept; excluded from the "
        "development subset.",
        plays.filter(
            (pl.col("offense_player_count") == 0)
            | (pl.col("defense_player_count") == 0)
        ),
    )
    ball_out = plays.filter(
        ~pl.col("ball_land_x").is_between(0, FIELD_LENGTH_YD)
        | ~pl.col("ball_land_y").is_between(0, FIELD_WIDTH_YD)
    )
    c.add(
        "ball_landing_outside_field",
        "info",
        "Plays whose ball_land_x/y lies outside the field rectangle (for example "
        "passes thrown out of bounds).",
        ball_out,
        count=ball_out.height,
    )

    # Supplementary join
    sup_dups = sup.filter(pl.struct(KEY).is_duplicated())
    c.add(
        "supplementary_duplicate_keys",
        "error",
        "Supplementary rows sharing a (game_id, play_id); the join would be ambiguous.",
        sup_dups,
    )
    sup_keys = sup.select(KEY).unique()
    c.add(
        "supplementary_missing_for_tracking",
        "error",
        "Tracked plays with no supplementary row.",
        plays.join(sup_keys, on=KEY, how="anti"),
    )
    sup_only = sup_keys.join(plays.select(KEY), on=KEY, how="anti")
    c.add(
        "supplementary_without_tracking",
        "info",
        "Supplementary rows with no tracking in the train files; not used.",
        count=sup_only.height,
        details={
            "seasons": ",".join(
                str(s)
                for s in sup.join(sup_only, on=KEY)["season"].unique().sort().to_list()
            )
        },
    )
    sup_nulls = {
        k: int(v)
        for k, v in sup.join(plays.select(KEY), on=KEY)
        .null_count()
        .row(0, named=True)
        .items()
        if v
    }
    c.add(
        "supplementary_optional_nulls",
        "info",
        "Null counts per supplementary column for tracked plays. Nulls are kept as "
        "null, never filled.",
        unit="rows",
        count=sum(sup_nulls.values()),
        details=dict(sup_nulls),
    )

    los = sup.select(
        *KEY,
        pl.when(pl.col("yardline_side").is_null())
        .then(60)
        .when(pl.col("yardline_side") == pl.col("possession_team"))
        .then(10 + pl.col("yardline_number"))
        .otherwise(110 - pl.col("yardline_number"))
        .alias("los_from_metadata"),
    )
    los_check = plays.join(los, on=KEY).with_columns(
        canonical_x_expr("absolute_yardline_number").alias("los_from_tracking")
    )
    c.add(
        "line_of_scrimmage_consistency",
        "warning",
        "Plays where absolute_yardline_number (rotated to the canonical frame) "
        "disagrees with the "
        "line of scrimmage implied by yardline_side / yardline_number / "
        "possession_team.",
        los_check.filter(pl.col("los_from_tracking") != pl.col("los_from_metadata")),
    )

    # Output (future ground truth)
    c.add(
        "output_duplicate_frame_rows",
        "error",
        "Plays with duplicate (nfl_id, frame_id) rows in the output files.",
        out.filter(pl.struct([*KEY, "nfl_id", "frame_id"]).is_duplicated()),
    )
    c.add(
        "output_non_finite_positions",
        "error",
        "Output rows with null, NaN, or infinite x/y.",
        _plays_where(
            out,
            pl.any_horizontal(
                [
                    pl.col(k).is_null() | pl.col(k).is_nan() | pl.col(k).is_infinite()
                    for k in ("x", "y")
                ]
            ),
        ),
    )
    out_outside = out.filter(
        ~pl.col("x").is_between(0, FIELD_LENGTH_YD)
        | ~pl.col("y").is_between(0, FIELD_WIDTH_YD)
    )
    c.add(
        "output_positions_outside_field",
        "info",
        "Future rows with x outside [0, 120] or y outside [0, 53.33]. Kept: players "
        "can run out of bounds after the throw.",
        unit="rows",
        count=out_outside.height,
    )
    out_keys = out.select(KEY).unique()
    c.add(
        "output_missing_for_input",
        "error",
        "Input plays with no output (future) rows.",
        plays.join(out_keys, on=KEY, how="anti"),
    )
    c.add(
        "output_without_input",
        "info",
        "Output plays with no input rows; ignored.",
        count=out_keys.join(plays.select(KEY), on=KEY, how="anti").height,
    )

    out_players = out.group_by([*KEY, "nfl_id"]).agg(
        pl.col("frame_id").min().alias("fmin"),
        pl.col("frame_id").max().alias("fmax"),
        pl.col("frame_id").n_unique().alias("fn"),
    )
    frames_check = out_players.join(plays.select([*KEY, "future_frame_count"]), on=KEY)
    c.add(
        "output_frames_match_num_frames_output",
        "error",
        "Plays where a future trajectory is not exactly frames 1..num_frames_output.",
        frames_check.filter(
            (pl.col("fmin") != 1)
            | (pl.col("fmax") != pl.col("future_frame_count"))
            | (pl.col("fn") != pl.col("future_frame_count"))
        ),
    )
    predicted = (
        inp.filter(pl.col("player_to_predict")).select([*KEY, "nfl_id"]).unique()
    )
    out_ids = out.select([*KEY, "nfl_id"]).unique()
    mismatch = pl.concat(
        [
            predicted.join(out_ids, on=[*KEY, "nfl_id"], how="anti"),
            out_ids.join(predicted, on=[*KEY, "nfl_id"], how="anti"),
        ]
    )
    c.add(
        "output_players_match_player_to_predict",
        "error",
        "Plays where output players differ from input players flagged "
        "player_to_predict.",
        mismatch,
    )

    last_obs = inp.filter(
        pl.col("frame_id") == pl.col("frame_id").max().over(KEY)
    ).select([*KEY, "nfl_id", "x", "y"])
    first_fut = out.filter(pl.col("frame_id") == 1).select(
        [*KEY, "nfl_id", pl.col("x").alias("fx"), pl.col("y").alias("fy")]
    )
    gap = last_obs.join(first_fut, on=[*KEY, "nfl_id"]).with_columns(
        ((pl.col("fx") - pl.col("x")) ** 2 + (pl.col("fy") - pl.col("y")) ** 2)
        .sqrt()
        .alias("d")
    )
    c.add(
        "output_continues_observed_sequence",
        "warning",
        "Future frame 1 should follow the last observed frame by one 0.1 s step. "
        "Plays where a player's displacement across that boundary exceeds "
        f"{CONTINUITY_LIMIT_YD} yd.",
        gap.filter(pl.col("d") > CONTINUITY_LIMIT_YD),
        details={
            "median_boundary_step_yd": round(
                float(gap.select(pl.col("d").median()).item() or 0.0), 4
            ),
            "p99_boundary_step_yd": round(
                float(gap.select(pl.col("d").quantile(0.99)).item() or 0.0), 4
            ),
        },
    )

    reasons = (
        pl.concat(c.reasons)
        .group_by(KEY)
        .agg(pl.col("reason").unique().sort().alias("exclusion_reasons"))
        if c.reasons
        else pl.DataFrame(
            schema={
                "game_id": pl.Int64,
                "play_id": pl.Int64,
                "exclusion_reasons": pl.List(pl.String),
            }
        )
    )
    index = (
        plays.join(
            sup_keys.with_columns(pl.lit(True).alias("has_supplementary")),
            on=KEY,
            how="left",
        )
        .join(reasons, on=KEY, how="left")
        .with_columns(
            play_id_expr().alias("id"),
            pl.col("has_supplementary").fill_null(False),
            pl.col("exclusion_reasons").fill_null(pl.lit([], pl.List(pl.String))),
        )
        .with_columns((pl.col("exclusion_reasons").list.len() == 0).alias("valid"))
        .sort(KEY)
    )
    return ValidationResult(
        checks=c.checks, play_index=index, dropped_rows=keyless.height
    )
