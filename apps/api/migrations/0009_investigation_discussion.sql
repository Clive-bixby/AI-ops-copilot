-- 0009_investigation_discussion.sql
--
-- Phase 4 M3: a discussion feed on an investigation.
--
-- Design notes
--   * Notes already live in `investigation_activity`, which is the activity
--     history and the note stream in one table. A comment is the same kind of
--     durable, attributed, append-only entry, so it belongs in that table too.
--     A second table would have to be merged back by every reader.
--   * The only storage change is the vocabulary: `comment` joins the allowed
--     activity types. The existing indexes already cover the feed order.
--   * Comments are append-only like notes: there is no edit or delete endpoint,
--     and nothing here introduces one.
--   * The body check is widened so a comment, like a note, can never be stored
--     with a blank body.

-- ---------------------------------------------------------------------------
-- 1. Activity vocabulary: allow comments
-- ---------------------------------------------------------------------------

ALTER TABLE investigation_activity
    DROP CONSTRAINT IF EXISTS investigation_activity_type_check;

ALTER TABLE investigation_activity
    ADD CONSTRAINT investigation_activity_type_check
        CHECK (
            type IN (
                'created',
                'note',
                'comment',
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

-- ---------------------------------------------------------------------------
-- 2. A comment needs text, exactly like a note
-- ---------------------------------------------------------------------------

ALTER TABLE investigation_activity
    DROP CONSTRAINT IF EXISTS investigation_activity_note_body_check;

ALTER TABLE investigation_activity
    ADD CONSTRAINT investigation_activity_note_body_check
        CHECK (
            type NOT IN ('note', 'comment')
            OR (body IS NOT NULL AND btrim(body) <> '')
        );

COMMENT ON TABLE investigation_activity IS
    'Investigation notes, comments and activity history in one stream: discussion entries, status changes, evidence and hypothesis events, analysis outcomes and follow-ups.';
