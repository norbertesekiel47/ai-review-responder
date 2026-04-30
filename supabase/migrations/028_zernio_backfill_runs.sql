-- supabase/migrations/028_zernio_backfill_runs.sql
--
-- Persists per-business summary of the one-shot Zernio first-connect backfill
-- so the dashboard can render reliable "X older reviews skipped" messaging
-- without dashboard-time Zernio API calls. Replaces the unreliable
-- "compare response count vs total Zernio reviews" approach.
--
-- See docs/superpowers/specs/2026-04-29-zernio-ingestion-replace-serpapi-design.md §5.

CREATE TABLE IF NOT EXISTS zernio_backfill_runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  zernio_account_id        TEXT NOT NULL,
  zernio_location_id       TEXT NOT NULL,
  subscription_tier        TEXT NOT NULL,                   -- snapshot at backfill time
  subscription_activated_at TIMESTAMPTZ NOT NULL,            -- snapshot at backfill time

  -- Bucket counts (what we processed)
  gap_processed_count       INTEGER NOT NULL DEFAULT 0,
  historical_processed_count INTEGER NOT NULL DEFAULT 0,

  -- Cap-skip counts (what we did NOT process due to tier/cap limits)
  gap_skipped_count         INTEGER NOT NULL DEFAULT 0,    -- gap reviews beyond cap=25
  historical_skipped_count  INTEGER NOT NULL DEFAULT 0,    -- premium-only; non-premium = total historical
  oldest_skipped_create_time TIMESTAMPTZ,                  -- for "older than [date]" copy

  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One backfill run per business (the predicate guard in the connect callback
-- ensures it fires only on first activation; this index is defense-in-depth).
CREATE UNIQUE INDEX IF NOT EXISTS zernio_backfill_runs_one_per_business
  ON zernio_backfill_runs (business_id);

ALTER TABLE zernio_backfill_runs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE zernio_backfill_runs IS
  'Per-business summary of Zernio first-connect backfill. Dashboard reads '
  'skipped counts to render "X older reviews skipped" messaging. Tier and '
  'subscription_activated_at are snapshotted to make the row self-contained.';
