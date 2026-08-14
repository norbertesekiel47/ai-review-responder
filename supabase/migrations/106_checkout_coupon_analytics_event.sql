-- 106_checkout_coupon_analytics_event.sql
-- Registers the beta comp coupon-decision analytics event (admin-invite-funnel
-- plan step 11 / ticket T3,
-- docs/superpowers/plans/2026-08-14-admin-invite-funnel.md) in the
-- analytics_events.event_name CHECK allowlist:
--   * checkout_coupon_decision — the beta comp decision taken for a Checkout
--     attempt: applied, skipped because the Account is not an admin invitee, or
--     skipped because BETA_COMP_COUPON_ID is unset. Emitted by
--     recordCouponDecision (src/lib/payments/plan-activation.ts) AFTER the
--     applyTierSnapshot transaction commits.
-- The emission lands in the same ticket as this migration; the migration must
-- reach a Supabase project BEFORE that code does (deploy-ordering hazard,
-- below).
--
-- Why a migration at all: registering the name only in ANALYTICS_EVENT_NAMES is
-- NOT enough (089's lesson, restated in 094's, 097's and 102's headers).
-- Without the CHECK entry the emission raises 23514. `ci:analytics-events`
-- cannot catch it either: it only compares the TS allowlist against
-- docs/analytics/events.md, never the database.
--
-- WHAT AN UNAPPLIED 106 ACTUALLY COSTS. The emission is deliberately POST-COMMIT
-- and wrapped in its own try/catch (reportCaughtError, then swallow), so a
-- rejected insert costs this metric plus a Sentry-reported handled error — NOT
-- the tier snapshot, NOT the Checkout attempt, and NOT the owner's plan
-- selection. That containment is by construction and not an accident: emitting
-- inside applyTierSnapshot's sql.begin would make an unapplied 106 abort the
-- whole tier-snapshot transaction, which is precisely the blast radius 102's
-- header describes for the pre-savepoint import-consent emission.
--
-- DEPLOY ORDERING STILL STANDS: apply to STAGING first, then PRODUCTION at
-- promotion, in both cases BEFORE the emitting code goes live. Containment
-- limits the damage; it does not make the ordering optional. A deploy that
-- leads this migration loses every checkout_coupon_decision until it is
-- applied — and that event is the ONLY durable signal that a beta tester's comp
-- was silently skipped before they are charged.
--
-- Same shape as 046 → 058 → 069 → 089 → 094 → 097 → 102: DROP + re-ADD is
-- idempotent in its end state, but the swap takes a brief ACCESS EXCLUSIVE lock
-- on analytics_events and re-validates existing rows — hence the lock_timeout,
-- and hence its own file. The new list is a strict superset of 102's, in the
-- same order, so existing rows always pass.
-- Constraint-only: no new relation, column or index, and the constraint name
-- has existed since 046 — so no SchemaRequirement export and no
-- assertSchemaReady entry (094, 097 and 102 record the same reasoning), and no
-- retention-policy row.
-- Rollback: revert the deploy (the constraint is a superset of the old one; the
-- event simply stops being emitted).

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
      'checkout_coupon_decision'
    )
  );
