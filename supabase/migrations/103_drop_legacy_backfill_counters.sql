-- 103_drop_legacy_backfill_counters.sql
-- Consented Review Import (#680, closing ticket of epic map #667): the DROP
-- half of the locked backfill-counter collapse. Removes the four legacy
-- gap_*/historical_* counters from `zernio_backfill_runs`, leaving
-- imported_count / skipped_count / oldest_skipped_create_time.
-- Design of record: ADR 0015
-- (docs/adr/0015-consented-import-unflagged-replacement.md) §4 + spec
-- docs/superpowers/specs/2026-08-05-consented-review-import-design.md §8a R4.
-- Staging precondition (DISCHARGED):
-- docs/runbooks/evidence/2026-08-08-consented-import-staging-proof.md.
-- Shape suite:
-- src/lib/shared/__tests__/migration-103-drop-legacy-backfill-counters.integration.test.ts
--
-- Design notes:
-- * THE NAIVE PREFLIGHT PREDICATE IS WRONG. "collapsed = legacy sums on every
--   row" false-positives on a HEALTHY post-#675 row: once the worker stopped
--   dual-writing, a real run carries imported_count non-zero with all four
--   legacy counters at 0, so the naive form reads that as a mismatch. Observed
--   live: BOTH staging rows flag under it, ZERO under the two-branch form
--   below. The gate must abort only on a row that did legacy work AND whose
--   collapsed values disagree.
-- * SOUNDNESS, stated narrowly. What is guaranteed is that a NONZERO COLLAPSED
--   value implies nonzero legacy counters, because the pre-#675 worker
--   dual-wrote both column sets in the SAME UPDATE. The broader claim "a
--   pre-#675 row with real work but zero legacy counters cannot exist" is
--   FALSE — a run interrupted after its review writes but before the final
--   counter UPDATE leaves all six counters at 0. Such a row is harmless:
--   imported_count = 0 means there is nothing to reconcile, and it satisfies
--   both branches. State the narrow claim, never the broad one.
-- * The preflight is EXECUTABLE, not a query documented here for an operator to
--   remember. A guard that never fires is indistinguishable from a working one
--   on clean data — both report zero abort rows, and both environments are
--   clean today — so a documented query proves nothing and a forgotten one
--   protects nothing. As a migration statement it cannot be skipped, and its
--   FAILING branch is testable (shape suite tests 3-4, which execute this exact
--   DO block against a pg_temp replica of the pre-103 shape).
-- * The guard is existence-guarded so the migration stays RE-RUNNABLE after the
--   DROP, and counts ALL FOUR legacy columns rather than probing one: 0 present
--   means already dropped (return), 4 means reconcile, and any PARTIAL state
--   RAISEs. Returning early on a partial schema would drop the remaining
--   columns' values unreconciled and unrecoverably. This migration's own ALTER
--   is atomic and cannot produce that state, but the guard is written to be
--   sound against any input state, not merely the ones this file creates.
-- * The column check resolves through `to_regclass` + `pg_attribute` rather
--   than a hardcoded `table_schema = 'public'` literal, so it follows the
--   search_path. That is what lets the shape suite execute this guard verbatim
--   against a pg_temp shadow — a 'public' literal cannot follow one, and would
--   make the suite self-contradictory (its final-state test needs `public`
--   post-103 with the columns ABSENT, while the guard tests need them PRESENT).
--   `NOT attisdropped` is required: pg_attribute retains dropped columns as
--   tombstone rows.
-- * `SET search_path` is SESSION-level, deliberately NOT `SET LOCAL`. `SET
--   LOCAL` outside a transaction block is a no-op that only emits a warning,
--   and migrations here are applied by plain `psql -f` (scripts/test-db-setup.sh)
--   with no --single-transaction and no BEGIN/COMMIT in the file — every
--   statement autocommits, so a `SET LOCAL` would not govern the DO and ALTER
--   below at all. Session-level `SET` is correct under BOTH autocommit and a
--   transaction-wrapped apply, and matches 099/100/101/102's bare
--   `SET lock_timeout`. Pinning it closes a real hole: Postgres searches the
--   session's temp schema FIRST for relations unless pg_temp is listed, so a
--   same-name temp table would otherwise capture to_regclass, the guard's
--   unqualified FROM, and the ALTER — this migration would report success while
--   leaving public.zernio_backfill_runs untouched. Consequence: a session-level
--   SET persists for the rest of that psql session. Harmless here (psql is
--   invoked once per migration, and 103 is head), but a future migration
--   sharing a session inherits `public, pg_temp`.
-- * POINT OF NO RETURN (the reason the collapse was split across two
--   migrations). `git revert` of the PR carrying this file removes the file but
--   does NOT un-drop applied columns. After 103 applies, reverting a pre-#675
--   epic PR puts the old dual-writing worker against a schema without these
--   columns → SQLSTATE 42703 undefined_column. This is where ADR 0015 §4's
--   revert-only backout stops being sufficient.
-- * `lock_timeout`: DROP COLUMN takes ACCESS EXCLUSIVE and can collide with an
--   in-flight backfill; 5s makes that a fast failure rather than a queue behind
--   a long transaction.
-- * RLS: no new relation and no policy change — existing `zernio_backfill_runs`
--   policies cover the surviving columns unchanged. No retention-policy row
--   (no new relation).
-- Rollback: NO down migration (099/100 precedent), because one cannot restore
-- the dropped values. If the DROP must be undone, re-ADD the four columns as
-- INTEGER NOT NULL DEFAULT 0; their historical values are unrecoverable — which
-- is precisely why the two-branch preflight proving collapsed = legacy sums is
-- the gate, and why the exposure is 2 staging rows / 0 prod rows.

SET lock_timeout = '5s';

SET search_path = public, pg_temp;

DO $$
DECLARE
  legacy_present INT;
  unreconciled   BIGINT;
BEGIN
  SELECT count(*) INTO legacy_present
    FROM pg_attribute
   WHERE attrelid = to_regclass('zernio_backfill_runs')
     AND NOT attisdropped
     AND attname IN ('gap_processed_count', 'historical_processed_count',
                     'gap_skipped_count', 'historical_skipped_count');

  IF legacy_present = 0 THEN
    RETURN;
  END IF;

  IF legacy_present <> 4 THEN
    RAISE EXCEPTION
      'migration 103 preflight: partial legacy-counter schema (% of 4 present)',
      legacy_present;
  END IF;

  SELECT count(*) INTO unreconciled
    FROM zernio_backfill_runs
   WHERE NOT (gap_processed_count = 0 AND historical_processed_count = 0
              AND gap_skipped_count = 0 AND historical_skipped_count = 0)
     AND (imported_count <> gap_processed_count + historical_processed_count
       OR skipped_count <> gap_skipped_count + historical_skipped_count);

  IF unreconciled > 0 THEN
    RAISE EXCEPTION
      'migration 103 preflight: % unreconciled backfill run(s)', unreconciled;
  END IF;
END $$;

ALTER TABLE zernio_backfill_runs
  DROP COLUMN IF EXISTS gap_processed_count,
  DROP COLUMN IF EXISTS historical_processed_count,
  DROP COLUMN IF EXISTS gap_skipped_count,
  DROP COLUMN IF EXISTS historical_skipped_count;
