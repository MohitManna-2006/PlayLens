"""Preprocess raw NFL tracking into canonical PlayLens artifacts.

    python -m playlens_ml.data.preprocess --dataset nfl_bdb_2026_analytics --subset dev

Steps: discover raw files -> check headers -> load with explicit types ->
validate the full dataset -> choose plays (deterministic dev subset, or every
valid play for ``full``) -> canonicalize -> write Parquet -> write manifest.
Raw files are only read. Broken required schemas stop the run with a message.
"""

from __future__ import annotations

import argparse
import logging
import shutil
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import polars as pl

from . import canonical_schema as cs
from .artifacts import ProcessedLayout, write_artifacts, write_info
from .bdb2026 import spec
from .bdb2026.canonicalize import CanonicalTables, canonicalize
from .bdb2026.discovery import RawDataError, check_all_headers, discover
from .bdb2026.load import read_supplementary, read_tracking
from .bdb2026.validate import ValidationResult, validate
from .coordinates import COORDINATE_DESCRIPTION, COORDINATE_SYSTEM
from .manifest import (
    MANIFEST_VERSION,
    PREPROCESSING_VERSION,
    dataset_version,
    git_info,
    raw_file_record,
    utc_now,
    write_json,
)
from .paths import data_layout, find_repo_root
from .subset import DevSubsetRule, eligibility, select_dev_plays

log = logging.getLogger("playlens.data.preprocess")
KEY = ["game_id", "play_id"]
SUBSETS = ("dev", "full")
LICENSE_NOTE = (
    "NFL Big Data Bowl 2026 competition data, used under the competition's data-use "
    "terms "
    "for development and portfolio demonstration. Raw and processed data are not "
    "committed."
)


class LeakageCheckError(RuntimeError):
    """Observed and future frames overlap in time for some play."""


@dataclass
class PreprocessOptions:
    dataset: str = spec.DATASET_NAME
    subset: str = "dev"
    data_root: Path | None = None
    raw_dir: Path | None = None
    rule: DevSubsetRule = field(default_factory=DevSubsetRule)


@dataclass
class RunSummary:
    dataset_version: str
    subset: str
    processed_dir: Path
    manifest_path: Path
    counts: dict[str, int]
    exclusions: dict[str, int]
    artifacts: dict[str, dict[str, Any]]
    selected_ids: list[str]


def assert_temporal_separation(tables: CanonicalTables) -> None:
    """Every future frame must come strictly after the play's last observed frame."""
    last_obs = tables.observed_tracking.group_by(KEY).agg(
        pl.col("frame_index").max().alias("last_obs")
    )
    first_fut = tables.future_trajectories.group_by(KEY).agg(
        pl.col("frame_index").min().alias("first_fut")
    )
    overlap = last_obs.join(first_fut, on=KEY).filter(
        pl.col("first_fut") <= pl.col("last_obs")
    )
    if overlap.height:
        raise LeakageCheckError(
            f"{overlap.height} plays have future frames inside the observed window."
        )


def _candidates(
    result: ValidationResult, sup: pl.DataFrame, rule: DevSubsetRule
) -> pl.DataFrame:
    needed = sorted(
        {
            *rule.required_metadata,
            *rule.diversity_fields,
            "week",
            "play_nullified_by_penalty",
        }
    )
    return result.play_index.join(sup.select([*KEY, *needed]), on=KEY, how="left")


