-- Migration 018: Sprint 6 Prompt 20a review fixes
--
-- Numbered 018 (not 017) to leave 017 for the planned Sprint 6 main migration
-- (017_sprint6_scale.sql — api_costs_daily_rollups, businesses.website,
-- businesses.owner_email_bounced) per docs/Final_Implementation_Plan.md.
--
-- This migration fixes three Prompt 20a issues:
-- 1. Expression index on correlation_id for fast operational queries.
--    The runbook SQL `SELECT * FROM job_outbox WHERE payload->>'correlation_id' = '<id>'`
--    would scan the whole table without this index at launch volume.
-- 2. Rebuild idx_jo_sync_reviews_inflight to include the transient 'dispatching' status.
--    The original migration 004 predates the claim-ownership refactor in OutboxPoller that
--    introduced 'dispatching'. Without this fix, a concurrent INSERT during the
--    pending→dispatching claim window can succeed and create a duplicate in-flight job.
-- 3. Index for recoverCorrelationId() lookup in approval routes.
--    The helper filters by (topic='generate_response', aggregate_id) ordered by
--    created_at DESC LIMIT 1. idx_jo_topic only covers (topic, status), so without
--    this index, the lookup scans all generate_response rows for the review.

-- ─── Expression index on correlation_id ───────────────────────────────────
-- Partial index: only payloads that actually carry correlation_id pay the cost.
-- Backward compat: outbox rows inserted before Prompt 20a have no correlation_id
-- field; they are excluded from the index via the `payload ? 'correlation_id'` guard.
CREATE INDEX IF NOT EXISTS idx_jo_correlation_id
  ON job_outbox ((payload->>'correlation_id'))
  WHERE payload ? 'correlation_id';

-- ─── Cleanup any pre-existing sync_reviews duplicates in all three states ──
-- Migration 004 collapsed pending/dispatched duplicates but not dispatching.
-- If any dispatching duplicates exist now, rebuilding the unique index below
-- would fail. Keep the oldest row in each (topic, aggregate_id) group and mark
-- the rest failed. Mirrors the migration 004 pattern.
UPDATE job_outbox
SET status = 'failed',
    last_error = 'Collapsed duplicate by migration 018 (dispatching-inclusive)',
    completed_at = NOW()
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY topic, aggregate_id
      ORDER BY created_at
    ) AS rn
    FROM job_outbox
    WHERE topic = 'sync_reviews'
      AND status IN ('pending', 'dispatching', 'dispatched')
  ) ranked
  WHERE rn > 1
);

-- ─── Rebuild sync_reviews in-flight unique index to cover 'dispatching' ──
-- CONCURRENTLY not used here because this runs at service startup; the table is
-- small at launch volume and brief locks are acceptable. If run against a large
-- production table later, rewrite as CONCURRENTLY outside a transaction block.
DROP INDEX IF EXISTS idx_jo_sync_reviews_inflight;

CREATE UNIQUE INDEX idx_jo_sync_reviews_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'sync_reviews'
    AND status IN ('pending', 'dispatching', 'dispatched');

-- ─── Index for recoverCorrelationId lookup ───────────────────────────────
-- Used by src/lib/approval/correlation.ts:
--   SELECT payload->>'correlation_id' FROM job_outbox
--   WHERE topic = 'generate_response' AND aggregate_id = <review_id>
--   ORDER BY created_at DESC LIMIT 1
-- Partial index on generate_response rows keeps it small; DESC ordering matches
-- the query so the LIMIT 1 is a single index lookup, not a scan.
CREATE INDEX IF NOT EXISTS idx_jo_generate_response_by_review
  ON job_outbox (aggregate_id, created_at DESC)
  WHERE topic = 'generate_response';
