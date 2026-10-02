"""Similarity retrieval over learned play embeddings (Phase 4).

PostgreSQL + pgvector holds the frozen Phase 3 embeddings and a few pre-snap
filter columns. ``store`` runs exact (sequential scan) and approximate (HNSW)
cosine searches; ``migrate``, ``ingest``, ``verify``, and ``benchmark`` are the
command-line tools behind ``pnpm db:migrate`` and ``pnpm retrieval:*``.
"""
