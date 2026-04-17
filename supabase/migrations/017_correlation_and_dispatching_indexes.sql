-- Migration 017: Sprint 6 Prompt 20a review fixes
--
-- 1. Expression index on correlation_id for fast operational queries.
--    The runbook SQL `SELECT * FROM job_outbox WHERE payload->>'correlation_id' = '<id>'`
--    would scan the whole table without this index at launch volume.
--
-- 2. Rebuild idx_jo_sync_reviews_inflight to include the transient 'dispatching' status.
--    The original migration 004 predates the claim-ownership refactor in OutboxPoller that
--    introduced 'dispatching'. Without this fix, a concurrent INSERT during the
--    pending→dispatching claim window can succeed and create a duplicate in-flight job.

-- ─── Expression index on correlation_id ───────────────────────────────────
-- Partial index: only payloads that actually carry correlation_id pay the cost.
-- Backward compat: outbox rows inserted before Prompt 20a have no correlation_id
-- field; they are excluded from the index via the `payload ? 'correlation_id'` guard.
CREATE INDEX IF NOT EXISTS idx_jo_correlation_id
  ON job_outbox ((payload->>'correlation_id'))
  WHERE payload ? 'correlation_id';

-- ─── Rebuild sync_reviews in-flight unique index to cover 'dispatching' ──
-- CONCURRENTLY not used here because this runs at service startup; the table is
-- small at launch volume and brief locks are acceptable. If run against a large
-- production table later, rewrite as CONCURRENTLY outside a transaction block.
DROP INDEX IF EXISTS idx_jo_sync_reviews_inflight;

CREATE UNIQUE INDEX idx_jo_sync_reviews_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'sync_reviews'
    AND status IN ('pending', 'dispatching', 'dispatched');
