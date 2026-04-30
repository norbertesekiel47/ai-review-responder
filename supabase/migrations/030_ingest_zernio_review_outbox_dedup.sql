-- supabase/migrations/030_ingest_zernio_review_outbox_dedup.sql
--
-- In-flight dedup for ingest_zernio_review outbox rows. Without this,
-- a worker crash mid-fan-out triggers Zernio's webhook retry (7×/51h),
-- which re-runs the webhook handler's INSERT...SELECT and produces
-- duplicate ingest_zernio_review rows for the same (business, review).
-- The worker is idempotent so the result is safe, but with 5+ retries ×
-- N connections, you have 5N rows fighting for the same review row +
-- burning Zernio API quota.
--
-- This partial unique index forces the webhook fan-out's
-- INSERT ... ON CONFLICT DO NOTHING to dedup against any non-terminal
-- (pending/dispatching/dispatched) row already in flight for the same
-- (business, zernio_review_id) pair.
--
-- See docs/superpowers/specs/2026-04-29-zernio-ingestion-replace-serpapi-design.md.

CREATE UNIQUE INDEX IF NOT EXISTS job_outbox_ingest_zernio_review_inflight
  ON job_outbox (aggregate_id, (payload->>'zernio_review_id'))
  WHERE topic = 'ingest_zernio_review'
    AND status IN ('pending', 'dispatching', 'dispatched');

COMMENT ON INDEX job_outbox_ingest_zernio_review_inflight IS
  'Prevents duplicate ingest_zernio_review outbox rows for the same '
  '(business, zernio_review_id) when Zernio retries a webhook delivery '
  'mid-processing. Used by the webhook fan-out INSERT ... ON CONFLICT '
  'DO NOTHING. Only covers non-terminal statuses so completed/failed '
  'rows don''t block future webhooks for the same review.';
