"""Play resources. Mirrored by apps/web/src/lib/contracts.ts.

Metadata is grouped by when it becomes known: ``context`` (pre-snap),
``annotations`` (charted labels describing the play), ``outcome`` (post-play
results). All three are descriptive; none is a model input.
"""

from typing import Literal

from pydantic import ConfigDict, Field

from .common import ApiModel, DatasetStatus, Provenance

Side = Literal["offense", "defense"]
Direction = Literal["left", "right"]
PlayType = Literal["pass", "run", "other"]


class PlayContext(ApiModel):
    """Known before the snap."""

    offense_formation: str | None
    receiver_alignment: str | None
    defenders_in_the_box: int | None
    home_score: int | None
    visitor_score: int | None
    home_win_probability: float | None = Field(
        description="Dataset-supplied pre-snap estimate."
    )
    visitor_win_probability: float | None = Field(
        description="Dataset-supplied pre-snap estimate."
    )
    expected_points: float | None = Field(
        description="Dataset-supplied pre-play expected points."
    )


class PlayAnnotations(ApiModel):
    """Charted labels describing what happened during the play. Not pre-snap
    information."""

    coverage_family: str | None = Field(
        description="team_coverage_man_zone, e.g. ZONE_COVERAGE."
    )
    coverage_type: str | None = Field(
        description="team_coverage_type, e.g. COVER_3_ZONE."
    )
    target_route: str | None = Field(description="route_of_targeted_receiver.")
    play_action: bool | None
    dropback_type: str | None
    dropback_distance: float | None
    pass_location_type: str | None


class PlayOutcome(ApiModel):
    """Post-play results. Descriptive only; never available before the play ends."""

    pass_result: str | None = Field(
        description="Code as supplied: C complete, I incomplete, IN intercepted."
    )
    pass_length: int | None
    yards_gained: int | None
    pre_penalty_yards_gained: int | None
    penalty_yards: int | None
    nullified_by_penalty: bool | None
    expected_points_added: float | None
    home_win_probability_added: float | None
    visitor_win_probability_added: float | None


class TrackingSummary(ApiModel):
    observed_frame_count: int
    observed_duration_s: float = Field(
        description="Time from the first to the last observed frame."
    )
    first_frame_id: int
    last_frame_id: int
    player_count: int
    offense_player_count: int
    defense_player_count: int
    predicted_player_count: int = Field(
        description="Players with a held-out future trajectory."
    )
    future_frame_count: int = Field(
        description="Frames of held-out future after the observed window."
    )
    future_duration_s: float
    ball_tracked: bool = Field(
        description="False: this dataset has no frame-level ball positions."
    )


class PlaySummary(ApiModel):
    id: str = Field(
        description="PlayLens play ID '<game_id>-<play_id>'.",
        examples=["2023091008-3826"],
    )
    game_id: int
    play_id: int = Field(description="NFL play ID; unique only within its game.")
    season: int | None
    week: int | None
    game_date: str | None = Field(description="ISO date.")
    home_team: str
    away_team: str
    offense: str | None
    defense: str | None
    quarter: int | None
    game_clock: str | None
    down: int | None = Field(ge=1, le=4)
    yards_to_go: int | None
    yardline_label: str | None = Field(description="e.g. 'DET 41'; '50' at midfield.")
    play_type: PlayType | None
    description: str | None = Field(
        description="Supplied narrative; describes the result (post-play)."
    )
    context: PlayContext
    annotations: PlayAnnotations
    outcome: PlayOutcome
    tracking: TrackingSummary


class PlayerRef(ApiModel):
    player_id: str = Field(
        description="Stable within the play: the NFL ID as a string."
    )
    nfl_id: int | None
    jersey: str | None = Field(description="Not supplied by this dataset.")
    name: str | None
    side: Side
    position: str | None
    role: str | None = Field(
        description="Passer, Targeted Receiver, Other Route Runner, Defensive Coverage."
    )
    player_to_predict: bool = Field(description="Has a held-out future trajectory.")


class PlayEvent(ApiModel):
    frame_id: int
    event: str


class BallLanding(ApiModel):
    """Where the pass lands (dataset ball_land_x/y). A single point, not a ball
    track."""

    x: float
    y: float
    x_raw: float
    y_raw: float
    in_field: bool


class CoordinateInfo(ApiModel):
    system: str
    description: str
    raw_play_direction: Direction | None
    raw_transform: Literal["identity", "rotate_180"] = Field(
        description="Applied to recorded values to produce canonical ones; "
        "it is its own inverse."
    )


class PlayDetail(PlaySummary):
    players: list[PlayerRef]
    events: list[PlayEvent] = Field(
        description="Supplied event annotations; this dataset has none."
    )
    play_direction: Direction | None = Field(
        description="Recorded attack direction. Coordinates are canonical."
    )
    line_of_scrimmage_x: float | None
    first_down_x: float | None
    frame_rate_hz: float
    ball_landing: BallLanding | None
    coordinates: CoordinateInfo
    provenance: Provenance


class SimilarityScores(ApiModel):
    source_play_id: str
    model_version: str
    scores: dict[str, float]


class PlayPage(ApiModel):
    items: list[PlaySummary]
    total: int
    page: int
    page_size: int
    sort: Literal["recent", "similarity"]
    similarity: SimilarityScores | None = Field(
        description="Always null: no retrieval model is served."
    )
    dataset: DatasetStatus

    model_config = ConfigDict(
        json_schema_extra={"description": "One page of plays, newest game first."}
    )


class Facets(ApiModel):
    seasons: list[int]
    weeks: list[int]
    teams: list[str]
    formations: list[str]
    coverages: list[str]
    play_types: list[PlayType]
    quarters: list[int]
