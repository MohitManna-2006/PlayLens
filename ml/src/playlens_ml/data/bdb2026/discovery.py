"""Raw file discovery and header validation. Raw files are only ever read."""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

import polars as pl

from . import spec


class RawDataError(RuntimeError):
    """The raw dataset is missing, incomplete, or has an unexpected schema."""


@dataclass(frozen=True)
class WeekFiles:
    season: int
    week: int
    input_path: Path
    output_path: Path


@dataclass(frozen=True)
class RawFiles:
    root: Path
    supplementary: Path
    weeks: tuple[WeekFiles, ...]

    def all_paths(self) -> list[Path]:
        paths = [self.supplementary]
        for w in self.weeks:
            paths += [w.input_path, w.output_path]
        return paths


def discover(raw_root: Path) -> RawFiles:
    """Pair ``input_<season>_w<NN>.csv`` with its output file, sorted by week."""
    if not raw_root.is_dir():
        raise RawDataError(
            f"Raw dataset not found at {raw_root}. Place the NFL Big Data Bowl 2026 "
            f"Analytics files there (see docs/data/nfl-bdb-2026-analytics.md)."
        )
    supplementary = raw_root / spec.SUPPLEMENTARY_FILE
    if not supplementary.is_file():
        raise RawDataError(f"Missing {spec.SUPPLEMENTARY_FILE} in {raw_root}.")
    tracking = raw_root / spec.TRACKING_DIR
    if not tracking.is_dir():
        raise RawDataError(f"Missing tracking directory {tracking}.")

    inputs: dict[tuple[int, int], Path] = {}
    outputs: dict[tuple[int, int], Path] = {}
    for path in sorted(tracking.iterdir()):
        if m := spec.INPUT_PATTERN.match(path.name):
            inputs[(int(m.group(1)), int(m.group(2)))] = path
        elif m := spec.OUTPUT_PATTERN.match(path.name):
            outputs[(int(m.group(1)), int(m.group(2)))] = path
    if not inputs:
        raise RawDataError(f"No input_<season>_w<NN>.csv files found in {tracking}.")
    unpaired = sorted(set(inputs) ^ set(outputs))
    if unpaired:
        names = ", ".join(f"{s} week {w}" for s, w in unpaired)
        raise RawDataError(f"Input and output files are not paired for: {names}.")
    weeks = tuple(
        WeekFiles(
            season=s, week=w, input_path=inputs[(s, w)], output_path=outputs[(s, w)]
        )
        for s, w in sorted(inputs)
    )
    return RawFiles(root=raw_root, supplementary=supplementary, weeks=weeks)


def read_header(path: Path) -> list[str]:
    with path.open(newline="", encoding="utf-8") as f:
        row = next(csv.reader(f), None)
    if not row:
        raise RawDataError(f"{path} is empty or has no header row.")
    return row


def check_header(path: Path, schema: dict[str, pl.DataType]) -> list[str]:
    """Fail on missing required columns; return any extra columns for the record."""
    header = read_header(path)
    missing = [c for c in schema if c not in header]
    if missing:
        raise RawDataError(
            f"{path.name} is missing required columns {missing}. Found {header}. "
            "This adapter targets the NFL Big Data Bowl 2026 Analytics release."
        )
    return [c for c in header if c not in schema]


def check_all_headers(files: RawFiles) -> dict[str, list[str]]:
    extras = {
        files.supplementary.name: check_header(
            files.supplementary, spec.SUPPLEMENTARY_SCHEMA
        )
    }
    for w in files.weeks:
        extras[w.input_path.name] = check_header(w.input_path, spec.INPUT_SCHEMA)
        extras[w.output_path.name] = check_header(w.output_path, spec.OUTPUT_SCHEMA)
    return {name: cols for name, cols in extras.items() if cols}
