"""Structural descriptors: a few physically interpretable summaries of a play.

They give Similar Plays and Compare concrete, checkable evidence next to the
learned similarity. They are deterministic functions of the canonical observed
tracking (yards; offense attacks toward +x; y runs across the field; see
``data/coordinates.py``). None of them is a model input, and none says why the
learned embedding places two plays close together.

Reference frames:

* **origin**: the last observed frame of the play (``observed_last_frame_id``),
  where the dataset's input window ends and the trajectory model forecasts from.
* **window**: the last ``WINDOW_FRAMES`` observed frames up to the origin (2.0 s at
  10 Hz), the same span the served encoder reads (ADR-0004); shorter plays use all
  their observed frames.

Only tracked players count. This release tracks the passer, route runners, and
coverage defenders, not offensive linemen or pass rushers.

The same function serves one play (Compare) and every play (startup index), so
single-play and batch values cannot drift apart.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import polars as pl

DESCRIPTOR_VERSION = "structural-v1"
WINDOW_FRAMES = 20
KEY = ["game_id", "play_id"]
TARGET_ROLE = "Targeted Receiver"

FrameRef = Literal["origin", "window"]


@dataclass(frozen=True)
class DescriptorSpec:
    key: str
    label: str
    unit: str
    frame: FrameRef
    definition: str
    requires: str
    """Why the value can be missing (shown instead of a number)."""


DESCRIPTORS: tuple[DescriptorSpec, ...] = (
    DescriptorSpec(
        key="offense_width",
        label="Offensive width",
        unit="yd",
        frame="origin",
        definition=(
            "max(y) - min(y) over tracked offensive players at the last observed "
            "frame: how far apart across the field the passer and route runners are."
        ),
        requires="Needs at least two tracked offensive players.",
    ),
    DescriptorSpec(
        key="deepest_defender_depth",
        label="Deepest defender depth",
        unit="yd",
        frame="origin",
        definition=(
            "max(x) over tracked defenders minus the line of scrimmage at the last "
            "observed frame: how far downfield the deepest tracked defender is."
        ),
        requires="Needs at least one tracked defender.",
    ),
    DescriptorSpec(
        key="target_depth",
        label="Targeted receiver depth",
        unit="yd",
        frame="origin",
        definition=(
            "Targeted receiver's x minus the line of scrimmage at the last observed "
            "frame (negative = behind the line)."
        ),
        requires="Needs a tracked targeted receiver.",
    ),
    DescriptorSpec(
        key="target_separation",
        label="Targeted receiver separation",
        unit="yd",
        frame="origin",
        definition=(
            "Euclidean distance from the targeted receiver to the nearest tracked "
            "defender at the last observed frame."
        ),
        requires="Needs a tracked targeted receiver and at least one defender.",
    ),
    DescriptorSpec(
        key="mean_speed",
        label="Mean player speed",
        unit="yd/s",
        frame="window",
        definition=(
            f"Mean tracked speed over every tracked player and frame in the last "
            f"{WINDOW_FRAMES} observed frames (2.0 s at 10 Hz) up to the last "
            "observed frame."
        ),
        requires="Needs tracked speeds in the window.",
    ),
)

OUTPUT_COLUMNS = [
    *KEY,
    "origin_frame_id",
    "window_start_frame_id",
    "offense_players_at_origin",
    "defense_players_at_origin",
    *(d.key for d in DESCRIPTORS),
]


def structural_descriptors(
    plays: pl.DataFrame | pl.LazyFrame,
    players: pl.DataFrame | pl.LazyFrame,
    tracking: pl.DataFrame | pl.LazyFrame,
) -> pl.DataFrame:
    """One row per play in ``plays`` with every descriptor (null when undefined).

    ``plays``: canonical plays rows (game_id, play_id, line_of_scrimmage_x,
    observed_frame_count, observed_last_frame_id). ``players``: game_id, play_id,
    nfl_id, side, player_role. ``tracking``: canonical observed rows (game_id,
    play_id, nfl_id, frame_id, frame_index, x, y, s). Extra columns are ignored.
    """
    p = plays.lazy().select(
        *KEY,
        pl.col("line_of_scrimmage_x").cast(pl.Float64).alias("los_x"),
        pl.col("observed_frame_count").cast(pl.Int64).alias("n_frames"),
        pl.col("observed_last_frame_id").cast(pl.Int64).alias("origin_frame_id"),
    )
    roles = players.lazy().select(*KEY, "nfl_id", "side", "player_role")
    rows = (
        tracking.lazy()
        .select(*KEY, "nfl_id", "frame_id", "frame_index", "x", "y", "s")
        .join(p, on=KEY, how="inner")
        .filter(pl.col("frame_index") >= pl.col("n_frames") - WINDOW_FRAMES)
        .join(roles, on=[*KEY, "nfl_id"], how="left")
    )
    window = rows.group_by(KEY).agg(
        pl.col("frame_id").min().alias("window_start_frame_id"),
        pl.col("s").drop_nans().mean().alias("mean_speed"),
    )
    origin = rows.filter(pl.col("frame_index") == pl.col("n_frames") - 1)
    offense = origin.filter(pl.col("side") == "offense")
    defense = origin.filter(pl.col("side") == "defense")
    off = offense.group_by(KEY).agg(
        pl.len().alias("offense_players_at_origin"),
        (pl.col("y").max() - pl.col("y").min()).alias("offense_width"),
    )
    de = defense.group_by(KEY).agg(
        pl.len().alias("defense_players_at_origin"),
        (pl.col("x").max() - pl.col("los_x").first()).alias("deepest_defender_depth"),
    )
    # Exactly one targeted receiver per play in this release; the lowest nfl_id
    # wins if a future source supplies more, so the result stays deterministic.
    target = (
        origin.filter(pl.col("player_role") == TARGET_ROLE)
        .sort([*KEY, "nfl_id"])
        .group_by(KEY, maintain_order=True)
        .first()
        .select(
            *KEY,
            pl.col("x").alias("tx"),
            pl.col("y").alias("ty"),
            (pl.col("x") - pl.col("los_x")).alias("target_depth"),
        )
    )
    separation = (
        target.join(defense.select(*KEY, "x", "y"), on=KEY, how="inner")
        .group_by(KEY)
        .agg(
            ((pl.col("x") - pl.col("tx")) ** 2 + (pl.col("y") - pl.col("ty")) ** 2)
            .sqrt()
            .min()
            .alias("target_separation")
        )
    )
    out = (
        p.join(window, on=KEY, how="left")
        .join(off, on=KEY, how="left")
        .join(de, on=KEY, how="left")
        .join(target.select(*KEY, "target_depth"), on=KEY, how="left")
        .join(separation, on=KEY, how="left")
        .with_columns(
            pl.col("offense_players_at_origin").fill_null(0).cast(pl.Int64),
            pl.col("defense_players_at_origin").fill_null(0).cast(pl.Int64),
        )
        .with_columns(
            # A width needs two players; one player has width 0 by arithmetic only.
            pl.when(pl.col("offense_players_at_origin") >= 2)
            .then(pl.col("offense_width"))
            .otherwise(None)
            .alias("offense_width"),
        )
        .select(OUTPUT_COLUMNS)
        .sort(KEY)
    )
    # The streaming engine keeps the full-corpus pass (~5M tracking rows) at a
    # small memory peak; results are identical to the in-memory engine.
    return out.collect(engine="streaming")
