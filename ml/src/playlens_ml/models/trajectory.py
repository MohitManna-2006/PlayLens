"""Trajectory model: spatial-temporal encoder + future-path head (Masterbrain §13).

Target representation (``residual_cv``, default): the head predicts a per-step
correction to the constant-velocity extrapolation from the last observed frame,

    p_hat(k) = p_last + v_last * k * dt + r(k),     k = 1..H

with the final layer zero-initialised, so an untrained model equals the
constant-velocity baseline and training learns where players deviate from it.
``displacement`` predicts p_hat(k) - p_last directly, for comparison.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal

import torch
from torch import nn

from ..features.spec import FRAME_RATE_HZ
from .encoder import EncoderConfig, EncoderOutput, SpatialTemporalEncoder

TargetRepresentation = Literal["residual_cv", "displacement"]


@dataclass
class HeadConfig:
    horizon: int
    hidden: int = 192
    target_representation: TargetRepresentation = "residual_cv"

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class TrajectoryOutput:
    positions: torch.Tensor  # [B, P, H, 2] canonical yards
    encoder: EncoderOutput


class TrajectoryModel(nn.Module):
    steps: torch.Tensor

    def __init__(
        self,
        encoder_cfg: EncoderConfig,
        head_cfg: HeadConfig,
        mean: list[float],
        std: list[float],
    ) -> None:
        super().__init__()
        self.encoder_cfg = encoder_cfg
        self.head_cfg = head_cfg
        self.encoder = SpatialTemporalEncoder(encoder_cfg, mean, std)
        d, e = encoder_cfg.hidden, encoder_cfg.embedding_dim
        self.head = nn.Sequential(
            nn.Linear(d + e, head_cfg.hidden),
            nn.GELU(),
            nn.Dropout(encoder_cfg.dropout),
            nn.Linear(head_cfg.hidden, head_cfg.horizon * 2),
        )
        last = self.head[-1]
        assert isinstance(last, nn.Linear)
        nn.init.zeros_(last.weight)
        nn.init.zeros_(last.bias)
        steps = (
            torch.arange(1, head_cfg.horizon + 1, dtype=torch.float32) / FRAME_RATE_HZ
        )
        self.register_buffer("steps", steps.view(1, 1, -1, 1))

    def forward(
        self,
        numeric: torch.Tensor,
        xy: torch.Tensor,
        vel: torch.Tensor,
        mask: torch.Tensor,
        categorical: torch.Tensor,
        to_predict: torch.Tensor,
        player_mask: torch.Tensor,
    ) -> TrajectoryOutput:
        enc = self.encoder(numeric, xy, vel, mask, categorical, to_predict, player_mask)
        b, p, _ = enc.players.shape
        play = enc.play_embedding.unsqueeze(1).expand(b, p, -1)
        delta = self.head(torch.cat([enc.players, play], dim=-1)).view(
            b, p, self.head_cfg.horizon, 2
        )
        last = xy[:, :, -1].unsqueeze(2)  # [B,P,1,2]
        if self.head_cfg.target_representation == "residual_cv":
            base = last + vel[:, :, -1].unsqueeze(2) * self.steps
        else:
            base = last
        return TrajectoryOutput(positions=base + delta, encoder=enc)


def masked_displacement_loss(
    pred: torch.Tensor,
    target: torch.Tensor,
    target_mask: torch.Tensor,
    to_predict: torch.Tensor,
) -> torch.Tensor:
    """Mean Euclidean error over valid (target player, future step) pairs.

    Chosen because it is the quantity ADE reports (in yards), it is robust like
    L1, and it ignores padded steps and non-target players entirely.
    """
    valid = target_mask & to_predict.unsqueeze(-1)
    dist = torch.sqrt(((pred - target) ** 2).sum(dim=-1) + 1e-6)
    count = valid.sum().clamp(min=1)
    return (dist * valid).sum() / count


def count_parameters(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters() if p.requires_grad)
