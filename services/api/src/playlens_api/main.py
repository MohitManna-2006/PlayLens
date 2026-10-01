"""PlayLens API application factory.

    uvicorn playlens_api.main:app --reload --port 8000

The processed dataset loads at startup. If it is missing or stale the API still
starts: /health reports ``degraded`` with the reason and data routes return 503
with instructions, rather than serving anything else.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from playlens_ml.data.artifacts import (
    ProcessedDatasetError,
    ProcessedLayout,
    load_processed,
)
from playlens_ml.data.paths import DataPathError, data_layout
from playlens_ml.inference.artifact import default_models_dir

from . import __version__
from .api.routes import health, models, plays
from .config import Settings
from .errors import install_error_handlers
from .observability import configure_logging, install_request_logging
from .repository.base import PlayRepository
from .repository.parquet import ParquetPlayRepository
from .services.models import ModelRegistry
from .services.plays import PlayService

log = logging.getLogger("playlens.api")

API_PREFIX = "/api/v1"
DESCRIPTION = """
Real NFL tracking data (NFL Big Data Bowl 2026 Analytics) in the PlayLens canonical
coordinate frame. Observed frames, held-out future trajectories, and post-play
metadata are separate resources. Trajectory forecasts come from a trained
model artifact (artifacts/models/); without one, model routes answer 503.
"""


def load_repository(settings: Settings) -> PlayRepository:
    layout = data_layout(root=settings.data_root)
    processed = ProcessedLayout.for_subset(
        layout.processed, settings.dataset, settings.subset
    )
    return ParquetPlayRepository(
        load_processed(processed), settings.tracking_cache_size
    )


def create_app(
    settings: Settings | None = None,
    repository: PlayRepository | None = None,
    registry: ModelRegistry | None = None,
) -> FastAPI:
    settings = settings or Settings()
    configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.play_service = None
        app.state.dataset_error = None
        app.state.model_registry = registry or ModelRegistry.load(
            settings.model_dir or default_models_dir(), settings.model_device
        )
        log.info(
            "startup.models",
            extra={
                "models": [m.version for m in app.state.model_registry.models],
                "errors": app.state.model_registry.errors,
            },
        )
        try:
            repo = repository or load_repository(settings)
            app.state.play_service = PlayService(repo)
            info = repo.info()
            log.info(
                "startup.dataset_loaded",
                extra={
                    "dataset_version": info.dataset_version,
                    "subset": info.subset,
                    "plays": info.play_count,
                    "schema_version": info.schema_version,
                },
            )
        except (ProcessedDatasetError, DataPathError) as err:
            app.state.dataset_error = str(err)
            log.error("startup.dataset_unavailable", extra={"reason": str(err)})
        yield

    app = FastAPI(
        title="PlayLens API",
        version=__version__,
        description=DESCRIPTION,
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=settings.cors_origin_regex,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID", "Server-Timing"],
    )
    install_request_logging(app)
    install_error_handlers(app)
    app.include_router(health.router)
    app.include_router(plays.router, prefix=API_PREFIX)
    app.include_router(models.router, prefix=API_PREFIX)
    return app


app = create_app()
