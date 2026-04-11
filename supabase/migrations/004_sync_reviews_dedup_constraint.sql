-- Prevent duplicate in-flight sync_reviews outbox entries per business.
-- Two concurrent ReconciliationPoller processes can both observe "no pending/dispatched
-- row" and both INSERT. This partial unique index makes the second INSERT fail with a
-- unique violation, which the poller catches and skips gracefully.

-- First, collapse any pre-existing duplicates so the index creation doesn't fail.
-- For each (topic, aggregate_id) group with multiple in-flight rows, keep only the
-- oldest one (smallest created_at) and fail the rest.
UPDATE job_outbox SET status = 'failed', last_error = 'Collapsed duplicate by migration 004', completed_at = NOW()
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY topic, aggregate_id ORDER BY created_at) AS rn
    FROM job_outbox
    WHERE topic = 'sync_reviews' AND status IN ('pending', 'dispatched')
  ) ranked
  WHERE rn > 1
);

CREATE UNIQUE INDEX idx_jo_sync_reviews_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'sync_reviews' AND status IN ('pending', 'dispatched');
