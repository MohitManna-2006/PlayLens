"""Machine-readable evaluation artifacts for any trajectory predictor.

artifacts/evaluation/<eval_id>/
    metrics.json            summary, provenance, definitions
    horizon_metrics.parquet error by future step
    slice_metrics.parquet   ADE/FDE by side, role, position, supplied horizon
    predictions.parquet     one row per target player and future step
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

from ..features.samples import SampleSet
from .metrics import (
    PlayerErrors,
    horizon_bucket,
    horizon_curve,
    player_errors,
    slice_metrics,
    summarize,
)

DEFINITIONS = {
    "units": "yards, canonical field coordinates (offense attacks +x)",
    "ade": (
        "Mean over target players of the mean Euclidean error over that player's "
        "valid future steps."
    ),
    "fde": (
        "Mean over target players of the Euclidean error at that player's last valid "
        "future step."
    ),
    "valid_step": (
        "A future step k (1..H) for which the dataset supplies the player's actual "
        "position."
    ),
    "horizon": (
        "H future steps of 0.1 s after the last observed frame; longer supplied "
        "futures are truncated at H."
    ),
}


def target_rows(samples: SampleSet) -> np.ndarray:
    """Player rows that are forecast targets with at least one valid future step."""
    return np.flatnonzero(samples.to_predict & samples.target_mask.any(axis=1))


@dataclass
class Evaluation:
    summary: dict[str, Any]
    horizon: pl.DataFrame
    slices: pl.DataFrame
    predictions: pl.DataFrame
    errors: PlayerErrors


def evaluate(
    samples: SampleSet, rows: np.ndarray, pred: np.ndarray, split: str
) -> Evaluation:
    """``pred`` is [len(rows), H, 2] for the given target player rows."""
    target = samples.target[rows]
    mask = samples.target_mask[rows]
    e = player_errors(pred, target, mask)
    play_of_row = np.searchsorted(samples.offsets, rows, side="right") - 1
    supplied = samples.target_horizon[play_of_row]
    labels = {
        "side": samples.side[rows],
        "role": samples.role[rows],
        "position": samples.position[rows],
        "supplied_horizon": horizon_bucket(supplied),
    }
    summary = {
        "split": split,
        **summarize(e),
        "plays": int(len(np.unique(play_of_row))),
    }
    h = pred.shape[1]
    steps = np.tile(np.arange(1, h + 1), len(rows))
    rep = np.repeat(np.arange(len(rows)), h)
    predictions = pl.DataFrame(
        {
            "id": samples.ids[play_of_row][rep],
            "game_id": samples.game_id[play_of_row][rep],
            "play_id": samples.play_id[play_of_row][rep],
            "nfl_id": samples.nfl_id[rows][rep],
            "side": samples.side[rows][rep],
            "position": samples.position[rows][rep],
            "step": steps,
            "frame_id": steps,  # output-file frame_id: step k is frame_id k
            "pred_x": pred[:, :, 0].reshape(-1),
            "pred_y": pred[:, :, 1].reshape(-1),
            "true_x": target[:, :, 0].reshape(-1),
            "true_y": target[:, :, 1].reshape(-1),
            "valid": mask.reshape(-1),
            "error_yd": e.error.reshape(-1),
        }
    )
    return Evaluation(
        summary=summary,
        horizon=pl.DataFrame(horizon_curve(e)),
        slices=pl.DataFrame(slice_metrics(e, labels)),
        predictions=predictions,
        errors=e,
    )


def write_evaluation(out_dir: Path, ev: Evaluation, provenance: dict[str, Any]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "summary": ev.summary,
        "horizon": ev.horizon.to_dicts(),
        "slices": ev.slices.to_dicts(),
        "definitions": DEFINITIONS,
        "provenance": provenance,
    }
    (out_dir / "metrics.json").write_text(
        json.dumps(payload, indent=2, sort_keys=True, default=str) + "\n"
    )
    ev.horizon.write_parquet(out_dir / "horizon_metrics.parquet")
    ev.slices.write_parquet(out_dir / "slice_metrics.parquet")
    ev.predictions.write_parquet(out_dir / "predictions.parquet")
