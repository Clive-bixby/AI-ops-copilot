-- 0003_source_index.sql
--
-- Phase 2 turns the document-only vector table into one index for every
-- searchable source type (document, log, ticket). Keeping one table means one
-- HNSW index, one full-text index and one retrieval query instead of three
-- divergent implementations.
--
-- The table is renamed in place so existing rows, the HNSW index and the
-- primary key survive. `document_id` becomes `source_id` + `source_type`, which
-- loses the foreign key cascade that documents used to get for free; the
-- triggers at the bottom restore that invariant for all three source tables.
--
-- Additions:
--   source_type           which source table owns the row
--   source_id             id in that source table
--   source_created_at     canonical source time, for unified time filters
--   embedding_model       model that produced `embedding`
--   embedding_dimensions  vector width that produced `embedding`
--   chunk_hash            content fingerprint of this chunk
--   tsv                   generated full-text vector (GIN indexed)
--
-- `embedding_dimensions` is recorded rather than inferred from the column type
-- so a provider/dimension change is visible and can be rejected at query time
-- instead of returning meaningless neighbours.

-- ---------------------------------------------------------------------------
-- 1. Rename document_chunks -> source_chunks (in place)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF to_regclass('public.document_chunks') IS NOT NULL
       AND to_regclass('public.source_chunks') IS NULL THEN
        ALTER TABLE document_chunks RENAME TO source_chunks;
    END IF;

    IF to_regclass('public.source_chunks') IS NULL THEN
        RAISE EXCEPTION
            'source_chunks is missing: 0001_initial_schema.sql must be applied first';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Add the unified columns, backfill from the existing shape, then enforce
-- ---------------------------------------------------------------------------

ALTER TABLE source_chunks
    ADD COLUMN IF NOT EXISTS source_type TEXT,
    ADD COLUMN IF NOT EXISTS source_id UUID,
    ADD COLUMN IF NOT EXISTS source_created_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS embedding_model TEXT,
    ADD COLUMN IF NOT EXISTS embedding_dimensions INTEGER,
    ADD COLUMN IF NOT EXISTS chunk_hash TEXT;

-- Existing rows were all document chunks. `document_id` still exists on the
-- first run; on a re-run it is already gone and the UPDATE is a no-op.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'source_chunks'
          AND column_name = 'document_id'
    ) THEN
        EXECUTE 'UPDATE source_chunks SET source_id = document_id WHERE source_id IS NULL';
    END IF;
END
$$;

UPDATE source_chunks SET source_type = 'document' WHERE source_type IS NULL;

-- Every pre-Phase-2 chunk was produced by the configured Ollama model.
-- `ALTER TABLE ... SET DEFAULT` is intentionally not used: new writes must
-- always state which model produced the vector.
UPDATE source_chunks
SET embedding_model = 'nomic-embed-text'
WHERE embedding_model IS NULL;

UPDATE source_chunks
SET embedding_dimensions = 768
WHERE embedding_dimensions IS NULL;

UPDATE source_chunks
SET chunk_hash = md5(content)
WHERE chunk_hash IS NULL;

UPDATE source_chunks sc
SET source_created_at = d.created_at
FROM documents d
WHERE sc.source_type = 'document'
  AND sc.source_id = d.id
  AND sc.source_created_at IS NULL;

ALTER TABLE source_chunks
    ALTER COLUMN source_type SET NOT NULL,
    ALTER COLUMN source_id SET NOT NULL,
    ALTER COLUMN embedding_model SET NOT NULL,
    ALTER COLUMN embedding_dimensions SET NOT NULL,
    ALTER COLUMN chunk_hash SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Replace the document-only identity with a source-aware one
-- ---------------------------------------------------------------------------

ALTER TABLE source_chunks
    DROP CONSTRAINT IF EXISTS document_chunks_document_id_chunk_index_key;

