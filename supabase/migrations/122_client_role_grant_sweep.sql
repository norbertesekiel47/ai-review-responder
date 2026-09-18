-- Migration 122: client-role grant sweep (#1176)
--
-- Removes the Supabase default table privileges `anon` and `authenticated` do
-- not need: every privilege on the twenty deny-all tables, and TRUNCATE,
-- REFERENCES, TRIGGER and MAINTAIN on every table in `public` and in the
-- owning role's default table privileges. Follow-up #1301 rebuilds the older
-- migration suites this change does not touch.
--
-- WHAT WAS WRONG (read-only introspection, 2026-09-16; identical on both
-- projects wherever both were read)
--
--   fact                                         production   staging
--   tables in public (relkind r)                 58           58
--   deny-all tables (RLS on, 0 policies) that
--     still grant anon/authenticated privileges  20           20
--   tables where anon / authenticated hold
--     TRUNCATE                                   49 / 49      49 / 49
--   tables with RLS off                          0            0
--   default ACL, owner `postgres`, schema public
--     (relations)                                not read     anon, authenticated,
--                                                             service_role = arwdDxtm
--
-- RLS filters ROWS; it removes no table privilege (117/118/119 precedent).
-- Zero policies already deny every row on the twenty tables, but the grants
-- keep them on the PostgREST surface, and TRUNCATE is exempt from row policies
-- entirely — a client role holding it can empty a table with RLS on.
--
-- WHY THIS IS SAFE
-- Every worker and server write goes through Postgres.js as the table owner,
-- which no client-role revoke touches. The only table read through supabase-js
-- is `users` (`src/proxy.ts`, the auth callback, the login hook; `rg`
-- 2026-09-16), and it keeps SELECT: only the
-- twenty deny-all tables lose DML. None of the twenty carries a column grant
-- (column grants exist only on `businesses` and `channel_enrollments`, which
-- lose no column right here), so `REVOKE ALL` strips nothing hidden. `owner`
-- and `service_role` are never named. `REVOKE` takes no relation lock; the
-- 5-second lock_timeout is a backstop, and the file is one transaction.
--
-- WHY THESE RIGHTS
-- TRUNCATE bypasses row policies. REFERENCES, TRIGGER and MAINTAIN are rights
-- no client code path needs. SELECT, INSERT, UPDATE and DELETE stay on every
-- table outside the deny-all list, where RLS policies govern them. Owner
-- decision 2026-09-16.
--
-- DEFAULT PRIVILEGES
-- No FOR ROLE: the statement targets current_user, so current_user must own
-- the tables — the DO guard below refuses otherwise, since a wrong applier
-- would silently change nobody's defaults. Only the schema-level entry is
-- touched (staging carries no global entry). Default DML stays. Sequence,
-- function and `supabase_admin` defaults are out of scope → #1300 (with the
-- deny-all registry split and recurrence guard).
--
-- VERSION GUARD
-- MAINTAIN exists from PostgreSQL 17 (both Supabase projects run 17); the test
-- container runs 16, where the keyword is a syntax error, so it is issued
-- through EXECUTE behind `server_version_num`. The suite
-- (`src/lib/shared/__tests__/migration-122-client-role-grant-sweep.integration.test.ts`)
-- therefore cannot execute the MAINTAIN branch; the mandatory PG17 four-right
-- query in `.claude/reference/migrations-log.md` entry 122 (must return 0 on
-- each project) is its proof, beside the global-default preflight there.
--
-- IDEMPOTENT / LOCKSTEP
-- Re-runnable: a second apply changes nothing. Apply staging FIRST, then
-- production. Verify by introspection (`has_table_privilege`, `aclexplode`
-- over `pg_class.relacl` and `pg_default_acl`), NEVER the Supabase migration
-- ledger, which does not track this repo's migrations.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Fail closed if applied by a role that does not own the tables: ALTER DEFAULT
-- PRIVILEGES without FOR ROLE targets current_user, so a wrong applier would
-- change nobody's defaults while the rest of the file still reported success.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND c.relowner <> current_user::regrole
  ) THEN
    RAISE EXCEPTION 'migration 122 must be applied by the role that owns every table in public';
  END IF;
END $$;

-- 1. Rights no client role needs, on every table. TRUNCATE is exempt from row
--    policies entirely.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- 2. Deny-all tables: RLS with zero policies already denies rows; remove the
--    table privileges too (117/118/119 precedent).
REVOKE ALL ON
  agent_outcomes, agent_run_steps, agent_runs, analytics_events,
  auto_approval_policies, flagged_responses, google_connections,
  impersonation_sessions, inbound_events, judge_verdicts, owner_leads,
  poller_cursors, prospect_demos, refusal_events, review_escalations,
  solicitation_consent, solicitation_send_breaker,
  solicitation_suppression_corrections, solicitation_suppressions,
  solicitation_unsubscribe_tokens
FROM anon, authenticated;

-- 3. Stop new tables inheriting the same rights.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon, authenticated;

-- 4. MAINTAIN exists from PostgreSQL 17 (both Supabase projects); the test
--    container is 16, where the keyword is a syntax error.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON ALL TABLES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE MAINTAIN ON TABLES FROM anon, authenticated';
  END IF;
END $$;

COMMIT;
