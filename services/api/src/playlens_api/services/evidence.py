"""Deterministic evidence records about a pair of plays.

Two kinds, never mixed with the retrieval signal itself:

* metadata: supplied pre-snap context and charted labels, compared for equality;
* structural_metric: tracking descriptors (playlens_ml.descriptors), compared by
  difference.

Neither kind is a model input, and agreement is supporting context, not the
reason the embedding placed two plays together.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from playlens_ml.descriptors import DESCRIPTORS

from ..repository.base import PlayRecord
from ..schemas.retrieval import Evidence, FrameReference

Source = Literal["pre_snap_context", "charted_label", "tracking"]


@dataclass(frozen=True)
class MetadataField:
    key: str
    label: str
    source: Source
    read: Callable[[PlayRecord], Any]
    numeric: bool
    unit: str | None
    definition: str


def _field_position(r: PlayRecord) -> float | None:
    los = r.play.get("line_of_scrimmage_x")
    return None if los is None else float(los) - 10.0


METADATA: tuple[MetadataField, ...] = (
    MetadataField(
        "down",
        "Down",
        "pre_snap_context",
        lambda r: r.play.get("down"),
        True,
        None,
        "Down before the snap, as supplied.",
    ),
    MetadataField(
        "yards_to_go",
        "Yards to go",
        "pre_snap_context",
        lambda r: r.play.get("yards_to_go"),
        True,
        "yd",
        "Yards to a first down before the snap, as supplied.",
    ),
    MetadataField(
        "quarter",
        "Quarter",
        "pre_snap_context",
        lambda r: r.play.get("quarter"),
        True,
        None,
        "Quarter as supplied; 5 is overtime.",
    ),
    MetadataField(
        "field_position",
        "Line of scrimmage, from own goal",
        "pre_snap_context",
        _field_position,
        True,
        "yd",
        "Yards from the offense's own goal line to the line of scrimmage.",
    ),
    MetadataField(
        "offense_formation",
        "Offensive formation",
        "pre_snap_context",
        lambda r: r.play.get("offense_formation"),
        False,
        None,
        "Dataset formation label (pre-snap). Not a model input.",
    ),
    MetadataField(
        "receiver_alignment",
        "Receiver alignment",
        "pre_snap_context",
        lambda r: r.play.get("receiver_alignment"),
        False,
        None,
        "Dataset receiver alignment label, e.g. 3x1 (pre-snap). Not a model input.",
    ),
    MetadataField(
        "coverage_type",
        "Coverage label",
        "charted_label",
        lambda r: r.annotations.get("team_coverage_type"),
        False,
        None,
        "Charted coverage label, recorded after the play. Not a model input.",
    ),
    MetadataField(
        "target_route",
        "Targeted receiver route",
        "charted_label",
        lambda r: r.annotations.get("route_of_targeted_receiver"),
        False,
        None,
        "Charted route of the targeted receiver, recorded after the play. Not a "
        "model input.",
    ),
)


def _metadata(scope: str, left: PlayRecord, right: PlayRecord) -> list[Evidence]:
    out = []
    for f in METADATA:
        a, b = f.read(left), f.read(right)
        missing = a is None or b is None
        relation: Literal["same", "different", "unavailable"] = (
            "unavailable" if missing else "same" if a == b else "different"
        )
        out.append(
            Evidence(
                id=f"{scope}.metadata.{f.key}",
                kind="metadata",
                source=f.source,
                label=f.label,
                left_value=float(a) if f.numeric and a is not None else None,
                right_value=float(b) if f.numeric and b is not None else None,
                left_text=None if f.numeric or a is None else str(a),
                right_text=None if f.numeric or b is None else str(b),
                unit=f.unit,
                decimals=1 if f.key == "field_position" else 0,
                delta=float(b) - float(a)
                if f.numeric and a is not None and b is not None
                else None,
                relation=relation,
                definition=f.definition,
                missing_reason="Not supplied for one or both plays."
                if missing
                else None,
            )
        )
    return out


def _frames(row: dict[str, Any], frame: str) -> list[int]:
    origin = int(row["origin_frame_id"])
    if frame == "origin":
        return [origin]
    start = row.get("window_start_frame_id")
    return [int(start), origin] if start is not None else [origin]


def _structural(
    scope: str, left: dict[str, Any], right: dict[str, Any]
) -> list[Evidence]:
    out = []
    for d in DESCRIPTORS:
        a, b = left.get(d.key), right.get(d.key)
        missing = a is None or b is None
        suffix: Literal["last_observed_frame", "last_2s_window"] = (
            "last_observed_frame" if d.frame == "origin" else "last_2s_window"
        )
        out.append(
            Evidence(
                id=f"{scope}.structure.{d.key}.{suffix}",
                kind="structural_metric",
                source="tracking",
                label=d.label,
                left_value=None if a is None else round(float(a), 3),
                right_value=None if b is None else round(float(b), 3),
                unit=d.unit,
                decimals=1,
                delta=round(float(b) - float(a), 3)
                if a is not None and b is not None
                else None,
                relation=None,
                definition=d.definition,
                missing_reason=d.requires if missing else None,
                frame_reference=FrameReference(
                    anchor=suffix,
                    left_frame_ids=_frames(left, d.frame),
                    right_frame_ids=_frames(right, d.frame),
                ),
            )
        )
    return out


def pair_evidence(
    scope: str,
    left: PlayRecord,
    right: PlayRecord,
    left_descriptors: dict[str, Any],
    right_descriptors: dict[str, Any],
) -> list[Evidence]:
    """Metadata then structural evidence; IDs are ``<scope>.<group>.<key>``."""
    return _metadata(scope, left, right) + _structural(
        scope, left_descriptors, right_descriptors
    )
