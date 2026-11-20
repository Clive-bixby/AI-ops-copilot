-- 0004_ingestion_runtime.sql
--
-- Phase 2 runtime tables: durable job status, request idempotency, grouped log
-- representations, and content fingerprints used to detect duplicates and to
-- skip re-embedding unchanged sources.
--
-- Design notes
--   * `ingestion_jobs` is the observable source of truth for ingestion status.
--     BullMQ (Redis) is the transport; losing Redis must not erase the history
--     of what was attempted.
--   * `ingest_idempotency` stores a response for an Idempotency-Key so a retried
--     request returns the original result instead of ingesting twice.
--   * `log_groups` is the embedded representation of logs. One group is a
--     normalised message template over a time window; `sample_log_ids` points
--     back at real log rows so a citation can show evidence, not a summary.
--   * Content hashes are nullable for legacy rows on purpose: this migration
--     never deletes or rewrites user data, and an existing database may contain
--     duplicates that predate dedupe. Uniqueness is enforced for newly written
--     rows only.

-- ---------------------------------------------------------------------------
-- 1. Content fingerprints
-- ---------------------------------------------------------------------------

---- Documents ---------------------------------------------------------------

ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS content_hash TEXT,
    ADD COLUMN IF NOT EXISTS file_hash TEXT;

-- Backfill the extracted-text fingerprint so re-uploading seeded documents is
-- detected. Empty documents are left NULL instead of all sharing md5('').
UPDATE documents
SET content_hash = md5(content)
WHERE content_hash IS NULL
  AND content IS NOT NULL
  AND btrim(content) <> '';

CREATE INDEX IF NOT EXISTS idx_documents_org_content_hash
    ON documents (organization_id, content_hash)
    WHERE content_hash IS NOT NULL;

-- Upload dedupe key: md5 of the original file bytes, computed before parsing.
-- Partial unique so legacy rows (NULL) never block the migration and a race
-- between two identical uploads is resolved by the database, not by luck.
CREATE UNIQUE INDEX IF NOT EXISTS documents_org_file_hash_uniq
    ON documents (organization_id, file_hash)
    WHERE file_hash IS NOT NULL;

---- Logs -------------------------------------------------------------------

ALTER TABLE logs
    ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Legacy rows keep NULL: their canonical hash format is defined by the
-- application, and recomputing it in SQL risks a mismatch that would silently
-- disable dedupe later.
CREATE UNIQUE INDEX IF NOT EXISTS logs_org_content_hash_uniq
    ON logs (organization_id, content_hash)
    WHERE content_hash IS NOT NULL;

---- Tickets ----------------------------------------------------------------

ALTER TABLE tickets
    ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Not unique: two genuinely different tickets may share title/description in a
-- schema that has no requester or external id. Replayed ingest requests are
-- deduplicated by Idempotency-Key; the hash is used to skip re-embedding
-- unchanged tickets and to report likely duplicates.
CREATE INDEX IF NOT EXISTS idx_tickets_org_content_hash
    ON tickets (organization_id, content_hash)
    WHERE content_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Ingestion job ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingestion_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    last_error TEXT,
    embedding_config_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    CONSTRAINT ingestion_jobs_source_type_check
        CHECK (source_type IN ('document', 'log', 'ticket')),
    CONSTRAINT ingestion_jobs_status_check
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
    CONSTRAINT ingestion_jobs_attempts_check
        CHECK (attempts >= 0 AND attempts <= max_attempts)
);

-- One active job per source. A duplicate submission finds the queued/running
-- job instead of creating a second worker run for the same content.
CREATE UNIQUE INDEX IF NOT EXISTS ingestion_jobs_active_source_uniq
    ON ingestion_jobs (organization_id, source_type, source_id)
    WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_org_created
    ON ingestion_jobs (organization_id, created_at DESC);

-- Worker restart recovery and the failed-job view.
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status_updated
    ON ingestion_jobs (status, updated_at);

-- ---------------------------------------------------------------------------
-- 3. Request idempotency
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest_idempotency (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_status INTEGER,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT ingest_idempotency_key_length_check
        CHECK (length(idempotency_key) BETWEEN 1 AND 255),
    CONSTRAINT ingest_idempotency_unique
        UNIQUE (organization_id, endpoint, idempotency_key)
);

-- Sweeping old keys is a maintenance query, not an application read.
CREATE INDEX IF NOT EXISTS idx_ingest_idempotency_created
    ON ingest_idempotency (created_at);

COMMENT ON TABLE ingest_idempotency IS
    'Stored responses for Idempotency-Key requests. Sweep rows older than the documented retention window.';

-- ---------------------------------------------------------------------------
-- 4. Grouped log representation
-- ---------------------------------------------------------------------------
-- Logs are events, not prose. Embedding every line would spend most of the
-- embedding budget on routine info/debug noise and produce near-duplicate
-- vectors. A group is one normalised template for one service/level inside one
-- time window, with the number of events and pointers to real log rows.

CREATE TABLE IF NOT EXISTS log_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    level TEXT NOT NULL,
    service TEXT,
    template TEXT NOT NULL,
    template_hash TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    event_count INTEGER NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL,
    -- References into `logs`; not a FK array because a group outlives any one
    -- sampled row and the id array is evidence, not ownership.
    sample_log_ids UUID[] NOT NULL DEFAULT '{}',
    sample_content TEXT,
    embedding_status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT log_groups_level_check
        CHECK (level IN ('debug', 'info', 'warn', 'error', 'fatal')),
    CONSTRAINT log_groups_event_count_check CHECK (event_count > 0),
    CONSTRAINT log_groups_window_check CHECK (window_end > window_start),
    CONSTRAINT log_groups_embedding_status_check
        CHECK (embedding_status IN ('pending', 'processing', 'indexed', 'failed'))
);

-- Deterministic group identity: re-ingesting the same window updates the group
-- instead of creating a second copy of it.
CREATE UNIQUE INDEX IF NOT EXISTS log_groups_identity_uniq
    ON log_groups (organization_id, level, COALESCE(service, ''), template_hash, window_start);

CREATE INDEX IF NOT EXISTS idx_log_groups_org_window
    ON log_groups (organization_id, window_start DESC);

CREATE INDEX IF NOT EXISTS idx_log_groups_pending
    ON log_groups (embedding_status)
    WHERE embedding_status IN ('pending', 'failed');

-- Evidence lookup is bounded by the group, not the whole log table.
CREATE INDEX IF NOT EXISTS idx_log_groups_org_id
    ON log_groups (organization_id, id);

-- ---------------------------------------------------------------------------
-- 5. Deleting a group removes its indexed chunk
-- ---------------------------------------------------------------------------
-- The function is defined in 0003 and takes the source_type as an argument.

DROP TRIGGER IF EXISTS log_groups_delete_source_chunks ON log_groups;
CREATE TRIGGER log_groups_delete_source_chunks
    AFTER DELETE ON log_groups
    FOR EACH ROW EXECUTE FUNCTION delete_source_chunks_for_source('log');

COMMENT ON TABLE log_groups IS
    'Embedded log representation: a normalised message template per level/service/time window, with sample log ids for evidence.';
COMMENT ON COLUMN log_groups.sample_content IS
    'Rendered text of the sample events; the source of the searchable chunk.';
