"""Tiny synthetic raw datasets in the BDB 2026 file layout, for tests only.

Players move in straight lines in the canonical frame; raw values are produced
by rotating left-moving plays, so tests can assert exact canonical positions.
Nothing here resembles real games and nothing is written outside the given
directory.
"""

from __future__ import annotations

import csv
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .bdb2026 import spec
from .coordinates import FIELD_LENGTH_YD, FIELD_WIDTH_YD, canonical_angle

OFFENSE = (
    ("QB", "Passer"),
    ("WR", "Targeted Receiver"),
    ("WR", "Other Route Runner"),
    ("TE", "Other Route Runner"),
    ("RB", "Other Route Runner"),
)
DEFENSE = (
    ("CB", "Defensive Coverage"),
    ("CB", "Defensive Coverage"),
    ("FS", "Defensive Coverage"),
    ("SS", "Defensive Coverage"),
    ("ILB", "Defensive Coverage"),
    ("OLB", "Defensive Coverage"),
)


@dataclass
class SyntheticPlay:
    game_id: int
    play_id: int
    week: int
    direction: str = "right"
    frames: int = 24
    future_frames: int = 8
    los_x: int = 40
    """Line of scrimmage in canonical x."""
    offense: str = "AAA"
    defense: str = "BBB"
    predicted_defenders: int = 2
    supplementary: dict[str, Any] = field(default_factory=dict)
    """Overrides for supplementary columns (use None for NA)."""


def _speed(side: str, k: int) -> tuple[float, float]:
    """Canonical velocity (vx, vy) in yd/s for player k on a side."""
    if side == "offense":
        return (0.5 + 0.8 * k, 0.4 * (k - 2))
    return (-0.3 + 0.6 * k, -0.3 * (k - 3))


def player_rows(p: SyntheticPlay) -> list[dict[str, Any]]:
    """One dict per (player, observed frame) with canonical ``cx, cy`` for
    assertions."""
    rows: list[dict[str, Any]] = []
    for side, roster in (("offense", OFFENSE), ("defense", DEFENSE)):
        for k, (pos, role) in enumerate(roster):
            nfl_id = (1 if side == "offense" else 2) * 1000 + k + p.play_id % 7
            predict = role == "Targeted Receiver" or (
                side == "defense" and k < p.predicted_defenders
            )
            x0 = p.los_x - 5.0 + k if side == "offense" else p.los_x + 3.0 + 2 * k
            y0 = 10.0 + 6.0 * k
            vx, vy = _speed(side, k)
            for f in range(1, p.frames + p.future_frames + 1):
                t = (f - 1) / spec.FRAME_RATE_HZ
                cx, cy = x0 + vx * t, y0 + vy * t
                cdir = math.degrees(math.atan2(vx, vy)) % 360.0
                rows.append(
                    {
                        "nfl_id": nfl_id,
                        "side": side,
                        "position": pos,
                        "role": role,
                        "predict": predict,
                        "frame": f,
                        "cx": cx,
                        "cy": cy,
                        "s": math.hypot(vx, vy),
                        "cdir": cdir,
                    }
                )
    return rows


def _raw(
    p: SyntheticPlay, cx: float, cy: float, cdir: float
) -> tuple[float, float, float]:
    if p.direction == "left":
        return FIELD_LENGTH_YD - cx, FIELD_WIDTH_YD - cy, canonical_angle(cdir, "left")
    return cx, cy, cdir


def _fmt(v: Any) -> str:
    """Mirror the published supplementary file: quoted strings, bare
    NA/TRUE/FALSE/numbers."""
    if v is None:
        return "NA"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, str):
        return '"' + v.replace('"', '""') + '"'
    return str(v)


