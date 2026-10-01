"""NFL Big Data Bowl 2026 Analytics: raw file layout and schemas.

Column lists and types were checked against every raw file (see
docs/data/nfl-bdb-2026-analytics.md). The adapter fails loudly when a required
column is missing instead of guessing.
"""

from __future__ import annotations

import re

import polars as pl

DATASET_NAME = "nfl_bdb_2026_analytics"
DATASET_TITLE = "NFL Big Data Bowl 2026 Analytics"
# The distribution folder name is the only source identifier the files carry.
SOURCE_IDENTIFIER = "114239_nfl_competition_files_published_analytics_final"
RAW_DIRNAME = SOURCE_IDENTIFIER

SUPPLEMENTARY_FILE = "supplementary_data.csv"
TRACKING_DIR = "train"
INPUT_PATTERN = re.compile(r"^input_(\d{4})_w(\d{2})\.csv$")
OUTPUT_PATTERN = re.compile(r"^output_(\d{4})_w(\d{2})\.csv$")

NULL_VALUES = ["NA", ""]

# 10 Hz: consecutive-frame displacement / 0.1 s matches the supplied speed
# (median ratio 0.99 across the dataset), see the dataset notes.
FRAME_RATE_HZ = 10.0

INPUT_SCHEMA: dict[str, pl.DataType] = {
    "game_id": pl.Int64(),
    "play_id": pl.Int64(),
    "player_to_predict": pl.Boolean(),
    "nfl_id": pl.Int64(),
    "frame_id": pl.Int64(),
    "play_direction": pl.String(),
    "absolute_yardline_number": pl.Int64(),
    "player_name": pl.String(),
    "player_height": pl.String(),
    "player_weight": pl.Int64(),
    "player_birth_date": pl.String(),
    "player_position": pl.String(),
    "player_side": pl.String(),
    "player_role": pl.String(),
    "x": pl.Float64(),
    "y": pl.Float64(),
    "s": pl.Float64(),
    "a": pl.Float64(),
    "dir": pl.Float64(),
    "o": pl.Float64(),
    "num_frames_output": pl.Int64(),
    "ball_land_x": pl.Float64(),
    "ball_land_y": pl.Float64(),
}

OUTPUT_SCHEMA: dict[str, pl.DataType] = {
    "game_id": pl.Int64(),
    "play_id": pl.Int64(),
    "nfl_id": pl.Int64(),
    "frame_id": pl.Int64(),
    "x": pl.Float64(),
    "y": pl.Float64(),
}

SUPPLEMENTARY_SCHEMA: dict[str, pl.DataType] = {
    "game_id": pl.Int64(),
    "season": pl.Int64(),
    "week": pl.Int64(),
    "game_date": pl.String(),
    "game_time_eastern": pl.String(),
    "home_team_abbr": pl.String(),
    "visitor_team_abbr": pl.String(),
    "play_id": pl.Int64(),
    "play_description": pl.String(),
    "quarter": pl.Int64(),
    "game_clock": pl.String(),
    "down": pl.Int64(),
    "yards_to_go": pl.Int64(),
    "possession_team": pl.String(),
    "defensive_team": pl.String(),
    "yardline_side": pl.String(),
    "yardline_number": pl.Int64(),
    "pre_snap_home_score": pl.Int64(),
    "pre_snap_visitor_score": pl.Int64(),
    "play_nullified_by_penalty": pl.String(),
    "pass_result": pl.String(),
    "pass_length": pl.Int64(),
    "offense_formation": pl.String(),
    "receiver_alignment": pl.String(),
    "route_of_targeted_receiver": pl.String(),
    "play_action": pl.Boolean(),
    "dropback_type": pl.String(),
    "dropback_distance": pl.Float64(),
    "pass_location_type": pl.String(),
    "defenders_in_the_box": pl.Int64(),
    "team_coverage_man_zone": pl.String(),
    "team_coverage_type": pl.String(),
    "penalty_yards": pl.Int64(),
    "pre_penalty_yards_gained": pl.Int64(),
    "yards_gained": pl.Int64(),
    "expected_points": pl.Float64(),
    "expected_points_added": pl.Float64(),
    "pre_snap_home_team_win_probability": pl.Float64(),
    "pre_snap_visitor_team_win_probability": pl.Float64(),
    "home_team_win_probability_added": pl.Float64(),
    # Spelling as published.
    "visitor_team_win_probility_added": pl.Float64(),
}

# Values observed in the published files. Anything else is reported and the
# play is excluded rather than coerced.
PLAYER_SIDES = ("Offense", "Defense")
PLAYER_ROLES = (
    "Passer",
    "Targeted Receiver",
    "Other Route Runner",
    "Defensive Coverage",
)
