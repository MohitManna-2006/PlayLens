"""Canonical PlayLens artifact schemas: the one definition of every processed column.

Artifacts are grouped by availability so later ML code reads observed input,
future targets, and post-play metadata from different files:

    observed/plays.parquet            identity, pre-snap context, structure
    observed/players.parquet          static player attributes per play
    observed/tracking.parquet         observed frames (canonical + raw values)
    targets/future_trajectories.parquet   held-out future positions
    descriptive/annotations.parquet   charted in-play labels
    descriptive/outcomes.parquet      post-play results
"""

from __future__ import annotations

from dataclasses import dataclass

import polars as pl

from .availability import Availability as A

# Bump when a column is added, removed, renamed, or changes meaning.
CANONICAL_SCHEMA_VERSION = "2"


@dataclass(frozen=True)
class Column:
    dtype: pl.DataType
    availability: A
    description: str


@dataclass(frozen=True)
class ArtifactSpec:
    name: str
    path: str
    columns: dict[str, Column]
    sort_by: tuple[str, ...]

    @property
    def schema(self) -> dict[str, pl.DataType]:
        return {k: c.dtype for k, c in self.columns.items()}

    @property
    def availability(self) -> dict[str, A]:
        return {k: c.availability for k, c in self.columns.items()}


def _c(dtype: pl.DataType, availability: A, description: str) -> Column:
    return Column(dtype, availability, description)


I64, F64, STR, BOOL, DATE = (
    pl.Int64(),
    pl.Float64(),
    pl.String(),
    pl.Boolean(),
    pl.Date(),
)

_KEYS = {
    "game_id": _c(I64, A.IDENTITY, "NFL game identifier."),
    "play_id": _c(I64, A.IDENTITY, "Play identifier, unique only within a game."),
}

PLAYS = ArtifactSpec(
    name="plays",
    path="observed/plays.parquet",
    sort_by=("game_id", "play_id"),
    columns={
        "id": _c(STR, A.IDENTITY, "PlayLens play ID '<game_id>-<play_id>'."),
        **_KEYS,
        "season": _c(I64, A.PRE_SNAP, "Season."),
        "week": _c(I64, A.PRE_SNAP, "Week of the season."),
        "game_date": _c(DATE, A.PRE_SNAP, "Game date (parsed from MM/DD/YYYY)."),
        "game_time_eastern": _c(
            STR, A.PRE_SNAP, "Kickoff time, US Eastern, as supplied."
        ),
        "home_team": _c(STR, A.PRE_SNAP, "Home team abbreviation."),
        "visitor_team": _c(STR, A.PRE_SNAP, "Visiting team abbreviation."),
        "possession_team": _c(STR, A.PRE_SNAP, "Offense."),
        "defensive_team": _c(STR, A.PRE_SNAP, "Defense."),
        "quarter": _c(I64, A.PRE_SNAP, "Quarter; 5 is overtime."),
        "game_clock": _c(STR, A.PRE_SNAP, "Game clock at the snap, MM:SS."),
        "down": _c(I64, A.PRE_SNAP, "Down."),
        "yards_to_go": _c(I64, A.PRE_SNAP, "Yards to a first down."),
        "yardline_side": _c(
            STR, A.PRE_SNAP, "Team whose half the ball is on; null at midfield."
        ),
        "yardline_number": _c(I64, A.PRE_SNAP, "Yard line 1-50."),
        "pre_snap_home_score": _c(I64, A.PRE_SNAP, "Home score before the play."),
        "pre_snap_visitor_score": _c(I64, A.PRE_SNAP, "Visitor score before the play."),
        "pre_snap_home_team_win_probability": _c(
            F64, A.PRE_SNAP, "Dataset-supplied pre-snap estimate."
        ),
        "pre_snap_visitor_team_win_probability": _c(
            F64, A.PRE_SNAP, "Dataset-supplied pre-snap estimate."
        ),
        "expected_points": _c(
            F64,
            A.PRE_SNAP,
            "Dataset-supplied expected points for the play (pre-play estimate).",
        ),
        "offense_formation": _c(STR, A.PRE_SNAP, "Offensive formation label."),
        "receiver_alignment": _c(
            STR, A.PRE_SNAP, "Receiver alignment label, e.g. 3x1."
        ),
        "defenders_in_the_box": _c(I64, A.PRE_SNAP, "Defenders in the box."),
        "play_direction_raw": _c(
            STR,
            A.PRE_SNAP,
            "Recorded attack direction; 'left' plays are rotated 180 deg.",
        ),
        "absolute_yardline_number_raw": _c(
            I64, A.PRE_SNAP, "Line of scrimmage in raw x."
        ),
        "line_of_scrimmage_x": _c(F64, A.PRE_SNAP, "Line of scrimmage, canonical x."),
        "first_down_x": _c(
            F64,
            A.PRE_SNAP,
            "Line to gain, canonical x (line of scrimmage + yards_to_go).",
        ),
        "frame_rate_hz": _c(F64, A.STRUCTURAL, "Tracking frame rate."),
        "observed_first_frame_id": _c(I64, A.STRUCTURAL, "First observed frame_id."),
        "observed_last_frame_id": _c(
            I64, A.STRUCTURAL, "Last observed frame_id (the prediction origin)."
        ),
        "observed_frame_count": _c(I64, A.STRUCTURAL, "Observed frames."),
        "player_count": _c(
            I64, A.STRUCTURAL, "Tracked players in the observed window."
        ),
        "offense_player_count": _c(I64, A.STRUCTURAL, "Tracked offensive players."),
        "defense_player_count": _c(I64, A.STRUCTURAL, "Tracked defensive players."),
        "predicted_player_count": _c(
            I64, A.TASK_INPUT_AT_ORIGIN, "Players flagged player_to_predict."
        ),
        "future_frame_count": _c(
            I64, A.TASK_INPUT_AT_ORIGIN, "num_frames_output: future frames to predict."
        ),
        "ball_land_x_raw": _c(
            F64, A.TASK_INPUT_AT_ORIGIN, "Ball landing x, raw frame."
        ),
        "ball_land_y_raw": _c(
            F64, A.TASK_INPUT_AT_ORIGIN, "Ball landing y, raw frame."
        ),
        "ball_land_x": _c(
            F64, A.TASK_INPUT_AT_ORIGIN, "Ball landing x, canonical frame."
        ),
        "ball_land_y": _c(
            F64, A.TASK_INPUT_AT_ORIGIN, "Ball landing y, canonical frame."
        ),
        "source_file": _c(STR, A.IDENTITY, "Raw input file the play came from."),
    },
)

