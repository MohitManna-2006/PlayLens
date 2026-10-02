from pathlib import Path

from playlens_ml.data.bdb2026.spec import DATASET_NAME
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .retrieval.db import DEFAULT_DATABASE_URL

# The Phase 3 model whose exported play embeddings power retrieval.
DEFAULT_EMBEDDING_MODEL = "trajectory-gnn-transformer-v1"
# Measured on the full corpus: see docs/evaluation/retrieval-v1.md.
DEFAULT_EF_SEARCH = 40


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
    model_dir: Path | None = Field(
        default=None,
        description=(
            "Directory of trained model artifacts; defaults to <repo>/artifacts/models."
        ),
    )
    model_device: str = Field(
        default="cpu", description="Inference device: cpu, mps, or cuda."
    )
    tracking_cache_size: int = Field(
        default=128, ge=1, description="Plays whose frames stay cached in memory."
    )
    database_url: str | None = Field(
        default=DEFAULT_DATABASE_URL,
        description=(
            "PostgreSQL + pgvector for similarity retrieval (docker compose service "
            "'postgres'). Empty disables retrieval; replay and forecasts still work."
        ),
    )
    embedding_model_version: str = Field(
        default=DEFAULT_EMBEDDING_MODEL,
        description="Embedding set searched when a request names no model version.",
    )
    hnsw_ef_search: int = Field(
        default=DEFAULT_EF_SEARCH,
        ge=1,
        le=1000,
        description=(
            "HNSW candidate list size for approximate search (raised to k when "
            "k is larger). Chosen from docs/evaluation/retrieval-v1.md."
        ),
    )
    db_pool_max_size: int = Field(
        default=4, ge=1, le=32, description="Pooled connections (read-only)."
    )
    db_timeout_s: float = Field(
        default=2.0,
        gt=0,
        description="Wait for a pooled connection, and statement timeout.",
    )

    @field_validator("data_root", "model_dir", "database_url", mode="before")
    @classmethod
    def _blank_is_default(cls, v: object) -> object:
        return None if v in ("", None) else v
