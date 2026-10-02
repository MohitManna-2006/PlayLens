"""Structural descriptors for served plays.

Computed once at startup for the whole processed dataset (one streaming pass,
about a second for 14k plays), so search evidence costs a dictionary lookup.
Plays missing from that table (an injected repository in tests) are computed
on demand with the same function from the repository's rows.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

import polars as pl
from playlens_ml.data import canonical_schema as cs
from playlens_ml.data.artifacts import ProcessedDataset
from playlens_ml.descriptors import structural_descriptors

from ..repository.base import PlayRecord, PlayRepository

log = logging.getLogger("playlens.api.descriptors")


class DescriptorIndex:
    def __init__(self, repo: PlayRepository, table: pl.DataFrame | None = None) -> None:
        self._repo = repo
        self._rows: dict[tuple[int, int], dict[str, Any]] = {}
        self._lock = threading.Lock()
        if table is not None:
            for row in table.iter_rows(named=True):
                self._rows[(row["game_id"], row["play_id"])] = row

    @classmethod
    def build(cls, repo: PlayRepository, data: ProcessedDataset) -> DescriptorIndex:
        start = time.perf_counter()
        table = structural_descriptors(
            data.plays, data.players, data.scan(cs.OBSERVED_TRACKING)
        )
        log.info(
            "startup.descriptors",
            extra={
                "plays": table.height,
                "duration_ms": round((time.perf_counter() - start) * 1000, 1),
            },
        )
        return cls(repo, table)

    def __len__(self) -> int:
        return len(self._rows)

    def get(self, record: PlayRecord) -> dict[str, Any]:
        key = (record.game_id, record.play_id)
        with self._lock:
            row = self._rows.get(key)
        if row is None:
            row = self._compute(record)
            with self._lock:
                self._rows[key] = row
        return row

    def _compute(self, record: PlayRecord) -> dict[str, Any]:
        tracking = pl.DataFrame(
            [
                {**r, "game_id": record.game_id, "play_id": record.play_id}
                for r in self._repo.observed_tracking(record.game_id, record.play_id)
            ],
            schema_overrides={"s": pl.Float64},
        )
        players = pl.DataFrame(
            [
                {
                    "game_id": record.game_id,
                    "play_id": record.play_id,
                    "nfl_id": p["nfl_id"],
                    "side": p["side"],
                    "player_role": p.get("player_role"),
                }
                for p in record.players
            ]
        )
        out = structural_descriptors(
            pl.DataFrame([dict(record.play)]), players, tracking
        )
        row: dict[str, Any] = out.row(0, named=True)
        return row
