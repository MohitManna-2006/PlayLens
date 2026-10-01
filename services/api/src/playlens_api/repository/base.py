"""Storage-neutral play repository interface.

Handlers and services depend on this protocol only. The Phase 2 implementation
reads processed Parquet; a PostgreSQL implementation can replace it without
touching routes or response schemas.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, TypedDict

DistanceBand = Literal["short", "medium", "long"]
OutcomeBand = Literal["gain", "no_gain", "loss", "unknown"]


@dataclass(frozen=True)
class DatasetInfo:
    dataset: str
    title: str
    source: str
    subset: str
    dataset_version: str
    schema_version: str
    coordinate_system: str
    coordinate_description: str
    frame_rate_hz: float
    play_count: int
    license_note: str
    generated_at: str


@dataclass(frozen=True)
class PlayRecord:
    """One play's canonical rows, grouped by availability."""

    id: str
    game_id: int
    play_id: int
    play: Mapping[str, Any]
    """Row of observed/plays.parquet."""
    annotations: Mapping[str, Any]
    outcome: Mapping[str, Any]
    players: Sequence[Mapping[str, Any]]
    """Rows of observed/players.parquet in roster order."""


@dataclass(frozen=True)
class PlayFilter:
    q: str | None = None
    season: int | None = None
    week: int | None = None
    offense: str | None = None
    defense: str | None = None
    formation: str | None = None
    coverage: str | None = None
    down: int | None = None
    distance: DistanceBand | None = None
    quarter: int | None = None
    play_type: str | None = None
    outcome: OutcomeBand | None = None


@dataclass(frozen=True)
class PlayQueryResult:
    records: list[PlayRecord]
    total: int


@dataclass(frozen=True)
class Facets:
    seasons: list[int] = field(default_factory=list)
    weeks: list[int] = field(default_factory=list)
    teams: list[str] = field(default_factory=list)
    formations: list[str] = field(default_factory=list)
    coverages: list[str] = field(default_factory=list)
    quarters: list[int] = field(default_factory=list)


class TrackingRow(TypedDict):
    nfl_id: int
    frame_id: int
    frame_index: int
    time_s: float
    x: float
    y: float
    s: float | None
    a: float | None
    dir: float | None
    o: float | None


class FutureRow(TypedDict):
    nfl_id: int
    frame_id: int
    frame_index: int
    time_s: float
    x: float
    y: float


class PlayRepository(Protocol):
    def info(self) -> DatasetInfo: ...

    def query_plays(self, flt: PlayFilter, offset: int, limit: int) -> PlayQueryResult:
        """Filtered plays, newest game first, then play order within a game."""
        ...

    def facets(self) -> Facets: ...

    def get_play(self, game_id: int, play_id: int) -> PlayRecord | None: ...

    def observed_tracking(self, game_id: int, play_id: int) -> list[TrackingRow]:
        """Observed rows ordered by frame_id then nfl_id. Never includes future rows."""
        ...

    def future_trajectories(self, game_id: int, play_id: int) -> list[FutureRow]:
        """Held-out future rows ordered by nfl_id then frame_id."""
        ...
