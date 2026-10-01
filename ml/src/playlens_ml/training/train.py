"""Train the spatial-temporal trajectory model.

    uv run python -m playlens_ml.training.train --config
    configs/trajectory_gnn_transformer.yaml
    uv run python -m playlens_ml.training.train --config ... --overfit 32 --epochs 300
    # sanity check

Model selection uses validation ADE only. After training, the best checkpoint
is frozen, scored once on validation and once on test next to the
constant-velocity baseline, and exported as a deployable artifact. Every run
writes artifacts/runs/<run_id>/ and an MLflow run.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch

from ..data.artifacts import ProcessedLayout, load_processed
from ..data.bdb2026.spec import DATASET_NAME
from ..data.manifest import utc_now
from ..data.paths import data_layout, find_repo_root
from ..datasets.splits import load_splits
from ..datasets.trajectory import (
    TrajectoryData,
    horizon_from_train,
    iterate_batches,
    load_trajectory_data,
)
from ..evaluation.evaluate import BASELINE_VERSIONS, evaluate_and_write, provenance
from ..evaluation.model_report import build_model_report
from ..features import spec as feature_spec
from ..features.encoding import Encoders, fit_encoders
from ..features.samples import SampleSet
from ..inference.artifact import TrajectoryArtifact
from ..inference.predictor import predict_positions
from ..models.encoder import EncoderConfig
from ..models.trajectory import (
    HeadConfig,
    TrajectoryModel,
    count_parameters,
    masked_displacement_loss,
)
from .config import TrainingConfig, load_config
from .runtime import environment, new_run_id, seed_everything, select_device
from .tracking import RunTracker

log = logging.getLogger("playlens.ml.train")


@dataclass
class TrainingResult:
    run_id: str
    run_dir: Path
    summary: dict[str, Any]
    artifact_dir: Path | None


def resolve_horizon(cfg: TrainingConfig, data_root: Path | None) -> int:
    if isinstance(cfg.data.horizon, int):
        return cfg.data.horizon
    layout = ProcessedLayout.for_subset(
        data_layout(root=data_root).processed, DATASET_NAME, cfg.data.subset
    )
    return horizon_from_train(load_processed(layout), load_splits(layout)[0], 0.95)


def build_model(
    cfg: TrainingConfig, encoders: Encoders, window: int, horizon: int
) -> TrajectoryModel:
    m = cfg.model
    enc = EncoderConfig(
        window=window,
        vocab_sizes={k: len(v) for k, v in encoders.vocabs.items()},
        hidden=m.hidden,
        categorical_dim=m.categorical_dim,
        knn=m.knn,
        gnn_layers=m.gnn_layers,
        gnn_heads=m.gnn_heads,
        transformer_layers=m.transformer_layers,
        transformer_heads=m.transformer_heads,
        ff_mult=m.ff_mult,
        dropout=m.dropout,
        embedding_dim=m.embedding_dim,
        interaction_layer=m.interaction_layer,
    )
    head = HeadConfig(
        horizon=horizon,
        hidden=m.head_hidden,
        target_representation=m.target_representation,
    )
    return TrajectoryModel(enc, head, list(encoders.mean), list(encoders.std))


def lr_lambda(total_steps: int, warmup_steps: int) -> Callable[[int], float]:
    def f(step: int) -> float:
        if step < warmup_steps:
            return (step + 1) / max(1, warmup_steps)
        progress = (step - warmup_steps) / max(1, total_steps - warmup_steps)
        return 0.5 * (1 + math.cos(math.pi * min(1.0, progress)))

    return f


def validation_scores(
    model: TrajectoryModel, encoders: Encoders, samples: SampleSet, device: torch.device
) -> dict[str, float]:
    pred, _ = predict_positions(model, encoders, samples, device)
    ev = evaluate_and_write(samples, "validation", pred, "epoch", {}, None)
    valid = samples.target_mask & samples.to_predict[:, None]
    dist = np.linalg.norm(pred - samples.target, axis=-1)
    return {
        "ade": ev.summary["ade_yd"],
        "fde": ev.summary["fde_yd"],
        "loss": float(dist[valid].mean()),
    }


def run_training(
    cfg: TrainingConfig,
    overfit: int | None = None,
    data_root: Path | None = None,
    artifacts_root: Path | None = None,
    config_path: str | None = None,
) -> TrainingResult:
    """``artifacts_root`` (default <repo>/artifacts) receives runs/, evaluation/, and
    models/."""
    if cfg.export and not cfg.evaluate_test:
        raise ValueError(
            "An exported model needs its test evaluation; set export: false."
        )
    started = time.perf_counter()
    seed_everything(cfg.seed)
    device = select_device(cfg.train.device)
    run_id = new_run_id("overfit" if overfit else cfg.model_name)
    artifacts = artifacts_root or find_repo_root() / "artifacts"
    run_dir = artifacts / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    feature_spec.assert_allowlist_is_safe()

    horizon = resolve_horizon(cfg, data_root)
    data: TrajectoryData = load_trajectory_data(
        cfg.data.subset, cfg.data.window, horizon, data_root=data_root
    )
    train_idx = data.indices("train")
    if overfit:
        train_idx = train_idx[:overfit]
    elif cfg.train.max_train_plays:
        rng = np.random.default_rng(cfg.seed)
        train_idx = np.sort(
            rng.choice(
                train_idx,
                size=min(cfg.train.max_train_plays, len(train_idx)),
                replace=False,
            )
        )
    train = data.samples.select(train_idx)
    val = train if overfit else data.subset("validation")
    encoders = fit_encoders(train)
    model = build_model(cfg, encoders, data.samples.window, horizon).to(device)
    params = count_parameters(model)

    env = environment(device)
    meta = {
        "run_id": run_id,
        "started_at": utc_now(),
        "model_name": cfg.model_name,
        "model_version": cfg.model_version,
        "dataset_version": data.dataset_version,
        "split_version": data.split_version,
        "window": data.samples.window,
        "horizon": horizon,
        "train_plays": train.n_plays,
        "validation_plays": val.n_plays,
        "parameters": params,
        "overfit_plays": overfit,
    }
    (run_dir / "config.json").write_text(json.dumps(cfg.to_json(), indent=2) + "\n")
    tracker = RunTracker(
        cfg.tracking.mlflow and not overfit,
        cfg.tracking.experiment,
        run_id,
        cfg.tracking.tracking_uri,
    )
    tracker.params({"config": cfg.to_json(), "meta": meta})
    tracker.tags(
        {
            "model_version": cfg.model_version,
            "dataset_version": data.dataset_version,
            "split_version": data.split_version,
            "git_commit": str(env["git"]["commit"]),
            "device": str(device),
        }
    )
    log.info(
        "run %s device=%s params=%d train=%d val=%d window=%d horizon=%d",
        run_id,
        device,
        params,
        train.n_plays,
        val.n_plays,
        data.samples.window,
        horizon,
    )

    batches_per_epoch = math.ceil(train.n_plays / cfg.train.batch_size)
    total_steps = batches_per_epoch * cfg.train.epochs
    opt = torch.optim.AdamW(
        model.parameters(), lr=cfg.train.lr, weight_decay=cfg.train.weight_decay
    )
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lr_lambda(total_steps, int(cfg.train.warmup_epochs * batches_per_epoch))
    )
    categorical = encoders.categorical(train)

    history: list[dict[str, float | None]] = []
    best = {"ade": float("inf"), "epoch": -1}
    initial = validation_scores(model, encoders, val, device)
    history.append(
        {
            "epoch": 0,
            "train_loss": None,  # no training before epoch 1
            "val_loss": initial["loss"],
            "val_ade": initial["ade"],
            "val_fde": initial["fde"],
            "lr": 0.0,
            "seconds": 0.0,
        }
    )
    stale = 0
    for epoch in range(1, cfg.train.epochs + 1):
        t0 = time.perf_counter()
        model.train()
        losses = []
        mirror = 0.0 if overfit else cfg.train.mirror_probability
        for batch in iterate_batches(
            train, encoders, cfg.train.batch_size, cfg.seed + epoch, mirror, categorical
        ):
            batch = batch.to(device)
            out = model(
                batch.numeric,
                batch.xy,
                batch.vel,
                batch.mask,
                batch.categorical,
                batch.to_predict,
                batch.player_mask,
            )
            loss = masked_displacement_loss(
                out.positions, batch.target, batch.target_mask, batch.to_predict
            )
            opt.zero_grad(set_to_none=True)
            loss.backward()  # type: ignore[no-untyped-call]
            torch.nn.utils.clip_grad_norm_(model.parameters(), cfg.train.grad_clip)
            opt.step()
            sched.step()
            losses.append(float(loss.detach().cpu()))
        scores = validation_scores(model, encoders, val, device)
        row: dict[str, float] = {
            "epoch": epoch,
            "train_loss": float(np.mean(losses)),
            "val_loss": scores["loss"],
            "val_ade": scores["ade"],
            "val_fde": scores["fde"],
            "lr": float(sched.get_last_lr()[0]),
            "seconds": time.perf_counter() - t0,
        }
        history.append(dict(row))
        tracker.metrics({k: v for k, v in row.items() if k != "epoch"}, step=epoch)
        log.info(
            "epoch %d train_loss %.4f val_ade %.4f val_fde %.4f (%.1fs)",
            epoch,
            row["train_loss"],
            row["val_ade"],
            row["val_fde"],
            row["seconds"],
        )
        if scores["ade"] < best["ade"] - 1e-4:
            best = {"ade": scores["ade"], "epoch": epoch}
            torch.save(model.state_dict(), run_dir / "best.pt")
            stale = 0
        else:
            stale += 1
            if not overfit and stale >= cfg.train.patience:
                log.info("early stop at epoch %d (best %d)", epoch, best["epoch"])
                break
    (run_dir / "history.json").write_text(json.dumps(history, indent=2) + "\n")

    model.load_state_dict(
        torch.load(run_dir / "best.pt", map_location=device, weights_only=True)
    )
    summary: dict[str, Any] = {
        **meta,
        "best_epoch": best["epoch"],
        "epochs_run": len(history) - 1,
        "environment": env,
        "finished_training_at": utc_now(),
        "history": history,
    }
    artifact_dir: Path | None = None
    if not overfit:
        summary["metrics"] = final_evaluation(
            model,
            encoders,
            data,
            device,
            run_id,
            tracker,
            artifacts / "evaluation",
            ("validation", "test") if cfg.evaluate_test else ("validation",),
        )
    summary["train_seconds"] = round(time.perf_counter() - started, 1)
    if not overfit and cfg.export:
        artifact = TrajectoryArtifact(
            model.cpu(),
            encoders,
            {
                "model_name": cfg.model_name,
                "model_version": cfg.model_version,
                "task": "trajectory",
                "run_id": run_id,
                "mlflow_run_id": tracker.run_id,
                "created_at": utc_now(),
                "dataset_version": data.dataset_version,
                "split_version": data.split_version,
                "split_policy": data.split_info["policy"],
                "games_by_split": data.split_info["games_by_split"],
                "parameters": params,
                "best_epoch": best["epoch"],
                "metrics": summary["metrics"],
                "training_device": str(device),
                "config_path": config_path,
                "config": cfg.to_json(),
                "git": env["git"],
                "uncertainty": "none",
            },
        )
        artifact_dir = artifact.save(artifacts / "models" / cfg.model_version)
        build_model_report(artifact_dir, artifacts / "evaluation")
        tracker.artifacts(artifact_dir, "model")
    (run_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, default=str) + "\n"
    )
    tracker.artifacts(run_dir / "summary.json")
    tracker.artifacts(run_dir / "config.json")
    tracker.end()
    return TrainingResult(run_id, run_dir, summary, artifact_dir)


def final_evaluation(
    model: TrajectoryModel,
    encoders: Encoders,
    data: TrajectoryData,
    device: torch.device,
    run_id: str,
    tracker: RunTracker,
    root: Path,
    splits: tuple[str, ...] = ("validation", "test"),
) -> dict[str, Any]:
    """Frozen best checkpoint: validation, then test once, each next to the
    baselines."""
    out: dict[str, Any] = {}
    prov = provenance(data, {"run_id": run_id})
    for split in splits:
        samples = data.subset(split)
        pred, _ = predict_positions(model, encoders, samples, device)
        ev = evaluate_and_write(
            samples, split, pred, "model", prov, root / run_id / f"model-{split}"
        )
        out[split] = {"model": ev.summary}
        for name in ("cv", "cv-fd"):
            b = evaluate_and_write(
                samples,
                split,
                None,
                BASELINE_VERSIONS[name],
                prov,
                root / run_id / f"{name}-{split}",
                baseline=name,
            )
            out[split][name] = b.summary
        tracker.metrics(
            {
                f"{split}_ade": ev.summary["ade_yd"],
                f"{split}_fde": ev.summary["fde_yd"],
                f"{split}_cv_ade": out[split]["cv"]["ade_yd"],
                f"{split}_cv_fde": out[split]["cv"]["fde_yd"],
            }
        )
        tracker.artifacts(
            root / run_id / f"model-{split}" / "metrics.json", f"evaluation/{split}"
        )
    return out


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument(
        "--overfit",
        type=int,
        default=None,
        help="Train and score on this many train plays only.",
    )
    parser.add_argument("--epochs", type=int, default=None)
    parser.add_argument("--device", default=None)
    parser.add_argument("--max-train-plays", type=int, default=None)
    parser.add_argument("--no-export", action="store_true")
    parser.add_argument("--no-mlflow", action="store_true")
    parser.add_argument("--model-version", default=None)
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    overrides: dict[str, Any] = {}
    if args.epochs is not None:
        overrides["train.epochs"] = args.epochs
    if args.device is not None:
        overrides["train.device"] = args.device
    if args.max_train_plays is not None:
        overrides["train.max_train_plays"] = args.max_train_plays
    if args.no_export:
        overrides["export"] = False
    if args.no_mlflow:
        overrides["tracking.mlflow"] = False
    if args.model_version:
        overrides["model_version"] = args.model_version
    cfg = load_config(args.config, overrides)
    try:
        config_path = str(args.config.resolve().relative_to(find_repo_root()))
    except ValueError:
        config_path = str(args.config)
    result = run_training(cfg, overfit=args.overfit, config_path=config_path)
    hist = result.summary["history"]
    print(
        f"\nrun {result.run_id}  best epoch {result.summary['best_epoch']}  -> "
        f"{result.run_dir}",
        file=sys.stderr,
    )
    print(
        f"  validation ADE: start {hist[0]['val_ade']:.3f}  best "
        f"{min(h['val_ade'] for h in hist):.3f} yd",
        file=sys.stderr,
    )
    for split, m in result.summary.get("metrics", {}).items():
        print(
            f"  {split:<10} model ADE {m['model']['ade_yd']:.3f} FDE "
            f"{m['model']['fde_yd']:.3f} | "
            f"CV ADE {m['cv']['ade_yd']:.3f} FDE {m['cv']['fde_yd']:.3f} yd",
            file=sys.stderr,
        )
    if result.artifact_dir:
        print(f"  artifact {result.artifact_dir}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
