"""Trajectory-model feature allowlist (ADR-0003).

The model sees only what is known at the prediction origin, the last observed
frame: observed kinematics, roster attributes, the line of scrimmage, and which
players are being forecast. Everything else is excluded on purpose and listed
in ``EXCLUDED`` with the reason. ``assert_allowlist_is_safe`` runs the Phase 2
availability guard over every source column, and the sample builder reads only
``SOURCE_COLUMNS``.
"""

from __future__ import annotations

from ..data import canonical_schema as cs
from ..data.availability import Availability, LeakageError, check_feature_columns

# Bump when a feature is added, removed, or computed differently.
FEATURE_SCHEMA_VERSION = "1"

FRAME_RATE_HZ = 10.0
FIELD_CENTER_Y = 80.0 / 3.0

# Per player, per observed frame; standardized with train-split statistics.
NUMERIC_FEATURES: tuple[str, ...] = (
    "x",  # canonical x, yards
    "y",  # canonical y, yards
    "x_from_los",  # x minus the line of scrimmage
    "s",  # speed, yd/s
    "a",  # acceleration, yd/s^2
    "sin_dir",
    "cos_dir",
    "sin_o",
    "cos_o",
    "vx",  # s * sin(dir)
    "vy",  # s * cos(dir)
    "dx_prev",  # displacement from the previous observed frame (0 at the first one)
    "dy_prev",
    "t_rel",  # seconds relative to the last observed frame (<= 0)
)
# Per player; vocabularies are built from the train split with an <unk> entry.
CATEGORICAL_FEATURES: tuple[str, ...] = ("side", "position", "role")
# Per player; 0/1.
BINARY_FEATURES: tuple[str, ...] = ("player_to_predict",)

# Canonical columns the sample builder is allowed to read, per artifact.
SOURCE_COLUMNS: dict[str, tuple[str, ...]] = {
    cs.OBSERVED_TRACKING.name: (
        "game_id",
        "play_id",
        "nfl_id",
        "frame_id",
        "frame_index",
        "x",
        "y",
        "s",
        "a",
        "dir",
        "o",
    ),
    cs.PLAYERS.name: (
        "game_id",
        "play_id",
        "nfl_id",
        "roster_order",
        "side",
        "player_position",
        "player_role",
        "player_to_predict",
    ),
    cs.PLAYS.name: (
        "id",
        "game_id",
        "play_id",
        "week",
        "line_of_scrimmage_x",
        "observed_frame_count",
    ),
}
# Read only to build targets and their masks; never model inputs.
TARGET_COLUMNS: dict[str, tuple[str, ...]] = {
    cs.FUTURE_TRAJECTORIES.name: ("game_id", "play_id", "nfl_id", "frame_id", "x", "y"),
}

# task_input_at_origin columns that are model inputs, and why each is allowed.
ALLOWED_TASK_INPUTS: dict[str, str] = {
    "player_role": (
        "Identifies the passer and the targeted receiver. The receiver is targeted "
        "at the moment the "
        "pass is released, which is the prediction origin, and the user-approved "
        "feature list includes it."
    ),
    "player_to_predict": (
        "Marks the players the model must forecast. Needed to choose outputs; also "
        "given as an input "
        "flag. Caveat: the dataset chose these players, which hints at who is near "
        "the play."
    ),
}

EXCLUDED: dict[str, str] = {
    "ball_land_x, ball_land_y": (
        "Where the pass lands is decided after the observed window. The input files "
        "carry it, but no "
        "local documentation establishes it as known at prediction time, so it is "
        "excluded."
    ),
    "future_frame_count (num_frames_output)": (
        "Encodes how long the ball is in the air. Used only to mask targets, never "
        "as an input."
    ),
    "predicted_player_count": (
        "Derived from player_to_predict over the play; adds nothing safe."
    ),
    "future_trajectories.*": "The targets themselves.",
    "annotations.* (coverage, target route, dropback, play action, pass location)": (
        "Charted after the play; not available at prediction time."
    ),
    "outcomes.* (pass result, pass length, yards, EPA, WPA, description)": (
        "Post-play outcomes."
    ),
    "pre-snap game context (down, distance, clock, score, formation, win prob.)": (
        "Known before the snap and allowed, but left out of this first, purely "
        "kinematic model to keep "
        "the input space small. A candidate for a later version."
    ),
    "x_raw, y_raw, dir_raw, o_raw, play_direction_raw": (
        "Recorded-frame duplicates of canonical values; mixing frames is forbidden "
        "(Masterbrain §9.1)."
    ),
    "player_height, player_weight, player_birth_date, player_name, nfl_id": (
        "Identity or physique; risks memorizing individuals and is not needed for "
        "the task."
    ),
}


def _registry() -> dict[str, Availability]:
    out: dict[str, Availability] = {}
    for spec in cs.ARTIFACTS:
        for col, availability in spec.availability.items():
            out[f"{spec.name}.{col}"] = availability
    return out


def assert_allowlist_is_safe() -> None:
    """Fail if any model-input column is a target, annotation, outcome, or unapproved
    task input."""
    registry = _registry()
    columns = [
        f"{artifact}.{col}" for artifact, cols in SOURCE_COLUMNS.items() for col in cols
    ]
    check_feature_columns(columns, registry, allow_task_inputs=True)
    task_inputs = {
        c.split(".", 1)[1]
        for c in columns
        if registry[c] is Availability.TASK_INPUT_AT_ORIGIN
    }
    unapproved = task_inputs - set(ALLOWED_TASK_INPUTS)
    if unapproved:
        raise LeakageError(
            "Task-input columns used without an explicit approval: "
            f"{sorted(unapproved)}"
        )


def describe() -> dict[str, object]:
    return {
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "numeric": list(NUMERIC_FEATURES),
        "categorical": list(CATEGORICAL_FEATURES),
        "binary": list(BINARY_FEATURES),
        "source_columns": {k: list(v) for k, v in SOURCE_COLUMNS.items()},
        "target_columns": {k: list(v) for k, v in TARGET_COLUMNS.items()},
        "allowed_task_inputs": ALLOWED_TASK_INPUTS,
        "excluded": EXCLUDED,
    }
