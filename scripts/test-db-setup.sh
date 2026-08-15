#!/usr/bin/env bash
#
# Provision the shared local test database to migrations head.
#
# Live-DB suites ASSERT the schema they need (assertSchemaReady) rather than
# re-applying migration SQL in beforeAll — run-time DDL takes ACCESS EXCLUSIVE
# locks that deadlock against sibling suites' row locks (#573). That makes this
# script the single owner of "the test DB is at head": run it once after
# creating the database and again whenever a migration lands.
#
# DESTRUCTIVE + repeatable: the migration chain is not re-runnable against a
# populated database (001 creates its tables unconditionally), so this drops and
# recreates schema `public` before applying it. That is deliberate — the value
# of this script is a DETERMINISTIC at-head schema, which is what lets suites
# assert instead of apply. It refuses any host that is not localhost.
#
#   pnpm test:db:setup
#
# Reads TEST_DATABASE_POOL_URL from the environment, falling back to .env.local.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_URL="${TEST_DATABASE_POOL_URL:-}"
if [ -z "$DB_URL" ] && [ -f .env.local ]; then
  DB_URL=$(sed -nE 's/^[[:space:]]*TEST_DATABASE_POOL_URL[[:space:]]*=[[:space:]]*"?([^"]*)"?[[:space:]]*$/\1/p' .env.local | head -1)
fi

if [ -z "$DB_URL" ]; then
  echo "TEST_DATABASE_POOL_URL is unset (checked the environment and .env.local)." >&2
  echo "See docs/runbooks/e2e-local-setup.md for creating the container." >&2
  exit 1
fi

# Destructive-by-nature DDL: refuse anything that is not a local database.
HOST=$(printf '%s' "$DB_URL" | sed -nE 's#^[a-z+]+://[^@]*@?([^:/?]+).*#\1#p')
case "$HOST" in
  localhost|127.0.0.1|::1) ;;
  *)
    echo "refusing to apply migrations to non-local host '$HOST' — test DB setup is local-only." >&2
    exit 1
    ;;
esac

echo "→ resetting schema public on '$HOST' (test database — all data is discarded)"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'

# ORDER MATTERS: the recreate above drops every grant on schema public, and on
# PG15+ the new schema is created with NO grant to PUBLIC. The bootstrap below is
# what restores USAGE for anon/authenticated/service_role — CI never reaches this
# reset (it applies the bootstrap to a pristine schema that still has the default
# grant), so this path is the only one that depends on that ordering. Moving the
# bootstrap above the reset, or dropping the schema after it, silently returns
# every RLS/permission suite to failing locally while passing in CI.
echo "→ bootstrapping Supabase prerequisites (roles, schema grants, auth.uid(), uuidv7)"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f scripts/ci/test-db-bootstrap.sql

echo "→ applying migrations"
for migration in $(ls supabase/migrations/*.sql | sort); do
  printf '   %s\n' "$(basename "$migration")"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$migration"
done

echo "✔ test database at head ($(ls supabase/migrations/*.sql | sort | tail -1 | xargs basename))"
