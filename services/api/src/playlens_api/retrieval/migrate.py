"""Versioned SQL migrations for the retrieval database.

    uv run python -m playlens_api.retrieval.migrate            # apply pending
    uv run python -m playlens_api.retrieval.migrate --status   # list only

Migrations are plain SQL files in ``migrations/`` named ``NNNN_description.sql``
and applied in order, each in its own transaction, under an advisory lock so two
runners cannot interleave. ``schema_migrations`` records each applied version
with a checksum; editing an applied file is an error, not a silent re-run.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from importlib import resources

import psycopg

from ..config import Settings
from .db import connect, redact

# Arbitrary constant: the advisory lock key that serializes migration runners.
LOCK_KEY = 7_302_514
NAME_PATTERN = re.compile(r"^(\d{4})_([a-z0-9_]+)\.sql$")

CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"""


class MigrationError(RuntimeError):
    """The database schema does not match the migration files."""


@dataclass(frozen=True)
class Migration:
    version: str
    name: str
    sql: str

    @property
    def checksum(self) -> str:
        return hashlib.sha256(self.sql.encode()).hexdigest()


def available_migrations() -> list[Migration]:
    folder = resources.files(__package__) / "migrations"
    found = []
    for entry in folder.iterdir():
        match = NAME_PATTERN.match(entry.name)
        if match:
            found.append(Migration(match[1], match[2], entry.read_text()))
    found.sort(key=lambda m: m.version)
    versions = [m.version for m in found]
    if len(set(versions)) != len(versions):
        raise MigrationError(f"Duplicate migration versions: {versions}")
    return found


@dataclass(frozen=True)
class SchemaState:
    applied: list[str]
    pending: list[str]

    @property
    def current(self) -> str | None:
        return self.applied[-1] if self.applied else None


def _applied(conn: psycopg.Connection) -> dict[str, str]:
    exists = conn.execute("SELECT to_regclass('schema_migrations')").fetchone()
    if not exists or exists[0] is None:
        return {}
    rows = conn.execute("SELECT version, checksum FROM schema_migrations").fetchall()
    return {str(v): str(c) for v, c in rows}


def schema_state(conn: psycopg.Connection) -> SchemaState:
    """Applied and pending versions; raises if an applied file was edited."""
    applied = _applied(conn)
    migrations = available_migrations()
    for m in migrations:
        if m.version in applied and applied[m.version] != m.checksum:
            raise MigrationError(
                f"Migration {m.version}_{m.name}.sql changed after it was applied. "
                "Add a new migration instead of editing an applied one."
            )
    unknown = sorted(set(applied) - {m.version for m in migrations})
    if unknown:
        raise MigrationError(
            f"The database has migrations this code does not know: {unknown}."
        )
    return SchemaState(
        applied=[m.version for m in migrations if m.version in applied],
        pending=[m.version for m in migrations if m.version not in applied],
    )


def migrate(conn: psycopg.Connection) -> list[Migration]:
    """Apply pending migrations in order. Returns the ones applied."""
    done: list[Migration] = []
    with conn.transaction():
        conn.execute(CREATE_TABLE)
    for m in available_migrations():
        with conn.transaction():
            conn.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_KEY,))
            # Re-read under the lock: another runner may have applied it.
            if m.version in _applied(conn):
                continue
            schema_state(conn)
            conn.execute(m.sql.encode())
            conn.execute(
                "INSERT INTO schema_migrations (version, name, checksum) "
                "VALUES (%s, %s, %s)",
                (m.version, m.name, m.checksum),
            )
        done.append(m)
    return done


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--database-url", default=None)
    parser.add_argument("--status", action="store_true", help="List; apply nothing.")
    args = parser.parse_args(argv)
    url = args.database_url or Settings().database_url
    try:
        with connect(url, "playlens-migrate") as conn:
            if args.status:
                state = schema_state(conn)
            else:
                for m in migrate(conn):
                    print(f"applied {m.version}_{m.name}.sql", file=sys.stderr)
                state = schema_state(conn)
    except (psycopg.Error, MigrationError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    print(
        f"{redact(url or '')}: applied {state.applied or 'none'}; "
        f"pending {state.pending or 'none'}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
