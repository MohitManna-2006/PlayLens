"""Stable external PlayLens play IDs.

A play's natural key is ``(game_id, play_id)``; ``play_id`` alone repeats across
games. The external ID joins both with a hyphen, e.g. ``2023090700-101``, so it
is URL-safe and sorts readably. Contracts still carry ``game_id`` and
``play_id`` separately.
"""

from __future__ import annotations

import re

import polars as pl

SEPARATOR = "-"
_PATTERN = re.compile(r"^(\d{1,12})-(\d{1,6})$")


class InvalidPlayIdError(ValueError):
    """The value is not a PlayLens play ID."""


def encode_play_id(game_id: int, play_id: int) -> str:
    if game_id < 0 or play_id < 0:
        raise InvalidPlayIdError(
            f"game_id and play_id must be non-negative, got {game_id}, {play_id}"
        )
    return f"{game_id}{SEPARATOR}{play_id}"


def decode_play_id(value: str) -> tuple[int, int]:
    """Return ``(game_id, play_id)``; raise ``InvalidPlayIdError`` otherwise."""
    match = _PATTERN.fullmatch(value)
    if match is None:
        raise InvalidPlayIdError(
            f"{value!r} is not a PlayLens play ID; expected '<game_id>-<play_id>', "
            "for example '2023090700-101'."
        )
    return int(match.group(1)), int(match.group(2))


def is_play_id(value: str) -> bool:
    return _PATTERN.fullmatch(value) is not None


def play_id_expr(game_col: str = "game_id", play_col: str = "play_id") -> pl.Expr:
    """Polars expression producing the external ID; same format as encode_play_id."""
    return pl.format("{}" + SEPARATOR + "{}", pl.col(game_col), pl.col(play_col))
