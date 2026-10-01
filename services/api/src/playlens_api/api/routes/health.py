from fastapi import APIRouter, Request

from ... import __version__
from ...schemas.health import Health, HealthDataset
from ...services.plays import PlayService

router = APIRouter(tags=["health"])


@router.get("/health", response_model=Health, summary="Liveness and dataset readiness")
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
    return Health(
        status="ok" if dataset.loaded else "degraded",
        service="playlens-api",
        version=__version__,
        dataset=dataset,
    )