def run(options: PreprocessOptions) -> RunSummary:
    if options.dataset != spec.DATASET_NAME:
        raise RawDataError(
            f"Unknown dataset {options.dataset!r}; supported: {spec.DATASET_NAME}."
        )
    if options.subset not in SUBSETS:
        raise RawDataError(f"Unknown subset {options.subset!r}; choose from {SUBSETS}.")
    layout = data_layout(root=options.data_root)
    raw_root = options.raw_dir or layout.raw / spec.RAW_DIRNAME

    files = discover(raw_root)
    extras = check_all_headers(files)
    log.info("raw.discovered root=%s weeks=%d", raw_root, len(files.weeks))

    inp = read_tracking(files.weeks, "input")
    out = read_tracking(files.weeks, "output")
    sup = read_supplementary(files.supplementary)
    log.info(
        "raw.loaded input_rows=%d output_rows=%d supplementary_rows=%d",
        inp.height,
        out.height,
        sup.height,
    )

    result = validate(inp, out, sup)
    for check in result.checks:
        level = logging.INFO if check.passed else logging.WARNING
        log.log(
            level,
            "validation.%s severity=%s %s=%d",
            check.name,
            check.severity,
            check.unit,
            check.count,
        )
    exclusions = result.exclusion_counts()
    valid = result.valid_keys
    log.info(
        "validation.summary plays=%d valid=%d excluded=%d reasons=%s",
        result.play_index.height,
        valid.height,
        result.play_index.height - valid.height,
        exclusions,
    )

    candidates = eligibility(_candidates(result, sup, options.rule), options.rule)
    if options.subset == "dev":
        selected = select_dev_plays(candidates, options.rule)
        selection: dict[str, Any] = {
            "kind": "deterministic_dev_subset",
            "rule": options.rule.describe(),
        }
    else:
        selected = valid.sort(KEY).with_row_index("selection_rank")
        selection = {
            "kind": "all_valid_plays",
            "rule": "Every play that passes validation.",
        }
    keys = selected.select(KEY)
    eligible_count = int(candidates["dev_eligible"].sum())
    log.info(
        "subset.selected subset=%s eligible=%d selected=%d",
        options.subset,
        eligible_count,
        keys.height,
    )

    tables = canonicalize(inp, out, sup, keys)
    assert_temporal_separation(tables)

    processed = ProcessedLayout.for_subset(
        layout.processed, options.dataset, options.subset
    )
    if processed.root.exists():
        shutil.rmtree(processed.root)
    artifacts = write_artifacts(tables.by_artifact(), processed)

    index_path = (
        layout.interim / options.dataset / f"play_index.{options.subset}.parquet"
    )
    index_path.parent.mkdir(parents=True, exist_ok=True)
    candidates.join(
        selected.select([*KEY, "selection_rank"]), on=KEY, how="left"
    ).with_columns(
        pl.col("selection_rank").is_not_null().alias(f"in_{options.subset}_subset")
    ).sort(KEY).write_parquet(index_path)

    in_rows = inp.group_by("source_file").len()
    out_rows = out.group_by("source_file").len()
    rows_by_file = {
        str(k): int(v) for k, v in [*in_rows.iter_rows(), *out_rows.iter_rows()]
    }
    raw_records = [
        raw_file_record(
            files.supplementary,
            raw_root,
            "supplementary",
            sup.height,
            spec.SUPPLEMENTARY_SCHEMA,
            extras.get(files.supplementary.name, []),
        )
    ]
    for w in files.weeks:
        raw_records.append(
            raw_file_record(
                w.input_path,
                raw_root,
                "input",
                rows_by_file.get(w.input_path.name, 0),
                spec.INPUT_SCHEMA,
                extras.get(w.input_path.name, []),
                w.season,
                w.week,
            )
        )
        raw_records.append(
            raw_file_record(
                w.output_path,
                raw_root,
                "output",
                rows_by_file.get(w.output_path.name, 0),
                spec.OUTPUT_SCHEMA,
                extras.get(w.output_path.name, []),
                w.season,
                w.week,
            )
        )

    version, fingerprint = dataset_version(
        options.dataset,
        options.subset,
        {
            "raw": sorted((r["name"], r["sha256"]) for r in raw_records),
            "preprocessing_version": PREPROCESSING_VERSION,
            "schema_version": cs.CANONICAL_SCHEMA_VERSION,
            "selection": selection,
        },
    )
    counts = {
        "raw_input_rows": inp.height,
        "raw_output_rows": out.height,
        "raw_supplementary_rows": sup.height,
        "raw_plays": result.play_index.height,
        "valid_plays": valid.height,
        "excluded_plays": result.play_index.height - valid.height,
        "dropped_keyless_rows": result.dropped_rows,
        "dev_eligible_plays": eligible_count,
        "selected_plays": keys.height,
        "observed_tracking_rows": tables.observed_tracking.height,
        "future_trajectory_rows": tables.future_trajectories.height,
        "players": tables.players.height,
    }
    generated_at = utc_now()
    repo_root = find_repo_root()
    git = git_info(repo_root)
    seasons = sorted({w.season for w in files.weeks})
    info = {
        "dataset": options.dataset,
        "dataset_title": spec.DATASET_TITLE,
        "source": spec.SOURCE_IDENTIFIER,
        "subset": options.subset,
        "dataset_version": version,
        "schema_version": cs.CANONICAL_SCHEMA_VERSION,
        "preprocessing_version": PREPROCESSING_VERSION,
        "coordinate_system": COORDINATE_SYSTEM,
        "coordinate_description": COORDINATE_DESCRIPTION,
        "frame_rate_hz": spec.FRAME_RATE_HZ,
        "seasons": seasons,
        "counts": counts,
        "artifacts": artifacts,
        "license_note": LICENSE_NOTE,
        "generated_at": generated_at,
    }
    write_info(processed, info)

    def rel(p: Path) -> str:
        try:
            return str(p.relative_to(repo_root))
        except ValueError:
            return str(p)

    manifest = {
        "manifest_version": MANIFEST_VERSION,
        **{
            k: info[k]
            for k in (
                "dataset",
                "dataset_title",
                "source",
                "subset",
                "dataset_version",
                "schema_version",
                "preprocessing_version",
                "coordinate_system",
                "frame_rate_hz",
                "seasons",
                "license_note",
                "generated_at",
            )
        },
        "dataset_fingerprint": fingerprint,
        "git": git,
        "raw_root": rel(raw_root),
        "raw_files": raw_records,
        "checksum_strategy": "Full SHA-256 of every raw file, streamed in 1 MiB "
        "blocks.",
        "validation": {
            "checks": [c.to_dict() for c in result.checks],
            "exclusions": exclusions,
        },
        "selection": selection,
        "selected_play_ids": selected.join(
            result.play_index.select([*KEY, "id"]), on=KEY
        )
        .sort("selection_rank")["id"]
        .to_list()
        if options.subset == "dev"
        else None,
        "counts": counts,
        "processed_root": rel(processed.root),
        "interim_play_index": rel(index_path),
        "artifacts": {
            spec_.name: {
                **artifacts[spec_.name],
                "availability": sorted(
                    {c.availability.value for c in spec_.columns.values()}
                ),
            }
            for spec_ in cs.ARTIFACTS
        },
    }
    manifest_path = (
        layout.manifests / f"{options.dataset}.{options.subset}.manifest.json"
    )
    write_json(manifest_path, manifest)
    log.info("manifest.written path=%s dataset_version=%s", manifest_path, version)

    ids = (
        tables.plays.join(selected.select([*KEY, "selection_rank"]), on=KEY)
        .sort("selection_rank")["id"]
        .to_list()
    )
    return RunSummary(
        version,
        options.subset,
        processed.root,
        manifest_path,
        counts,
        exclusions,
        artifacts,
        ids,
    )


