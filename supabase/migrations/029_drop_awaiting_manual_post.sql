-- supabase/migrations/029_drop_awaiting_manual_post.sql
--
-- Decommission the manual-post fallback (spec §6.12b).
--
-- 1. Bulk-fail any orphan 'awaiting_manual_post' rows. Prod has zero
--    such rows per CLAUDE.md; this is defensive for dev/staging fixtures
--    and any rare legacy in-flight data.
-- 2. Rebuild the migration-026 partial unique index without the dead
--    status in its predicate. The index name is preserved so any code
--    that references the constraint name continues to find it.
-- 3. Drop the migration-024 dedup index whose predicate is no longer
--    satisfiable (template='admin_manual_post' won't be produced again
--    after manual-post is deleted in code).
--
-- Apply order: AFTER migration 028 (per spec §12 rollout step 1).

-- 1. Terminate orphan rows.
UPDATE responses
  SET status = 'failed',
      posting_error = 'manual_post_deprecated_2026_04',
      updated_at = NOW()
  WHERE status = 'awaiting_manual_post';

-- 2. Rebuild the non-terminal uniqueness index without 'awaiting_manual_post'.
DROP INDEX IF EXISTS responses_one_non_terminal_per_review;

CREATE UNIQUE INDEX IF NOT EXISTS responses_one_non_terminal_per_review
  ON responses (review_id)
  WHERE status IN (
    'pending_approval',
    'approved',
    'edited',
    'awaiting_owner_connect'
  );

COMMENT ON INDEX responses_one_non_terminal_per_review IS
  'Enforces "at most one non-terminal response per review". Migration 029 '
  'dropped awaiting_manual_post from the predicate after the manual-post '
  'fallback was decommissioned.';

-- 3. Drop the migration-024 dedup index. Predicate template='admin_manual_post'
--    is no longer satisfiable after manual-post code deletion.
DROP INDEX IF EXISTS notification_deliveries_response_template_uniq;
