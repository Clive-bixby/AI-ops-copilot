-- 0005_investigations.sql
--
-- Phase 3: persistent investigations.
--
-- An investigation is an engineer's working record of one operational problem:
-- the problem statement, the sources collected as evidence, a real timestamped
-- timeline, the analysis runs that interpreted that evidence, hypotheses a human
-- can verify or reject, and an activity log that doubles as notes.
--
-- Design notes
--   * Every child table carries organization_id and references its parent
--     through a composite foreign key (investigation_id, organization_id). A row
--     belonging to another tenant's investigation is therefore impossible at the
--     storage layer, not only in application code.
--   * Vocabularies are TEXT + CHECK, matching 0002/0004, rather than new enum
--     types that are awkward to extend later.
--   * Evidence stores the excerpt and source timestamps that were resolved on
--     the server. Client-supplied content is never trusted, and a similarity is
--     only stored for a match that actually had one (keyword-only hits keep NULL).
--   * `investigation_activity` is both the note stream and the activity history.
--     Two near-identical tables would have to be merged again by every reader.
--   * `investigation_analyses` stores the evidence ids, search parameters, model
--     and structured result of each run so an analysis is reproducible without
--     persisting the prompt itself.
--   * A partial unique index allows at most one pending analysis per
--     investigation, so two concurrent requests cannot both spend model credits.
--   * Deleting a source (document, ticket, log group) removes the evidence that
--     pointed at it, mirroring the source_chunks cleanup from 0003.

-- ---------------------------------------------------------------------------
-- 1. Investigations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS investigations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    severity TEXT NOT NULL DEFAULT 'medium',
    -- Free-form component name; matches the vocabulary log_groups.service uses.
    service TEXT,
    error_signature TEXT,
    window_start TIMESTAMPTZ,
    window_end TIMESTAMPTZ,
    -- NULL means "search every source type".
    source_types TEXT[],
    resolution_summary TEXT,
    -- Users are never deleted through the API, so RESTRICT is the honest rule:
    -- losing the creator would make the record unattributable.
    created_by UUID NOT NULL REFERENCES users(id),
    resolved_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Referenced by every child table's composite foreign key.
    CONSTRAINT investigations_id_org_uniq UNIQUE (id, organization_id),
    CONSTRAINT investigations_title_check CHECK (length(btrim(title)) BETWEEN 3 AND 200),
    CONSTRAINT investigations_description_check
        CHECK (length(btrim(description)) BETWEEN 10 AND 4000),
    CONSTRAINT investigations_status_check
        CHECK (status IN ('open', 'investigating', 'resolved', 'closed')),
    CONSTRAINT investigations_severity_check
        CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    CONSTRAINT investigations_window_check
        CHECK (window_start IS NULL OR window_end IS NULL OR window_end > window_start),
    CONSTRAINT investigations_source_types_check
        CHECK (source_types IS NULL OR source_types <@ ARRAY['document', 'log', 'ticket']::TEXT[]),
    -- A resolved investigation always has a resolution and the time it was
    -- recorded; the system never marks an investigation resolved on its own.
    CONSTRAINT investigations_resolved_check
        CHECK (
            status <> 'resolved'
            OR (
                resolved_at IS NOT NULL
                AND resolution_summary IS NOT NULL
                AND btrim(resolution_summary) <> ''
            )
        ),
    CONSTRAINT investigations_closed_check
        CHECK (status <> 'closed' OR closed_at IS NOT NULL),
    CONSTRAINT investigations_resolution_summary_length_check
        CHECK (resolution_summary IS NULL OR length(resolution_summary) <= 2000)
);

