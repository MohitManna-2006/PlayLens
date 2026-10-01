"""When each canonical field becomes known, relative to a play's timeline.

Observed input, future targets, and post-play metadata live in separate
artifacts. ``check_feature_columns`` is the guard later feature builders call so
an outcome or target column cannot slip into model inputs unnoticed.
"""

from __future__ import annotations

from collections.abc import Iterable
from enum import StrEnum


class Availability(StrEnum):
    IDENTITY = "identity"
    """Keys and provenance; carry no football information."""
    STRUCTURAL = "structural"
    """Counts and frame ranges of the observed window."""
    PRE_SNAP = "pre_snap"
    """Known before the snap: game situation, alignment, pre-snap estimates."""
    OBSERVED_WINDOW = "observed_window"
    """Tracking inside the observed input window, up to its last frame."""
    TASK_INPUT_AT_ORIGIN = "task_input_at_origin"
    """Supplied in the input files as known at the end of the observed window,
    but describing the pass: targeted receiver, players to predict, ball landing
    spot, number of future frames. A strictly pre-throw model must not use them."""
    IN_PLAY_ANNOTATION = "in_play_annotation"
    """Charted labels describing the play (coverage, route, dropback, play action)."""
    FUTURE_TARGET = "future_target"
    """Held-out positions after the observed window (the output files)."""
    POST_PLAY_OUTCOME = "post_play_outcome"
    """Results: pass result, yards, EPA, win-probability change, narrative."""


SAFE_BY_DEFAULT = frozenset(
    {
        Availability.IDENTITY,
        Availability.STRUCTURAL,
        Availability.PRE_SNAP,
        Availability.OBSERVED_WINDOW,
    }
)
NEVER_MODEL_INPUT = frozenset(
    {
        Availability.FUTURE_TARGET,
        Availability.POST_PLAY_OUTCOME,
        Availability.IN_PLAY_ANNOTATION,
    }
)


class LeakageError(ValueError):
    """A requested feature column is not available before the prediction target."""


def check_feature_columns(
    columns: Iterable[str],
    registry: dict[str, Availability],
    *,
    allow_task_inputs: bool = False,
) -> None:
    """Raise unless every column is registered and allowed as a model input.

    ``allow_task_inputs`` must be passed explicitly by tasks whose definition
    permits TASK_INPUT_AT_ORIGIN fields (the BDB 2026 trajectory task does).
    """
    allowed = set(SAFE_BY_DEFAULT)
    if allow_task_inputs:
        allowed.add(Availability.TASK_INPUT_AT_ORIGIN)
    problems = []
    for col in columns:
        klass = registry.get(col)
        if klass is None:
            problems.append(f"{col} (unregistered)")
        elif klass not in allowed:
            problems.append(f"{col} ({klass.value})")
    if problems:
        raise LeakageError(
            "Columns not allowed as model inputs: " + ", ".join(problems)
        )
