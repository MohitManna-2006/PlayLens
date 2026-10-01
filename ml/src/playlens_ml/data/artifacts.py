"""Processed-dataset layout, writing, and schema-checked loading.

The API and later ML code read processed data only through ``load_processed``,
which rejects artifacts whose columns or types differ from
``canonical_schema`` instead of serving partially trusted data.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import polars as pl

from . import canonical_schema as cs

DATASET_INFO_FILE = "dataset.json"


class ProcessedDatasetError(RuntimeError):
    """Processed artifacts are missing, stale, or corrupt."""


def conform(frame: pl.DataFrame, spec: cs.ArtifactSpec) -> pl.DataFrame:
    """Select, type, and sort exactly the columns of ``spec``."""
    missing = [c for c in spec.columns if c not in frame.columns]
    if missing:
        raise ValueError(f"{spec.name}: missing canonical columns {missing}")
    return frame.select(
        [pl.col(name).cast(dtype, strict=True) for name, dtype in spec.schema.items()]
    ).sort(list(spec.sort_by))


@dataclass(frozen=True)
class ProcessedLayout:
    root: Path
    """``<data>/processed/<dataset>/<subset>``"""

    @classmethod
    def for_subset(
        cls, processed_root: Path, dataset: str, subset: str
    ) -> ProcessedLayout:
        return cls(processed_root / dataset / subset)

    def path(self, spec: cs.ArtifactSpec) -> Path:
        return self.root / spec.path

    @property
    def info_path(self) -> Path:
        return self.root / DATASET_INFO_FILE


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while block := f.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def write_artifacts(
    tables: dict[str, pl.DataFrame], layout: ProcessedLayout
) -> dict[str, dict[str, Any]]:
    """Write each canonical table; return name -> {path, rows, sha256}."""
    written: dict[str, dict[str, Any]] = {}
    for spec in cs.ARTIFACTS:
        frame = conform(tables[spec.name], spec)
        path = layout.path(spec)
        path.parent.mkdir(parents=True, exist_ok=True)
        # ~64k-row groups keep per-play predicate pushdown cheap on large subsets.
        frame.write_parquet(
            path, compression="zstd", statistics=True, row_group_size=65_536
        )
        written[spec.name] = {
            "path": spec.path,
            "rows": frame.height,
            "sha256": sha256_file(path),
        }
    return written


def write_info(layout: ProcessedLayout, info: dict[str, Any]) -> None:
    layout.info_path.write_text(json.dumps(info, indent=2, sort_keys=True) + "\n")


@dataclass(frozen=True)
class ProcessedDataset:
    layout: ProcessedLayout
    info: dict[str, Any]
    plays: pl.DataFrame
    players: pl.DataFrame
    annotations: pl.DataFrame
    outcomes: pl.DataFrame

    @property
    def dataset_version(self) -> str:
        return str(self.info["dataset_version"])

    def scan(self, spec: cs.ArtifactSpec) -> pl.LazyFrame:
        return pl.scan_parquet(self.layout.path(spec))


def _check_schema(layout: ProcessedLayout, spec: cs.ArtifactSpec) -> None:
    path = layout.path(spec)
    if not path.is_file():
        raise ProcessedDatasetError(f"Missing processed artifact {path}.")
    try:
        actual = pl.read_parquet_schema(path)
    except Exception as err:  # noqa: BLE001 - any read failure means a corrupt file
        raise ProcessedDatasetError(f"Could not read {path}: {err}") from err
    expected = spec.schema
    if dict(actual) != expected:
        raise ProcessedDatasetError(
            f"{path} does not match canonical schema v{cs.CANONICAL_SCHEMA_VERSION} "
            f"(expected {list(expected)}, found {list(actual)}). Re-run preprocessing."
        )


def load_processed(layout: ProcessedLayout) -> ProcessedDataset:
    """Load small per-play tables eagerly; tracking stays on disk for lazy scans."""
    if not layout.info_path.is_file():
        raise ProcessedDatasetError(
            f"No processed dataset at {layout.root}. Run `pnpm data:dev` "
            "(python -m playlens_ml.data.preprocess --dataset nfl_bdb_2026_analytics "
            "--subset dev)."
        )
    info = json.loads(layout.info_path.read_text())
    if str(info.get("schema_version")) != cs.CANONICAL_SCHEMA_VERSION:
        raise ProcessedDatasetError(
            f"{layout.root} was built with canonical schema "
            f"v{info.get('schema_version')}, "
            f"this code expects v{cs.CANONICAL_SCHEMA_VERSION}. Re-run preprocessing."
        )
    for spec in cs.ARTIFACTS:
        _check_schema(layout, spec)
    return ProcessedDataset(
        layout=layout,
        info=info,
        plays=pl.read_parquet(layout.path(cs.PLAYS)),
        players=pl.read_parquet(layout.path(cs.PLAYERS)),
        annotations=pl.read_parquet(layout.path(cs.ANNOTATIONS)),
        outcomes=pl.read_parquet(layout.path(cs.OUTCOMES)),
    )
