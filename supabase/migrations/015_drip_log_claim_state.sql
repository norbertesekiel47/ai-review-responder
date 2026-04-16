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

-- Collapse any duplicate non-failed onboarding_drip outbox rows that may have
-- been created before the unique index existed. Keep the oldest row per
-- (aggregate_id, drip_type) and mark the rest as 'failed'.
UPDATE job_outbox
SET status = 'failed', last_error = 'migration 015: collapsed duplicate'
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY aggregate_id, payload->>'drip_type'
      ORDER BY created_at ASC
    ) AS rn
    FROM job_outbox
    WHERE topic = 'onboarding_drip' AND status <> 'failed'
  ) dupes
  WHERE rn > 1
);

-- Partial unique index for outbox dedup (idempotent — safe if 014 already created it)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_outbox_onboarding_drip
  ON job_outbox(aggregate_id, (payload->>'drip_type'))
  WHERE topic = 'onboarding_drip'
    AND status <> 'failed';

-- Partial index for scheduler query performance at scale.
-- The scheduler predicate is: subscription_activated_at <= NOW() - interval,
-- which Postgres can use as a range scan on this index.
CREATE INDEX IF NOT EXISTS idx_businesses_drip_ready
  ON businesses(subscription_activated_at)
  WHERE subscription_status = 'active'
    AND subscription_activated_at IS NOT NULL;
