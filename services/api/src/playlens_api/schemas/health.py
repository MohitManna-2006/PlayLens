"""Health and readiness."""

from typing import Literal

from pydantic import Field

from .common import ApiModel


class HealthDataset(ApiModel):
    loaded: bool
    dataset_version: str | None
    subset: str | None
    play_count: int | None
    error: str | None


class HealthModels(ApiModel):
    loaded: list[str] = Field(description="Model versions loaded from artifacts.")
    errors: dict[str, str] = Field(
        description="Artifact directories that failed validation, with the reason."
    )


class Health(ApiModel):
    status: Literal["ok", "degraded"]
    service: str
    version: str
    dataset: HealthDataset
    models: HealthModels
