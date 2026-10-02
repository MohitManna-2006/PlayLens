from typing import Annotated

from fastapi import APIRouter, Depends, Request

from ...schemas.common import ErrorEnvelope
from ...schemas.retrieval import (
    CompareRequest,
    CompareResponse,
    SimilarityRequest,
    SimilaritySearchResponse,
)
from ...services.retrieval import RetrievalService
from ..deps import get_retrieval_service

router = APIRouter(tags=["retrieval"])
Retrieval = Annotated[RetrievalService, Depends(get_retrieval_service)]

ERRORS: dict[int | str, dict[str, object]] = {
    404: {
        "model": ErrorEnvelope,
        "description": "play_not_found, embedding_unavailable (the play has no stored "
        "embedding), or model_version_unavailable.",
    },
    422: {
        "model": ErrorEnvelope,
        "description": "invalid_play_id, invalid_k, invalid_filters, "
        "invalid_comparison, or another malformed request.",
    },
    503: {
        "model": ErrorEnvelope,
        "description": "database_unavailable or retrieval_unavailable (not migrated, "
        "not loaded, or built for another dataset); dataset_unavailable.",
    },
}


def _request_id(request: Request) -> str:
    value = getattr(request.state, "request_id", None)
    return value if isinstance(value, str) else "unknown"


@router.post(
    "/search/similar",
    response_model=SimilaritySearchResponse,
    summary="Nearest plays by cosine similarity of learned play embeddings",
    responses=ERRORS,
)
def search_similar(
    req: SimilarityRequest, request: Request, service: Retrieval
) -> SimilaritySearchResponse:
    """Real nearest-neighbour retrieval in PostgreSQL + pgvector over the frozen
    Phase 3 embeddings. The query play is never returned. Filters run inside the
    database query. Each result carries deterministic metadata and tracking
    evidence; cosine similarity is not a probability."""
    return service.search(req, _request_id(request))


@router.post(
    "/compare",
    response_model=CompareResponse,
    summary="Deterministic comparison of two plays",
    responses=ERRORS,
)
def compare(
    req: CompareRequest, request: Request, service: Retrieval
) -> CompareResponse:
    """Play identities, embedding similarity with exact ranks (when retrieval is
    available), metadata and structural evidence, and a role-based player
    correspondence. Frames come from /plays/{id}/frames."""
    return service.compare(req, _request_id(request))
