-- Migration 017: Sprint 6 main schema
--
-- Combines all Sprint 6 schema needs in one migration per docs/Final_Implementation_Plan.md:
-- 1. api_costs_daily_rollups table for archival aggregation (Prompt 20b)
-- 2. businesses.website column for onboarding pre-fill (Prompt 20c)
-- 3. businesses.owner_email_bounced column for email deliverability (Prompt 20d)
-- 4. notification_deliveries(created_at) index for archival DELETE scans (Prompt 20b)
--
-- UNIQUE NULLS NOT DISTINCT is Postgres 15+ syntax. This treats multiple NULL
-- business_id rows as colliding for uniqueness — correct for platform-level
-- cost entries (e.g., SerpAPI demo pre-fill) which have business_id = NULL.

CREATE TABLE IF NOT EXISTS api_costs_daily_rollups (
  id UUID PRIMARY KEY,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL,
  rollup_date DATE NOT NULL,
  total_cost_usd DECIMAL(10,6) NOT NULL,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_cost_rollups_business_provider_date
    UNIQUE NULLS NOT DISTINCT (business_id, provider, rollup_date)
);

ALTER TABLE api_costs_daily_rollups ENABLE ROW LEVEL SECURITY;

-- Indexes for admin costs page query patterns:
-- (business, date DESC) for per-business historical breakdown
-- (provider, date DESC) for byProvider aggregation across dates
-- (date DESC) for byDay aggregation across all businesses/providers
CREATE INDEX IF NOT EXISTS idx_cost_rollups_business_date
  ON api_costs_daily_rollups(business_id, rollup_date DESC);
CREATE INDEX IF NOT EXISTS idx_cost_rollups_provider_date
  ON api_costs_daily_rollups(provider, rollup_date DESC);
CREATE INDEX IF NOT EXISTS idx_cost_rollups_date
  ON api_costs_daily_rollups(rollup_date DESC);

-- Sprint 6 business columns (consumed by Prompt 20c/20d)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS owner_email_bounced BOOLEAN NOT NULL DEFAULT FALSE;

-- Archival DELETE scans notification_deliveries by created_at.
-- The existing idx_nd_business covers (business_id, created_at) but leads with
-- business_id, so a scan across all businesses by created_at alone can't use it.
CREATE INDEX IF NOT EXISTS idx_nd_created_at
  ON notification_deliveries(created_at);
