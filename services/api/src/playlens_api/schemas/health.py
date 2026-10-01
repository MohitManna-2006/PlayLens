"""Health and readiness."""

from typing import Literal

from .common import ApiModel


class HealthDataset(ApiModel):
    loaded: bool
    dataset_version: str | None
    subset: str | None
    play_count: int | None
    error: str | None


class Health(ApiModel):
    status: Literal["ok", "degraded"]
    service: str
    version: str
    dataset: HealthDataset
