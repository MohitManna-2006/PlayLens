from fastapi import Request

from ..errors import DatasetUnavailable
from ..services.plays import PlayService


def get_play_service(request: Request) -> PlayService:
    service: PlayService | None = getattr(request.app.state, "play_service", None)
    if service is None:
        reason = (
            getattr(request.app.state, "dataset_error", None)
            or "The processed dataset is not loaded."
        )
        raise DatasetUnavailable(reason)
    return service
