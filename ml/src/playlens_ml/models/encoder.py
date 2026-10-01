"""Spatial-temporal play encoder (Masterbrain §11, ADR-0004).

    observed frame t -> player nodes -> kNN interaction graph -> GATv2 layers (spatial)
    per-player frame sequence -> Transformer encoder with padding mask (temporal)
    last observed frame -> one GATv2 interaction layer over contextual players
    players -> attention pooling -> play embedding

Only observed frames enter the encoder; the attention mask hides padded frames
and nothing after the prediction origin exists in the input.
"""

from __future__ import annotations

import warnings
from dataclasses import asdict, dataclass, field
from typing import Any

import torch
from torch import nn

from ..features.spec import CATEGORICAL_FEATURES, NUMERIC_FEATURES
from ..graphs.knn import EDGE_FEATURES, knn_graph

# torch_geometric scripts helpers at import time; torch 2.14 deprecates jit.script.
warnings.filterwarnings(
    "ignore", message="`torch.jit.script` is deprecated", category=FutureWarning
)
from torch_geometric.nn import GATv2Conv  # noqa: E402


@dataclass
class EncoderConfig:
    window: int
    vocab_sizes: dict[str, int] = field(default_factory=dict)
    hidden: int = 96
    categorical_dim: int = 8
    knn: int = 4
    gnn_layers: int = 2
    gnn_heads: int = 4
    transformer_layers: int = 2
    transformer_heads: int = 4
    ff_mult: int = 2
    dropout: float = 0.1
    embedding_dim: int = 128
    interaction_layer: bool = True

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


class GraphBlock(nn.Module):
    """Pre-norm residual GATv2 layer that consumes edge features."""

    def __init__(self, hidden: int, heads: int, dropout: float) -> None:
        super().__init__()
        if hidden % heads:
            raise ValueError("hidden must be divisible by gnn_heads")
        self.norm = nn.LayerNorm(hidden)
        self.conv = GATv2Conv(
            hidden,
            hidden // heads,
            heads=heads,
            edge_dim=len(EDGE_FEATURES),
            add_self_loops=True,
            fill_value="mean",
            dropout=0.0,
        )
        self.drop = nn.Dropout(dropout)

    def forward(
        self, h: torch.Tensor, edge_index: torch.Tensor, edge_attr: torch.Tensor
    ) -> torch.Tensor:
        msg = torch.nn.functional.gelu(self.conv(self.norm(h), edge_index, edge_attr))
        out: torch.Tensor = h + self.drop(msg)
        return out


@dataclass
class EncoderOutput:
    players: torch.Tensor  # [B, P, D] contextual player state at the origin
    play_embedding: torch.Tensor  # [B, E]
    pool_weights: torch.Tensor  # [B, P]


