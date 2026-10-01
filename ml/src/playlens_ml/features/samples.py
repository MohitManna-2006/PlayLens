"""Per-play model samples built from canonical tables.

One implementation serves training and inference so features cannot drift.
Players are stored ragged (play ``offsets``); every array is indexed by a global
player row. Observed frames are right-aligned in a fixed window of ``window``
frames ending at the last observed frame (the prediction origin); shorter plays
are front-padded and masked. Targets cover future steps 1..``horizon`` after the
origin and are masked beyond each play's supplied horizon.
"""

from __future__ import annotations

from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

from ..data import canonical_schema as cs
from .spec import FRAME_RATE_HZ, NUMERIC_FEATURES, SOURCE_COLUMNS, TARGET_COLUMNS

KEY = ["game_id", "play_id"]
F = len(NUMERIC_FEATURES)


@dataclass
class SampleSet:
    # play level
    ids: np.ndarray  # str
    game_id: np.ndarray  # int64
    play_id: np.ndarray  # int64
    week: np.ndarray  # int64
    offsets: np.ndarray  # int64, n_plays + 1
    origin_frame_id: np.ndarray  # last observed frame_id per play
    target_horizon: np.ndarray  # supplied future frames per play (0 when unknown)
    # player level
    nfl_id: np.ndarray  # int64
    side: np.ndarray  # str
    position: np.ndarray  # str
    role: np.ndarray  # str
    to_predict: np.ndarray  # bool
    numeric: np.ndarray  # float32 [n, window, F]
    xy: np.ndarray  # float32 [n, window, 2] canonical positions
    vel: np.ndarray  # float32 [n, window, 2] from s and dir
    mask: np.ndarray  # bool [n, window]
    target: np.ndarray  # float32 [n, horizon, 2] canonical future positions
    target_mask: np.ndarray  # bool [n, horizon]

    @property
    def n_plays(self) -> int:
        return int(len(self.ids))

    @property
    def window(self) -> int:
        return int(self.mask.shape[1])

    @property
    def horizon(self) -> int:
        return int(self.target_mask.shape[1])

    def play_slice(self, i: int) -> slice:
        return slice(int(self.offsets[i]), int(self.offsets[i + 1]))

    def select(self, play_indices: np.ndarray) -> SampleSet:
        """Subset by play index, preserving order."""
        play_indices = np.asarray(play_indices, dtype=np.int64)
        rows = (
            np.concatenate(
                [np.arange(self.offsets[i], self.offsets[i + 1]) for i in play_indices]
            )
            if len(play_indices)
            else np.zeros(0, dtype=np.int64)
        )
        counts = self.offsets[play_indices + 1] - self.offsets[play_indices]
        offsets = np.concatenate([[0], np.cumsum(counts)]).astype(np.int64)
        values: dict[str, Any] = {}
        for f in fields(self):
            arr = getattr(self, f.name)
            if f.name == "offsets":
                values[f.name] = offsets
            elif f.name in _PLAY_FIELDS:
                values[f.name] = arr[play_indices]
            else:
                values[f.name] = arr[rows]
        return SampleSet(**values)

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez(path, **{f.name: getattr(self, f.name) for f in fields(self)})

    @classmethod
    def load(cls, path: Path) -> SampleSet:
        with np.load(path, allow_pickle=False) as z:
            return cls(**{f.name: z[f.name] for f in fields(cls)})


_PLAY_FIELDS = {
    "ids",
    "game_id",
    "play_id",
    "week",
    "origin_frame_id",
    "target_horizon",
}


def _angle_terms(deg: pl.Expr, name: str) -> list[pl.Expr]:
    rad = deg.radians()
    return [rad.sin().alias(f"sin_{name}"), rad.cos().alias(f"cos_{name}")]


