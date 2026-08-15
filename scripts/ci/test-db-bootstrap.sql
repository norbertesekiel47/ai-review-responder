-- CI / local test-DB bootstrap.
--
-- The migrations in supabase/migrations/ target a real Supabase Postgres, which
-- ships a handful of objects the SQL assumes already exist: the anon /
-- authenticated / service_role roles, the auth schema + auth.uid(), and the
-- pg_uuidv7 extension's uuidv7(). A stock Postgres service has none of these, so
-- the migration chain fails to apply. This script recreates just enough of those
-- prerequisites for the migrations to apply and for the DB-backed test suite to
-- run. It is for ephemeral test databases ONLY — production uses real Supabase.
--
-- Idempotent: safe to run against a fresh database.

-- Supabase roles referenced by GRANT / RLS policy definitions.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END
$$;

-- USAGE on schema public for those roles. This is NOT decoration — it is the
-- one thing that makes the two provisioning paths agree.
--
-- CI (.github/workflows/ci.yml → .github/actions/test-db) applies this script
-- onto the service container's PRISTINE `public` schema, which still carries
-- Postgres's default `GRANT USAGE ON SCHEMA public TO PUBLIC`, so `authenticated`
-- inherits USAGE and never needed an explicit grant. `scripts/test-db-setup.sh`
-- (local) first runs `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` — and on
-- PG15+ a freshly created schema carries NO grant to PUBLIC at all. The two paths
-- therefore produced different databases from the same "shared recipe".
--
-- The symptom is a silent lie rather than an error: with no USAGE, a role cannot
-- see any relation in the schema, so Postgres answers a table-level privilege
-- probe with 42P01 `relation "x" does not exist` instead of 42501 `permission
-- denied for table x`. Every RLS/permission suite that asserts the DENIAL MESSAGE
-- fails locally while passing in CI — which reads as "my machine is broken", not
-- as a provisioning bug (found 2026-08-14 during the migration lockstep audit; it
-- cost a full isolation pass to attribute).
--
-- Shape below mirrors a real Supabase project's `public` ACL: USAGE to PUBLIC
-- plus explicit grants to the three Supabase roles. In CI the PUBLIC grant is a
-- redundant no-op; locally it is the repair. Idempotent either way.
GRANT USAGE ON SCHEMA public TO PUBLIC;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Supabase auth schema + auth.uid(). RLS policy definitions reference auth.uid();
-- it only needs to exist for the policies to be created. The suite connects as a
-- superuser/service identity, so the runtime value is irrelevant in tests.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

-- pgcrypto for gen_random_uuid(); pg_uuidv7's uuidv7() stubbed to a random UUID
-- (the suite relies on uniqueness, not time-ordering, in CI).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE OR REPLACE FUNCTION public.uuidv7() RETURNS uuid
  LANGUAGE sql VOLATILE AS $$ SELECT gen_random_uuid() $$;