class SpatialTemporalEncoder(nn.Module):
    mean: torch.Tensor
    std: torch.Tensor

    def __init__(self, cfg: EncoderConfig, mean: list[float], std: list[float]) -> None:
        super().__init__()
        self.cfg = cfg
        d = cfg.hidden
        self.register_buffer("mean", torch.tensor(mean, dtype=torch.float32))
        self.register_buffer("std", torch.tensor(std, dtype=torch.float32))
        self.embeds = nn.ModuleList(
            nn.Embedding(cfg.vocab_sizes[name], cfg.categorical_dim)
            for name in CATEGORICAL_FEATURES
        )
        in_dim = (
            len(NUMERIC_FEATURES) + len(CATEGORICAL_FEATURES) * cfg.categorical_dim + 1
        )
        self.input = nn.Sequential(nn.Linear(in_dim, d), nn.GELU(), nn.Linear(d, d))
        self.spatial = nn.ModuleList(
            GraphBlock(d, cfg.gnn_heads, cfg.dropout) for _ in range(cfg.gnn_layers)
        )
        self.position = nn.Parameter(torch.zeros(cfg.window, d))
        nn.init.normal_(self.position, std=0.02)
        layer = nn.TransformerEncoderLayer(
            d,
            cfg.transformer_heads,
            d * cfg.ff_mult,
            cfg.dropout,
            activation="gelu",
            batch_first=True,
            norm_first=True,
        )
        self.temporal = nn.TransformerEncoder(
            layer, cfg.transformer_layers, enable_nested_tensor=False
        )
        self.temporal_norm = nn.LayerNorm(d)
        self.interaction = (
            GraphBlock(d, cfg.gnn_heads, cfg.dropout) if cfg.interaction_layer else None
        )
        self.pool_score = nn.Linear(d, 1)
        self.project = nn.Sequential(
            nn.Linear(d, cfg.embedding_dim), nn.LayerNorm(cfg.embedding_dim)
        )

    def node_inputs(
        self, numeric: torch.Tensor, categorical: torch.Tensor, to_predict: torch.Tensor
    ) -> torch.Tensor:
        b, p, t, _ = numeric.shape
        x = (numeric - self.mean) / self.std
        cats = torch.cat(
            [emb(categorical[..., i]) for i, emb in enumerate(self.embeds)], dim=-1
        )  # [B,P,C*e]
        static = (
            torch.cat([cats, to_predict.float().unsqueeze(-1)], dim=-1)
            .unsqueeze(2)
            .expand(b, p, t, -1)
        )
        return torch.cat([x, static], dim=-1)

    def forward(
        self,
        numeric: torch.Tensor,
        xy: torch.Tensor,
        vel: torch.Tensor,
        mask: torch.Tensor,
        categorical: torch.Tensor,
        to_predict: torch.Tensor,
        player_mask: torch.Tensor,
    ) -> EncoderOutput:
        b, p, t, _ = numeric.shape
        d = self.cfg.hidden
        side = categorical[..., CATEGORICAL_FEATURES.index("side")]  # [B, P]
        h = self.input(self.node_inputs(numeric, categorical, to_predict))  # [B,P,T,D]
        h = h * mask.unsqueeze(-1)

        # Spatial: one graph per (play, frame); node id = (b*T + t)*P + p.
        if self.spatial:
            frame_xy = xy.permute(0, 2, 1, 3).reshape(b * t, p, 2)
            frame_vel = vel.permute(0, 2, 1, 3).reshape(b * t, p, 2)
            frame_side = side.unsqueeze(1).expand(b, t, p).reshape(b * t, p)
            frame_valid = mask.permute(0, 2, 1).reshape(b * t, p)
            graph = knn_graph(
                frame_xy, frame_vel, frame_side, frame_valid, self.cfg.knn
            )
            nodes = h.permute(0, 2, 1, 3).reshape(b * t * p, d)
            keep = frame_valid.reshape(-1, 1)
            for block in self.spatial:
                nodes = block(nodes, graph.edge_index, graph.edge_attr) * keep
            h = nodes.reshape(b, t, p, d).permute(0, 2, 1, 3)

        # Temporal: one sequence per player, right-aligned so the last slot is the
        # origin.
        seq = h.reshape(b * p, t, d) + self.position
        pad = ~mask.reshape(b * p, t)
        # Padded players keep one slot so attention is defined; zeroed below.
        pad[:, -1] = False
        z = self.temporal_norm(
            self.temporal(seq, src_key_padding_mask=pad)[:, -1]
        ).reshape(b, p, d)
        z = z * player_mask.unsqueeze(-1)

        if self.interaction is not None:
            graph = knn_graph(
                xy[:, :, -1], vel[:, :, -1], side, player_mask, self.cfg.knn
            )
            z = (
                self.interaction(z.reshape(b * p, d), graph.edge_index, graph.edge_attr)
            ).reshape(b, p, d)
            z = z * player_mask.unsqueeze(-1)

        scores = self.pool_score(z).squeeze(-1).masked_fill(~player_mask, float("-inf"))
        weights = torch.softmax(scores, dim=-1)
        weights = torch.nan_to_num(weights, nan=0.0)
        pooled = (weights.unsqueeze(-1) * z).sum(dim=1)
        return EncoderOutput(
            players=z, play_embedding=self.project(pooled), pool_weights=weights
        )