def build_samples(
    plays: pl.DataFrame,
    players: pl.DataFrame,
    tracking: pl.DataFrame,
    future: pl.DataFrame | None,
    window: int,
    horizon: int,
    target_horizon: pl.DataFrame | None = None,
) -> SampleSet:
    """Build samples for every play in ``plays``.

    ``future`` (output-file rows) and ``target_horizon`` (game_id, play_id,
    future_frame_count) are optional: inference passes neither. Only
    ``spec.SOURCE_COLUMNS`` are read for inputs.
    """
    plays = plays.select(SOURCE_COLUMNS[cs.PLAYS.name]).sort(KEY)
    players = players.select(SOURCE_COLUMNS[cs.PLAYERS.name]).join(
        plays.select(KEY), on=KEY, how="semi"
    )
    players = players.sort([*KEY, "roster_order"]).with_row_index("row")
    tracking = tracking.select(SOURCE_COLUMNS[cs.OBSERVED_TRACKING.name]).join(
        plays.select(KEY), on=KEY, how="semi"
    )

    last = tracking.group_by(KEY).agg(
        pl.col("frame_index").max().alias("last_index"),
        pl.col("frame_id").max().alias("origin_frame_id"),
    )
    frames = (
        tracking.sort([*KEY, "nfl_id", "frame_index"])
        .with_columns(
            pl.col("x").diff().over([*KEY, "nfl_id"]).fill_null(0.0).alias("dx_prev"),
            pl.col("y").diff().over([*KEY, "nfl_id"]).fill_null(0.0).alias("dy_prev"),
        )
        .join(last, on=KEY)
        .join(plays.select(*KEY, "line_of_scrimmage_x"), on=KEY)
        .with_columns(
            (pl.col("frame_index") - pl.col("last_index") + (window - 1)).alias("slot"),
            (pl.col("x") - pl.col("line_of_scrimmage_x")).alias("x_from_los"),
            ((pl.col("frame_index") - pl.col("last_index")) / FRAME_RATE_HZ).alias(
                "t_rel"
            ),
            *_angle_terms(pl.col("dir"), "dir"),
            *_angle_terms(pl.col("o"), "o"),
            (pl.col("s") * pl.col("dir").radians().sin()).alias("vx"),
            (pl.col("s") * pl.col("dir").radians().cos()).alias("vy"),
        )
        .filter(pl.col("slot") >= 0)
        .join(players.select(*KEY, "nfl_id", "row"), on=[*KEY, "nfl_id"])
    )
    n = players.height
    numeric = np.zeros((n, window, F), dtype=np.float32)
    xy = np.zeros((n, window, 2), dtype=np.float32)
    vel = np.zeros((n, window, 2), dtype=np.float32)
    mask = np.zeros((n, window), dtype=bool)
    rows = frames["row"].to_numpy()
    slots = frames["slot"].to_numpy()
    feats = frames.select(NUMERIC_FEATURES).fill_null(0.0).to_numpy().astype(np.float32)
    numeric[rows, slots] = feats
    xy[rows, slots] = frames.select("x", "y").to_numpy().astype(np.float32)
    vel[rows, slots] = (
        frames.select("vx", "vy").fill_null(0.0).to_numpy().astype(np.float32)
    )
    mask[rows, slots] = True

    target = np.zeros((n, horizon, 2), dtype=np.float32)
    target_mask = np.zeros((n, horizon), dtype=bool)
    if future is not None:
        fut = (
            future.select(TARGET_COLUMNS[cs.FUTURE_TRAJECTORIES.name])
            .filter(pl.col("frame_id") <= horizon)
            .join(
                players.filter(pl.col("player_to_predict")).select(
                    *KEY, "nfl_id", "row"
                ),
                on=[*KEY, "nfl_id"],
            )
        )
        frows = fut["row"].to_numpy()
        steps = fut["frame_id"].to_numpy() - 1
        target[frows, steps] = fut.select("x", "y").to_numpy().astype(np.float32)
        target_mask[frows, steps] = True

    counts = (
        players.group_by(KEY, maintain_order=True)
        .len()
        .join(plays.select(KEY), on=KEY, how="right", maintain_order="right")
    )
    offsets = np.concatenate(
        [[0], np.cumsum(counts["len"].fill_null(0).to_numpy())]
    ).astype(np.int64)
    meta = plays.join(last, on=KEY, how="left").sort(KEY)
    horizons = (
        meta.join(
            target_horizon.select(*KEY, "future_frame_count"),
            on=KEY,
            how="left",
            maintain_order="left",
        )["future_frame_count"]
        .fill_null(0)
        .to_numpy()
        if target_horizon is not None
        else np.zeros(meta.height, dtype=np.int64)
    )
    return SampleSet(
        ids=meta["id"].to_numpy().astype(str),
        game_id=meta["game_id"].to_numpy().astype(np.int64),
        play_id=meta["play_id"].to_numpy().astype(np.int64),
        week=meta["week"].fill_null(0).to_numpy().astype(np.int64),
        offsets=offsets,
        origin_frame_id=meta["origin_frame_id"]
        .fill_null(-1)
        .to_numpy()
        .astype(np.int64),
        target_horizon=np.asarray(horizons, dtype=np.int64),
        nfl_id=players["nfl_id"].to_numpy().astype(np.int64),
        side=players["side"].fill_null("").to_numpy().astype(str),
        position=players["player_position"].fill_null("").to_numpy().astype(str),
        role=players["player_role"].fill_null("").to_numpy().astype(str),
        to_predict=players["player_to_predict"]
        .fill_null(False)
        .to_numpy()
        .astype(bool),
        numeric=numeric,
        xy=xy,
        vel=vel,
        mask=mask,
        target=target,
        target_mask=target_mask,
    )


def last_observed(samples: SampleSet) -> tuple[np.ndarray, np.ndarray]:
    """Position and supplied velocity at the last observed frame, per player row."""
    return samples.xy[:, -1, :], samples.vel[:, -1, :]