def _print_summary(s: RunSummary) -> None:
    print(f"\nPlayLens preprocessing complete: {s.dataset_version}")
    for k, v in s.counts.items():
        print(f"  {k:<26} {v:>10,}")
    print(f"  exclusions by reason       {s.exclusions or 'none'}")
    print(f"  processed artifacts        {s.processed_dir}")
    for name, a in s.artifacts.items():
        print(f"    {name:<22} {a['rows']:>9,} rows  {a['path']}")
    print(f"  manifest                   {s.manifest_path}")
    if s.selected_ids:
        print(f"  first selected play        {s.selected_ids[0]}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--dataset", default=spec.DATASET_NAME, choices=[spec.DATASET_NAME]
    )
    parser.add_argument("--subset", default="dev", choices=SUBSETS)
    parser.add_argument(
        "--data-root",
        type=Path,
        default=None,
        help="Data directory (default: <repo>/data or $PLAYLENS_DATA_ROOT).",
    )
    parser.add_argument(
        "--raw-dir",
        type=Path,
        default=None,
        help="Raw dataset directory (default: <data>/raw/<release folder>).",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    try:
        summary = run(
            PreprocessOptions(
                dataset=args.dataset,
                subset=args.subset,
                data_root=args.data_root,
                raw_dir=args.raw_dir,
            )
        )
    except (RawDataError, LeakageCheckError) as err:
        log.error("preprocess.failed %s", err)
        print(f"\nPreprocessing failed: {err}", file=sys.stderr)
        return 1
    _print_summary(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
