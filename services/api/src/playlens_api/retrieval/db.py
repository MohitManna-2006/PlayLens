"""Database connection helpers shared by the API and the retrieval tools."""

from __future__ import annotations

import re
from typing import Any

import psycopg

DEFAULT_DATABASE_URL = "postgresql://playlens_dev:playlens_dev@localhost:5432/playlens"
CONNECT_TIMEOUT_S = 3


class DatabaseNotConfigured(RuntimeError):
    """No database URL is configured."""


def normalize_url(url: str) -> str:
    """Accept SQLAlchemy-style URLs (``postgresql+psycopg://``) as libpq URLs."""
    return re.sub(r"^postgres(ql)?\+psycopg2?://", "postgresql://", url.strip())


def redact(url: str) -> str:
    """The URL with any password replaced, for logs and error messages."""
    return re.sub(r"://([^:/@]+):[^@]*@", r"://\1:***@", url)


def connect(url: str | None, application: str, **kwargs: Any) -> psycopg.Connection:
    """One direct connection for command-line tools (the API uses a pool).

    Autocommit by default: every write and every search runs in an explicit
    ``conn.transaction()`` block, which is then a real top-level transaction."""
    kwargs.setdefault("autocommit", True)
    if not url:
        raise DatabaseNotConfigured(
            "No database URL. Set PLAYLENS_DATABASE_URL or pass --database-url."
        )
    try:
        return psycopg.connect(
            normalize_url(url),
            connect_timeout=CONNECT_TIMEOUT_S,
            application_name=application,
            **kwargs,
        )
    except psycopg.OperationalError as err:
        raise psycopg.OperationalError(
            f"Could not connect to {redact(normalize_url(url))}: {err}. "
            "Start the database with `pnpm db:up` (Docker Compose)."
        ) from err