def supplementary_row(p: SyntheticPlay) -> dict[str, Any]:
    los = p.los_x
    if los == 60:
        side, number = None, 50
    elif los < 60:
        side, number = p.offense, los - 10
    else:
        side, number = p.defense, 110 - los
    row: dict[str, Any] = {
        "game_id": p.game_id,
        "season": 2023,
        "week": p.week,
        "game_date": f"09/{p.week + 6:02d}/2023",
        "game_time_eastern": "13:00:00",
        "home_team_abbr": p.defense,
        "visitor_team_abbr": p.offense,
        "play_id": p.play_id,
        "play_description": f"(12:00) Synthetic pass to {p.play_id} for 7 yards.",
        "quarter": 1,
        "game_clock": "12:00",
        "down": 2,
        "yards_to_go": 6,
        "possession_team": p.offense,
        "defensive_team": p.defense,
        "yardline_side": side,
        "yardline_number": number,
        "pre_snap_home_score": 0,
        "pre_snap_visitor_score": 3,
        "play_nullified_by_penalty": "N",
        "pass_result": "C",
        "pass_length": 5,
        "offense_formation": "SHOTGUN",
        "receiver_alignment": "2x2",
        "route_of_targeted_receiver": "OUT",
        "play_action": False,
        "dropback_type": "TRADITIONAL",
        "dropback_distance": 3.5,
        "pass_location_type": "INSIDE_BOX",
        "defenders_in_the_box": 6,
        "team_coverage_man_zone": "ZONE_COVERAGE",
        "team_coverage_type": "COVER_3_ZONE",
        "penalty_yards": None,
        "pre_penalty_yards_gained": 7,
        "yards_gained": 7,
        "expected_points": 1.25,
        "expected_points_added": 0.4,
        "pre_snap_home_team_win_probability": 0.55,
        "pre_snap_visitor_team_win_probability": 0.45,
        "home_team_win_probability_added": -0.01,
        "visitor_team_win_probility_added": 0.01,
    }
    row.update(p.supplementary)
    return row


def write_raw_dataset(
    raw_root: Path, plays: list[SyntheticPlay], season: int = 2023
) -> Path:
    """Write supplementary + weekly input/output CSVs under ``raw_root``; return it."""
    train = raw_root / spec.TRACKING_DIR
    train.mkdir(parents=True, exist_ok=True)
    with (raw_root / spec.SUPPLEMENTARY_FILE).open("w", newline="") as f:
        f.write(",".join(f'"{c}"' for c in spec.SUPPLEMENTARY_SCHEMA) + "\n")
        for p in plays:
            row = supplementary_row(p)
            f.write(",".join(_fmt(row[c]) for c in spec.SUPPLEMENTARY_SCHEMA) + "\n")

    for week in sorted({p.week for p in plays}):
        with (
            (train / f"input_{season}_w{week:02d}.csv").open("w", newline="") as fi,
            (train / f"output_{season}_w{week:02d}.csv").open("w", newline="") as fo,
        ):
            wi, wo = csv.writer(fi), csv.writer(fo)
            wi.writerow(list(spec.INPUT_SCHEMA))
            wo.writerow(list(spec.OUTPUT_SCHEMA))
            for p in (q for q in plays if q.week == week):
                ayl = (
                    p.los_x
                    if p.direction == "right"
                    else int(FIELD_LENGTH_YD) - p.los_x
                )
                land_x, land_y, _ = _raw(p, p.los_x + 12.0, 20.0, 0.0)
                for r in player_rows(p):
                    x, y, d = _raw(p, r["cx"], r["cy"], r["cdir"])
                    if r["frame"] <= p.frames:
                        wi.writerow(
                            [
                                p.game_id,
                                p.play_id,
                                "True" if r["predict"] else "False",
                                r["nfl_id"],
                                r["frame"],
                                p.direction,
                                ayl,
                                f"Player {r['nfl_id']}",
                                "6-1",
                                200,
                                "1999-01-01",
                                r["position"],
                                r["side"].title(),
                                r["role"],
                                round(x, 4),
                                round(y, 4),
                                round(r["s"], 4),
                                0.1,
                                round(d, 4),
                                round(d, 4),
                                p.future_frames,
                                land_x,
                                land_y,
                            ]
                        )
                    elif r["predict"]:
                        wo.writerow(
                            [
                                p.game_id,
                                p.play_id,
                                r["nfl_id"],
                                r["frame"] - p.frames,
                                round(x, 4),
                                round(y, 4),
                            ]
                        )
    return raw_root


def default_plays() -> list[SyntheticPlay]:
    """Three weeks, two games each, two plays per game, both directions."""
    plays = []
    teams = [
        ("AAA", "BBB"),
        ("CCC", "DDD"),
        ("EEE", "FFF"),
        ("GGG", "HHH"),
        ("III", "JJJ"),
        ("KKK", "LLL"),
    ]
    for week in (1, 2, 3):
        for g in range(2):
            off, dfn = teams[(week - 1) * 2 + g]
            game_id = 2099090000 + week * 10 + g
            for n, play_id in enumerate((100 + week, 200 + g)):
                plays.append(
                    SyntheticPlay(
                        game_id=game_id,
                        play_id=play_id,
                        week=week,
                        direction="left" if (g + n) % 2 else "right",
                        los_x=30 + 10 * n + 5 * g,
                        offense=off,
                        defense=dfn,
                        frames=22 + week + n,
                        future_frames=6 + g,
                    )
                )
    return plays
