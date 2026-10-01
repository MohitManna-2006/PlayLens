"""Device selection, seeding, and run provenance (Masterbrain §20)."""

from __future__ import annotations

import logging
import os
import platform
import random
import uuid
import warnings
from datetime import UTC, datetime
from importlib import metadata
from typing import Any, Literal

import numpy as np
import torch

from ..data.manifest import git_info
from ..data.paths import find_repo_root

log = logging.getLogger("playlens.ml.runtime")
DeviceChoice = Literal["auto", "cpu", "mps", "cuda"]
TRACKED_PACKAGES = ("torch", "torch-geometric", "numpy", "polars", "pyarrow", "mlflow")


class DeviceError(RuntimeError):
    """The requested device is not available on this machine."""


def select_device(choice: DeviceChoice) -> torch.device:
    """auto prefers CUDA, then Apple MPS, then CPU. Explicit choices fail clearly."""
    if choice == "cuda" or (choice == "auto" and torch.cuda.is_available()):
        if not torch.cuda.is_available():
            raise DeviceError("CUDA was requested but is not available.")
        return torch.device("cuda")
    if choice == "mps" or (choice == "auto" and torch.backends.mps.is_available()):
        if not torch.backends.mps.is_available():
            raise DeviceError(
                "MPS was requested but is not available (needs Apple silicon and a "
                "recent PyTorch)."
            )
        return torch.device("mps")
    return torch.device("cpu")


def seed_everything(seed: int, deterministic: bool = True) -> None:
    """Seed Python, NumPy, and torch.

    Deterministic kernels are requested where supported; MPS and some CUDA
    kernels remain nondeterministic, which is recorded with each run.
    """
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if deterministic:
        os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
        torch.use_deterministic_algorithms(True, warn_only=True)
        # MPS scatter kernels have no deterministic variant; this is recorded in each
        # run's
        # environment["deterministic_note"] instead of warning on every batch.
        warnings.filterwarnings(
            "ignore", message=r".*does not have a deterministic implementation.*"
        )


def new_run_id(prefix: str) -> str:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return f"{prefix}-{stamp}-{uuid.uuid4().hex[:6]}"


def environment(device: torch.device) -> dict[str, Any]:
    versions: dict[str, str | None] = {}
    for pkg in TRACKED_PACKAGES:
        try:
            versions[pkg] = metadata.version(pkg)
        except metadata.PackageNotFoundError:
            versions[pkg] = None
    return {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "device": str(device),
        "deterministic_note": (
            "CPU runs request deterministic kernels. MPS kernels (scatter-based "
            "attention softmax and "
            "Transformer reductions) are not guaranteed bit-reproducible."
            if device.type != "cpu"
            else "CPU with torch.use_deterministic_algorithms(True)."
        ),
        "packages": versions,
        "git": git_info(find_repo_root()),
    }
