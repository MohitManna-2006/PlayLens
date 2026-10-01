"""Compact evaluation report stored with a model artifact (served by the API).

    uv run python -m playlens_ml.evaluation.model_report --model-dir
    artifacts/models/<version>

Reads the training run's evaluation directories (artifacts/evaluation/<run_id>/
{model,cv,cv-fd}-{validation,test}/), adds 95% cluster-bootstrap intervals that
resample plays (players within a play are correlated), and writes
<model_dir>/evaluation.json with summaries, horizon curves, and slices for the
model and both constant-velocity baselines on both held-out splits.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

from ..data.paths import find_repo_root
from .metrics import MIN_SLICE_PLAYERS

PREDICTORS = ("model", "cv", "cv-fd")
SPLITS = ("validation", "test")
BOOTSTRAP_SAMPLES = 1000
BOOTSTRAP_SEED = 7


def per_player(predictions: pl.DataFrame) -> pl.DataFrame:
    valid = predictions.filter(pl.col("valid"))
    return (
        valid.sort("id", "nfl_id", "step")
        .group_by("id", "nfl_id", maintain_order=True)
        .agg(
            pl.col("error_yd").mean().alias("ade"),
            pl.col("error_yd").last().alias("fde"),
        )
    )


def cluster_bootstrap(
    players: pl.DataFrame, column: str, seed: int = BOOTSTRAP_SEED
) -> dict[str, float]:
    """95% percentile interval of the player-mean, resampling whole plays."""
    per_play = (
        players.group_by("id")
        .agg(pl.col(column).sum().alias("s"), pl.len().alias("n"))
        .sort("id")
    )
    sums, counts = per_play["s"].to_numpy(), per_play["n"].to_numpy()
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(sums), size=(BOOTSTRAP_SAMPLES, len(sums)))
    means = sums[idx].sum(axis=1) / counts[idx].sum(axis=1)
    return {
        "lo": float(np.percentile(means, 2.5)),
        "hi": float(np.percentile(means, 97.5)),
        "level": 0.95,
    }


def load_split_eval(directory: Path) -> dict[str, Any]:
    metrics = json.loads((directory / "metrics.json").read_text())
    players = per_player(pl.read_parquet(directory / "predictions.parquet"))
    return {
        "summary": metrics["summary"],
        "horizon": metrics["horizon"],
        "slices": metrics["slices"],
        "ade_interval": cluster_bootstrap(players, "ade"),
        "fde_interval": cluster_bootstrap(players, "fde"),
    }


def build_model_report(
    model_dir: Path, evaluation_root: Path | None = None
) -> dict[str, Any]:
    meta = json.loads((model_dir / "model.json").read_text())
    root = (evaluation_root or find_repo_root() / "artifacts" / "evaluation") / meta[
        "run_id"
    ]
    report: dict[str, Any] = {
        "model_version": meta["model_version"],
        "run_id": meta["run_id"],
        "bootstrap": {
            "samples": BOOTSTRAP_SAMPLES,
            "seed": BOOTSTRAP_SEED,
            "unit": "play",
        },
        "min_slice_players": MIN_SLICE_PLAYERS,
        "splits": {},
    }
    for split in SPLITS:
        report["splits"][split] = {
            p: load_split_eval(root / f"{p}-{split}") for p in PREDICTORS
        }
    out = model_dir / "evaluation.json"
    out.write_text(json.dumps(report, indent=2) + "\n")
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--model-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    report = build_model_report(args.model_dir)
    for split, preds in report["splits"].items():
        for name, ev in preds.items():
            s = ev["summary"]
            print(
                f"{split:<10} {name:<6} ADE {s['ade_yd']:.3f} "
                f"[{ev['ade_interval']['lo']:.3f}, {ev['ade_interval']['hi']:.3f}] "
                f"FDE {s['fde_yd']:.3f} n={s['players']}",
                file=sys.stderr,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
