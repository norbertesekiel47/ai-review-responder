-- 097_suppression_analytics_events.sql
-- Registers the Suppression ledger's two analytics events (#643, locked spec
-- docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §9.4) in
-- the analytics_events.event_name DB CHECK allowlist:
--   * solicitation_suppressed — a Suppression ledger row was inserted; emitted
--     by this ticket's writer (recordSuppression) in the SAME transaction.
--   * solicitation_suppressed_at_dispatch — the last-moment re-check refused a
--     send; emitted by #630, NOT by this ticket. Registered here so #644 and
--     #630 both stay migration-free.
--
-- Why a separate migration from 096 (G8): registering the names only in
-- ANALYTICS_EVENT_NAMES is NOT enough (089's lesson, restated in 094's header):
-- without the CHECK entry every emitting transaction ROLLS BACK on the
-- constraint, and `ci:analytics-events` would not catch it (it only compares
-- the TS allowlist against docs/analytics/events.md, never the database).
--
-- Same shape as 046 → 058 → 069 → 089 → 094: DROP + re-ADD is idempotent in its
-- end state, but the swap takes a brief ACCESS EXCLUSIVE lock on
-- analytics_events and re-validates existing rows — hence the lock_timeout, and
-- hence its own file rather than riding along in 096. The new list is a strict
-- superset of 094's, so existing rows always pass.
-- Rollback: revert the deploy (the constraint is a superset of the old one;
-- both events simply stop being emitted).

SET lock_timeout = '5s';

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
      'trial_cancelled',
      'competitor_rival_picked',
      'solicitation_consent_recorded',
      'solicitation_consent_upgraded',
      'solicitation_suppressed',
      'solicitation_suppressed_at_dispatch'
    )
  );
