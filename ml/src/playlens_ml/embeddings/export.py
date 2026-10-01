"""Export learned play embeddings from a trained trajectory model.

    uv run python -m playlens_ml.embeddings.export --model-dir
    artifacts/models/trajectory-gnn-transformer-v1

Each play's embedding is the encoder's attention-pooled play representation
(the same vector the trajectory head consumes), L2-normalised so cosine
similarity is a dot product. Output:

    data/processed/<dataset>/<subset>/embeddings/<model_version>.parquet
        id, game_id, play_id, week, split, model_version, embedding (float32[E]),
        raw_norm
    data/manifests/<dataset>.<subset>.embeddings.<model_version>.json   (committed:
    counts, hashes)
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl
import torch

from ..data.artifacts import ProcessedLayout, sha256_file
from ..data.bdb2026.spec import DATASET_NAME
from ..data.manifest import utc_now, write_json
from ..data.paths import data_layout
from ..datasets.trajectory import TrajectoryData, load_trajectory_data
from ..inference.predictor import TrajectoryPredictor

DETERMINISM_TOLERANCE = 1e-4


class EmbeddingCheckError(RuntimeError):
    """An exported embedding table failed validation."""


@dataclass
class EmbeddingExport:
    table: pl.DataFrame
    path: Path
    manifest: dict[str, Any]


def embedding_table(
    data: TrajectoryData, embeddings: np.ndarray, model_version: str
) -> pl.DataFrame:
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    unit = (embeddings / np.maximum(norms, 1e-12)).astype(np.float32)
    s = data.samples
    return pl.DataFrame(
        {
            "id": s.ids,
            "game_id": s.game_id,
            "play_id": s.play_id,
            "week": s.week,
            "split": data.split,
            "model_version": [model_version] * s.n_plays,
            "embedding": pl.Series(unit, dtype=pl.Array(pl.Float32, unit.shape[1])),
            "raw_norm": norms[:, 0].astype(np.float32),
        }
    )


def validate_table(table: pl.DataFrame, expected_rows: int, dim: int) -> dict[str, Any]:
    emb = np.asarray(table["embedding"].to_numpy())
    checks = {
        "rows": table.height,
        "expected_rows": expected_rows,
        "dimension": int(emb.shape[1]),
        "finite": bool(np.isfinite(emb).all()),
        "unique_play_model_pairs": table.select("id", "model_version").unique().height
        == table.height,
        "unit_norm_max_deviation": float(np.abs(np.linalg.norm(emb, axis=1) - 1).max()),
    }
    problems = []
    if checks["rows"] != expected_rows:
        problems.append(f"expected {expected_rows} rows, found {checks['rows']}")
    if checks["dimension"] != dim:
        problems.append(f"expected dimension {dim}, found {checks['dimension']}")
    if not checks["finite"]:
        problems.append("embeddings contain NaN or Inf")
    if not checks["unique_play_model_pairs"]:
        problems.append("duplicate (play, model_version) rows")
    if problems:
        raise EmbeddingCheckError("; ".join(problems))
    return checks


def export_embeddings(
    model_dir: Path,
    subset: str = "full",
    device: str = "cpu",
    data_root: Path | None = None,
) -> EmbeddingExport:
    predictor = TrajectoryPredictor.load(model_dir, device)
    art = predictor.artifact
    data = load_trajectory_data(subset, art.window, art.horizon, data_root=data_root)
    _, emb = predictor.predict_samples(data.samples, batch_size=256)
    table = embedding_table(data, emb, art.model_version)
    checks = validate_table(
        table, data.samples.n_plays, art.model.encoder_cfg.embedding_dim
    )

    # Determinism: re-embed a fixed sample of plays and compare.
    probe = np.arange(min(256, data.samples.n_plays))
    _, again = predictor.predict_samples(data.samples.select(probe), batch_size=32)
    drift = float(np.abs(again - emb[probe]).max())
    checks["determinism_max_abs_diff"] = drift
    if drift > DETERMINISM_TOLERANCE:
        raise EmbeddingCheckError(
            f"Repeated inference differs by {drift:.2e} (> {DETERMINISM_TOLERANCE})."
        )

    layout = data_layout(root=data_root)
    processed = ProcessedLayout.for_subset(layout.processed, DATASET_NAME, subset)
    path = processed.root / "embeddings" / f"{art.model_version}.parquet"
    path.parent.mkdir(parents=True, exist_ok=True)
    table.write_parquet(path)
    manifest = {
        "model_version": art.model_version,
        "model_weights_sha256": art.metadata["weights_sha256"],
        "dataset_version": data.dataset_version,
        "model_dataset_version": art.metadata["dataset_version"],
        "split_version": data.split_version,
        "subset": subset,
        "dimension": checks["dimension"],
        "normalization": "L2-normalised; cosine similarity = dot product",
        "rows_by_split": {k: int(v) for k, v in table.group_by("split").len().rows()},
        "checks": checks,
        "device": device,
        "path": str(path.relative_to(layout.root.parent))
        if path.is_relative_to(layout.root.parent)
        else str(path),
        "sha256": sha256_file(path),
        "generated_at": utc_now(),
    }
    write_json(
        layout.manifests
        / f"{DATASET_NAME}.{subset}.embeddings.{art.model_version}.json",
        manifest,
    )
    return EmbeddingExport(table, path, manifest)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--subset", default="full")
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args(argv)
    torch.set_grad_enabled(False)
    out = export_embeddings(args.model_dir, args.subset, args.device)
    m = out.manifest
    print(
        f"exported {out.table.height} embeddings (dim {m['dimension']}) -> {out.path}",
        file=sys.stderr,
    )
    print(
        f"  by split {m['rows_by_split']}  determinism drift "
        f"{m['checks']['determinism_max_abs_diff']:.2e}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
