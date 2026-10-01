from pathlib import Path

from playlens_ml.data.bdb2026.spec import DATASET_NAME
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """API settings, read from ``PLAYLENS_*`` environment variables."""

    model_config = SettingsConfigDict(
        env_prefix="PLAYLENS_", env_file=".env", extra="ignore"
    )

    data_root: Path | None = Field(
        default=None,
        description="Data directory; defaults to <repo>/data (same as preprocessing).",
    )
    dataset: str = DATASET_NAME
    subset: str = Field(
        default="dev", description="Processed subset to serve: dev or full."
    )
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]
    cors_origin_regex: str | None = Field(
        default=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
        description="Also allow any local port (Next.js moves off 3000 when busy).",
    )
    log_level: str = "INFO"
    tracking_cache_size: int = Field(
        default=128, ge=1, description="Plays whose frames stay cached in memory."
    )

    @field_validator("data_root", mode="before")
    @classmethod
    def _blank_is_default(cls, v: object) -> object:
        return None if v in ("", None) else v
