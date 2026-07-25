-- 089_competitor_rival_pick.sql
-- Owner-picked Named rival for the Competitor Delta line (#546, wayfinder map
-- #528; semantics locked in #532 item 2).
--
-- Shape: three additive nullable columns on businesses, following the
-- migration-014 precedent that all per-location ranking/competitor config
-- (tracked_keywords, ranking_search_location, google_place_lat/lng) lives here.
-- A location has at most one pick, so a 1:1 column set beats a side table —
-- and the digest's existing businesses SELECT picks these up for free, costing
-- the WeeklySummaryWorker read path zero extra queries.
--
-- rival_place_id is the canonical ChIJ… Place ID of the picked competitor. It
-- is deliberately NOT a foreign key to competitor_snapshots: packs are replaced
-- wholesale on every ranking run (084's replace-pack idempotency), so an FK
-- would cascade-delete a pick the owner explicitly made. Pack membership is a
-- READ-side question, answered per-digest by resolveNamedRival.
--
-- rival_title_snapshot is the display name captured AT PICK TIME, server-derived
-- from the matched pack row (never client-supplied — it reaches a rendered
-- email). It is read only for the dropout note and the settings UI's
-- absent-pick entry; a rival present in the pack always renders its LIVE title.
--
-- The COLUMN additions are additive: no backfill, no default, existing rows
-- keep NULL and behave exactly as today (Auto-default rival). The CHECK
-- constraint below is NOT additive in the same sense — it is dropped and
-- re-added, which takes a brief ACCESS EXCLUSIVE lock on analytics_events and
-- re-validates every existing row. The end state is idempotent on re-run, but
-- the execution is not a no-op; hence the lock_timeout below.
-- Rollback: revert the deploy (the columns go unread and the constraint is a
-- superset of the old one, so both are safe to leave in place).
--
-- RLS: businesses' existing policies cover these columns unchanged. All writes
-- come from the owner-scoped Next.js route over the direct Postgres connection.

SET lock_timeout = '5s';

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS rival_place_id TEXT,
  ADD COLUMN IF NOT EXISTS rival_title_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS rival_picked_at TIMESTAMPTZ;

COMMENT ON COLUMN businesses.rival_place_id IS
  'Owner-picked Named rival Place ID for the Competitor Delta line (#546). NULL = use the Auto-default rival.';
COMMENT ON COLUMN businesses.rival_title_snapshot IS
  'Display name captured at pick time, server-derived from the pack row. Read only for the dropout note and the absent-pick UI entry.';
COMMENT ON COLUMN businesses.rival_picked_at IS
  'When the owner made the current pick. NULL when no pick is set.';

-- analytics_events.event_name is a DB-level CHECK allowlist (046, last extended
-- by 069). Registering the event in ANALYTICS_EVENT_NAMES is NOT enough: without
-- this, every pick transaction ROLLS BACK on the constraint, and
-- `ci:analytics-events` would not catch it (it only compares the TS allowlist
-- against docs/analytics/events.md, never the database).
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
      'competitor_rival_picked'
    )
  );
