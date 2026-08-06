-- 101_import_decision_three_valued_check.sql
-- Corrective migration for 100 (#673, epic map #667): tighten
-- `businesses.import_decision` to the THREE-valued enum locked by #670 —
-- `pending | accepted | declined`, no stored 'expired'.
--
-- Why: migration 100 shipped a four-valued CHECK including 'expired'. Its
-- intake was locked minutes BEFORE #670's amendment landed on ticket #673
-- (2026-08-05 ~11:25 PT), and the plan reviews validated against the intake,
-- so the stale contract shipped. The locked design (spec §4 + §5.3, PR #684):
-- expiry is DERIVED on read (`pending AND import_offer_expires_at <= now()`),
-- never materialised — no poller, and a CHECK value nothing writes would
-- misrepresent the state machine. 100 is immutable (applied to staging + prod
-- 2026-08-05), so the fix is this migration per the migrations-log convention.
--
-- Preflight (embedded, order matters): no writer of 'expired' has ever
-- existed — 100's columns shipped reader/writer-less — and both environments
-- verified zero non-pending rows at authoring. Guard anyway before the
-- ADD CONSTRAINT re-validates existing rows:
--   SELECT count(*) FROM businesses WHERE import_decision = 'expired';
-- must return 0. (CHECK-passes-NULL trap does not apply — the column is
-- NOT NULL since 100.)
--
-- * Same named constraint, DROP + re-ADD (100's own idempotent pattern);
--   brief ACCESS EXCLUSIVE lock on `businesses`, guarded by lock_timeout.
-- * COMMENT literals contain NO semicolons (shape-suite ';'-split convention).
-- * No new relation -> no RLS change, no retention-policy row, no index.
-- Rollback: tightening only — no code depends on either arity today; undoing
-- it would be a new migration re-widening the CHECK, which #670 forbids.

SET lock_timeout = '5s';

ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_import_decision_check;
ALTER TABLE businesses
  ADD CONSTRAINT businesses_import_decision_check
  CHECK (import_decision IN ('pending', 'accepted', 'declined'));

COMMENT ON COLUMN businesses.import_decision IS
  'Consented Review Import offer state for this location (#673, spec 2026-08-05 §4 — three-valued per the #670 amendment, migration 101): pending = not yet answered, accepted/declined = owner answered. Expiry is DERIVED on read — pending AND import_offer_expires_at <= now() (§5.3) — never stored. DEFAULT pending is exact (§8a R3): backdating to accepted was rejected.';
COMMENT ON COLUMN businesses.import_decision_at IS
  'When the owner answered the import offer. NULL while pending — including offers that lapse, because expiry is derived and never stamped (§5.3, #670, migration 101).';
