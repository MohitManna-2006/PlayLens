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


class HealthRetrieval(ApiModel):
    """Similarity retrieval (PostgreSQL + pgvector). Read from a cached status
    check, not a table scan."""

    status: Literal["ready", "unavailable", "disabled"]
    reason: str | None
    database_reachable: bool | None
    backend: Literal["pgvector", "memory"] | None
    server_version: str | None
    pgvector_version: str | None
    schema_version: str | None
    pending_migrations: list[str]
    model_version: str = Field(description="Embedding set searched by default.")
    embedding_count: int | None
    dataset_version: str | None
    split_version: str | None
    hnsw_index: str | None


class Health(ApiModel):
    status: Literal["ok", "degraded"] = Field(
        description="degraded when the dataset is not loaded or retrieval is "
        "configured but not ready."
    )
    service: str
    version: str
    dataset: HealthDataset
    models: HealthModels
    retrieval: HealthRetrieval
