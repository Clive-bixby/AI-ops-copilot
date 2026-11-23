-- 0008_action_items.sql
--
-- Phase 4, milestone 2: action items.
--
-- An action item is a unit of follow-up work attached to exactly one
-- investigation. It is created by a person, may be assigned to any member of the
-- same organization, and carries its own append-only event history so a status
-- change is never silently overwritten.
--
-- Provenance
--   `created_from` records whether a person wrote the item (`manual`) or accepted
--   a suggestion produced by an analysis (`analysis`). The source ids are
--   nullable so `ON DELETE SET NULL` can clear them when an analysis or
--   hypothesis is removed, but `source_label` is an immutable snapshot and is
--   what keeps the provenance readable after that happens. A trigger enforces the
--   insert-time requirement (an analysis-derived item must name a source) and the
--   immutability rules, because a CHECK cannot require a column that a foreign
--   key is allowed to null out.
--
-- Lifecycle
--   open -> in_progress | blocked | completed
--   in_progress -> open | blocked | completed
--   blocked -> open | in_progress | completed
--   completed -> open (reopen)
--   A blocked item must carry a non-empty reason. Completing stamps
--   `completed_at`; reopening clears it. The policy lives in
--   `actionItemPolicy.ts` and is mirrored by the CHECKs here.

-- ---------------------------------------------------------------------------
-- 1. Referenced analysis rows need a composite key
-- ---------------------------------------------------------------------------
-- 0005 gives hypotheses a `(id, investigation_id)` key so a citation cannot
-- cross investigations. Analyses never needed one until provenance columns
-- started pointing at them, so it is added here instead of editing 0005.

ALTER TABLE investigation_analyses
    ADD CONSTRAINT investigation_analyses_id_investigation_uniq
        UNIQUE (id, investigation_id);

