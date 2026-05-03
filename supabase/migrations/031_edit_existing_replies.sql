-- supabase/migrations/031_edit_existing_replies.sql
-- IMPORTANT: this file mixes transactional DDL with CONCURRENTLY index
-- creation. Apply non-transactionally — uncheck the "single transaction" box
-- in the Supabase SQL editor, OR split at the obvious boundary if your
-- runner doesn't support per-statement isolation.
--
-- See docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md §4.2.

-- ── PRE-FLIGHT CHECK (run BEFORE applying) ─────────────────────────────
-- The unique index in step 3 will fail (and leave an INVALID index behind)
-- if there are already two 'posted' rows for the same review_id. Verify
-- empty result first:
--
--   SELECT review_id, count(*) FROM responses
--     WHERE status = 'posted'
--     GROUP BY review_id
--     HAVING count(*) > 1;
--   -- expect: 0 rows
--
-- If non-empty, BLOCK migration and surface to ops; investigate the
-- duplicate 'posted' rows before proceeding.

-- 1. Track which reviews came in already-replied at first ingest.
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS external_reply_ingested_at TIMESTAMPTZ NULL;

-- 2. Counter for backfill summary visibility.
ALTER TABLE zernio_backfill_runs
  ADD COLUMN IF NOT EXISTS external_reply_ingested_count INTEGER NOT NULL DEFAULT 0;

-- 3. At any time exactly ONE responses row per review can be 'posted'
--    (Google has at most one live reply per review). Protects against
--    publisher bugs that might double-post.
--
--    CONCURRENTLY is REQUIRED — migration 023's note (supabase/migrations/
--    023_non_terminal_response_uniqueness.sql) flags that plain index
--    creation can take ACCESS EXCLUSIVE on responses, which is sizable.
--    CONCURRENTLY uses a less-blocking approach (RowExclusive +
--    ShareUpdateExclusive) at the cost of doing two table scans and not
--    running inside a transaction.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS responses_one_posted_per_review
  ON responses (review_id)
  WHERE status = 'posted';

-- 4. Index that supports the Past Replies query
--    (ORDER BY review_date DESC, scoped to business_id). Most existing
--    per-business queries already use a similar pattern, but plan-time
--    inspection didn't find an exact match for (business_id, review_date DESC).
--    Use IF NOT EXISTS so re-running is safe; CONCURRENTLY because reviews
--    is sizable in production. The migration is already non-transactional
--    (per the comment at the top), so adding CONCURRENTLY here is safe.
--    Drop this clause if a regression query plan shows an existing index
--    already serves the query.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_business_review_date
  ON reviews (business_id, review_date DESC);

-- ── POST-MIGRATION VERIFICATION (run AFTER applying) ───────────────────
--
--   SELECT indexname, indisvalid FROM pg_indexes
--     JOIN pg_class ON pg_class.relname = indexname
--     JOIN pg_index ON pg_index.indexrelid = pg_class.oid
--     WHERE indexname IN ('responses_one_posted_per_review',
--                         'idx_reviews_business_review_date');
--   -- expect: indisvalid = true for both
--
-- If indisvalid = false, the CONCURRENTLY build was interrupted; DROP
-- INDEX <name> and re-run.
