from fastapi import APIRouter

from ...schemas.models import ModelInfo

router = APIRouter(tags=["models"])


@router.get("/models", response_model=list[ModelInfo], summary="Served models")
def list_models() -> list[ModelInfo]:
    """No model is trained or served yet, so the registry is empty.

    The web app reads this list to decide which model features to offer; an empty
    list keeps forecasts, similarity, and PlayLab visibly unavailable.
    """
    return []
