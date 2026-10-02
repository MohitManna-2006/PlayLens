"""Play service: maps canonical repository rows to API contracts.

No football values are invented here. Labels such as ``yardline_label`` are
formatting of supplied fields; missing values stay null.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Mapping
from typing import Any

from playlens_ml.data.coordinates import FIELD_LENGTH_YD, FIELD_WIDTH_YD
from playlens_ml.data.ids import InvalidPlayIdError, decode_play_id

from ..errors import CapabilityUnavailable, InvalidPlayId, InvalidQuery, PlayNotFound
from ..repository.base import PlayFilter, PlayRecord, PlayRepository
from ..schemas.common import DatasetStatus, Provenance
from ..schemas.plays import (
    BallLanding,
    CoordinateInfo,
    Facets,
    PlayAnnotations,
    PlayContext,
    PlayDetail,
    PlayerRef,
    PlayOutcome,
    PlayPage,
    PlaySummary,
    TrackingSummary,
)
from ..schemas.tracking import (
    Frame,
    FramePlayer,
    FramesPayload,
    FuturePayload,
    FuturePoint,
    FutureTrajectory,
)

DECIMALS = 3
FUTURE_DESCRIPTION = (
    "Held-out ground-truth positions after the observed window, from the dataset's "
    "output files. "
    "Available only for players flagged player_to_predict. This is not a model "
    "prediction."
)


def _r(v: float | None) -> float | None:
    return None if v is None else round(v, DECIMALS)


def _yardline_label(p: Mapping[str, Any]) -> str | None:
    number, side = p.get("yardline_number"), p.get("yardline_side")
    if number is None:
        return None
    if side is None:
        return str(number) if number == 50 else None
    return f"{side} {number}"


def _in_field(x: float, y: float) -> bool:
    return 0 <= x <= FIELD_LENGTH_YD and 0 <= y <= FIELD_WIDTH_YD


class PlayService:
    def __init__(self, repository: PlayRepository) -> None:
        self.repo = repository

    # ---- dataset ----

    def dataset_status(self) -> DatasetStatus:
        i = self.repo.info()
        return DatasetStatus(
            dataset=i.dataset,
            title=i.title,
            source=i.source,
            subset=i.subset,
            dataset_version=i.dataset_version,
            schema_version=i.schema_version,
            play_count=i.play_count,
            synthetic=False,
            license_note=i.license_note,
            generated_at=i.generated_at,
        )

    def _provenance(self) -> Provenance:
        i = self.repo.info()
        return Provenance(
            source=f"{i.title} ({i.source})",
            dataset=i.dataset,
            dataset_version=i.dataset_version,
            schema_version=i.schema_version,
            coordinate_convention=i.coordinate_description,
            synthetic=False,
            subset=i.subset,
        )

    # ---- lookup ----

    def record(self, external_id: str) -> PlayRecord:
        try:
            game_id, play_id = decode_play_id(external_id)
        except InvalidPlayIdError as err:
            raise InvalidPlayId(str(err)) from err
        record = self.repo.get_play(game_id, play_id)
        if record is None:
            raise PlayNotFound(
                f"Play {external_id} is not in dataset "
                f"{self.repo.info().dataset_version}."
            )
        return record

    # ---- summaries ----

    def _summary_fields(self, r: PlayRecord) -> dict[str, Any]:
        p, a, o = r.play, r.annotations, r.outcome
        rate = float(p["frame_rate_hz"])
        date = p.get("game_date")
        return {
            "id": r.id,
            "game_id": r.game_id,
            "play_id": r.play_id,
            "season": p.get("season"),
            "week": p.get("week"),
            "game_date": date.isoformat() if isinstance(date, dt.date) else None,
            "home_team": p["home_team"],
            "away_team": p["visitor_team"],
            "offense": p.get("possession_team"),
            "defense": p.get("defensive_team"),
            "quarter": p.get("quarter"),
            "game_clock": p.get("game_clock"),
            "down": p.get("down"),
            "yards_to_go": p.get("yards_to_go"),
            "yardline_label": _yardline_label(p),
            # Every play in this dataset is a pass with a supplied pass_result.
            "play_type": "pass" if o.get("pass_result") else None,
            "description": o.get("play_description"),
            "context": PlayContext(
                offense_formation=p.get("offense_formation"),
                receiver_alignment=p.get("receiver_alignment"),
                defenders_in_the_box=p.get("defenders_in_the_box"),
                home_score=p.get("pre_snap_home_score"),
                visitor_score=p.get("pre_snap_visitor_score"),
                home_win_probability=p.get("pre_snap_home_team_win_probability"),
                visitor_win_probability=p.get("pre_snap_visitor_team_win_probability"),
                expected_points=p.get("expected_points"),
            ),
            "annotations": PlayAnnotations(
                coverage_family=a.get("team_coverage_man_zone"),
                coverage_type=a.get("team_coverage_type"),
                target_route=a.get("route_of_targeted_receiver"),
                play_action=a.get("play_action"),
                dropback_type=a.get("dropback_type"),
                dropback_distance=a.get("dropback_distance"),
                pass_location_type=a.get("pass_location_type"),
            ),
            "outcome": PlayOutcome(
                pass_result=o.get("pass_result"),
                pass_length=o.get("pass_length"),
                yards_gained=o.get("yards_gained"),
                pre_penalty_yards_gained=o.get("pre_penalty_yards_gained"),
                penalty_yards=o.get("penalty_yards"),
                nullified_by_penalty=o.get("play_nullified_by_penalty"),
                expected_points_added=o.get("expected_points_added"),
                home_win_probability_added=o.get("home_team_win_probability_added"),
                visitor_win_probability_added=o.get(
                    "visitor_team_win_probability_added"
                ),
            ),
            "tracking": TrackingSummary(
                observed_frame_count=p["observed_frame_count"],
                observed_duration_s=round((p["observed_frame_count"] - 1) / rate, 3),
                first_frame_id=p["observed_first_frame_id"],
                last_frame_id=p["observed_last_frame_id"],
                player_count=p["player_count"],
                offense_player_count=p["offense_player_count"],
                defense_player_count=p["defense_player_count"],
                predicted_player_count=p["predicted_player_count"],
                future_frame_count=p["future_frame_count"],
                future_duration_s=round(p["future_frame_count"] / rate, 3),
                ball_tracked=False,
            ),
        }

    def summary(self, r: PlayRecord) -> PlaySummary:
        return PlaySummary(**self._summary_fields(r))

    def list_plays(
        self,
        flt: PlayFilter,
        page: int,
        page_size: int,
        sort: str,
        similar_to: str | None,
    ) -> PlayPage:
        if sort == "similarity" or similar_to:
            raise CapabilityUnavailable(
                "The play list does not sort by similarity. Ranked neighbours come "
                "from POST /api/v1/search/similar. Use sort=recent."
            )
        if page < 1 or not 1 <= page_size <= 200:
            raise InvalidQuery("page must be >= 1 and page_size between 1 and 200.")
        result = self.repo.query_plays(flt, (page - 1) * page_size, page_size)
        return PlayPage(
            items=[PlaySummary(**self._summary_fields(r)) for r in result.records],
            total=result.total,
            page=page,
            page_size=page_size,
            sort="recent",
            similarity=None,
            dataset=self.dataset_status(),
        )

    def facets(self) -> Facets:
        f = self.repo.facets()
        return Facets(
            seasons=f.seasons,
            weeks=f.weeks,
            teams=f.teams,
            formations=f.formations,
            coverages=f.coverages,
            play_types=["pass"],
            quarters=f.quarters,
        )

    # ---- detail ----

    def get_play(self, external_id: str) -> PlayDetail:
        r = self.record(external_id)
        p = r.play
        direction = p.get("play_direction_raw")
        info = self.repo.info()
        players = [
            PlayerRef(
                player_id=str(row["nfl_id"]),
                nfl_id=row["nfl_id"],
                jersey=None,
                name=row.get("player_name"),
                side=row["side"],
                position=row.get("player_position"),
                role=row.get("player_role"),
                player_to_predict=bool(row.get("player_to_predict")),
            )
            for row in r.players
        ]
        landing = None
        if p.get("ball_land_x") is not None and p.get("ball_land_y") is not None:
            landing = BallLanding(
                x=round(p["ball_land_x"], DECIMALS),
                y=round(p["ball_land_y"], DECIMALS),
                x_raw=round(p["ball_land_x_raw"], DECIMALS),
                y_raw=round(p["ball_land_y_raw"], DECIMALS),
                in_field=_in_field(p["ball_land_x"], p["ball_land_y"]),
            )
        return PlayDetail(
            **self._summary_fields(r),
            players=players,
            events=[],
            play_direction=direction,
            line_of_scrimmage_x=p.get("line_of_scrimmage_x"),
            first_down_x=p.get("first_down_x"),
            frame_rate_hz=float(p["frame_rate_hz"]),
            ball_landing=landing,
            coordinates=CoordinateInfo(
                system=info.coordinate_system,
                description=info.coordinate_description,
                raw_play_direction=direction,
                raw_transform="rotate_180" if direction == "left" else "identity",
            ),
            provenance=self._provenance(),
        )

    # ---- frames ----

    def get_frames(
        self, external_id: str, start_frame: int | None, end_frame: int | None
    ) -> FramesPayload:
        r = self.record(external_id)
        if (
            start_frame is not None
            and end_frame is not None
            and start_frame > end_frame
        ):
            raise InvalidQuery("start_frame must not be greater than end_frame.")
        frames: list[Frame] = []
        current: list[FramePlayer] = []
        head: tuple[int, int, float] | None = None

        def flush() -> None:
            if head is not None:
                frames.append(
                    Frame(
                        frame_id=head[0],
                        frame_index=head[1],
                        time_s=head[2],
                        ball=None,
                        players=current,
                    )
                )

        for row in self.repo.observed_tracking(r.game_id, r.play_id):
            fid = row["frame_id"]
            if (start_frame is not None and fid < start_frame) or (
                end_frame is not None and fid > end_frame
            ):
                continue
            if head is None or head[0] != fid:
                flush()
                head, current = (fid, row["frame_index"], round(row["time_s"], 3)), []
            current.append(
                FramePlayer(
                    player_id=str(row["nfl_id"]),
                    x=round(row["x"], DECIMALS),
                    y=round(row["y"], DECIMALS),
                    s=_r(row["s"]),
                    a=_r(row["a"]),
                    dir=_r(row["dir"]),
                    o=_r(row["o"]),
                )
            )
        flush()
        info = self.repo.info()
        return FramesPayload(
            id=r.id,
            dataset_version=info.dataset_version,
            schema_version=info.schema_version,
            coordinate_system=info.coordinate_system,
            frame_rate_hz=float(r.play["frame_rate_hz"]),
            observed_frame_count=r.play["observed_frame_count"],
            frames=frames,
        )

    def get_future(self, external_id: str) -> FuturePayload:
        r = self.record(external_id)
        by_player: dict[int, list[FuturePoint]] = {}
        for row in self.repo.future_trajectories(r.game_id, r.play_id):
            by_player.setdefault(row["nfl_id"], []).append(
                FuturePoint(
                    frame_id=row["frame_id"],
                    frame_index=row["frame_index"],
                    time_s=round(row["time_s"], 3),
                    x=round(row["x"], DECIMALS),
                    y=round(row["y"], DECIMALS),
                )
            )
        p = r.play
        rate = float(p["frame_rate_hz"])
        info = self.repo.info()
        last_index = p["observed_frame_count"] - 1
        return FuturePayload(
            id=r.id,
            description=FUTURE_DESCRIPTION,
            dataset_version=info.dataset_version,
            schema_version=info.schema_version,
            coordinate_system=info.coordinate_system,
            frame_rate_hz=rate,
            origin_frame_id=p["observed_last_frame_id"],
            origin_time_s=round(last_index / rate, 3),
            horizon_frames=p["future_frame_count"],
            horizon_s=round(p["future_frame_count"] / rate, 3),
            trajectories=[
                FutureTrajectory(player_id=str(k), points=v)
                for k, v in by_player.items()
            ],
        )
