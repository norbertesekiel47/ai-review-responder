-- =============================================================================
-- Sprint 5B: Retention Expansion
-- Migration: 014_retention_expansion.sql
--
-- Adds database objects deferred from Sprint 5A:
--   - onboarding_drip_log table (idempotent drip email delivery)
--   - satisfaction_responses table (weekly pulse feedback from owners)
--   - businesses: subscription timing, ranking, notification opt-out columns
--   - approval_audit_log: session-authenticated dashboard action support
--   - ranking_snapshots: unique constraint for ON CONFLICT upserts
--
-- Reference: docs/Final_Implementation_Plan.md — Sprint 5B deferred database objects
-- =============================================================================

BEGIN;

-- =============================================================================
-- NEW TABLE: onboarding_drip_log
-- Tracks which onboarding drip emails have been sent per business.
-- UNIQUE constraint on (business_id, drip_type) ensures idempotent delivery.
-- Drip timing is based on businesses.subscription_activated_at, NOT created_at.
-- Only fires for 'active' businesses — never 'pending_payment'.
-- =============================================================================

CREATE TABLE IF NOT EXISTS onboarding_drip_log (
  id UUID PRIMARY KEY,  -- app-generated UUIDv7, no DEFAULT (convention since migration 002)
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  drip_type TEXT NOT NULL CHECK (drip_type IN ('day_1', 'day_7', 'day_30')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, drip_type)
);

ALTER TABLE onboarding_drip_log ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_onboarding_drip_business
  ON onboarding_drip_log(business_id);

-- =============================================================================
-- NEW TABLE: satisfaction_responses
-- Stores weekly satisfaction pulse responses from business owners.
-- Linked from the bottom of the Weekly Value Report email.
-- GET renders confirmation page (no DB write); POST upserts the response.
-- "not_great" rating triggers a partner_satisfaction_alert via outbox.
-- =============================================================================

CREATE TABLE IF NOT EXISTS satisfaction_responses (
  id UUID PRIMARY KEY,  -- app-generated UUIDv7
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  week_start_date DATE NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('great', 'ok', 'not_great')),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, week_start_date)
);

ALTER TABLE satisfaction_responses ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_satisfaction_responses_business_week
  ON satisfaction_responses(business_id, week_start_date DESC);

-- =============================================================================
-- ALTER businesses: subscription timing, ranking, notification opt-out
-- =============================================================================

-- Drip email timing anchor. Set by Stripe webhook on checkout.session.completed
-- when transitioning to subscription_status='active'. Never set for pending_payment.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS subscription_activated_at TIMESTAMPTZ;

-- Tracked keywords for automated ranking (JSONB array of strings).
-- Empty by default. Admin explicitly sets before ranking tracking starts.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS tracked_keywords JSONB DEFAULT '[]'::jsonb;

-- Location data for SerpAPI ranking searches (ll= parameter).
-- Populated from PlaceAutocomplete during onboarding or admin edit.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS google_place_address TEXT;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS google_place_lat NUMERIC(10, 7);

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS google_place_lng NUMERIC(10, 7);

-- Explicit override for ranking search location (e.g., "San Jose, CA").
-- Used when coordinates are unavailable. Admin can set manually.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS ranking_search_location TEXT;

-- Notification opt-out flags for owner settings page.
-- WeeklySummaryScheduler and MonthlyImpactScheduler must respect these.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS weekly_summary_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS monthly_impact_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- =============================================================================
-- BACKFILL: subscription_activated_at for existing active businesses
-- Uses updated_at as best approximation of when they became active.
-- =============================================================================

UPDATE businesses
  SET subscription_activated_at = updated_at
  WHERE subscription_status = 'active'
    AND subscription_activated_at IS NULL;

-- =============================================================================
-- BACKFILL: normalize tracked_keywords NULLs
-- Ensures the column is always a valid JSONB array, never NULL.
-- =============================================================================

UPDATE businesses
  SET tracked_keywords = '[]'::jsonb
  WHERE tracked_keywords IS NULL;

ALTER TABLE businesses
  ALTER COLUMN tracked_keywords SET DEFAULT '[]'::jsonb,
  ALTER COLUMN tracked_keywords SET NOT NULL;

-- =============================================================================
-- ALTER approval_audit_log: support session-authenticated dashboard actions
-- Existing token-based approval routes continue to write token_hash.
-- New dashboard routes write actor_user_id + auth_method='owner_session'.
-- =============================================================================

-- Drop NOT NULL on token_hash — dashboard approval actions won't have a token
ALTER TABLE approval_audit_log
  ALTER COLUMN token_hash DROP NOT NULL;

-- Actor identity for session-authenticated actions (owner dashboard)
ALTER TABLE approval_audit_log
  ADD COLUMN IF NOT EXISTS actor_user_id UUID REFERENCES users(id);

-- Distinguish token-based (email link) vs session-based (dashboard) actions
ALTER TABLE approval_audit_log
  ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'token'
    CHECK (auth_method IN ('token', 'owner_session'));

-- =============================================================================
-- ranking_snapshots: unique constraint for ON CONFLICT upserts
-- Required before automated ranking tracking uses:
--   ON CONFLICT (business_id, keyword, snapshot_date) DO UPDATE ...
-- If this fails, manually dedupe existing duplicate snapshots first.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uniq_ranking_snapshots_business_keyword_date
  ON ranking_snapshots(business_id, keyword, snapshot_date);

-- =============================================================================
-- PARTIAL INDEX: businesses eligible for automated ranking tracking
-- Used by RankingTrackingScheduler to find businesses with verified place IDs,
-- active subscriptions, and at least one tracked keyword.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_businesses_ranking_ready
  ON businesses(subscription_status, place_id_verified)
  WHERE subscription_status = 'active'
    AND place_id_verified = TRUE
    AND tracked_keywords <> '[]'::jsonb;

-- =============================================================================
-- PARTIAL UNIQUE INDEX: prevent duplicate track_ranking outbox entries
-- Uses (aggregate_id, payload->>'run_date') so two scheduler instances, a
-- restart during the same 22:00 UTC window, or a fast-completing job cannot
-- enqueue multiple jobs for the same business + run date.
--
-- Covers ALL statuses except 'failed' (which should allow a retry via a new
-- outbox entry). Completed jobs ARE included — if a job completed for this
-- business+date, another one must not be created. Retries for transient
-- failures go through BullMQ's built-in retry mechanism on the existing
-- outbox entry, not by inserting a new row.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uniq_outbox_track_ranking_run
  ON job_outbox(aggregate_id, (payload->>'run_date'))
  WHERE topic = 'track_ranking'
    AND status <> 'failed';

-- =============================================================================
-- CHECK CONSTRAINT: tracked_keywords must be a JSONB array
-- Prevents malformed values that would crash the worker on parse.
-- Idempotent: only adds if the constraint does not already exist.
-- =============================================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_tracked_keywords_array'
  ) THEN
    ALTER TABLE businesses
      ADD CONSTRAINT chk_tracked_keywords_array
      CHECK (jsonb_typeof(tracked_keywords) = 'array');
  END IF;
END $$;

COMMIT;
