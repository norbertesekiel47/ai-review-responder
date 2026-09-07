-- 118_poller_heartbeats.sql
--
-- #949 — `isJudgeHealthy` cannot detect a dead JudgeSweepPoller.
--
-- WHAT A ROW IS
-- One row is one background loop's proof of life: the wall-clock time it last
-- COMPLETED a cycle. The table is platform machinery, not tenant data — there
-- is no `account_id` and there never should be.
--
-- WHY IT EXISTS
-- `isJudgeHealthy` (src/lib/responses/judge-health.ts) inferred Judge health
-- from two indirect signals: stale Judge outbox rows, and error-verdict
-- density. The staleness arm requires
--   EXISTS (SELECT 1 FROM job_outbox WHERE topic = 'judge_verdict'
--             AND aggregate_id = r.id AND created_at < NOW() - 60 min)
-- and THAT PREDICATE IS THE SWEEP'S OWN OUTPUT. A `JudgeSweepPoller` that
-- never runs writes no such row, so the arm is vacuously false for every
-- response and can never fire. The probe returned `true` indefinitely while
-- the Judge did no work at all. This is not a threshold that is merely hard to
-- trip; it is structurally unreachable in the exact failure mode that matters.
--
-- Both consumers of the probe inherited the hole, and both are posting
-- preconditions: `applyJudgeGate` / `applyJudgeGateInTx`
-- (worker/jobs/publisher/judge-gate.ts — invariant #3) and the release phase's
-- Judge split (src/lib/solicitation/release.ts — D18). Fixing at the probe
-- reaches both without either consumer changing.
--
-- SHAPE
-- * `poller_name` is a NATURAL primary key — a deliberate, documented
--   departure from the UUIDv7 convention. The table holds one row per
--   background loop (order 10, not order 10^6), every access is a single-key
--   lookup or upsert by that name, and a surrogate UUID would still need a
--   UNIQUE(poller_name) for `ON CONFLICT` to infer. The convention exists for
--   insert locality on high-volume append tables; this table never appends.
-- * `last_cycle_at` is written with NOW() on every successful cycle. It is
--   never read for ordering, only compared against a threshold.
-- * Shared, not Judge-specific: a second poller adds a ROW, not a migration.
--   Only `judge_sweep` is written in this change.
--
-- POSTURE
-- * Platform-only. RLS enabled with ZERO policies (deny-all — the
--   flagged_responses/051, judge_verdicts/076, refusal_events/116,
--   admin_audit_log/117 posture). Server access is only through the
--   RLS-bypassing Postgres.js `postgres` role.
-- * RLS protects ROWS, not table privileges, so the client roles' table ACL is
--   revoked too (076/088/055/117 precedent, widened to SELECT and to `anon`).
--   That is what lets the live suite assert `has_table_privilege(...) = false`
--   in EVERY environment, not only where the bootstrap grants nothing.
-- * NOT a `TENANT_TABLES` member — it sits in `REVIEWED_NOT_TENANT_SCOPED`
--   (scripts/ci/tenant-tables.ts). It is also deliberately ABSENT from
--   `TABLE_DISPOSITIONS`: unlike `admin_audit_log` (117), which is classified
--   only because its `actor_user_id` column is on the offboarding
--   account-linked column scan, this table carries NO foreign key and NO
--   account-linked column at all. `table-disposition.test.ts` asserts exact
--   equality between the disposition list and
--   TENANT_TABLES + REQUIRED_EXPLICIT_TABLES + REQUIRED_SPEC_ONLY_TABLES, so
--   an entry here would FAIL that suite. Offboarding has nothing to classify.
-- * Retention: keep forever, bounded by cardinality — the row count is the
--   number of background loops, and each cycle UPDATES in place rather than
--   inserting. No ArchivalPoller arm, no TTL, no purge arm.
-- * No index beyond the primary key: every read is `WHERE poller_name = $1`.
--
-- Additive and re-runnable. Apply staging first, then prod (lockstep); verify
-- by introspection (pg_tables / pg_class.relrowsecurity / pg_policies count = 0
-- / has_table_privilege), never the migration ledger.

CREATE TABLE IF NOT EXISTS poller_heartbeats (
  poller_name   TEXT PRIMARY KEY,
  last_cycle_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE poller_heartbeats IS
  'Durable background-loop liveness (#949): one row per poller, last_cycle_at = the time that loop last COMPLETED a cycle. Platform-scoped — no account_id, not a tenant table, not in TABLE_DISPOSITIONS. Deny-all RLS with client-role privileges revoked. Written only by recordPollerCycle (src/lib/shared/poller-liveness.ts); each poller name has exactly one writer.';

COMMENT ON COLUMN poller_heartbeats.last_cycle_at IS
  'Set to NOW() after a cycle finishes WITHOUT throwing. A failed or still-running cycle deliberately leaves it stale — a cycle that did not complete is not proof of life.';

ALTER TABLE poller_heartbeats ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: deny-all. Server reaches the table through the
-- RLS-bypassing postgres role only.
REVOKE ALL ON poller_heartbeats FROM anon, authenticated;
