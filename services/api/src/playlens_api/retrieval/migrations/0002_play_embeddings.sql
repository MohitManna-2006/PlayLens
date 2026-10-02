-- Learned play embeddings for similarity retrieval (Phase 4).
--
-- Vectors are the frozen Phase 3 export (trajectory-gnn-transformer-v1): 128-d,
-- L2-normalised, so cosine distance (<=>) orders neighbours exactly like the dot
-- product. They are stored as exported: no centering, whitening, or
-- renormalisation.
--
-- A few pre-snap context columns are copied from the canonical dataset so
-- metadata filters run in the same statement as the vector ordering. Tracking
-- frames stay in Parquet; this is not a copy of the dataset.

-- One row per imported embedding export: what produced the vectors.
CREATE TABLE embedding_sets (
    model_version        TEXT PRIMARY KEY,
    dataset_version      TEXT NOT NULL,
    split_version        TEXT NOT NULL,
    dimension            INTEGER NOT NULL CHECK (dimension > 0),
    normalization        TEXT NOT NULL,
    artifact_path        TEXT NOT NULL,
    artifact_sha256      TEXT NOT NULL,
    model_weights_sha256 TEXT NOT NULL,
    row_count            INTEGER NOT NULL CHECK (row_count >= 0),
    -- Cosine similarity of random play pairs in this space, computed at import,
    -- so scores can be read relative to the space (it is anisotropic).
    cosine_reference     JSONB NOT NULL,
    loaded_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE play_embeddings (
    play_id             TEXT NOT NULL,          -- PlayLens ID '<game_id>-<play_id>'
    model_version       TEXT NOT NULL
        REFERENCES embedding_sets (model_version) ON DELETE CASCADE,
    dataset_version     TEXT NOT NULL,
    split_version       TEXT NOT NULL,
    split               TEXT NOT NULL CHECK (split IN ('train', 'validation', 'test')),
    embedding           vector(128) NOT NULL,
    -- Pre-snap context (canonical observed/plays.parquet). Filters only; none of
    -- these is a model input.
    season              SMALLINT,
    week                SMALLINT,
    quarter             SMALLINT,
    down                SMALLINT,
    yards_to_go         SMALLINT,
    offense             TEXT,
    defense             TEXT,
    offense_formation   TEXT,
    -- Line of scrimmage in yards from the offense's own goal line
    -- (canonical line_of_scrimmage_x - 10).
    yards_from_own_goal REAL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (play_id, model_version)
);

-- Approximate nearest neighbours by cosine distance. m and ef_construction are
-- pgvector's defaults, written out so the index definition is self-describing.
CREATE INDEX play_embeddings_embedding_hnsw
    ON play_embeddings USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
