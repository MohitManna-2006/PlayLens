"""Evaluate a trajectory predictor on one split and write evaluation artifacts.

    python -m playlens_ml.evaluation.evaluate --predictor cv --split validation
    python -m playlens_ml.evaluation.evaluate --predictor model --model-dir
    artifacts/models/<version> --split validation

Every predictor is scored with the same samples, masks, and metric code. The
learned model's test score is produced once by the training command after
checkpoint selection; this CLI evaluates on test only when asked explicitly.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal

import numpy as np

from ..data.manifest import git_info, utc_now
from ..data.paths import find_repo_root
from ..datasets.splits import SPLITS
from ..datasets.trajectory import (
    TrajectoryData,
    horizon_from_train,
    load_trajectory_data,
)
from ..features.samples import SampleSet
from ..models.baselines import VelocitySource, predict_constant_velocity
from .report import Evaluation, evaluate, target_rows, write_evaluation

PredictorName = Literal["cv", "cv-fd", "model"]
BASELINES: dict[str, VelocitySource] = {"cv": "supplied", "cv-fd": "finite_difference"}
BASELINE_VERSIONS = {
    "cv": "trajectory-cv-baseline-v1",
    "cv-fd": "trajectory-cv-fd-baseline-v1",
}


def evaluation_root() -> Path:
    return find_repo_root() / "artifacts" / "evaluation"


def baseline_predictions(samples: SampleSet, rows: np.ndarray, name: str) -> np.ndarray:
    return predict_constant_velocity(
        samples.xy[rows],
        samples.vel[rows],
        samples.mask[rows],
        samples.horizon,
        BASELINES[name],
    )


def evaluate_and_write(
    samples: SampleSet,
    split: str,
    pred_all_rows: np.ndarray | None,
    predictor: str,
    provenance: dict[str, Any],
    out_dir: Path | None,
    baseline: str | None = None,
) -> Evaluation:
    """Score either full-row model predictions or a named constant-velocity baseline."""
    rows = target_rows(samples)
    if baseline:
        pred = baseline_predictions(samples, rows, baseline)
    else:
        assert pred_all_rows is not None, "model predictions or a baseline is required"
        pred = pred_all_rows[rows]
    ev = evaluate(samples, rows, pred, split)
    ev.summary["predictor"] = predictor
    if out_dir is not None:
        write_evaluation(
            out_dir,
            ev,
            {
                **provenance,
                "predictor": predictor,
                "split": split,
                "evaluated_at": utc_now(),
            },
        )
    return ev


def provenance(
    data: TrajectoryData, extra: dict[str, Any] | None = None
) -> dict[str, Any]:
    return {
        "dataset_version": data.dataset_version,
        "split_version": data.split_version,
        "window": data.samples.window,
        "horizon": data.samples.horizon,
        "git": git_info(find_repo_root()),
        **(extra or {}),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--predictor", choices=["cv", "cv-fd", "model"], default="cv")
    parser.add_argument("--split", choices=SPLITS, default="validation")
    parser.add_argument("--subset", default="full")
    parser.add_argument("--model-dir", type=Path, default=None)
    parser.add_argument("--window", type=int, default=20)
    parser.add_argument(
        "--horizon",
        type=int,
        default=None,
        help="Default: the train q95 rule (or the model's).",
    )
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args(argv)

    if args.predictor == "model":
        if args.model_dir is None:
            parser.error("--model-dir is required for --predictor model")
        from ..inference.predictor import TrajectoryPredictor

        predictor = TrajectoryPredictor.load(args.model_dir, args.device)
        window, horizon = predictor.artifact.window, predictor.artifact.horizon
        name = predictor.artifact.model_version
    else:
        from ..data.artifacts import ProcessedLayout, load_processed
        from ..data.bdb2026.spec import DATASET_NAME
        from ..data.paths import data_layout
        from ..datasets.splits import load_splits

        window = args.window
        layout = ProcessedLayout.for_subset(
            data_layout().processed, DATASET_NAME, args.subset
        )
        horizon = args.horizon or horizon_from_train(
            load_processed(layout), load_splits(layout)[0]
        )
        name = BASELINE_VERSIONS[args.predictor]
    data = load_trajectory_data(args.subset, window, horizon)
    samples = data.subset(args.split)
    out = evaluation_root() / f"{name}-{args.split}-{utc_now().replace(':', '')}"
    if args.predictor == "model":
        pred, _ = predictor.predict_samples(samples)
        ev = evaluate_and_write(
            samples,
            args.split,
            pred,
            name,
            provenance(data, {"model": predictor.artifact.metadata.get("run_id")}),
            out,
        )
    else:
        ev = evaluate_and_write(
            samples,
            args.split,
            None,
            name,
            provenance(data),
            out,
            baseline=args.predictor,
        )
    s = ev.summary
    print(
        f"{name} on {args.split}: ADE {s['ade_yd']:.3f} yd, FDE {s['fde_yd']:.3f} yd "
        f"({s['players']} target players, {s['plays']} plays) -> {out}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