PLAYERS = ArtifactSpec(
    name="players",
    path="observed/players.parquet",
    sort_by=("game_id", "play_id", "roster_order"),
    columns={
        **_KEYS,
        "nfl_id": _c(I64, A.IDENTITY, "NFL player identifier."),
        "roster_order": _c(
            I64,
            A.IDENTITY,
            "Stable display order: offense then defense, by role, then nfl_id.",
        ),
        "player_name": _c(STR, A.IDENTITY, "Player name."),
        "player_position": _c(STR, A.PRE_SNAP, "Roster position."),
        "side": _c(STR, A.PRE_SNAP, "'offense' or 'defense' (from player_side)."),
        "player_role": _c(
            STR,
            A.TASK_INPUT_AT_ORIGIN,
            "Passer, Targeted Receiver, Other Route Runner, Defensive Coverage.",
        ),
        "player_to_predict": _c(
            BOOL,
            A.TASK_INPUT_AT_ORIGIN,
            "Whether the player has a future trajectory target.",
        ),
        "player_height": _c(STR, A.PRE_SNAP, "Height as supplied (feet-inches)."),
        "player_weight": _c(I64, A.PRE_SNAP, "Weight in pounds."),
        "player_birth_date": _c(DATE, A.PRE_SNAP, "Birth date."),
    },
)

OBSERVED_TRACKING = ArtifactSpec(
    name="observed_tracking",
    path="observed/tracking.parquet",
    sort_by=("game_id", "play_id", "frame_id", "nfl_id"),
    columns={
        **_KEYS,
        "nfl_id": _c(I64, A.IDENTITY, "NFL player identifier."),
        "frame_id": _c(I64, A.STRUCTURAL, "Frame number as supplied."),
        "frame_index": _c(
            I64, A.STRUCTURAL, "0-based index within the observed window."
        ),
        "time_s": _c(
            F64,
            A.STRUCTURAL,
            "Seconds since the first observed frame (frame_index / frame rate).",
        ),
        "x": _c(F64, A.OBSERVED_WINDOW, "Canonical x, yards."),
        "y": _c(F64, A.OBSERVED_WINDOW, "Canonical y, yards."),
        "s": _c(F64, A.OBSERVED_WINDOW, "Speed, yd/s (orientation-free)."),
        "a": _c(F64, A.OBSERVED_WINDOW, "Acceleration, yd/s^2 (orientation-free)."),
        "dir": _c(F64, A.OBSERVED_WINDOW, "Canonical movement direction, degrees."),
        "o": _c(F64, A.OBSERVED_WINDOW, "Canonical orientation, degrees."),
        "x_raw": _c(F64, A.OBSERVED_WINDOW, "Recorded x."),
        "y_raw": _c(F64, A.OBSERVED_WINDOW, "Recorded y."),
        "dir_raw": _c(F64, A.OBSERVED_WINDOW, "Recorded dir."),
        "o_raw": _c(F64, A.OBSERVED_WINDOW, "Recorded o."),
    },
)

