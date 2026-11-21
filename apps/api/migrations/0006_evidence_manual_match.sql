-- 0006_evidence_manual_match.sql
--
-- Phase 3 evidence can also be linked by an engineer who already knows the
-- source (a ticket id quoted in a war room, a runbook they just read). That link
-- has no retrieval arm behind it, so it must not claim to be a keyword or vector
-- match. 0005 is already applied, so its CHECK constraint is replaced here
-- instead of being edited in place (applied migrations are checksum-locked).
--
-- `manual` evidence never carries a similarity: there is no cosine score for a
-- link a human typed in.

ALTER TABLE investigation_evidence
    DROP CONSTRAINT IF EXISTS investigation_evidence_match_type_check;

ALTER TABLE investigation_evidence
    ADD CONSTRAINT investigation_evidence_match_type_check
    CHECK (match_type IN ('vector', 'keyword', 'hybrid', 'manual'));

ALTER TABLE investigation_evidence
    DROP CONSTRAINT IF EXISTS investigation_evidence_similarity_presence_check;

ALTER TABLE investigation_evidence
    ADD CONSTRAINT investigation_evidence_similarity_presence_check
    CHECK ((match_type IN ('keyword', 'manual')) = (similarity IS NULL));
