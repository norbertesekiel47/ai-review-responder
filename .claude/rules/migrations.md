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

- **`ON CONFLICT` must match partial-index predicate BYTE-FOR-BYTE** or Postgres won't recognize the constraint. Expression indexes must use IMMUTABLE expressions: `(created_at AT TIME ZONE 'UTC')::date`, not `created_at::date` (STABLE is rejected in index predicates).

## Rules

- **Schema + migrations** → `.claude/reference/migrations-log.md` (authoritative): base schema (`001_initial_schema.sql`), current head / next number, and the UUIDv7 time-ordered-PK convention. Read it before any migration.
