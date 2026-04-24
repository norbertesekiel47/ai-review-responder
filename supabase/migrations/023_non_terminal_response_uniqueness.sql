-- Migration 023: enforce "at most one non-terminal response per review"
--
-- Background: the invariant is documented at migration 001 line 207 and in
-- the CLAUDE.md Response status section. The only uniqueness constraint on
-- the responses table today is UNIQUE (review_id, version) — which does NOT
-- prevent two rows at the same review_id+different versions from both being
-- in an actionable state (pending_approval / approved / edited /
-- awaiting_manual_post). Review regeneration is supposed to set the prior
-- row to 'superseded' in the same transaction, but there is no database-
-- level guard if that path is ever missed.
--
-- This partial unique index makes violating the invariant a hard error.
-- Terminal statuses ('superseded', 'failed', 'posted') are excluded from
-- the index so historical rows never conflict with a new actionable draft.
--
-- 'posted' is terminal here because once a response is live on Google the
-- review is effectively handled — any future action requires a new review
-- ingest, which creates a new row anyway.
--
-- Note: CREATE INDEX CONCURRENTLY would be preferable in production, but
-- the migration runner executes inside a single transaction via Supabase
-- SQL editor, which disallows CONCURRENTLY. A plain CREATE INDEX holds a
-- brief ACCESS EXCLUSIVE lock — acceptable for this table's size.

CREATE UNIQUE INDEX IF NOT EXISTS responses_one_non_terminal_per_review
  ON responses (review_id)
  WHERE status IN ('pending_approval', 'approved', 'edited', 'awaiting_manual_post');

COMMENT ON INDEX responses_one_non_terminal_per_review IS
  'Enforces "at most one non-terminal response per review" invariant. '
  'Regeneration flow MUST set the prior row to superseded in the same tx.';
