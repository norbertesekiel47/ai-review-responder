-- supabase/migrations/042_zernio_backfill_run_reasons.sql
--
-- The original zernio_backfill_runs model allowed exactly one row per
-- business. That is correct for first-connect backfill, but reactivated
-- locations need later catch-up runs without overwriting or skipping the
-- initial run.

ALTER TABLE zernio_backfill_runs
  ADD COLUMN IF NOT EXISTS run_reason TEXT NOT NULL DEFAULT 'initial',
  ADD COLUMN IF NOT EXISTS correlation_id UUID;

DROP INDEX IF EXISTS zernio_backfill_runs_one_per_business;

CREATE UNIQUE INDEX IF NOT EXISTS zernio_backfill_runs_one_initial_per_business
  ON zernio_backfill_runs (business_id)
  WHERE run_reason = 'initial';

CREATE UNIQUE INDEX IF NOT EXISTS zernio_backfill_runs_correlation_id_uniq
  ON zernio_backfill_runs (correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS zernio_backfill_runs_business_reason_started_idx
  ON zernio_backfill_runs (business_id, run_reason, started_at DESC);

COMMENT ON COLUMN zernio_backfill_runs.run_reason IS
  'initial for first-connect one-shot backfill; reactivation for later archive/restore catch-up runs.';

COMMENT ON COLUMN zernio_backfill_runs.correlation_id IS
  'Idempotency key for non-initial backfill runs, usually copied from the outbox payload.';