-- Dropping the column also drops document_chunks_document_id_fkey. Source
-- deletion is handled by the triggers below instead.
ALTER TABLE source_chunks DROP COLUMN IF EXISTS document_id;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'source_chunks_source_type_check'
    ) THEN
        ALTER TABLE source_chunks
            ADD CONSTRAINT source_chunks_source_type_check
            CHECK (source_type IN ('document', 'log', 'ticket'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'source_chunks_chunk_index_check'
    ) THEN
        ALTER TABLE source_chunks
            ADD CONSTRAINT source_chunks_chunk_index_check
            CHECK (chunk_index >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'source_chunks_embedding_dimensions_check'
    ) THEN
        ALTER TABLE source_chunks
            ADD CONSTRAINT source_chunks_embedding_dimensions_check
            CHECK (embedding_dimensions > 0);
    END IF;
END
$$;

-- Refuse to build the unique index over data that would violate it, with a
-- named reason, instead of failing with a bare unique_violation.
DO $$
DECLARE
    offending TEXT;
BEGIN
    SELECT string_agg(problem, '; ') INTO offending
    FROM (
        SELECT source_type || '/' || source_id || '/chunk ' || chunk_index ||
               '=' || count(*) AS problem
        FROM source_chunks
        GROUP BY source_type, source_id, chunk_index
        HAVING count(*) > 1
        LIMIT 5
    ) duplicates;

    IF offending IS NOT NULL THEN
        RAISE EXCEPTION
            'Cannot build source_chunks uniqueness: duplicate (source_type, source_id, chunk_index) rows (%).',
            offending;
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS source_chunks_source_chunk_uniq
    ON source_chunks (organization_id, source_type, source_id, chunk_index);

-- ---------------------------------------------------------------------------
-- 4. Full-text search over chunk content
-- ---------------------------------------------------------------------------
-- Generated with the 'english' configuration so German-style identifiers stay
-- intact and normal prose is stemmed. Keyword retrieval and the vector arm are
-- fused in one statement (see retrieval service); no external search engine.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'source_chunks'::regclass
          AND attname = 'tsv'
          AND NOT attisdropped
    ) THEN
        ALTER TABLE source_chunks
            ADD COLUMN tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_source_chunks_tsv
    ON source_chunks USING gin (tsv);

-- ---------------------------------------------------------------------------
-- 5. Indexes for the queries Phase 2 actually runs
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_document_chunks_org')
       AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_source_chunks_org') THEN
        ALTER INDEX idx_document_chunks_org RENAME TO idx_source_chunks_org;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_document_chunks_embedding_hnsw_cosine')
       AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_source_chunks_embedding_hnsw_cosine') THEN
        ALTER INDEX idx_document_chunks_embedding_hnsw_cosine
            RENAME TO idx_source_chunks_embedding_hnsw_cosine;
    END IF;
END
$$;

DROP INDEX IF EXISTS idx_document_chunks_org_document;

-- Source filtering and cleanup: WHERE organization_id = ? AND source_type = ?
-- AND source_id = ?.
CREATE INDEX IF NOT EXISTS idx_source_chunks_org_source
    ON source_chunks (organization_id, source_type, source_id);

-- Unified time filters: organization_id = ? AND source_created_at BETWEEN ...
CREATE INDEX IF NOT EXISTS idx_source_chunks_org_type_time
    ON source_chunks (organization_id, source_type, source_created_at DESC);

-- ---------------------------------------------------------------------------
-- 6. Source deletion removes indexed content
-- ---------------------------------------------------------------------------
-- A polymorphic source_id cannot be a foreign key, so an AFTER DELETE trigger on
-- every source table keeps the old ON DELETE CASCADE behaviour. This also holds
-- for deletes that do not go through the API.

CREATE OR REPLACE FUNCTION delete_source_chunks_for_source()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM source_chunks
    WHERE organization_id = OLD.organization_id
      AND source_type = TG_ARGV[0]
      AND source_id = OLD.id;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_delete_source_chunks ON documents;
CREATE TRIGGER documents_delete_source_chunks
    AFTER DELETE ON documents
    FOR EACH ROW EXECUTE FUNCTION delete_source_chunks_for_source('document');

DROP TRIGGER IF EXISTS logs_delete_source_chunks ON logs;
CREATE TRIGGER logs_delete_source_chunks
    AFTER DELETE ON logs
    FOR EACH ROW EXECUTE FUNCTION delete_source_chunks_for_source('log');

DROP TRIGGER IF EXISTS tickets_delete_source_chunks ON tickets;
CREATE TRIGGER tickets_delete_source_chunks
    AFTER DELETE ON tickets
    FOR EACH ROW EXECUTE FUNCTION delete_source_chunks_for_source('ticket');

COMMENT ON TABLE source_chunks IS
    'Unified search index: one row per retrievable chunk of a document, log group or ticket.';
COMMENT ON COLUMN source_chunks.source_created_at IS
    'Canonical source timestamp (document upload, log event/window, ticket creation) for unified time filters.';
COMMENT ON COLUMN source_chunks.embedding_dimensions IS
    'Vector width recorded at write time; retrieval rejects an embedding config whose width differs.';
