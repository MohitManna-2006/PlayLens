from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ...schemas.common import ErrorEnvelope
from ...schemas.models import (
    EvaluationReport,
    ModelInfo,
    TrajectoryPrediction,
    TrajectoryRequest,
)
from ...services.models import ModelRegistry, PredictionService, evaluation_report
from ..deps import get_model_registry, get_prediction_service

router = APIRouter(tags=["models"])
Registry = Annotated[ModelRegistry, Depends(get_model_registry)]
Predictions = Annotated[PredictionService, Depends(get_prediction_service)]

ERRORS: dict[int | str, dict[str, object]] = {
    404: {"model": ErrorEnvelope, "description": "Unknown play or model version."},
    422: {
        "model": ErrorEnvelope,
        "description": "Malformed request, or the play cannot be forecast.",
    },
    503: {
        "model": ErrorEnvelope,
        "description": "No model or no processed dataset is loaded.",
    },
}


@router.get("/models", response_model=list[ModelInfo], summary="Served models")
def list_models(registry: Registry) -> list[ModelInfo]:
    """Models loaded from trained artifacts, with dataset/split versions and metrics.

    Empty when no artifact exists; the web app then keeps forecasts unavailable.
    """
    return registry.infos()


@router.post(
    "/predict/trajectory",
    response_model=TrajectoryPrediction,
    summary="Forecast target players' future paths from the last observed frame",
    responses=ERRORS,
)
def predict_trajectory(
    req: TrajectoryRequest, service: Predictions
) -> TrajectoryPrediction:
    """Real model inference. The response names the model and dataset versions, the
    split the play belonged to during training, and the server-side latency."""
    return service.predict(req)


@router.get(
    "/evaluation/summary",
    response_model=EvaluationReport,
    summary="Recorded evaluation of a served model",
    responses={404: ERRORS[404], 503: ERRORS[503]},
)
def evaluation_summary(
    registry: Registry, model_version: Annotated[str | None, Query()] = None
) -> EvaluationReport:
    return evaluation_report(registry.get(model_version))
