"""Provenance manifest for a preprocessing run (Masterbrain §9).

Every raw file gets a full SHA-256 (about one second for the 0.9 GB release),
its size, row count, and a fingerprint of its column names and types. The
dataset version is derived from those checksums, the preprocessing and schema
versions, and the subset rule, so a rerun on unchanged inputs reproduces it.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import polars as pl

from .artifacts import sha256_file

# Bump when preprocessing logic changes in a way that alters any artifact.
PREPROCESSING_VERSION = "1.0.0"
MANIFEST_VERSION = "1"


def schema_fingerprint(schema: dict[str, pl.DataType]) -> str:
    payload = json.dumps([[name, str(dtype)] for name, dtype in schema.items()])
    return hashlib.sha256(payload.encode()).hexdigest()


def git_info(repo_root: Path) -> dict[str, Any]:
    def run(*args: str) -> str | None:
        try:
            return subprocess.run(
                ["git", *args],
                cwd=repo_root,
                capture_output=True,
                text=True,
                check=True,
                timeout=10,
            ).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return None

    commit = run("rev-parse", "HEAD")
    status = run("status", "--porcelain", "--untracked-files=no")
    return {"commit": commit, "dirty": None if status is None else bool(status)}


def raw_file_record(
    path: Path,
    raw_root: Path,
    kind: str,
    rows: int,
    schema: dict[str, pl.DataType],
    extra_columns: list[str],
    season: int | None = None,
    week: int | None = None,
) -> dict[str, Any]:
    return {
        "name": path.name,
        "relative_path": str(path.relative_to(raw_root)),
        "kind": kind,
        "season": season,
        "week": week,
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "rows": rows,
        "columns": list(schema),
        "dtypes": {name: str(dtype) for name, dtype in schema.items()},
        "extra_columns": extra_columns,
        "schema_fingerprint": schema_fingerprint(schema),
    }


def dataset_version(
    dataset: str, subset: str, fingerprint_inputs: dict[str, Any]
) -> tuple[str, str]:
    """Return (version string, full fingerprint). Timestamps are deliberately
    excluded."""
    digest = hashlib.sha256(
        json.dumps(fingerprint_inputs, sort_keys=True).encode()
    ).hexdigest()
    return f"{dataset}@{subset}-{digest[:12]}", digest


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True, default=str) + "\n")
