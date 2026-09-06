-- 115_qr_scan_analytics_event.sql
--
-- Adds 'qr_scan_redirected' to the analytics_events event_name CHECK
-- (feat-qr-review-request; docs/context/review-qr.md "QR redirect" — one event per
-- successful Review QR scan redirect). Constraint-only on the 106 precedent:
-- no SchemaRequirement export, no assertSchemaReady entry, no
-- retention-policy row (analytics_events already carries its posture).

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
      'solicitation_suppressed_at_dispatch',
      'import_offer_created',
      'import_decision_recorded',
      'checkout_coupon_decision',
      'qr_scan_redirected'
    )
  );
