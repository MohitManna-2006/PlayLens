"""Leakage-safe train/validation/test splits (Masterbrain §19).

Policy ``temporal-weeks-v1``: split by NFL week, earlier weeks for training,
later weeks held out. A game is played in exactly one week, so every frame,
player, observed prefix, and future target of a play, and every play of a game,
land in the same split. Nothing is sampled at random.

    python -m playlens_ml.datasets.splits --subset full

Weeks 1-14 train, 15-16 validation, 17-18 test. The rationale and the
per-split statistics are in docs/decisions/ADR-0003-ml-split-and-leakage-policy.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import polars as pl

from ..data import canonical_schema as cs
from ..data.artifacts import ProcessedLayout, load_processed
from ..data.bdb2026.spec import DATASET_NAME
from ..data.manifest import utc_now, write_json
from ..data.paths import data_layout

SPLITS = ("train", "validation", "test")
KEY = ["game_id", "play_id"]


class SplitError(RuntimeError):
    """The split policy cannot be applied to this dataset."""


@dataclass(frozen=True)
class SplitPolicy:
    name: str = "temporal-weeks-v1"
    train_weeks: tuple[int, ...] = tuple(range(1, 15))
    validation_weeks: tuple[int, ...] = (15, 16)
    test_weeks: tuple[int, ...] = (17, 18)

    def split_of_week(self) -> dict[int, str]:
        mapping: dict[int, str] = {}
        for split, weeks in zip(
            SPLITS,
            (self.train_weeks, self.validation_weeks, self.test_weeks),
            strict=True,
        ):
            for w in weeks:
                if w in mapping:
                    raise SplitError(f"Week {w} is assigned to two splits.")
                mapping[w] = split
        return mapping

    def describe(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "unit": "NFL week (whole games, hence whole plays)",
            "train_weeks": list(self.train_weeks),
            "validation_weeks": list(self.validation_weeks),
            "test_weeks": list(self.test_weeks),
        }


def assign_splits(plays: pl.DataFrame, policy: SplitPolicy) -> pl.DataFrame:
    """One row per play: id, game_id, play_id, week, split. Fails on unmapped weeks."""
    mapping = policy.split_of_week()
    unmapped = sorted(set(plays["week"].to_list()) - set(mapping))
    if unmapped:
        raise SplitError(
            f"Weeks {unmapped} are not covered by split policy {policy.name}."
        )
    out = (
        plays.select("id", *KEY, "week")
        .with_columns(
            pl.col("week")
            .replace_strict(mapping, return_dtype=pl.String)
            .alias("split")
        )
        .sort(KEY)
    )
    leaking = (
        out.group_by("game_id")
        .agg(pl.col("split").n_unique().alias("n"))
        .filter(pl.col("n") > 1)
    )
    if leaking.height:
        raise SplitError(f"{leaking.height} games would span more than one split.")
    return out


def split_version(assignments: pl.DataFrame, policy: SplitPolicy) -> str:
    rows = assignments.sort(KEY).select("id", "split").rows()
    digest = hashlib.sha256(json.dumps([policy.name, rows]).encode()).hexdigest()
    return f"{policy.name}-{digest[:12]}"


def split_statistics(
    assignments: pl.DataFrame, plays: pl.DataFrame, players: pl.DataFrame
) -> dict[str, Any]:
    targets = (
        players.filter(pl.col("player_to_predict"))
        .join(plays.select(*KEY, "future_frame_count", "observed_frame_count"), on=KEY)
        .join(assignments.select(*KEY, "split"), on=KEY)
    )
    stats: dict[str, Any] = {}
    for split in SPLITS:
        a = assignments.filter(pl.col("split") == split)
        t = targets.filter(pl.col("split") == split)
        p = plays.join(a.select(KEY), on=KEY)
        stats[split] = {
            "plays": a.height,
            "games": a["game_id"].n_unique(),
            "weeks": sorted(a["week"].unique().to_list()),
            "target_players": t.height,
            "target_frames": int(t["future_frame_count"].sum() or 0),
            "targets_by_role": {
                r: n
                for r, n in t.group_by("player_role").len().sort("player_role").rows()
            },
            "future_frames_quantiles": {
                str(q): float(p["future_frame_count"].quantile(q) or 0)
                for q in (0.05, 0.5, 0.95)
            },
            "observed_frames_quantiles": {
                str(q): float(p["observed_frame_count"].quantile(q) or 0)
                for q in (0.05, 0.5, 0.95)
            },
        }
    return stats


def ml_dir(layout: ProcessedLayout) -> Path:
    return layout.root / "ml"


def splits_path(layout: ProcessedLayout) -> Path:
    return ml_dir(layout) / "splits.parquet"


def load_splits(layout: ProcessedLayout) -> tuple[pl.DataFrame, dict[str, Any]]:
    path = splits_path(layout)
    if not path.is_file():
        raise SplitError(f"No splits at {path}. Run `pnpm ml:splits`.")
    info = json.loads((ml_dir(layout) / "splits.json").read_text())
    return pl.read_parquet(path), info


def write_splits(
    subset: str = "full",
    policy: SplitPolicy | None = None,
    data_root: Path | None = None,
) -> dict[str, Any]:
    policy = policy or SplitPolicy()
    layout = data_layout(root=data_root)
    processed = ProcessedLayout.for_subset(layout.processed, DATASET_NAME, subset)
    data = load_processed(processed)
    assignments = assign_splits(data.plays, policy)
    version = split_version(assignments, policy)
    info = {
        "split_version": version,
        "policy": policy.describe(),
        "dataset_version": data.dataset_version,
        "schema_version": cs.CANONICAL_SCHEMA_VERSION,
        "statistics": split_statistics(assignments, data.plays, data.players),
        "games_by_split": {
            s: sorted(
                assignments.filter(pl.col("split") == s)["game_id"].unique().to_list()
            )
            for s in SPLITS
        },
        "generated_at": utc_now(),
    }
    out = ml_dir(processed)
    out.mkdir(parents=True, exist_ok=True)
    assignments.write_parquet(splits_path(processed))
    write_json(out / "splits.json", info)
    write_json(layout.manifests / f"{DATASET_NAME}.{subset}.splits.json", info)
    return info


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--subset", default="full", choices=["dev", "full"])
    parser.add_argument("--data-root", type=Path, default=None)
    args = parser.parse_args(argv)
    info = write_splits(args.subset, data_root=args.data_root)
    print(
        f"split {info['split_version']} over {info['dataset_version']}", file=sys.stderr
    )
    for split, s in info["statistics"].items():
        print(
            f"  {split:<10} weeks {s['weeks'][0]}-{s['weeks'][-1]}  games "
            f"{s['games']:>4}  "
            f"plays {s['plays']:>6}  target players {s['target_players']:>6}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
