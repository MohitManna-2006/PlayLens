"""k-nearest-neighbour interaction graphs, one graph per (play, frame).

Nodes are the tracked players present in a frame. Each node receives directed
edges from its ``k`` nearest present players by canonical Euclidean distance
(``k`` shrinks to n-1 in small frames). There are no self edges here; message
layers may add their own self loops. Ties are broken by player slot so graphs
are deterministic. Offense and defense are not filtered: both are neighbours,
and a same-side flag is an edge feature.

Edge features (neighbour j -> node i), with fixed documented scales:
    dx/10, dy/10       position of j relative to i, yards / 10
    dist/10            Euclidean distance, yards / 10
    dvx/5, dvy/5       velocity of j relative to i, yd/s / 5
    same_side          1 when j and i are on the same side, else 0
"""

from __future__ import annotations

from dataclasses import dataclass

import torch

EDGE_FEATURES = ("dx", "dy", "dist", "dvx", "dvy", "same_side")
POSITION_SCALE = 10.0
VELOCITY_SCALE = 5.0


@dataclass
class Graph:
    edge_index: torch.Tensor  # [2, E] global node ids (source, target)
    edge_attr: torch.Tensor  # [E, len(EDGE_FEATURES)]


def knn_graph(
    xy: torch.Tensor,
    vel: torch.Tensor,
    side: torch.Tensor,
    valid: torch.Tensor,
    k: int,
) -> Graph:
    """Graphs for ``G`` frames of ``P`` player slots.

    xy, vel: [G, P, 2]; side: [G, P] int codes; valid: [G, P] bool.
    Node id of (g, p) is g * P + p.
    """
    g, p = valid.shape
    device = xy.device
    k_eff = min(k, p - 1)
    if k_eff <= 0:
        return Graph(
            torch.zeros((2, 0), dtype=torch.long, device=device),
            torch.zeros((0, len(EDGE_FEATURES)), dtype=xy.dtype, device=device),
        )
    dist = torch.cdist(xy, xy)  # [G, P, P]
    blocked = (~valid).unsqueeze(1) | torch.eye(
        p, dtype=torch.bool, device=device
    ).unsqueeze(0)
    dist = dist.masked_fill(blocked, float("inf"))
    order = torch.sort(dist, dim=-1, stable=True).indices[..., :k_eff]  # [G, P, k]
    nd = torch.gather(dist, -1, order)
    keep = valid.unsqueeze(-1) & torch.isfinite(nd)  # [G, P, k]
    base = (torch.arange(g, device=device) * p).view(g, 1, 1)
    dst = (base + torch.arange(p, device=device).view(1, p, 1)).expand(g, p, k_eff)[
        keep
    ]
    src = (base + order)[keep]
    flat_xy = xy.reshape(-1, 2)
    flat_vel = vel.reshape(-1, 2)
    flat_side = side.reshape(-1)
    rel = flat_xy[src] - flat_xy[dst]
    rel_v = flat_vel[src] - flat_vel[dst]
    attr = torch.cat(
        [
            rel / POSITION_SCALE,
            torch.linalg.vector_norm(rel, dim=-1, keepdim=True) / POSITION_SCALE,
            rel_v / VELOCITY_SCALE,
            (flat_side[src] == flat_side[dst]).to(xy.dtype).unsqueeze(-1),
        ],
        dim=-1,
    )
    return Graph(torch.stack([src, dst]), attr)
