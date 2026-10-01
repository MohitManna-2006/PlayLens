"""Play repository over processed Parquet artifacts.

Per-play metadata (a few rows per play) is loaded and indexed at startup.
Tracking stays on disk and is read per play with predicate pushdown, then
cached, so memory stays bounded for the full dataset as well as the dev subset.
"""

from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Callable, Mapping
from functools import lru_cache
from typing import Any, cast

import polars as pl
from playlens_ml.data import canonical_schema as cs
from playlens_ml.data.artifacts import ProcessedDataset

from .base import (
    DatasetInfo,
    Facets,
    FutureRow,
    PlayFilter,
    PlayQueryResult,
    PlayRecord,
    TrackingRow,
)

log = logging.getLogger("playlens.api.repository")
KEY = ["game_id", "play_id"]
TRACKING_COLUMNS = [
    "nfl_id",
    "frame_id",
    "frame_index",
    "time_s",
    "x",
    "y",
    "s",
    "a",
    "dir",
    "o",
]
FUTURE_COLUMNS = ["nfl_id", "frame_id", "frame_index", "time_s", "x", "y"]


def _distance_band(ytg: int | None) -> str | None:
    if ytg is None:
        return None
    return "short" if ytg <= 3 else "medium" if ytg <= 7 else "long"


def _outcome_band(yards: int | None) -> str:
    if yards is None:
        return "unknown"
    return "gain" if yards > 0 else "loss" if yards < 0 else "no_gain"


def _by_key(frame: pl.DataFrame) -> dict[tuple[int, int], dict[str, Any]]:
    return {(r["game_id"], r["play_id"]): r for r in frame.iter_rows(named=True)}


class ParquetPlayRepository:
    def __init__(self, data: ProcessedDataset, tracking_cache_size: int = 128) -> None:
        self._data = data
        info = data.info
        self._info = DatasetInfo(
            dataset=info["dataset"],
            title=info["dataset_title"],
            source=info["source"],
            subset=info["subset"],
            dataset_version=info["dataset_version"],
            schema_version=info["schema_version"],
            coordinate_system=info["coordinate_system"],
            coordinate_description=info["coordinate_description"],
            frame_rate_hz=float(info["frame_rate_hz"]),
            play_count=data.plays.height,
            license_note=info["license_note"],
            generated_at=info["generated_at"],
        )
        annotations = _by_key(data.annotations)
        outcomes = _by_key(data.outcomes)
        players: dict[tuple[int, int], list[dict[str, Any]]] = {}
        for row in data.players.sort([*KEY, "roster_order"]).iter_rows(named=True):
            players.setdefault((row["game_id"], row["play_id"]), []).append(row)

        records = []
        for row in data.plays.iter_rows(named=True):
            key = (row["game_id"], row["play_id"])
            records.append(
                PlayRecord(
                    id=row["id"],
                    game_id=key[0],
                    play_id=key[1],
                    play=row,
                    annotations=annotations.get(key, {}),
                    outcome=outcomes.get(key, {}),
                    players=players.get(key, []),
                )
            )
        # Newest game first, then play order within the game.
        records.sort(
            key=lambda r: (
                -(r.play["game_date"] or dt.date.min).toordinal(),
                -r.game_id,
                r.play_id,
            )
        )
        self._records = records
        self._index = {(r.game_id, r.play_id): r for r in records}
        self._search = {r.id: self._search_text(r) for r in records}
        self.observed_tracking = cast(
            Callable[[int, int], list[TrackingRow]],
            lru_cache(tracking_cache_size)(self._load_tracking),
        )
        self.future_trajectories = cast(
            Callable[[int, int], list[FutureRow]],
            lru_cache(tracking_cache_size)(self._load_future),
        )
        log.info(
            "repository.loaded dataset_version=%s plays=%d",
            self._info.dataset_version,
            len(records),
        )

    @staticmethod
    def _search_text(r: PlayRecord) -> str:
        values = [
            r.id,
            r.play.get("home_team"),
            r.play.get("visitor_team"),
            r.play.get("possession_team"),
            r.play.get("defensive_team"),
            r.play.get("offense_formation"),
            r.outcome.get("play_description"),
            r.annotations.get("team_coverage_type"),
            r.annotations.get("route_of_targeted_receiver"),
        ]
        return " ".join(str(v) for v in values if v is not None).lower()

    def info(self) -> DatasetInfo:
        return self._info

    def _matches(self, r: PlayRecord, f: PlayFilter) -> bool:
        p: Mapping[str, Any] = r.play
        equal = [
            (f.season, p["season"]),
            (f.week, p["week"]),
            (f.offense, p["possession_team"]),
            (f.defense, p["defensive_team"]),
            (f.formation, p["offense_formation"]),
            (f.coverage, r.annotations.get("team_coverage_type")),
            (f.down, p["down"]),
            (f.quarter, p["quarter"]),
        ]
        if any(want is not None and want != have for want, have in equal):
            return False
        if f.q and f.q.strip().lower() not in self._search[r.id]:
            return False
        if f.distance and _distance_band(p["yards_to_go"]) != f.distance:
            return False
        play_type = "pass" if r.outcome.get("pass_result") else None
        if f.play_type and play_type != f.play_type:
            return False
        return not (
            f.outcome and _outcome_band(r.outcome.get("yards_gained")) != f.outcome
        )

    def query_plays(self, flt: PlayFilter, offset: int, limit: int) -> PlayQueryResult:
        matched = [r for r in self._records if self._matches(r, flt)]
        return PlayQueryResult(
            records=matched[offset : offset + limit], total=len(matched)
        )

    def facets(self) -> Facets:
        def distinct(values: list[Any]) -> list[Any]:
            return sorted({v for v in values if v is not None})

        plays = [r.play for r in self._records]
        return Facets(
            seasons=sorted(distinct([p["season"] for p in plays]), reverse=True),
            weeks=distinct([p["week"] for p in plays]),
            teams=distinct(
                [p["possession_team"] for p in plays]
                + [p["defensive_team"] for p in plays]
            ),
            formations=distinct([p["offense_formation"] for p in plays]),
            coverages=distinct(
                [r.annotations.get("team_coverage_type") for r in self._records]
            ),
            quarters=distinct([p["quarter"] for p in plays]),
        )

    def get_play(self, game_id: int, play_id: int) -> PlayRecord | None:
        return self._index.get((game_id, play_id))

    def _read_play(
        self,
        spec: cs.ArtifactSpec,
        game_id: int,
        play_id: int,
        columns: list[str],
        order: list[str],
    ) -> list[dict[str, Any]]:
        return (
            self._data.scan(spec)
            .filter((pl.col("game_id") == game_id) & (pl.col("play_id") == play_id))
            .select(columns)
            .sort(order)
            .collect()
            .to_dicts()
        )

    def _load_tracking(self, game_id: int, play_id: int) -> list[TrackingRow]:
        rows = self._read_play(
            cs.OBSERVED_TRACKING,
            game_id,
            play_id,
            TRACKING_COLUMNS,
            ["frame_id", "nfl_id"],
        )
        return cast(list[TrackingRow], rows)

    def _load_future(self, game_id: int, play_id: int) -> list[FutureRow]:
        rows = self._read_play(
            cs.FUTURE_TRAJECTORIES,
            game_id,
            play_id,
            FUTURE_COLUMNS,
            ["nfl_id", "frame_id"],
        )
        return cast(list[FutureRow], rows)
