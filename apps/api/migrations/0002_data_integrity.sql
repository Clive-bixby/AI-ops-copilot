-- 0002_data_integrity.sql
--
-- The baseline schema left tenant, status and message columns nullable and had
-- almost no indexes, so a bug (or a manual INSERT) could store rows the API can
-- never read back correctly, and list queries scanned whole tables.
--
-- Two-step approach:
--   1. normalise values that have a documented default, so the CHECK
--      constraints can be added on any database that was written by older code
--   2. refuse to proceed, with a named reason, if a column that cannot be
--      defaulted still holds NULLs. Nothing is deleted or guessed.
--
-- Constraint names follow Postgres' default naming so they can be dropped or
-- altered later without hunting for them.

-- ---------------------------------------------------------------------------
-- 1. Normalise values with unambiguous defaults
-- ---------------------------------------------------------------------------

-- Log levels the parser accepts (apps/api/src/modules/logs/log.parser.ts).
UPDATE logs
SET level = 'info'
WHERE level IS NULL
   OR level NOT IN ('debug', 'info', 'warn', 'error', 'fatal');

-- Ticket status/priority domains (apps/api/src/modules/tickets/ticket.parser.ts).
UPDATE tickets
SET status = 'open'
WHERE status IS NULL
   OR status NOT IN ('open', 'pending', 'in_progress', 'resolved', 'closed');

UPDATE tickets
SET priority = 'medium'
WHERE priority IS NULL
   OR priority NOT IN ('low', 'medium', 'high', 'urgent');

-- Document processing states (documents.service.ts). An unknown state is not
-- "processed", so it is reset to pending and can be reprocessed.
UPDATE documents
SET processing_status = 'pending'
WHERE processing_status IS NULL
   OR processing_status NOT IN ('pending', 'processing', 'processed', 'failed');

-- ---------------------------------------------------------------------------
-- 2. Refuse to guess about columns that have no safe default
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    offending text;
BEGIN
    SELECT string_agg(problem, '; ') INTO offending
    FROM (
        SELECT 'logs.organization_id=' || count(*) AS problem
        FROM logs WHERE organization_id IS NULL
        HAVING count(*) > 0
        UNION ALL
        SELECT 'logs.message=' || count(*)
        FROM logs WHERE message IS NULL
        HAVING count(*) > 0
        UNION ALL
        SELECT 'logs.timestamp=' || count(*)
        FROM logs WHERE timestamp IS NULL
        HAVING count(*) > 0
        UNION ALL
        SELECT 'tickets.organization_id=' || count(*)
        FROM tickets WHERE organization_id IS NULL
        HAVING count(*) > 0
        UNION ALL
        SELECT 'tickets.title=' || count(*)
        FROM tickets WHERE title IS NULL
        HAVING count(*) > 0
        UNION ALL
        SELECT 'documents.organization_id=' || count(*)
        FROM documents WHERE organization_id IS NULL
        HAVING count(*) > 0
        UNION ALL
        SELECT 'documents.filename=' || count(*)
        FROM documents WHERE filename IS NULL
        HAVING count(*) > 0
        UNION ALL
        SELECT 'memberships.user_id=' || count(*)
        FROM memberships WHERE user_id IS NULL
        HAVING count(*) > 0
        UNION ALL
        SELECT 'memberships.organization_id=' || count(*)
        FROM memberships WHERE organization_id IS NULL
        HAVING count(*) > 0
    ) problems;

    IF offending IS NOT NULL THEN
        RAISE EXCEPTION
            'Cannot enforce NOT NULL: rows with missing values (%). Repair or remove these rows, then re-run the migration.',
            offending;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. NOT NULL on the columns every code path already supplies
-- ---------------------------------------------------------------------------

ALTER TABLE logs
    ALTER COLUMN organization_id SET NOT NULL,
    ALTER COLUMN level SET NOT NULL,
    ALTER COLUMN message SET NOT NULL,
    ALTER COLUMN timestamp SET NOT NULL;

ALTER TABLE tickets
    ALTER COLUMN organization_id SET NOT NULL,
    ALTER COLUMN title SET NOT NULL,
    ALTER COLUMN status SET NOT NULL,
    ALTER COLUMN priority SET NOT NULL;

ALTER TABLE documents
    ALTER COLUMN organization_id SET NOT NULL,
    ALTER COLUMN filename SET NOT NULL;

ALTER TABLE memberships
    ALTER COLUMN user_id SET NOT NULL,
    ALTER COLUMN organization_id SET NOT NULL,
    ALTER COLUMN role SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. CHECK constraints for the value domains the API relies on
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logs_level_check') THEN
        ALTER TABLE logs
            ADD CONSTRAINT logs_level_check
            CHECK (level IN ('debug', 'info', 'warn', 'error', 'fatal'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_status_check') THEN
        ALTER TABLE tickets
            ADD CONSTRAINT tickets_status_check
            CHECK (status IN ('open', 'pending', 'in_progress', 'resolved', 'closed'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_priority_check') THEN
        ALTER TABLE tickets
            ADD CONSTRAINT tickets_priority_check
            CHECK (priority IN ('low', 'medium', 'high', 'urgent'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_processing_status_check') THEN
        ALTER TABLE documents
            ADD CONSTRAINT documents_processing_status_check
            CHECK (processing_status IN ('pending', 'processing', 'processed', 'failed'));
    END IF;

    -- A document is only "processed" once it has a completion timestamp.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_processed_at_check') THEN
        ALTER TABLE documents
            ADD CONSTRAINT documents_processed_at_check
            CHECK (processing_status <> 'processed' OR processed_at IS NOT NULL);
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. Indexes for the queries the API actually runs
-- ---------------------------------------------------------------------------

-- listLogs(): WHERE organization_id = $1 ORDER BY timestamp DESC
CREATE INDEX IF NOT EXISTS idx_logs_org_timestamp
    ON logs (organization_id, timestamp DESC);

-- Level filters and the insight rollups.
CREATE INDEX IF NOT EXISTS idx_logs_org_level
    ON logs (organization_id, level);

-- listTickets(): WHERE organization_id = $1 ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_tickets_org_created
    ON tickets (organization_id, created_at DESC);

-- Ticket status filters and the insight rollups.
CREATE INDEX IF NOT EXISTS idx_tickets_org_status
    ON tickets (organization_id, status);

-- listDocuments(): WHERE organization_id = $1 ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_documents_org_created
    ON documents (organization_id, created_at DESC);

-- Membership lookups by organization (the unique index covers user_id first).
CREATE INDEX IF NOT EXISTS idx_memberships_org
    ON memberships (organization_id);
