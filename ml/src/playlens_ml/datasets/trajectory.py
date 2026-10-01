"""Trajectory dataset: cached samples, split selection, and padded torch batches."""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl
import torch

from ..data import canonical_schema as cs
from ..data.artifacts import ProcessedDataset, ProcessedLayout, load_processed
from ..data.bdb2026.spec import DATASET_NAME
from ..data.paths import data_layout
from ..features.encoding import Encoders
from ..features.samples import SampleSet, build_samples
from ..features.spec import FEATURE_SCHEMA_VERSION, FIELD_CENTER_Y, NUMERIC_FEATURES
from .splits import load_splits, ml_dir

log = logging.getLogger("playlens.ml.dataset")
KEY = ["game_id", "play_id"]
_IDX = {name: i for i, name in enumerate(NUMERIC_FEATURES)}


@dataclass
class TrajectoryData:
    samples: SampleSet
    split: np.ndarray  # str per play
    dataset_version: str
    split_version: str
    split_info: dict[str, Any]
    cache_path: Path

    def indices(self, split: str) -> np.ndarray:
        return np.flatnonzero(self.split == split)

    def subset(self, split: str) -> SampleSet:
        return self.samples.select(self.indices(split))


def horizon_from_train(
    processed: ProcessedDataset, splits: pl.DataFrame, quantile: float = 0.95
) -> int:
    """Smallest horizon that fully covers ``quantile`` of train target players'
    supplied futures."""
    train_keys = splits.filter(pl.col("split") == "train").select(KEY)
    targets = (
        processed.players.filter(pl.col("player_to_predict"))
        .join(train_keys, on=KEY, how="semi")
        .join(processed.plays.select(*KEY, "future_frame_count"), on=KEY)
    )
    return int(
        np.ceil(
            targets["future_frame_count"].quantile(quantile, interpolation="higher")
            or 1
        )
    )


def load_trajectory_data(
    subset: str,
    window: int,
    horizon: int,
    data_root: Path | None = None,
    rebuild: bool = False,
) -> TrajectoryData:
    layout = data_layout(root=data_root)
    processed_layout = ProcessedLayout.for_subset(
        layout.processed, DATASET_NAME, subset
    )
    splits, split_info = load_splits(processed_layout)
    processed = load_processed(processed_layout)
    key = hashlib.sha256(
        json.dumps(
            [
                processed.dataset_version,
                split_info["split_version"],
                FEATURE_SCHEMA_VERSION,
                window,
                horizon,
            ]
        ).encode()
    ).hexdigest()[:12]
    cache = ml_dir(processed_layout) / f"samples-w{window}-h{horizon}-{key}.npz"
    if cache.is_file() and not rebuild:
        samples = SampleSet.load(cache)
    else:
        log.info("building samples window=%d horizon=%d", window, horizon)
        samples = build_samples(
            processed.plays,
            processed.players,
            processed.scan(cs.OBSERVED_TRACKING).collect(),
            processed.scan(cs.FUTURE_TRAJECTORIES).collect(),
            window=window,
            horizon=horizon,
            target_horizon=processed.plays.select(*KEY, "future_frame_count"),
        )
        samples.save(cache)
    order = pl.DataFrame({"id": samples.ids}).join(
        splits.select("id", "split"), on="id", how="left", maintain_order="left"
    )
    if order["split"].null_count():
        raise ValueError("Some plays have no split assignment; regenerate splits.")
    return TrajectoryData(
        samples=samples,
        split=order["split"].to_numpy().astype(str),
        dataset_version=processed.dataset_version,
        split_version=split_info["split_version"],
        split_info=split_info,
        cache_path=cache,
    )


@dataclass
class Batch:
    numeric: torch.Tensor  # [B, P, T, F] raw (the model standardizes)
    xy: torch.Tensor  # [B, P, T, 2]
    vel: torch.Tensor  # [B, P, T, 2]
    mask: torch.Tensor  # [B, P, T] bool, observed and real
    categorical: torch.Tensor  # [B, P, C] int64
    to_predict: torch.Tensor  # [B, P] bool
    player_mask: torch.Tensor  # [B, P] bool
    target: torch.Tensor  # [B, P, H, 2]
    target_mask: torch.Tensor  # [B, P, H] bool
    play_index: torch.Tensor  # [B] index into the SampleSet

    def to(self, device: torch.device) -> Batch:
        return Batch(**{k: v.to(device) for k, v in self.__dict__.items()})


