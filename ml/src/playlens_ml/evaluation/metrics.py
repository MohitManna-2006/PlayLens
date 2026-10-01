"""Masked trajectory metrics. Units are yards (canonical field coordinates).

Definitions (Masterbrain §13.3):
    error(p, k)  Euclidean distance between predicted and actual position of
                 target player p at future step k (k = 1..H, 0.1 s apart).
    ADE(p)       mean of error(p, k) over p's valid steps.
    FDE(p)       error at p's last valid step, min(H, supplied horizon).
    ADE, FDE     means over target players with at least one valid step, so
                 every target player counts once regardless of horizon.
    error@k      mean error(p, k) over players valid at step k.
Padded steps never enter any average.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

MIN_SLICE_PLAYERS = 100


@dataclass(frozen=True)
class PlayerErrors:
    error: np.ndarray  # [n, H], nan where invalid
    ade: np.ndarray  # [n], nan when no valid step
    fde: np.ndarray  # [n]
    valid_steps: np.ndarray  # [n] int

    @property
    def scored(self) -> np.ndarray:
        return self.valid_steps > 0


def player_errors(
    pred: np.ndarray, target: np.ndarray, mask: np.ndarray
) -> PlayerErrors:
    """pred, target: [n, H, 2]; mask: [n, H] bool."""
    if pred.shape != target.shape or pred.shape[:2] != mask.shape:
        raise ValueError(
            f"Shape mismatch: pred {pred.shape}, target {target.shape}, mask "
            f"{mask.shape}"
        )
    err = np.linalg.norm(pred.astype(np.float64) - target.astype(np.float64), axis=-1)
    err = np.where(mask, err, np.nan)
    valid = mask.sum(axis=1)
    with np.errstate(invalid="ignore"):
        ade = np.where(valid > 0, np.nansum(err, axis=1) / np.maximum(valid, 1), np.nan)
    last = np.where(valid > 0, mask.shape[1] - 1 - np.argmax(mask[:, ::-1], axis=1), 0)
    fde = np.where(valid > 0, err[np.arange(len(err)), last], np.nan)
    return PlayerErrors(error=err, ade=ade, fde=fde, valid_steps=valid)


def summarize(e: PlayerErrors) -> dict[str, float | int]:
    s = e.scored
    n = int(s.sum())
    return {
        "ade_yd": float(np.mean(e.ade[s])) if n else float("nan"),
        "fde_yd": float(np.mean(e.fde[s])) if n else float("nan"),
        "players": n,
        "frames": int(e.valid_steps.sum()),
    }


def horizon_curve(e: PlayerErrors, dt: float = 0.1) -> list[dict[str, float | int]]:
    rows: list[dict[str, float | int]] = []
    for k in range(e.error.shape[1]):
        col = e.error[:, k]
        ok = ~np.isnan(col)
        rows.append(
            {
                "step": k + 1,
                "horizon_s": round((k + 1) * dt, 3),
                "error_yd": float(col[ok].mean()) if ok.any() else float("nan"),
                "players": int(ok.sum()),
            }
        )
    return rows


def slice_metrics(
    e: PlayerErrors, labels: dict[str, np.ndarray]
) -> list[dict[str, object]]:
    """ADE/FDE per value of each label array (aligned with players)."""
    rows: list[dict[str, object]] = []
    s = e.scored
    for name, values in labels.items():
        for value in sorted({str(v) for v in values[s]}):
            m = s & (values.astype(str) == value)
            n = int(m.sum())
            rows.append(
                {
                    "slice": name,
                    "value": value,
                    "players": n,
                    "ade_yd": float(e.ade[m].mean()) if n else float("nan"),
                    "fde_yd": float(e.fde[m].mean()) if n else float("nan"),
                    "sufficient": n >= MIN_SLICE_PLAYERS,
                }
            )
    return rows


def horizon_bucket(supplied: np.ndarray) -> np.ndarray:
    """Label each player by its supplied future length."""
    return np.select(
        [supplied <= 10, supplied <= 20],
        ["1-10 frames", "11-20 frames"],
        default="21+ frames",
    ).astype(str)
