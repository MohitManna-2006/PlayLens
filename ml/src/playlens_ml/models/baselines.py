"""Constant-velocity trajectory baseline (Masterbrain §18).

Each player keeps the velocity it had at the last observed frame:

    p(k) = p_last + v * k * dt,  k = 1..H,  dt = 0.1 s

Velocity sources:
    supplied            v = s * (sin dir, cos dir) at the last observed frame
                        (the dataset's tracked speed and direction; primary)
    finite_difference   v = (p_last - p_prev) / dt from the last two observed frames

Neither variant is tuned on any split.
"""

from __future__ import annotations

from typing import Literal

import numpy as np

from ..features.spec import FRAME_RATE_HZ

VelocitySource = Literal["supplied", "finite_difference"]
DT = 1.0 / FRAME_RATE_HZ


def finite_difference_velocity(xy: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """[n, T, 2] right-aligned positions -> [n, 2]; zero when fewer than two frames."""
    both = mask[:, -1] & mask[:, -2]
    v = (xy[:, -1] - xy[:, -2]) / DT
    return np.where(both[:, None], v, 0.0).astype(np.float32)


def constant_velocity(
    last_xy: np.ndarray, velocity: np.ndarray, horizon: int
) -> np.ndarray:
    """[n, 2], [n, 2] -> [n, horizon, 2] canonical positions."""
    steps = (np.arange(1, horizon + 1, dtype=np.float32) * DT)[None, :, None]
    out: np.ndarray = (last_xy[:, None, :] + velocity[:, None, :] * steps).astype(
        np.float32
    )
    return out


def predict_constant_velocity(
    xy: np.ndarray,
    vel: np.ndarray,
    mask: np.ndarray,
    horizon: int,
    source: VelocitySource = "supplied",
) -> np.ndarray:
    velocity = (
        vel[:, -1] if source == "supplied" else finite_difference_velocity(xy, mask)
    )
    return constant_velocity(xy[:, -1], velocity, horizon)
