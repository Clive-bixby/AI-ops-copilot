-- 0007_investigation_ownership.sql
--
-- Phase 4, milestone 1: investigation ownership.
--
-- An investigation can now name one member of its organization as the person
-- responsible for it. Ownership is intentionally nullable: the backend never
-- invents an owner, and an investigation created through the API without an
-- owner stays unassigned until a person assigns it.
--
-- Design notes
--   * The foreign key is composite `(owner_user_id, organization_id)` against
--     `memberships(user_id, organization_id)`. A user who is not a member of the
--     investigation's organization therefore cannot be stored as its owner, even
--     through a direct SQL write.
--   * `ON DELETE SET NULL (owner_user_id)` clears only the owner column when the
--     membership is removed. The investigation itself survives and becomes
--     unassigned; the record is not deleted because a person left the team.
--   * `investigation_activity.type` is extended additively with `owner_change`.
--     Existing rows already satisfy the new CHECK, so the constraint can be
--     replaced safely (0005 is checksum-locked and is not edited).

-- ---------------------------------------------------------------------------
-- 1. Owner column and membership-backed foreign key
-- ---------------------------------------------------------------------------

ALTER TABLE investigations
    ADD COLUMN IF NOT EXISTS owner_user_id UUID;

ALTER TABLE investigations
    DROP CONSTRAINT IF EXISTS investigations_owner_fk;

ALTER TABLE investigations
    ADD CONSTRAINT investigations_owner_fk
        FOREIGN KEY (owner_user_id, organization_id)
        REFERENCES memberships(user_id, organization_id)
        ON DELETE SET NULL (owner_user_id);

COMMENT ON COLUMN investigations.owner_user_id IS
    'The organization member responsible for this investigation. NULL means unassigned; never inferred from the creator.';

-- ---------------------------------------------------------------------------
-- 2. Owner indexes
-- ---------------------------------------------------------------------------
-- One index serves "my investigations" and "this person's investigations"; the
-- second serves status-first queues with owner grouping.

CREATE INDEX IF NOT EXISTS idx_investigations_org_owner_status
    ON investigations (organization_id, owner_user_id, status);

CREATE INDEX IF NOT EXISTS idx_investigations_org_status_owner
    ON investigations (organization_id, status, owner_user_id);

-- ---------------------------------------------------------------------------
-- 3. Activity vocabulary
-- ---------------------------------------------------------------------------

ALTER TABLE investigation_activity
    DROP CONSTRAINT IF EXISTS investigation_activity_type_check;

ALTER TABLE investigation_activity
    ADD CONSTRAINT investigation_activity_type_check
        CHECK (
            type IN (
                'created',
                'note',
                'status_change',
                'severity_change',
                'owner_change',
                'evidence_added',
                'evidence_removed',
                'hypothesis_created',
                'hypothesis_status',
                'analysis_started',
                'analysis_succeeded',
                'analysis_failed',
                'follow_up'
            )
        );
