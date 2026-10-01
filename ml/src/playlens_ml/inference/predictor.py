"""Typed trajectory inference over canonical play data.

``TrajectoryPredictor.predict_play`` takes one play's canonical rows (as the
API repository returns them), builds features with the same code used in
training, and returns predictions for the play's target players. Plays that
cannot be predicted return a typed reason instead of a guess.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import numpy as np
import polars as pl
import torch

from ..datasets.trajectory import iterate_batches
from ..features.encoding import Encoders
from ..features.samples import SampleSet, build_samples
from ..models.trajectory import TrajectoryModel
from .artifact import TrajectoryArtifact

UnsupportedReason = Literal[
    "no_observed_frames", "no_target_players", "too_few_observed_frames"
]
MIN_OBSERVED_FRAMES = (
    2  # constant-velocity residual needs a velocity; every real play has >= 8
)


@dataclass
class PlayerPrediction:
    nfl_id: int
    positions: np.ndarray  # [H, 2] canonical yards for future steps 1..H


@dataclass
class PlayPrediction:
    play_id: str
    origin_frame_id: int
    input_start_frame_id: int
    horizon: int
    players: list[PlayerPrediction]
    embedding: np.ndarray
    latency_ms: float


@dataclass
class Unsupported:
    play_id: str
    reason: UnsupportedReason
    message: str


@torch.no_grad()
def predict_positions(
    model: TrajectoryModel,
    encoders: Encoders,
    samples: SampleSet,
    device: torch.device,
    batch_size: int = 128,
) -> tuple[np.ndarray, np.ndarray]:
    """Run ``model`` in eval mode over every play; shared by training, evaluation, and
    serving."""
    model.eval()
    positions = np.zeros((len(samples.nfl_id), samples.horizon, 2), np.float32)
    embeddings = np.zeros(
        (samples.n_plays, model.encoder_cfg.embedding_dim), np.float32
    )
    categorical = encoders.categorical(samples)
    for batch in iterate_batches(
        samples, encoders, batch_size, categorical=categorical
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
        pos = out.positions.cpu().numpy()
        emb = out.encoder.play_embedding.cpu().numpy()
        for j, i in enumerate(batch.play_index.cpu().numpy()):
            sl = samples.play_slice(int(i))
            positions[sl] = pos[j, : sl.stop - sl.start]
            embeddings[i] = emb[j]
    return positions, embeddings


@dataclass
class TrajectoryPredictor:
    artifact: TrajectoryArtifact
    device: torch.device = field(default_factory=lambda: torch.device("cpu"))

    @classmethod
    def load(cls, directory: Path, device: str = "cpu") -> TrajectoryPredictor:
        dev = torch.device(device)
        return cls(TrajectoryArtifact.load(directory, dev), dev)

    def predict_samples(
        self, samples: SampleSet, batch_size: int = 128
    ) -> tuple[np.ndarray, np.ndarray]:
        """Positions for every player row [n_players, H, 2] and embeddings [n_plays,
        E]."""
        return predict_positions(
            self.artifact.model,
            self.artifact.encoders,
            samples,
            self.device,
            batch_size,
        )

    def predict_play(
        self, play: pl.DataFrame, players: pl.DataFrame, tracking: pl.DataFrame
    ) -> PlayPrediction | Unsupported:
        start = time.perf_counter()
        play_id = str(play["id"][0])
        if tracking.height == 0:
            return Unsupported(
                play_id,
                "no_observed_frames",
                "This play has no observed tracking frames.",
            )
        if tracking["frame_index"].n_unique() < MIN_OBSERVED_FRAMES:
            return Unsupported(
                play_id,
                "too_few_observed_frames",
                f"The model needs at least {MIN_OBSERVED_FRAMES} observed frames.",
            )
        if not players["player_to_predict"].any():
            return Unsupported(
                play_id,
                "no_target_players",
                "No player in this play is flagged for prediction.",
            )
        samples = build_samples(
            play, players, tracking, None, self.artifact.window, self.artifact.horizon
        )
        positions, embeddings = self.predict_samples(samples, batch_size=1)
        rows = np.flatnonzero(samples.to_predict)
        first_frame = int(tracking["frame_id"].to_numpy().min())
        start_frame = max(
            first_frame, int(samples.origin_frame_id[0]) - self.artifact.window + 1
        )
        return PlayPrediction(
            play_id=play_id,
            origin_frame_id=int(samples.origin_frame_id[0]),
            input_start_frame_id=start_frame,
            horizon=self.artifact.horizon,
            players=[
                PlayerPrediction(int(samples.nfl_id[r]), positions[r]) for r in rows
            ],
            embedding=embeddings[0],
            latency_ms=(time.perf_counter() - start) * 1000,
        )
