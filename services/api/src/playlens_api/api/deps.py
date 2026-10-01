from fastapi import Request

from ..errors import DatasetUnavailable
from ..services.models import ModelRegistry, PredictionService
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


def get_model_registry(request: Request) -> ModelRegistry:
    registry: ModelRegistry = request.app.state.model_registry
    return registry


def get_prediction_service(request: Request) -> PredictionService:
    return PredictionService(get_model_registry(request), get_play_service(request))
