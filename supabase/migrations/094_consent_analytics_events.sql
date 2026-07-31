-- 094_consent_analytics_events.sql
-- Registers the consent ledger's two analytics events (#625, locked spec
-- docs/superpowers/specs/2026-07-28-consent-ledger-design.md §8.1) in the
-- analytics_events.event_name DB CHECK allowlist:
--   * solicitation_consent_recorded — a consent row was inserted
--   * solicitation_consent_upgraded — the §4.2 DO UPDATE branch fired
--
-- Why a separate migration from 093: registering the names only in
-- ANALYTICS_EVENT_NAMES is NOT enough (089's lesson, restated verbatim there):
-- without the CHECK entry every consent-recording csv_ingest transaction
-- ROLLS BACK on the constraint, and `ci:analytics-events` would not catch it
-- (it only compares the TS allowlist against docs/analytics/events.md, never
-- the database). 093 was already the recorded head when the gap surfaced, and
-- applied migrations are immutable — the fix is head+1.
--
-- Same shape as 046 → 058 → 069 → 089: DROP + re-ADD is idempotent in its end
-- state, but the swap takes a brief ACCESS EXCLUSIVE lock on analytics_events
-- and re-validates existing rows — hence the lock_timeout. The new list is a
-- strict superset of 089's, so existing rows always pass.
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
      'solicitation_consent_upgraded'
    )
  );