def mirror_y(
    numeric: np.ndarray, xy: np.ndarray, vel: np.ndarray, target: np.ndarray
) -> None:
    """In-place reflection across the field's long axis (train-time augmentation).

    Offense still attacks +x. Under y' = W - y: vy, dy and cos(angle) change sign;
    sin(angle), x terms, speed, and time are unchanged.
    """
    w = 2 * FIELD_CENTER_Y
    for name in ("vy", "dy_prev", "cos_dir", "cos_o"):
        numeric[..., _IDX[name]] *= -1
    numeric[..., _IDX["y"]] = w - numeric[..., _IDX["y"]]
    xy[..., 1] = w - xy[..., 1]
    vel[..., 1] *= -1
    target[..., 1] = w - target[..., 1]


def collate(
    samples: SampleSet,
    categorical: np.ndarray,
    play_indices: np.ndarray,
    mirror: np.ndarray | None = None,
) -> Batch:
    """Pad players to the largest play in the batch. ``mirror`` flags plays to
    reflect."""
    b = len(play_indices)
    counts = samples.offsets[play_indices + 1] - samples.offsets[play_indices]
    p = int(counts.max()) if b else 1
    t, h, f = samples.window, samples.horizon, samples.numeric.shape[2]
    numeric = np.zeros((b, p, t, f), np.float32)
    xy = np.zeros((b, p, t, 2), np.float32)
    vel = np.zeros((b, p, t, 2), np.float32)
    mask = np.zeros((b, p, t), bool)
    cat = np.zeros((b, p, categorical.shape[1]), np.int64)
    to_predict = np.zeros((b, p), bool)
    player_mask = np.zeros((b, p), bool)
    target = np.zeros((b, p, h, 2), np.float32)
    target_mask = np.zeros((b, p, h), bool)
    for j, i in enumerate(play_indices):
        sl = samples.play_slice(int(i))
        n = sl.stop - sl.start
        numeric[j, :n] = samples.numeric[sl]
        xy[j, :n] = samples.xy[sl]
        vel[j, :n] = samples.vel[sl]
        mask[j, :n] = samples.mask[sl]
        cat[j, :n] = categorical[sl]
        to_predict[j, :n] = samples.to_predict[sl]
        player_mask[j, :n] = True
        target[j, :n] = samples.target[sl]
        target_mask[j, :n] = samples.target_mask[sl]
        if mirror is not None and mirror[j]:
            mirror_y(numeric[j, :n], xy[j, :n], vel[j, :n], target[j, :n])
    return Batch(
        numeric=torch.from_numpy(numeric),
        xy=torch.from_numpy(xy),
        vel=torch.from_numpy(vel),
        mask=torch.from_numpy(mask),
        categorical=torch.from_numpy(cat),
        to_predict=torch.from_numpy(to_predict),
        player_mask=torch.from_numpy(player_mask),
        target=torch.from_numpy(target),
        target_mask=torch.from_numpy(target_mask),
        play_index=torch.from_numpy(np.asarray(play_indices, dtype=np.int64)),
    )


def iterate_batches(
    samples: SampleSet,
    encoders: Encoders,
    batch_size: int,
    shuffle_seed: int | None = None,
    mirror_probability: float = 0.0,
    categorical: np.ndarray | None = None,
) -> Iterator[Batch]:
    """Deterministic batching; a seed shuffles play order and mirror draws."""
    categorical = encoders.categorical(samples) if categorical is None else categorical
    order = np.arange(samples.n_plays)
    rng = np.random.default_rng(shuffle_seed) if shuffle_seed is not None else None
    if rng is not None:
        rng.shuffle(order)
    for start in range(0, len(order), batch_size):
        idx = order[start : start + batch_size]
        mirror = (
            rng.random(len(idx)) < mirror_probability
            if (rng is not None and mirror_probability > 0)
            else None
        )
        yield collate(samples, categorical, idx, mirror)
