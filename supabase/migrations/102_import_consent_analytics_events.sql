-- 102_import_consent_analytics_events.sql
-- Registers the two Import offer analytics events (#679 T1; epic #667, spec
-- docs/superpowers/specs/2026-08-05-consented-review-import-design.md §5.1)
-- in the analytics_events.event_name DB CHECK allowlist:
--   * import_offer_created — an Import offer was minted for a location (the
--     Import window deadline was stamped); emitted by createImportOffer
--     (src/lib/reviews/import-consent.ts) inside the caller's transaction.
--   * import_decision_recorded — the owner answered the Import offer; emitted
--     by recordImportDecisionAndEnqueue inside its own sql.begin, alongside the
--     Import consent write and the initial-import enqueue.
-- Both emissions land in #679 T2; this migration must reach a Supabase project
-- BEFORE that code does (deploy-ordering hazard, below).
--
-- Why a migration at all: registering the names only in ANALYTICS_EVENT_NAMES
-- is NOT enough (089's lesson, restated in 094's and 097's headers). Without
-- the CHECK entry every emitting transaction ROLLS BACK on the constraint —
-- and for import_decision_recorded that transaction is a legitimate owner
-- consent decision, so the owner's "yes" would be lost, not just the metric.
-- `ci:analytics-events` cannot catch it either: it only compares the TS
-- allowlist against docs/analytics/events.md, never the database.
--
-- DEPLOY ORDERING (high-risk lane): apply to STAGING first, then PRODUCTION at
-- promotion, in both cases BEFORE the emitting code goes live. An app deploy
-- that leads this migration turns every Import offer mint and every owner
-- Import decision into a rolled-back transaction.
--
-- Same shape as 046 → 058 → 069 → 089 → 094 → 097: DROP + re-ADD is idempotent
-- in its end state, but the swap takes a brief ACCESS EXCLUSIVE lock on
-- analytics_events and re-validates existing rows — hence the lock_timeout, and
-- hence its own file. The new list is a strict superset of 097's, in the same
-- order, so existing rows always pass.
-- Constraint-only: no new relation, column or index, and the constraint name
-- has existed since 046 — so no SchemaRequirement export and no
-- assertSchemaReady entry (094 and 097 record the same reasoning), and no
-- retention-policy row.
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
      'solicitation_suppressed_at_dispatch',
      'import_offer_created',
      'import_decision_recorded'
    )
  );
