"""Typed CSV loading. Parsing happens here and nowhere else."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import polars as pl

from . import spec
from .discovery import RawDataError, WeekFiles


def _scan(path: Path, schema: dict[str, pl.DataType]) -> pl.LazyFrame:
    return pl.scan_csv(
        path,
        schema_overrides=schema,
        infer_schema=False,
        null_values=spec.NULL_VALUES,
    ).select(list(schema))


def _collect(frame: pl.LazyFrame, what: str) -> pl.DataFrame:
    try:
        return frame.collect()
    except pl.exceptions.PolarsError as err:
        raise RawDataError(
            f"Could not parse {what} with the expected types: {err}"
        ) from err


def read_tracking(weeks: Sequence[WeekFiles], kind: str) -> pl.DataFrame:
    """Read all ``input`` or ``output`` files, tagging each row with its source week."""
    schema = spec.INPUT_SCHEMA if kind == "input" else spec.OUTPUT_SCHEMA
    frames = []
    for w in weeks:
        path = w.input_path if kind == "input" else w.output_path
        frames.append(
            _scan(path, schema).with_columns(
                pl.lit(w.week, pl.Int64).alias("source_week"),
                pl.lit(path.name).alias("source_file"),
            )
        )
    return _collect(pl.concat(frames), f"{kind} tracking files")


def read_supplementary(path: Path) -> pl.DataFrame:
    return _collect(_scan(path, spec.SUPPLEMENTARY_SCHEMA), path.name)
