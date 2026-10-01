"""Observed frames and held-out future ground truth, kept in separate payloads."""

from typing import Literal

from pydantic import Field

from .common import ApiModel


class BallPosition(ApiModel):
    x: float
    y: float


class FramePlayer(ApiModel):
    player_id: str
    x: float = Field(description="Canonical x, yards (rounded to 0.001).")
    y: float = Field(description="Canonical y, yards (rounded to 0.001).")
    s: float | None = Field(description="Speed, yd/s.")
    a: float | None = Field(description="Acceleration, yd/s^2.")
    dir: float | None = Field(
        description="Canonical movement direction, degrees, 0 = +y, clockwise."
    )
    o: float | None = Field(
        description="Canonical orientation, degrees, 0 = +y, clockwise."
    )


class Frame(ApiModel):
    frame_id: int
    frame_index: int = Field(description="0-based index within the observed window.")
    time_s: float = Field(description="Seconds since the first observed frame.")
    ball: BallPosition | None = Field(
        description="Null: this dataset has no frame-level ball positions."
    )
    players: list[FramePlayer]


class FramesPayload(ApiModel):
    """Observed tracking only. Never contains future (output-file) positions."""

    id: str
    dataset_version: str
    schema_version: str
    coordinate_system: str
    frame_rate_hz: float
    observed_frame_count: int
    frames: list[Frame]


class FuturePoint(ApiModel):
    frame_id: int = Field(
        description="Output-file frame number; restarts at 1 after the observed window."
    )
    frame_index: int = Field(description="Continues the observed frame_index.")
    time_s: float
    x: float
    y: float


class FutureTrajectory(ApiModel):
    player_id: str
    points: list[FuturePoint]


class FuturePayload(ApiModel):
    """Held-out actual future positions from the dataset. Not a prediction."""

    id: str
    kind: Literal["actual_future"] = "actual_future"
    description: str
    dataset_version: str
    schema_version: str
    coordinate_system: str
    frame_rate_hz: float
    origin_frame_id: int = Field(
        description="Last observed frame; the future starts one frame later."
    )
    origin_time_s: float
    horizon_frames: int
    horizon_s: float
    trajectories: list[FutureTrajectory]