-- ---------------------------------------------------------------------------
-- 2. Action items
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS action_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL,
    investigation_id UUID NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'medium',
    -- NULL means unassigned. Never inferred from the creator.
    assignee_user_id UUID,
    due_at TIMESTAMPTZ,
    blocked_reason TEXT,
    completed_at TIMESTAMPTZ,
    completed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    -- Provenance: who or what the item came from. See the header comment.
    created_from TEXT NOT NULL DEFAULT 'manual',
    source_analysis_id UUID,
    source_hypothesis_id UUID,
    source_label TEXT,
    -- Users are never deleted through the API, so RESTRICT is the honest rule.
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT action_items_investigation_fk
        FOREIGN KEY (investigation_id, organization_id)
        REFERENCES investigations(id, organization_id) ON DELETE CASCADE,
    -- Referenced by action_item_events.
    CONSTRAINT action_items_id_org_uniq UNIQUE (id, organization_id),
    -- A member of another organization cannot be stored as the assignee.
    CONSTRAINT action_items_assignee_fk
        FOREIGN KEY (assignee_user_id, organization_id)
        REFERENCES memberships(user_id, organization_id)
        ON DELETE SET NULL (assignee_user_id),
    -- Provenance sources must belong to the same investigation, not merely to
    -- the same organization.
    CONSTRAINT action_items_source_analysis_fk
        FOREIGN KEY (source_analysis_id, investigation_id)
        REFERENCES investigation_analyses(id, investigation_id)
        ON DELETE SET NULL (source_analysis_id),
    CONSTRAINT action_items_source_hypothesis_fk
        FOREIGN KEY (source_hypothesis_id, investigation_id)
        REFERENCES investigation_hypotheses(id, investigation_id)
        ON DELETE SET NULL (source_hypothesis_id),

    CONSTRAINT action_items_title_check
        CHECK (length(btrim(title)) BETWEEN 3 AND 200),
    CONSTRAINT action_items_description_check
        CHECK (description IS NULL OR length(description) <= 4000),
    CONSTRAINT action_items_status_check
        CHECK (status IN ('open', 'in_progress', 'blocked', 'completed')),
    CONSTRAINT action_items_priority_check
        CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    -- A blocked item without a reason is not actionable; the reason is what
    -- tells the next person what to unblock.
    CONSTRAINT action_items_blocked_reason_check
        CHECK (
            status <> 'blocked'
            OR (blocked_reason IS NOT NULL AND btrim(blocked_reason) <> '')
        ),
    CONSTRAINT action_items_blocked_reason_length_check
        CHECK (blocked_reason IS NULL OR length(blocked_reason) <= 1000),
    CONSTRAINT action_items_completed_check
        CHECK (status <> 'completed' OR completed_at IS NOT NULL),
    CONSTRAINT action_items_not_completed_check
        CHECK (status = 'completed' OR completed_at IS NULL),
    CONSTRAINT action_items_created_from_check
        CHECK (created_from IN ('manual', 'analysis')),
    CONSTRAINT action_items_source_label_check
        CHECK (source_label IS NULL OR length(btrim(source_label)) BETWEEN 1 AND 500),
    -- source_label is never nulled by a foreign key, so this CHECK is safe.
    CONSTRAINT action_items_analysis_source_label_check
        CHECK (created_from <> 'analysis' OR source_label IS NOT NULL),
    -- A manual item cannot carry provenance fields it did not earn.
    CONSTRAINT action_items_manual_provenance_check
        CHECK (
            created_from <> 'manual'
            OR (
                source_analysis_id IS NULL
                AND source_hypothesis_id IS NULL
                AND source_label IS NULL
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_action_items_org_status_priority
    ON action_items (organization_id, status, priority);

CREATE INDEX IF NOT EXISTS idx_action_items_org_assignee_status
    ON action_items (organization_id, assignee_user_id, status);

CREATE INDEX IF NOT EXISTS idx_action_items_investigation_created
    ON action_items (investigation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_action_items_org_due
    ON action_items (organization_id, due_at)
    WHERE due_at IS NOT NULL;

COMMENT ON TABLE action_items IS
    'Follow-up work attached to one investigation. Human-created records with optional analysis provenance; never executed by the system.';

COMMENT ON COLUMN action_items.created_from IS
    'manual = written by a person; analysis = accepted from an analysis suggestion. Immutable.';

COMMENT ON COLUMN action_items.source_label IS
    'Immutable snapshot of the suggestion an analysis-derived item came from.';

-- ---------------------------------------------------------------------------
-- 3. Provenance guard
-- ---------------------------------------------------------------------------
-- Enforced here rather than in a CHECK because `ON DELETE SET NULL` is allowed
-- to clear a source id, which a CHECK cannot distinguish from a bad insert.

CREATE OR REPLACE FUNCTION enforce_action_item_provenance()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.created_from = 'analysis'
           AND NEW.source_analysis_id IS NULL
           AND NEW.source_hypothesis_id IS NULL THEN
            RAISE EXCEPTION
                'An analysis-derived action item needs a source analysis or hypothesis'
                USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
    END IF;

    IF NEW.created_from IS DISTINCT FROM OLD.created_from THEN
        RAISE EXCEPTION 'created_from is immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.source_label IS DISTINCT FROM OLD.source_label THEN
        RAISE EXCEPTION 'source_label is immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    -- A source may be cleared by ON DELETE SET NULL (NEW is NULL), but it may
    -- never be set to a different non-null analysis or hypothesis.
    IF NEW.source_analysis_id IS NOT NULL
       AND NEW.source_analysis_id IS DISTINCT FROM OLD.source_analysis_id THEN
        RAISE EXCEPTION 'source_analysis_id cannot be repointed'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.source_hypothesis_id IS NOT NULL
       AND NEW.source_hypothesis_id IS DISTINCT FROM OLD.source_hypothesis_id THEN
        RAISE EXCEPTION 'source_hypothesis_id cannot be repointed'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS action_items_provenance_guard ON action_items;
CREATE TRIGGER action_items_provenance_guard
    BEFORE INSERT OR UPDATE ON action_items
    FOR EACH ROW EXECUTE FUNCTION enforce_action_item_provenance();

-- ---------------------------------------------------------------------------
-- 4. Event history
-- ---------------------------------------------------------------------------
-- Separate from the investigation activity stream: action items are durable
-- units of work and their history must survive independently. The API exposes
-- only append and read; there is no update or delete route.

CREATE TABLE IF NOT EXISTS action_item_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    action_item_id UUID NOT NULL,
    organization_id UUID NOT NULL,
    type TEXT NOT NULL,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    body TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT action_item_events_action_item_fk
        FOREIGN KEY (action_item_id, organization_id)
        REFERENCES action_items(id, organization_id) ON DELETE CASCADE,
    CONSTRAINT action_item_events_type_check
        CHECK (
            type IN (
                'created',
                'status_change',
                'assignee_change',
                'priority_change',
                'due_change',
                'details_change'
            )
        ),
    CONSTRAINT action_item_events_body_check
        CHECK (body IS NULL OR length(body) <= 1000)
);

CREATE INDEX IF NOT EXISTS idx_action_item_events_item_created
    ON action_item_events (action_item_id, created_at ASC);

COMMENT ON TABLE action_item_events IS
    'Append-only history for one action item: who changed what and when.';

-- The service only inserts, but the database refuses an in-place rewrite too.
CREATE OR REPLACE FUNCTION reject_action_item_event_update()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'action item events are append-only'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS action_item_events_no_update ON action_item_events;
CREATE TRIGGER action_item_events_no_update
    BEFORE UPDATE ON action_item_events
    FOR EACH ROW EXECUTE FUNCTION reject_action_item_event_update();
