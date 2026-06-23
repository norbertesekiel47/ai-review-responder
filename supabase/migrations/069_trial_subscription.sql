-- =====================================================================
-- 069_trial_subscription.sql
--
-- Card-up-front, Stripe-native 30-day free trial (PLAN.md rev 6).
--
-- Two additive, idempotent, non-destructive changes — NO new column, NO data
-- backfill (accounts.trial_ends_at already exists from migration 034; the
-- explicit 'trialing' subscription_status is a new VARCHAR value and there is
-- NO CHECK constraint on accounts.subscription_status, so nothing to alter
-- there):
--
--   1. Clarifying COMMENT on accounts.subscription_activated_at — it is the
--      SERVICE-START anchor (set at trial start for trialing accounts, at first
--      payment for non-trial activations), NOT necessarily the first-payment
--      date. ~47 service-start consumers reuse this column; rev-3's separate
--      entitlement_started_at column was rejected (Codex round 4 concurred).
--
--   2. Extend the analytics_events event_name allowlist with the four durable
--      server-side trial lifecycle facts. Replaces the constraint added in 058.
--      Keep this list in lockstep with ANALYTICS_EVENT_NAMES in
--      src/lib/analytics/events.ts (drift-guard: pnpm ci:analytics-events).
--
-- Transactional — safe to apply in a SINGLE transaction (no CONCURRENTLY).
-- Apply staging-first, then production, both Supabase projects in lockstep.
--
-- Verification after apply:
--   SELECT col_description('accounts'::regclass, (
--     SELECT attnum FROM pg_attribute
--     WHERE attrelid = 'accounts'::regclass AND attname = 'subscription_activated_at'
--   ));  -- expect the service-start comment
--   -- INSERT INTO analytics_events (... event_name 'trial_started' ...);  -- expect success
-- =====================================================================

COMMENT ON COLUMN accounts.subscription_activated_at IS
  'Service-start anchor: set when entitlement begins — at TRIAL START for trialing accounts (Stripe trial_start), or at first payment for non-trial activations. NOT necessarily the first-payment date. ~47 downstream consumers (onboarding drip, Zernio backfill gap window, etc.) read this as "when the customer started getting the product".';

ALTER TABLE analytics_events
  DROP CONSTRAINT IF EXISTS analytics_events_event_name_check;

ALTER TABLE analytics_events
  ADD CONSTRAINT analytics_events_event_name_check
  CHECK (
    event_name IN (
      'signup_started',
      'email_verified',
      'sample_demo_started',
      'sample_demo_to_signup',
      'gbp_connect_started',
      'gbp_connect_failed',
      'gbp_connected',
      'first_review_ingested',
      'first_response_drafted',
      'activation_completed',
      'offboarding_started',
      'offboarding_reactivated',
      'offboarding_teardown_completed',
      'offboarding_purged',
      'trial_started',
      'trial_converted',
      'trial_payment_failed',
      'trial_cancelled'
    )
  );
