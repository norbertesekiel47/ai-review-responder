---
paths:
  - "supabase/migrations/**"
  - ".claude/reference/migrations-log.md"
---

# Migrations rules

## Read first

- `.claude/reference/migrations-log.md` (see Rules below).
- Skill `new-migration` before the first line of migration SQL; `supabase:supabase-postgres-best-practices` for query/schema perf.
- Lab notes: `.claude/reference/lab-notes/migrations.md` (indexes / migrations; "Migration lockstep audit" is the entry point for "is migration N applied in env X?"), `.claude/reference/lab-notes/postgres.md` (Postgres.js / JSONB / PgBouncer).
- `docs/directory/repo-surfaces.md` § `supabase/migrations/`.
- Lockstep: migrations run against both Supabase projects, staging first — `.claude/CLAUDE.md` § Environments & branches. Never re-derive lockstep from prose; introspect both databases.

## Traps

- **A migration's guard suite EXECUTES the file; it never parses it.** Five red-team passes found nine P0s in a regex guard for migration 119 and none in the migration. Shape: `MIGRATION_SHAPE_FILES` + degrade → assert the degrade landed → apply verbatim via `db.unsafe` → diff the catalogue over EVERY `public` table. "Unchanged" needs a BEFORE — `has_table_privilege` is unconditionally true for a superuser, and the CI owner is one. Full story: lab-notes/migrations.md Summary.
- **Apply and introspect through the SESSION pooler (port 5432), never the transaction pooler `DATABASE_POOL_URL` uses (6543).** A session `SET` through 6543 can outlive your client on a shared server connection (a stray `default_transaction_read_only` hands the next caller `25006`). Express read-only intent per transaction: `BEGIN READ ONLY; …; COMMIT;` (#1176).
- **Lockstep is a byte comparison of both projects, never per-project checks.** One snapshot query each (client table ACL + client column ACL + every `pg_default_acl` row), then diff the files, before AND after. The pre-apply file is also the only correct rollback source; a blanket `GRANT ALL` inverse widens tables an earlier migration had already narrowed (#1176).
- **`ON CONFLICT` must match partial-index predicate BYTE-FOR-BYTE** or Postgres won't recognize the constraint. Expression indexes must use IMMUTABLE expressions: `(created_at AT TIME ZONE 'UTC')::date`, not `created_at::date` (STABLE is rejected in index predicates).

## Rules

- **Schema + migrations** → `.claude/reference/migrations-log.md` (authoritative): base schema (`001_initial_schema.sql`), current head / next number, and the UUIDv7 time-ordered-PK convention. Read it before any migration.
