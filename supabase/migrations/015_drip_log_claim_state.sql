-- =============================================================================
-- Sprint 5B: Onboarding drip log claim/sent state separation
-- Migration: 015_drip_log_claim_state.sql
--
-- Fixes: drip_log now represents claim state separately from sent state.
-- sent_at is nullable and only set after email delivery succeeds.
-- Also adds the onboarding_drip outbox dedup index if migration 014
-- was already applied without it.
-- =============================================================================

-- Make sent_at nullable — a claimed but not-yet-sent drip has sent_at = NULL.
-- Existing rows (already sent) keep their timestamps.
ALTER TABLE onboarding_drip_log ALTER COLUMN sent_at DROP NOT NULL;
ALTER TABLE onboarding_drip_log ALTER COLUMN sent_at DROP DEFAULT;

-- Partial unique index for outbox dedup (idempotent — safe if 014 already created it)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_outbox_onboarding_drip
  ON job_outbox(aggregate_id, (payload->>'drip_type'))
  WHERE topic = 'onboarding_drip'
    AND status <> 'failed';

-- Partial index for scheduler query performance at scale
CREATE INDEX IF NOT EXISTS idx_businesses_drip_ready
  ON businesses(subscription_activated_at)
  WHERE subscription_status = 'active'
    AND subscription_activated_at IS NOT NULL;
