-- pgvector provides the vector type, the cosine distance operator (<=>), and
-- HNSW indexes. The image ships the extension; this makes it available in the
-- PlayLens database.
CREATE EXTENSION IF NOT EXISTS vector;
