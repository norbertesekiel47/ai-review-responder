-- Migration 119: deny-all row level security on `job_outbox` (#1171)
--
-- Closes the last staging/prod RLS drift, surfaced by research ticket #1160
-- (admin split map #1159) and introspected 2026-09-07.
--
-- WHAT WAS WRONG
-- `job_outbox` was the ONLY table of the 54 in schema `public` whose RLS state
-- differed between the two Supabase projects:
--
--   production  (udeyaqnvpojbwgoaxwdg)  relrowsecurity = true,  0 policies
--   staging     (kubdiqdhqbhwmqfditeg)  relrowsecurity = FALSE, 0 policies
--
-- and on BOTH projects `anon` and `authenticated` still hold the Supabase
-- default table privileges. With RLS off, that combination is not a disclosure
-- bug alone: `anon` holds INSERT, and `OutboxPoller` dispatches whatever rows
-- it finds to BullMQ without asking who wrote them. Anyone holding the public
-- staging anon key could therefore enqueue a job of their choosing. The local
-- test database carried the same posture as staging.
--
-- WHY THE DRIFT EXISTED (provenance: migration 107's header)
-- Production was provisioned 2026-04-05 from a Supabase template carrying the
-- `ensure_rls` DDL event trigger, which issued
-- `ALTER TABLE <new table> ENABLE ROW LEVEL SECURITY` after every CREATE TABLE
-- in `public`. Staging was provisioned 2026-05-30, after Supabase dropped it.
-- Production therefore acquired this posture for free and staging never did;
-- no migration in this repo ever asked for it. Migration 107 removed the
-- generator and DELIBERATELY left its past output alone, recording that the
-- `job_outbox` repair was a reviewed change owed its own migration. This is
-- that migration, and it converges UPWARD — toward the stricter posture that
-- production has already run without incident since 2026-04-05.
--
-- WHY THIS IS SAFE FOR THE WORKER
-- Nothing reaches `job_outbox` through supabase-js: every enqueue, claim,
-- dispatch and sweep goes through Postgres.js as the table OWNER, and
-- PostgreSQL exempts a table's owner from RLS unless FORCE is set. FORCE is
-- deliberately NOT set here, and the accompanying suite asserts
-- `relforcerowsecurity = false` — setting it would deny the outbox to its only
-- writer and stop every async job in the platform. Confirmed by review against
-- the live catalogues: every application connection authenticates as
-- `postgres`, which BOTH owns this table AND holds BYPASSRLS, and there is no
-- supabase-js access, no `.rpc(`, no view, function, trigger, publication or
-- Edge Function over `job_outbox`, and zero column ACLs.
--
-- The empirical half of that argument covers the ALTER ONLY. Production has
-- run RLS-on since 2026-04-05, but it has run it WITH the client grants still
-- in place — `anon` and `authenticated` hold `arwdDxtm` there today. The
-- post-119 posture has therefore run in NO environment, and the REVOKE is the
-- statement carrying whatever residual risk this migration has. Four review
-- axes independently caught an earlier draft of this paragraph claiming
-- production had run "this exact posture"; it had not.
--
-- WHY THE REVOKE
-- RLS filters ROWS; it does not remove a table privilege (117/118 precedent).
-- The revoke names `anon` and `authenticated` ONLY — never the owner, never
-- `service_role`, never PUBLIC. It removes the relation from the PostgREST
-- surface those two keys reach, so the deny is a permission error rather than
-- an empty result set.
--
-- NO POLICY IS ADDED, deliberately. Zero policies IS the deny-all guarantee,
-- the same posture as `auto_approval_policies`, `poller_heartbeats` (118) and
-- `admin_audit_log` (117). There is no owner-facing read of the outbox, so any
-- policy at all would open a wider door than the product needs.
--
-- REGISTRIES: none change. `job_outbox` stays in `REVIEWED_NOT_TENANT_SCOPED`
-- and OUT of `TENANT_TABLES` (owner decision, 2026-09-07): membership also
-- switches on `ci:tenant-scope`, which demands an account_id/business_id
-- predicate on every binding, and the table carries neither column while 55
-- production files BIND it in SQL (78 reference the identifier at all).
-- `ci:rls-audit` audits only `TENANT_TABLES`, so the regression guard for this
-- boundary is
-- `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts`,
-- exactly as 117's suite guards `admin_audit_log`.
--
-- LOCKING — why the ALTER is GUARDED rather than issued unconditionally
-- `ALTER TABLE … ENABLE ROW LEVEL SECURITY` is NOT a lock-free no-op when the
-- flag is already set: `ATExecSetRowSecurity` has no early-out and
-- `AT_EnableRowSecurity` takes ACCESS EXCLUSIVE, so an unconditional statement
-- would block every write to the busiest table in the schema for up to the
-- lock_timeout on PRODUCTION, in exchange for updating `pg_class` to the value
-- it already holds. `REVOKE` takes no relation lock at all. The ALTER is
-- therefore the only lock this migration acquires, and guarding it on
-- `relrowsecurity` makes the file a true no-op on production rather than an
-- aspirational one. An earlier draft claimed "no-op" while issuing the ALTER
-- unconditionally; two review axes caught it.
--
-- TRANSACTION — why `BEGIN` + `SET LOCAL` and not a session-level `SET`
-- Wrapping earns three things at once: `SET LOCAL` is effective and does not
-- leak a session GUC, the lock is held for the shortest possible window, and
-- the ALTER and the REVOKE become ATOMIC — closing the tear where a failure
-- between them leaves row filtering on with the client grants still live.
-- 109 and 114 are the precedent (both wrap; 10 of the 11 `SET LOCAL`
-- migrations do). 088 is the sole unwrapped file and the only source of the
-- `SET LOCAL can only be used in transaction blocks` warning — an earlier
-- draft read that one warning as the rule and switched to a session-level
-- `SET` on 092/101's precedent, which was the weaker of the two answers.
--
-- IDEMPOTENT / LOCKSTEP
-- Re-runnable everywhere. On production the guarded ALTER does nothing and the
-- REVOKE is the substantive statement; on staging and the local test database
-- both apply. Apply staging FIRST, then production, in the same change window.
-- Verify by introspection (`pg_class.relrowsecurity` /
-- `pg_class.relforcerowsecurity` / `pg_policies` count = 0 / `pg_class.relacl`
-- via `aclexplode`), NEVER the Supabase migration ledger, which does not track
-- this repo's 0xx migrations. Introspection is also the ONLY detector of a
-- half-applied lockstep: nothing automated notices one project left behind.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT (
    SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_outbox'::regclass
  ) THEN
    ALTER TABLE job_outbox ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- Deliberately NO policies: deny-all. Server reaches the table through the
-- RLS-bypassing owner role only.
REVOKE ALL ON job_outbox FROM anon, authenticated;

COMMENT ON TABLE job_outbox IS
  'Transactional outbox (invariant #2): the platform dispatch spine. Deny-all RLS since migration 119 (#1171) — zero policies, client-role privileges revoked, FORCE deliberately off because every writer connects as the table owner.';

COMMIT;
