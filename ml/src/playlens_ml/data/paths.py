"""Repository-relative data locations.

Nothing here hardcodes a machine path. The data root defaults to ``<repo>/data``
and can be overridden with ``PLAYLENS_DATA_ROOT``.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

REPO_MARKER = "PLAYLENS_MASTERBRAIN.md"
DATA_ROOT_ENV = "PLAYLENS_DATA_ROOT"


class DataPathError(RuntimeError):
    """A required data location could not be resolved."""


def find_repo_root(start: Path | None = None) -> Path:
    """Walk up from ``start`` (or this file, then the CWD) to the repo root."""
    candidates = [start] if start is not None else [Path(__file__), Path.cwd()]
    for origin in candidates:
        for directory in [origin, *origin.resolve().parents]:
            if (directory / REPO_MARKER).is_file():
                return directory
    raise DataPathError(
        f"Could not find the PlayLens repository root (no {REPO_MARKER} above "
        f"{candidates[0]}). Set {DATA_ROOT_ENV} to the data directory."
    )


@dataclass(frozen=True)
class DataLayout:
    """The four data areas from Masterbrain §8."""

    root: Path

    @property
    def raw(self) -> Path:
        return self.root / "raw"

    @property
    def interim(self) -> Path:
        return self.root / "interim"

    @property
    def processed(self) -> Path:
        return self.root / "processed"

    @property
    def manifests(self) -> Path:
        return self.root / "manifests"


def data_layout(
    env: Mapping[str, str] | None = None, root: Path | None = None
) -> DataLayout:
    """Resolve the data layout: explicit ``root`` > env override > ``<repo>/data``."""
    if root is not None:
        return DataLayout(root=root.resolve())
    env = os.environ if env is None else env
    override = env.get(DATA_ROOT_ENV)
    if override:
        return DataLayout(root=Path(override).expanduser().resolve())
    return DataLayout(root=find_repo_root() / "data")