CREATE INDEX IF NOT EXISTS idx_investigations_org_updated
    ON investigations (organization_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_investigations_org_status_updated
    ON investigations (organization_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_investigations_org_severity
    ON investigations (organization_id, severity);

COMMENT ON TABLE investigations IS
    'One operational problem under investigation: problem statement, lifecycle, optional scope (service/time window), and the human-verified resolution.';

-- ---------------------------------------------------------------------------
-- 2. Evidence
-- ---------------------------------------------------------------------------
-- `source_id` is polymorphic (documents.id, tickets.id, log_groups.id). It cannot
-- be a foreign key, so deletion is handled by the triggers in section 7 and
-- existence is verified by the collection service before a row is written.

CREATE TABLE IF NOT EXISTS investigation_evidence (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    investigation_id UUID NOT NULL,
    organization_id UUID NOT NULL,
    source_type TEXT NOT NULL,
    source_id UUID NOT NULL,
    -- Which chunk of that source the excerpt came from (0 for tickets/log groups).
    chunk_index INTEGER NOT NULL DEFAULT 0,
    -- Snapshot of the source label at collection time: filename, ticket title or
    -- log template. It is evidence of what was read, not a live copy of the source.
    source_title TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    -- The source's own timestamp. NULL when the source genuinely has none; never
    -- inferred from retrieval metadata or the collection time.
    source_created_at TIMESTAMPTZ,
    source_metadata JSONB,
    match_type TEXT NOT NULL,
    retrieval_score DOUBLE PRECISION NOT NULL,
    -- Cosine similarity, or NULL for a keyword-only match. Never invented.
    similarity DOUBLE PRECISION,
    relevance TEXT NOT NULL,
    inclusion_reason TEXT NOT NULL,
    -- The query that surfaced this source, kept so an analysis is reproducible.
    retrieval_query TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'retrieval',
    -- NULL for system-collected evidence.
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT investigation_evidence_investigation_fk
        FOREIGN KEY (investigation_id, organization_id)
        REFERENCES investigations(id, organization_id) ON DELETE CASCADE,
    -- Referenced by hypothesis links so evidence cannot move between investigations.
    CONSTRAINT investigation_evidence_id_investigation_uniq
        UNIQUE (id, investigation_id),
    -- One evidence row per source: an investigation lists sources, not chunk spam.
    CONSTRAINT investigation_evidence_source_uniq
        UNIQUE (investigation_id, source_type, source_id),
    CONSTRAINT investigation_evidence_source_type_check
        CHECK (source_type IN ('document', 'log', 'ticket')),
    CONSTRAINT investigation_evidence_chunk_index_check CHECK (chunk_index >= 0),
    CONSTRAINT investigation_evidence_match_type_check
        CHECK (match_type IN ('vector', 'keyword', 'hybrid')),
    CONSTRAINT investigation_evidence_relevance_check
        CHECK (relevance IN ('direct', 'historical', 'related', 'weak')),
    CONSTRAINT investigation_evidence_origin_check
        CHECK (origin IN ('retrieval', 'manual')),
    CONSTRAINT investigation_evidence_excerpt_check
        CHECK (length(excerpt) BETWEEN 1 AND 2000),
    CONSTRAINT investigation_evidence_similarity_check
        CHECK (similarity IS NULL OR (similarity >= 0 AND similarity <= 1)),
    -- A keyword-only match has no cosine similarity; a vector/hybrid match has one.
    CONSTRAINT investigation_evidence_similarity_presence_check
        CHECK (
            (match_type = 'keyword' AND similarity IS NULL)
            OR (match_type <> 'keyword' AND similarity IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS idx_investigation_evidence_investigation
    ON investigation_evidence (investigation_id, source_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_investigation_evidence_org_source
    ON investigation_evidence (organization_id, source_type, source_id);

COMMENT ON TABLE investigation_evidence IS
    'Sources collected for an investigation, with the server-resolved excerpt, real source timestamp, retrieval provenance and a deterministic relevance class.';

-- ---------------------------------------------------------------------------
-- 3. Analysis runs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS investigation_analyses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    investigation_id UUID NOT NULL,
    organization_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    -- Typed, user-facing reason when a run failed. Never a provider stack trace.
    failure_reason TEXT,
    -- Bumped whenever the prompt or the output schema changes.
    analysis_version INTEGER NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    -- Exactly the evidence rows the model was given.
    evidence_ids UUID[] NOT NULL DEFAULT '{}',
    -- Derived queries, filters and limits. No prompts and no secrets.
    search_params JSONB NOT NULL DEFAULT '{}'::JSONB,
    summary TEXT,
    key_observations JSONB NOT NULL DEFAULT '[]'::JSONB,
    next_steps JSONB NOT NULL DEFAULT '[]'::JSONB,
    insufficient_evidence BOOLEAN NOT NULL DEFAULT FALSE,
    missing_information TEXT[] NOT NULL DEFAULT '{}',
    generation_ms INTEGER,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT investigation_analyses_investigation_fk
        FOREIGN KEY (investigation_id, organization_id)
        REFERENCES investigations(id, organization_id) ON DELETE CASCADE,
    CONSTRAINT investigation_analyses_status_check
        CHECK (status IN ('pending', 'succeeded', 'failed')),
    CONSTRAINT investigation_analyses_version_check CHECK (analysis_version > 0),
    CONSTRAINT investigation_analyses_generation_check
        CHECK (generation_ms IS NULL OR generation_ms >= 0),
    CONSTRAINT investigation_analyses_observations_check
        CHECK (jsonb_typeof(key_observations) = 'array'),
    CONSTRAINT investigation_analyses_next_steps_check
        CHECK (jsonb_typeof(next_steps) = 'array'),
    CONSTRAINT investigation_analyses_failure_reason_check
        CHECK (status <> 'failed' OR failure_reason IS NOT NULL)
);

-- One run in flight per investigation. A crashed run is reclaimed by the service
-- after a bounded staleness window, so this cannot wedge an investigation.
CREATE UNIQUE INDEX IF NOT EXISTS investigation_analyses_pending_uniq
    ON investigation_analyses (investigation_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_investigation_analyses_investigation
    ON investigation_analyses (investigation_id, created_at DESC);

COMMENT ON TABLE investigation_analyses IS
    'One AI analysis run: the evidence ids and search parameters used, model metadata, and the validated structured result. The prompt itself is not stored.';

-- ---------------------------------------------------------------------------
-- 4. Hypotheses
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS investigation_hypotheses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    investigation_id UUID NOT NULL,
    organization_id UUID NOT NULL,
    statement TEXT NOT NULL,
    rationale TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unverified',
    -- Distinguishes a model suggestion from a conclusion a human recorded.
    status_source TEXT NOT NULL DEFAULT 'model',
    missing_information TEXT[] NOT NULL DEFAULT '{}',
    verification_steps TEXT[] NOT NULL DEFAULT '{}',
    -- Stable identity so a repeated analysis does not duplicate a hypothesis.
    statement_hash TEXT NOT NULL,
    analysis_id UUID REFERENCES investigation_analyses(id) ON DELETE SET NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT investigation_hypotheses_investigation_fk
        FOREIGN KEY (investigation_id, organization_id)
        REFERENCES investigations(id, organization_id) ON DELETE CASCADE,
    -- Referenced by hypothesis-evidence links.
    CONSTRAINT investigation_hypotheses_id_investigation_uniq
        UNIQUE (id, investigation_id),
    CONSTRAINT investigation_hypotheses_statement_uniq
        UNIQUE (investigation_id, statement_hash),
    CONSTRAINT investigation_hypotheses_status_check
        CHECK (status IN ('unverified', 'supported', 'rejected')),
    CONSTRAINT investigation_hypotheses_status_source_check
        CHECK (status_source IN ('model', 'user')),
    CONSTRAINT investigation_hypotheses_statement_check
        CHECK (length(btrim(statement)) BETWEEN 1 AND 1000),
    CONSTRAINT investigation_hypotheses_rationale_check
        CHECK (length(btrim(rationale)) BETWEEN 1 AND 2000)
);

CREATE INDEX IF NOT EXISTS idx_investigation_hypotheses_investigation
    ON investigation_hypotheses (investigation_id, created_at ASC);

COMMENT ON TABLE investigation_hypotheses IS
    'Possible explanations for the observed problem. status_source records whether the status was set by the model (unverified default) or by a user.';

-- ---------------------------------------------------------------------------
-- 5. Hypothesis ↔ evidence links
-- ---------------------------------------------------------------------------
-- Both foreign keys include investigation_id, so evidence from another
-- investigation can never be cited as support.

CREATE TABLE IF NOT EXISTS investigation_hypothesis_evidence (
    hypothesis_id UUID NOT NULL,
    evidence_id UUID NOT NULL,
    investigation_id UUID NOT NULL,
    organization_id UUID NOT NULL,
    relation TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (hypothesis_id, evidence_id, relation),
    CONSTRAINT investigation_hypothesis_evidence_hypothesis_fk
        FOREIGN KEY (hypothesis_id, investigation_id)
        REFERENCES investigation_hypotheses(id, investigation_id) ON DELETE CASCADE,
    CONSTRAINT investigation_hypothesis_evidence_evidence_fk
        FOREIGN KEY (evidence_id, investigation_id)
        REFERENCES investigation_evidence(id, investigation_id) ON DELETE CASCADE,
    CONSTRAINT investigation_hypothesis_evidence_investigation_fk
        FOREIGN KEY (investigation_id, organization_id)
        REFERENCES investigations(id, organization_id) ON DELETE CASCADE,
    CONSTRAINT investigation_hypothesis_evidence_relation_check
        CHECK (relation IN ('supports', 'contradicts'))
);

CREATE INDEX IF NOT EXISTS idx_investigation_hypothesis_evidence_evidence
    ON investigation_hypothesis_evidence (evidence_id);

-- ---------------------------------------------------------------------------
-- 6. Activity and notes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS investigation_activity (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    investigation_id UUID NOT NULL,
    organization_id UUID NOT NULL,
    type TEXT NOT NULL,
    -- NULL for system events (evidence collection, analysis runs).
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    -- The note text, or a factual one-line description of what changed.
    body TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT investigation_activity_investigation_fk
        FOREIGN KEY (investigation_id, organization_id)
        REFERENCES investigations(id, organization_id) ON DELETE CASCADE,
    CONSTRAINT investigation_activity_type_check
        CHECK (
            type IN (
                'created',
                'note',
                'status_change',
                'severity_change',
                'evidence_added',
                'evidence_removed',
                'hypothesis_created',
                'hypothesis_status',
                'analysis_started',
                'analysis_succeeded',
                'analysis_failed',
                'follow_up'
            )
        ),
    CONSTRAINT investigation_activity_body_check
        CHECK (body IS NULL OR length(body) <= 4000),
    CONSTRAINT investigation_activity_note_body_check
        CHECK (type <> 'note' OR (body IS NOT NULL AND btrim(body) <> ''))
);

CREATE INDEX IF NOT EXISTS idx_investigation_activity_investigation
    ON investigation_activity (investigation_id, created_at DESC);

COMMENT ON TABLE investigation_activity IS
    'Investigation notes and activity history in one stream: notes, status changes, evidence and hypothesis events, analysis outcomes and follow-ups.';

-- ---------------------------------------------------------------------------
-- 7. Deleting a source removes the evidence that cited it
-- ---------------------------------------------------------------------------
-- Mirrors `delete_source_chunks_for_source()` from 0003. Evidence is a citation,
-- so it must not outlive the record it points at.

CREATE OR REPLACE FUNCTION delete_investigation_evidence_for_source()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM investigation_evidence
    WHERE organization_id = OLD.organization_id
      AND source_type = TG_ARGV[0]
      AND source_id = OLD.id;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_delete_investigation_evidence ON documents;
CREATE TRIGGER documents_delete_investigation_evidence
    AFTER DELETE ON documents
    FOR EACH ROW EXECUTE FUNCTION delete_investigation_evidence_for_source('document');

DROP TRIGGER IF EXISTS tickets_delete_investigation_evidence ON tickets;
CREATE TRIGGER tickets_delete_investigation_evidence
    AFTER DELETE ON tickets
    FOR EACH ROW EXECUTE FUNCTION delete_investigation_evidence_for_source('ticket');

DROP TRIGGER IF EXISTS log_groups_delete_investigation_evidence ON log_groups;
CREATE TRIGGER log_groups_delete_investigation_evidence
    AFTER DELETE ON log_groups
    FOR EACH ROW EXECUTE FUNCTION delete_investigation_evidence_for_source('log');
