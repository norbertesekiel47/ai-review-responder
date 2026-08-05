-- 100_import_consent_and_backfill_counters.sql
-- Consented Review Import (#673, epic map #667): the per-location import-offer
-- state on `businesses`, plus the ADD half of the locked backfill-counter
-- collapse on `zernio_backfill_runs`.
-- Design of record: ADR 0015
-- (docs/adr/0015-consented-import-unflagged-replacement.md) + spec
-- docs/superpowers/specs/2026-08-05-consented-review-import-design.md §4
-- (data model) and §8a R1/R3/R4 (rollout posture, locked at #668).
--
-- Design notes:
-- * Consent lives as columns on `businesses`, not a side table — owner
--   decision at charting (#673): a location has exactly one import offer, and
--   099/089 set the precedent that 1:1 per-location config lives here.
-- * `import_decision` is NOT NULL DEFAULT 'pending' — EXACT per #668. Both
--   environments hold zero `businesses` rows at migration time (prod always
--   empty; staging fully reset 2026-08-05), so there is no existing
--   population, no backfill clause, and no backdating: writing 'accepted' for
--   rows that never answered records a consent that was never given, and was
--   explicitly rejected (§8a R3).
-- * The CHECK pairs with NOT NULL — a CHECK alone passes NULL (checklist).
-- * Deliberately NO cross-column CHECK tying the timestamps to the decision:
--   the writers land later (#677 decision API, #679 expiry sweep) and the
--   'expired' stamping semantics are theirs to lock (owner decision,
--   2026-08-05). A wrong CHECK here costs a migration 101 to undo.
-- * NO index for the expiry sweep — #679 adds a partial index if its scan
--   needs one (099 precedent: no speculative indexes).
-- * The counter ADD is deliberately HALF of the locked collapse (map #667):
--   imported_count = gap + historical processed, skipped_count = gap +
--   historical skipped. ADD here; the DROP of the four legacy
--   gap_*/historical_* counters is a separate cleanup migration (#680) after
--   the epic proves on staging — so `git revert` of any epic PR never leaves
--   the deployed worker writing to a dropped column (§8a R4; the 42703 class
--   flagged at 099). ZernioBackfillWorker dual-writes BOTH sets from the PR
--   that carries this migration.
-- * RLS: existing `businesses` / `zernio_backfill_runs` policies cover the
--   new columns unchanged. No new relation → no retention-policy row.
-- * Additive-only: no backfill, no CONCURRENTLY; one transaction.
-- * COMMENT literals contain NO semicolons — the shape suite splits the
--   executable SQL on ';' to allowlist every statement.
-- Rollback: revert the app deploy (the worker dual-write is the only code
-- touching any of these columns); the columns are inert with code reverted —
-- DEFAULT 'pending' / DEFAULT 0 need no writer. No down migration (099
-- precedent).

SET lock_timeout = '5s';

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS import_decision          TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS import_decision_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS import_offer_expires_at  TIMESTAMPTZ;

ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_import_decision_check;
ALTER TABLE businesses
  ADD CONSTRAINT businesses_import_decision_check
  CHECK (import_decision IN ('pending', 'accepted', 'declined', 'expired'));

COMMENT ON COLUMN businesses.import_decision IS
  'Consented Review Import offer state for this location (#673, spec 2026-08-05 §4): pending = not yet answered, accepted/declined = owner answered, expired = offer lapsed unanswered (#679). DEFAULT pending is exact — zero rows existed at migration time (§8a R3), and backdating to accepted was rejected.';
COMMENT ON COLUMN businesses.import_decision_at IS
  'When the owner answered the import offer. NULL while pending. Whether the #679 expiry sweep stamps this for expired rows is that ticket''s decision — deliberately unconstrained here.';
COMMENT ON COLUMN businesses.import_offer_expires_at IS
  'Import-offer deadline: prompt creation + 7 days (#677 writes it). NULL until the offer is first shown.';

ALTER TABLE zernio_backfill_runs
  ADD COLUMN IF NOT EXISTS imported_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_count  INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN zernio_backfill_runs.imported_count IS
  'Collapsed successor of gap_processed_count + historical_processed_count (map #667). ADD half of the two-migration collapse (§8a R4). Dual-written by ZernioBackfillWorker while the gap/historical split exists — that legacy writer contract ends when #675 replaces the selection semantics (legacy counters then freeze at DEFAULT 0 for new runs), and the #680 DROP must be preceded by a reconciliation preflight proving collapsed = legacy sums on pre-#675 rows.';
COMMENT ON COLUMN zernio_backfill_runs.skipped_count IS
  'Collapsed successor of gap_skipped_count + historical_skipped_count (map #667). Same two-migration collapse as imported_count — oldest_skipped_create_time is unchanged.';
