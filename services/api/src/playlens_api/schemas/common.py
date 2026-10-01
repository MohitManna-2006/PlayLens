from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    """Base for every response model: unknown fields are a bug, not data."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class ErrorBody(ApiModel):
    code: str = Field(description="Stable machine-readable error code.")
    message: str = Field(
        description="What went wrong and, where possible, how to fix it."
    )
    status: int
    request_id: str | None = None
    details: dict[str, Any] | None = None


class ErrorEnvelope(ApiModel):
    """Every non-2xx response has this shape."""

    error: ErrorBody

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "error": {
                    "code": "play_not_found",
                    "message": "Play 2023090700-999 is not in dataset "
                    "nfl_bdb_2026_analytics@dev-46b081804b38.",
                    "status": 404,
                    "request_id": "5f2c9a1be0d4",
                    "details": None,
                }
            }
        }
    )


class DatasetStatus(ApiModel):
    dataset: str | None
    title: str | None
    source: str | None
    subset: str | None
    dataset_version: str | None
    schema_version: str | None
    play_count: int
    synthetic: bool
    license_note: str | None
    generated_at: str | None


class Provenance(ApiModel):
    source: str
    dataset: str
    dataset_version: str
    schema_version: str
    coordinate_convention: str
    synthetic: bool
    subset: str | None
