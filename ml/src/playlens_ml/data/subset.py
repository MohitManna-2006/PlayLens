"""Deterministic development subset.

Selection never looks at model behaviour. It filters for plays that exercise the
replay fully (enough frames, complete metadata, both sides tracked, a future
target beyond the receiver) and then spreads picks across weeks, games, teams,
formations, coverages, and routes. Ties are broken by a salted SHA-256 of the
play ID, so the result depends only on the data and the rule below.
"""

from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field
from typing import Any

import polars as pl

KEY = ["game_id", "play_id"]


@dataclass(frozen=True)
class DevSubsetRule:
    version: str = "dev-v1"
    plays_per_week: int = 3
    min_observed_frames: int = 20
    """2.0 s at 10 Hz, enough to see routes develop."""
    min_offense_players: int = 4
    min_defense_players: int = 5
    min_predicted_players: int = 2
    """The targeted receiver plus at least one defender with a future path."""
    required_metadata: tuple[str, ...] = (
        "down",
        "yards_to_go",
        "game_clock",
        "offense_formation",
        "receiver_alignment",
        "team_coverage_man_zone",
        "team_coverage_type",
        "route_of_targeted_receiver",
        "dropback_type",
        "pass_result",
    )
    diversity_fields: tuple[str, ...] = field(
        default=(
            "team_coverage_type",
            "offense_formation",
            "possession_team",
            "defensive_team",
            "route_of_targeted_receiver",
        )
    )

    def describe(self) -> dict[str, Any]:
        return {
            **asdict(self),
            "eligibility": [
                "passes every validation check (no exclusion reason)",
                "play_nullified_by_penalty is N",
                f"observed_frame_count >= {self.min_observed_frames}",
                "exactly one Passer",
                f"offense_player_count >= {self.min_offense_players}",
                f"defense_player_count >= {self.min_defense_players}",
                f"predicted_player_count >= {self.min_predicted_players}",
                "every observed x in [0, 120] and y in [0, 53.33]",
                "non-null " + ", ".join(self.required_metadata),
            ],
            "ordering": (
                f"For each week in ascending order pick {self.plays_per_week} plays, "
                "one per game. "
                "Each pick maximises the number of diversity_fields values not yet "
                "in the subset; "
                f"ties go to the smallest sha256('{self.version}:' + play ID)."
            ),
        }


def selection_key(version: str, play_id: str) -> str:
    return hashlib.sha256(f"{version}:{play_id}".encode()).hexdigest()


def eligibility(candidates: pl.DataFrame, rule: DevSubsetRule) -> pl.DataFrame:
    """Add ``dev_ineligible_reasons`` (list) and ``dev_eligible`` to each candidate
    row."""
    conditions: list[tuple[str, pl.Expr]] = [
        ("failed_validation", ~pl.col("valid")),
        (
            "nullified_by_penalty",
            pl.col("play_nullified_by_penalty").fill_null("?") != "N",
        ),
        ("too_few_frames", pl.col("observed_frame_count") < rule.min_observed_frames),
        ("passer_count_not_one", pl.col("passer_count") != 1),
        ("too_few_offense", pl.col("offense_player_count") < rule.min_offense_players),
        ("too_few_defense", pl.col("defense_player_count") < rule.min_defense_players),
        (
            "too_few_predicted",
            pl.col("predicted_player_count") < rule.min_predicted_players,
        ),
        ("positions_outside_field", ~pl.col("observed_in_field")),
        *((f"missing_{c}", pl.col(c).is_null()) for c in rule.required_metadata),
    ]
    reasons = pl.concat_list(
        [
            pl.when(cond).then(pl.lit(name)).otherwise(pl.lit(None, pl.String))
            for name, cond in conditions
        ]
    ).list.drop_nulls()
    return candidates.with_columns(
        reasons.alias("dev_ineligible_reasons")
    ).with_columns(
        (pl.col("dev_ineligible_reasons").list.len() == 0).alias("dev_eligible")
    )


def select_dev_plays(candidates: pl.DataFrame, rule: DevSubsetRule) -> pl.DataFrame:
    """Return the selected plays with ``selection_rank`` and ``selection_key``."""
    eligible = (
        eligibility(candidates, rule)
        .filter(pl.col("dev_eligible"))
        .with_columns(
            pl.col("id")
            .map_elements(
                lambda v: selection_key(rule.version, v), return_dtype=pl.String
            )
            .alias("selection_key")
        )
        .sort(["week", "selection_key"])
    )
    seen: dict[str, set[Any]] = {f: set() for f in rule.diversity_fields}
    picked: list[dict[str, Any]] = []
    for (week,), group in eligible.group_by(["week"], maintain_order=True):
        pool = group.to_dicts()
        games: set[int] = set()
        for _ in range(rule.plays_per_week):
            best: dict[str, Any] | None = None
            best_score = -1
            for row in pool:  # sorted by selection_key, so the first max wins ties
                if row["game_id"] in games:
                    continue
                score = sum(row[f] not in seen[f] for f in rule.diversity_fields)
                if score > best_score:
                    best, best_score = row, score
            if best is None:
                break
            games.add(best["game_id"])
            for f in rule.diversity_fields:
                seen[f].add(best[f])
            picked.append(
                {
                    "game_id": best["game_id"],
                    "play_id": best["play_id"],
                    "week": week,
                    "selection_key": best["selection_key"],
                }
            )
    return pl.DataFrame(
        picked,
        schema={
            "game_id": pl.Int64,
            "play_id": pl.Int64,
            "week": pl.Int64,
            "selection_key": pl.String,
        },
    ).with_row_index("selection_rank")
