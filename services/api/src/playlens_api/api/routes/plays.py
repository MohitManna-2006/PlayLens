from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query

from ...repository.base import PlayFilter
from ...schemas.common import DatasetStatus, ErrorEnvelope
from ...schemas.plays import Facets, PlayDetail, PlayPage, PlayType
from ...schemas.tracking import FramesPayload, FuturePayload
from ...services.plays import PlayService
from ..deps import get_play_service

router = APIRouter(tags=["plays"])
Service = Annotated[PlayService, Depends(get_play_service)]
PlayIdPath = Annotated[
    str,
    Path(
        description="PlayLens play ID '<game_id>-<play_id>'.",
        examples=["2023091008-3826"],
    ),
]

ERRORS: dict[int | str, dict[str, object]] = {
    404: {"model": ErrorEnvelope, "description": "Unknown play."},
    422: {"model": ErrorEnvelope, "description": "Malformed play ID or query."},
    503: {"model": ErrorEnvelope, "description": "Processed dataset not loaded."},
}


@router.get(
    "/dataset",
    response_model=DatasetStatus,
    summary="Dataset served by this API",
    responses={503: ERRORS[503]},
)
def dataset(service: Service) -> DatasetStatus:
    return service.dataset_status()


@router.get(
    "/plays",
    response_model=PlayPage,
    summary="Browse plays",
    responses={422: ERRORS[422], 503: ERRORS[503]},
)
def list_plays(
    service: Service,
    q: Annotated[
        str | None,
        Query(
            description="Case-insensitive search over ID, teams, description, "
            "formation, coverage, and route."
        ),
    ] = None,
    season: int | None = None,
    week: Annotated[int | None, Query(ge=1, le=22)] = None,
    offense: str | None = None,
    defense: str | None = None,
    formation: Annotated[
        str | None, Query(description="offense_formation, e.g. SHOTGUN.")
    ] = None,
    coverage: Annotated[
        str | None, Query(description="team_coverage_type, e.g. COVER_3_ZONE.")
    ] = None,
    down: Annotated[int | None, Query(ge=1, le=4)] = None,
    distance: Annotated[
        Literal["short", "medium", "long"] | None,
        Query(description="1-3, 4-7, 8+ yards to go."),
    ] = None,
    quarter: Annotated[int | None, Query(ge=1, le=5)] = None,
    play_type: PlayType | None = None,
    outcome: Annotated[
        Literal["gain", "no_gain", "loss", "unknown"] | None,
        Query(description="By yards_gained."),
    ] = None,
    sort: Literal["recent", "similarity"] = "recent",
    similar_to: str | None = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 50,
) -> PlayPage:
    flt = PlayFilter(
        q=q,
        season=season,
        week=week,
        offense=offense,
        defense=defense,
        formation=formation,
        coverage=coverage,
        down=down,
        distance=distance,
        quarter=quarter,
        play_type=play_type,
        outcome=outcome,
    )
    return service.list_plays(flt, page, page_size, sort, similar_to)


@router.get(
    "/plays/facets",
    response_model=Facets,
    summary="Filter values present in the dataset",
    responses={503: ERRORS[503]},
)
def facets(service: Service) -> Facets:
    return service.facets()


@router.get(
    "/plays/{play_id}",
    response_model=PlayDetail,
    summary="Play metadata and roster",
    responses=ERRORS,
)
def get_play(service: Service, play_id: PlayIdPath) -> PlayDetail:
    return service.get_play(play_id)


@router.get(
    "/plays/{play_id}/frames",
    response_model=FramesPayload,
    summary="Observed tracking frames",
    responses=ERRORS,
)
def get_frames(
    service: Service,
    play_id: PlayIdPath,
    start_frame: Annotated[
        int | None, Query(ge=1, description="First frame_id to include.")
    ] = None,
    end_frame: Annotated[
        int | None, Query(ge=1, description="Last frame_id to include.")
    ] = None,
) -> FramesPayload:
    return service.get_frames(play_id, start_frame, end_frame)


@router.get(
    "/plays/{play_id}/future",
    response_model=FuturePayload,
    summary="Held-out actual future trajectories (ground truth, not predictions)",
    responses=ERRORS,
)
def get_future(service: Service, play_id: PlayIdPath) -> FuturePayload:
    return service.get_future(play_id)
