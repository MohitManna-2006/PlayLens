"""Brute-force cosine nearest neighbours in NumPy: the independent reference.

pgvector is checked against this, never against itself. Distances are computed
in float64 from the stored float32 vectors as ``1 - cos(a, b)``; pgvector
accumulates in float32, so the two agree to about 1e-6 and plays whose
distances differ by less than that may legitimately swap places.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np
import polars as pl

from .types import SearchFilters

TIE_TOLERANCE = 2e-6

PREDICATES: dict[str, Callable[[Any], pl.Expr]] = {
    "down": lambda v: pl.col("down") == v,
    "yards_to_go_min": lambda v: pl.col("yards_to_go") >= v,
    "yards_to_go_max": lambda v: pl.col("yards_to_go") <= v,
    "quarter": lambda v: pl.col("quarter") == v,
    "week_min": lambda v: pl.col("week") >= v,
    "week_max": lambda v: pl.col("week") <= v,
    "offense": lambda v: pl.col("offense") == v,
    "defense": lambda v: pl.col("defense") == v,
    "offense_formation": lambda v: pl.col("offense_formation") == v,
    "field_position_min": lambda v: pl.col("yards_from_own_goal") >= v,
    "field_position_max": lambda v: pl.col("yards_from_own_goal") <= v,
    "splits": lambda v: pl.col("split").is_in(list(v)),
}


def unit(vectors: np.ndarray) -> np.ndarray:
    v = vectors.astype(np.float64)
    out: np.ndarray = v / np.linalg.norm(v, axis=1, keepdims=True)
    return out


def eligible(rows: pl.DataFrame, filters: SearchFilters, query_id: str) -> np.ndarray:
    """Boolean mask over ``rows`` (columns as stored: pid, split, filter columns),
    with the same null semantics as SQL (a null never matches)."""
    expr = pl.col("pid") != query_id
    for name, value in filters.active().items():
        expr = expr & PREDICATES[name](value)
    out: np.ndarray = rows.select(expr.fill_null(False)).to_series().to_numpy()
    return out


@dataclass(frozen=True)
class Neighbour:
    index: int
    play_id: str
    distance: float


def topk(
    unit_vectors: np.ndarray,
    ids: list[str],
    query_index: int,
    k: int,
    mask: np.ndarray,
) -> list[Neighbour]:
    """Exact top-k by cosine distance, ties broken by play ID (like the SQL)."""
    candidates = np.flatnonzero(mask)
    if len(candidates) == 0:
        return []
    dist = 1.0 - unit_vectors[candidates] @ unit_vectors[query_index]
    order = sorted(range(len(candidates)), key=lambda j: (dist[j], ids[candidates[j]]))
    return [
        Neighbour(int(candidates[j]), ids[candidates[j]], float(dist[j]))
        for j in order[:k]
    ]


@dataclass(frozen=True)
class Agreement:
    identical: bool
    """Same IDs in the same order."""
    equivalent: bool
    """Identical, or different only among plays tied within TIE_TOLERANCE."""
    max_distance_error: float


def compare_to_reference(
    got: list[tuple[str, float]],
    unit_vectors: np.ndarray,
    index_of: dict[str, int],
    query_index: int,
    expected: list[Neighbour],
) -> Agreement:
    """Check a database result against the reference top-k."""
    got_ids = [g[0] for g in got]
    exp_ids = [e.play_id for e in expected]
    errors = []
    for pid, d in got:
        ref = 1.0 - float(unit_vectors[index_of[pid]] @ unit_vectors[query_index])
        errors.append(abs(ref - d))
    max_err = max(errors, default=0.0)
    if got_ids == exp_ids:
        return Agreement(True, True, max_err)
    if len(got_ids) != len(exp_ids) or max_err > 1e-5:
        return Agreement(False, False, max_err)
    # Differences are acceptable only between plays at (nearly) equal distance.
    ok = True
    for (pid, d), e in zip(got, expected, strict=True):
        if pid != e.play_id and abs(d - e.distance) > TIE_TOLERANCE:
            ok = False
    if set(got_ids) != set(exp_ids):
        boundary = expected[-1].distance
        for pid, d in got:
            if pid not in exp_ids and abs(d - boundary) > TIE_TOLERANCE:
                ok = False
    return Agreement(False, ok, max_err)
