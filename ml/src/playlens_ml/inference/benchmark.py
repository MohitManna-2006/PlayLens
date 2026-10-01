"""Inference latency benchmark on real test-split plays.

    uv run python -m playlens_ml.inference.benchmark --model-dir
    artifacts/models/<version> [--device cpu]

Times ``TrajectoryPredictor.predict_play`` (feature build + forward pass, one
play per call, warm) for plays chosen by a salted hash, not by speed. Data
loading and HTTP are excluded. Writes benchmark.json into the model artifact
so the API and the model card report the same numbers.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl
import torch

from ..data import canonical_schema as cs
from ..data.artifacts import ProcessedLayout, load_processed
from ..data.bdb2026.spec import DATASET_NAME
from ..data.manifest import utc_now
from ..data.paths import data_layout
from ..datasets.splits import load_splits
from .predictor import TrajectoryPredictor, Unsupported

KEY = ["game_id", "play_id"]


def hardware() -> str:
    try:
        import subprocess

        chip = subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True
        ).stdout.strip()
    except OSError:
        chip = ""
    return f"{chip or platform.processor()} ({platform.machine()}, {platform.system()})"


def run_benchmark(
    model_dir: Path,
    device: str = "cpu",
    n_plays: int = 200,
    warmup: int = 10,
    subset: str = "full",
) -> dict[str, Any]:
    torch.set_grad_enabled(False)
    predictor = TrajectoryPredictor.load(model_dir, device)
    layout = ProcessedLayout.for_subset(data_layout().processed, DATASET_NAME, subset)
    data = load_processed(layout)
    splits, _ = load_splits(layout)
    test_ids = splits.filter(pl.col("split") == "test")["id"].to_list()
    chosen = sorted(
        test_ids, key=lambda i: hashlib.sha256(f"bench-v1:{i}".encode()).hexdigest()
    )[: n_plays + warmup]
    keys = data.plays.filter(pl.col("id").is_in(chosen)).select(*KEY, "id")
    tracking = (
        data.scan(cs.OBSERVED_TRACKING).join(keys.lazy(), on=KEY, how="semi").collect()
    )
    per_play = []
    for pid in chosen:
        play = data.plays.filter(pl.col("id") == pid)
        g, p = int(play["game_id"][0]), int(play["play_id"][0])
        flt = (pl.col("game_id") == g) & (pl.col("play_id") == p)
        per_play.append((play, data.players.filter(flt), tracking.filter(flt)))

    times: list[float] = []
    players = 0
    for i, (play, pls, trk) in enumerate(per_play):
        t0 = time.perf_counter()
        out = predictor.predict_play(play, pls, trk)
        if device == "mps":
            torch.mps.synchronize()
        elapsed = (time.perf_counter() - t0) * 1000
        if isinstance(out, Unsupported):
            continue
        if i >= warmup:
            times.append(elapsed)
            players += len(out.players)
    arr = np.array(times)
    return {
        "model_version": predictor.artifact.model_version,
        "operation": (
            "predict_play: feature build + forward pass, one play per call, warm"
        ),
        "timing_scope": "model_only",
        "excludes": "data loading, HTTP, JSON serialization",
        "device": device,
        "hardware": hardware(),
        "batch_size": 1,
        "plays": len(times),
        "target_players": players,
        "warmup_calls": warmup,
        "p50_ms": round(float(np.percentile(arr, 50)), 2),
        "p95_ms": round(float(np.percentile(arr, 95)), 2),
        "p99_ms": round(float(np.percentile(arr, 99)), 2),
        "mean_ms": round(float(arr.mean()), 2),
        "torch_threads": torch.get_num_threads(),
        "measured_at": utc_now(),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--device", default="cpu", choices=["cpu", "mps", "cuda"])
    parser.add_argument("--plays", type=int, default=200)
    args = parser.parse_args(argv)
    result = run_benchmark(args.model_dir, args.device, args.plays)
    path = args.model_dir / "benchmark.json"
    existing = json.loads(path.read_text()) if path.is_file() else {}
    existing[args.device] = result
    path.write_text(json.dumps(existing, indent=2) + "\n")
    print(
        f"{result['model_version']} on {args.device}: p50 {result['p50_ms']} ms, p95 "
        f"{result['p95_ms']} ms, "
        f"p99 {result['p99_ms']} ms over {result['plays']} plays -> {path}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
