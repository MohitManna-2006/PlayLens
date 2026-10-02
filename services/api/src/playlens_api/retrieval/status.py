"""Read-only readiness check of the retrieval database, for developer scripts.

    uv run python -m playlens_api.retrieval.status            # summary block
    uv run python -m playlens_api.retrieval.status --brief    # one line

Exit codes: 0 ready; 1 database unreachable; 2 schema not current (pending
migrations, missing extension or index); 3 no embeddings loaded for the model.
It reads the same status the API reports in /health and changes nothing.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

import psycopg

from ..config import Settings
from .db import connect, normalize_url, redact
from .migrate import MigrationError
from .store import read_status

READY, UNREACHABLE, SCHEMA, NOT_LOADED = 0, 1, 2, 3


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--model-version", default=None)
    parser.add_argument("--database-url", default=None)
    parser.add_argument("--brief", action="store_true", help="Print one line.")
    args = parser.parse_args(argv)
    settings = Settings()
    url = args.database_url or settings.database_url or ""
    model = args.model_version or settings.embedding_model_version

    def report(code: int, line: str, details: list[str] | None = None) -> int:
        print(line)
        if not args.brief:
            for d in details or []:
                print(f"  {d}")
        return code

    target = redact(normalize_url(url)) if url else "(PLAYLENS_DATABASE_URL empty)"
    try:
        with connect(url, "playlens-status") as conn:
            status = read_status(conn)
    except (psycopg.Error, RuntimeError, MigrationError) as err:
        reason = str(err).strip().splitlines()[0] if str(err).strip() else "error"
        return report(UNREACHABLE, f"database unreachable at {target}", [reason])

    details = [
        target,
        f"PostgreSQL {status.server_version} · pgvector "
        f"{status.pgvector_version or 'not installed'}",
        f"migrations: latest applied {status.schema_version or 'none'}; pending "
        f"{', '.join(status.pending_migrations) or 'none'}",
        f"HNSW index: {status.index.name if status.index else 'missing'}",
    ]
    if not status.pgvector_version or status.pending_migrations or not status.index:
        return report(SCHEMA, "schema not current: run `make db-migrate`", details)
    emb = next((s for s in status.embedding_sets if s.model_version == model), None)
    if emb is None or emb.row_count == 0:
        return report(
            NOT_LOADED,
            f"no embeddings loaded for {model}: run `make db-load`",
            details,
        )
    details.append(
        f"dataset {emb.dataset_version} · split {emb.split_version} · "
        f"loaded {emb.loaded_at}"
    )
    return report(READY, f"{emb.row_count:,} embeddings ({model})", details)


if __name__ == "__main__":
    sys.exit(main())