FUTURE_TRAJECTORIES = ArtifactSpec(
    name="future_trajectories",
    path="targets/future_trajectories.parquet",
    sort_by=("game_id", "play_id", "nfl_id", "frame_id"),
    columns={
        **_KEYS,
        "nfl_id": _c(I64, A.IDENTITY, "NFL player identifier."),
        "frame_id": _c(
            I64, A.FUTURE_TARGET, "Output frame number as supplied (restarts at 1)."
        ),
        "frame_index": _c(
            I64,
            A.FUTURE_TARGET,
            "Index continuing the observed window: observed_frame_count - 1 + "
            "frame_id.",
        ),
        "time_s": _c(F64, A.FUTURE_TARGET, "Seconds since the first observed frame."),
        "x": _c(F64, A.FUTURE_TARGET, "Canonical x, yards."),
        "y": _c(F64, A.FUTURE_TARGET, "Canonical y, yards."),
        "x_raw": _c(F64, A.FUTURE_TARGET, "Recorded x."),
        "y_raw": _c(F64, A.FUTURE_TARGET, "Recorded y."),
    },
)

ANNOTATIONS = ArtifactSpec(
    name="annotations",
    path="descriptive/annotations.parquet",
    sort_by=("game_id", "play_id"),
    columns={
        **_KEYS,
        "play_action": _c(BOOL, A.IN_PLAY_ANNOTATION, "Play action."),
        "dropback_type": _c(STR, A.IN_PLAY_ANNOTATION, "Dropback type."),
        "dropback_distance": _c(F64, A.IN_PLAY_ANNOTATION, "Dropback distance, yards."),
        "pass_location_type": _c(
            STR, A.IN_PLAY_ANNOTATION, "Where the pass was thrown from."
        ),
        "team_coverage_man_zone": _c(
            STR, A.IN_PLAY_ANNOTATION, "Man or zone coverage label."
        ),
        "team_coverage_type": _c(
            STR, A.IN_PLAY_ANNOTATION, "Coverage label, e.g. COVER_3_ZONE."
        ),
        "route_of_targeted_receiver": _c(
            STR, A.IN_PLAY_ANNOTATION, "Route label of the targeted receiver."
        ),
    },
)

OUTCOMES = ArtifactSpec(
    name="outcomes",
    path="descriptive/outcomes.parquet",
    sort_by=("game_id", "play_id"),
    columns={
        **_KEYS,
        "play_description": _c(
            STR,
            A.POST_PLAY_OUTCOME,
            "Narrative play description, including the result.",
        ),
        "pass_result": _c(
            STR, A.POST_PLAY_OUTCOME, "Pass result code as supplied (C, I, IN)."
        ),
        "pass_length": _c(I64, A.POST_PLAY_OUTCOME, "Pass length as supplied."),
        "yards_gained": _c(I64, A.POST_PLAY_OUTCOME, "Yards gained."),
        "pre_penalty_yards_gained": _c(
            I64, A.POST_PLAY_OUTCOME, "Yards gained before penalties."
        ),
        "penalty_yards": _c(
            I64, A.POST_PLAY_OUTCOME, "Penalty yards; null when no penalty is recorded."
        ),
        "play_nullified_by_penalty": _c(
            BOOL, A.POST_PLAY_OUTCOME, "Play nullified by penalty (from Y/N)."
        ),
        "expected_points_added": _c(F64, A.POST_PLAY_OUTCOME, "Dataset-supplied EPA."),
        "home_team_win_probability_added": _c(
            F64, A.POST_PLAY_OUTCOME, "Dataset-supplied WPA, home."
        ),
        # Raw column is spelled visitor_team_win_probility_added.
        "visitor_team_win_probability_added": _c(
            F64, A.POST_PLAY_OUTCOME, "Dataset-supplied WPA, visitor."
        ),
    },
)

ARTIFACTS: tuple[ArtifactSpec, ...] = (
    PLAYS,
    PLAYERS,
    OBSERVED_TRACKING,
    FUTURE_TRAJECTORIES,
    ANNOTATIONS,
    OUTCOMES,
)
