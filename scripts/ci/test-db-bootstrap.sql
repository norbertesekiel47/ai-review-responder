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
