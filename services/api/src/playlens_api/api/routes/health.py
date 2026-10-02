from fastapi import APIRouter, Request

from ... import __version__
from ...schemas.health import Health, HealthDataset, HealthModels
from ...services.models import ModelRegistry
from ...services.plays import PlayService
from ...services.retrieval import RetrievalService

router = APIRouter(tags=["health"])


@router.get(
    "/health",
    response_model=Health,
    summary="Liveness, dataset readiness, and retrieval readiness",
)
def health(request: Request) -> Health:
    service: PlayService | None = getattr(request.app.state, "play_service", None)
    if service is None:
        dataset = HealthDataset(
            loaded=False,
            dataset_version=None,
            subset=None,
            play_count=None,
            error=getattr(request.app.state, "dataset_error", None),
        )
    else:
        info = service.repo.info()
        dataset = HealthDataset(
            loaded=True,
            dataset_version=info.dataset_version,
            subset=info.subset,
            play_count=info.play_count,
            error=None,
        )
    registry: ModelRegistry | None = getattr(request.app.state, "model_registry", None)
    models = HealthModels(
        loaded=[m.version for m in registry.models] if registry else [],
        errors=dict(registry.errors) if registry else {},
    )
    retrieval_service: RetrievalService = request.app.state.retrieval
    retrieval = retrieval_service.health()
    healthy = dataset.loaded and retrieval.status != "unavailable"
    return Health(
        status="ok" if healthy else "degraded",
        service="playlens-api",
        version=__version__,
        dataset=dataset,
        models=models,
        retrieval=retrieval,
    )
