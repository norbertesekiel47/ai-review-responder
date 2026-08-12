---
name: new-migration
description: Use when creating, numbering, reviewing, or applying a Postgres migration (any file in supabase/migrations/) — before writing the first line of migration SQL, and when deciding how to verify a migration was applied.
---

# New Migration Workflow

Migrations are numbered `NNN_description.sql`, applied to staging AND prod in
lockstep (staging first), and **immutable once applied** (PreToolUse hook
`migration-immutability-guard.sh` blocks edits at or below the recorded head).
The fix for an applied migration is always a NEW migration.

Authoritative sources — this skill is the checklist, not the data:
- `.claude/reference/migrations-log.md` — head/next number, full per-migration history, retention policy. **Read it before anything else.**
- `.claude/reference/lab-notes.md` "Indexes / migrations" topic — the failure catalog behind the checklist below.
- `.claude/CLAUDE.md` "Environments & branches" — lockstep rule + standing exceptions (e.g. 078 deliberately absent in prod until the WS8 cutover).

## Workflow

1. **Number**: read `migrations-log.md` head ("Current head: **NNN**"); yours is head+1, zero-padded to 3 digits. Never guess or reuse a number.
2. **Header comment**: what it does, which plan/spec drove it, and any pre-flight gate SQL (several past migrations embed their preflight in the header — follow that pattern when order matters).
3. **Author against the checklist** (each item is a real past incident):
   - All tables use **UUIDv7 time-ordered PKs** (project convention, see migrations-log.md).
   - Index/predicate expressions must be **IMMUTABLE**: `(created_at AT TIME ZONE 'UTC')::date`, never `created_at::date` (STABLE is rejected).
   - Any `ON CONFLICT` targeting a partial index must reference the predicate **byte-for-byte** or Postgres won't match the constraint.
   - **CHECK constraints pass NULL** — pair with `NOT NULL` and run NULL-safe preflight counts before adding a strict CHECK.
   - Set `lock_timeout` for `ALTER TABLE` on hot tables; a hung ALTER is usually a lock queue behind a long-lived Supavisor session (cancel the stalled backend, verify clean, retry — lab-notes).
   - New table? Decide **RLS posture** (most tables: app-enforced scoping, no RLS; admin-only tables: deny-all RLS), add **tenant scoping** to queries, and add a row to the migrations-log **retention policy** table (or note why exempt).
4. **Apply staging first, then prod**, same change window. Verify by **schema introspection** (`information_schema.columns` / `pg_indexes` for the objects created) — NEVER the Supabase migration ledger; `list_migrations` does not track RepWorth's `0xx` migrations (lab note 2026-06-20).
5. **Same-change bookkeeping** (skipping any of these is a bug):
   - Update `migrations-log.md`: bump the head line AND add the migration's entry.
   - If the migration adds a JSONB column that production code will read via Postgres.js: add the parser site to `.claude/CLAUDE.md`'s PgBouncer JSONB carve-out list.
6. **Gates**: `pnpm test`, `pnpm ci:rls-audit`, `pnpm ci:tenant-scope` (`.claude/CLAUDE.md` requires the last two for DB-touching changes).

## Common mistakes

- Editing an applied migration "just to fix a typo" — blocked by hook; write head+1 instead.
- Trusting `list_migrations` as proof of application — it returns wrong/empty results here; introspect the schema.
- Applying to prod but not staging (or vice versa) — lockstep violation; the only sanctioned exception is documented in `.claude/CLAUDE.md` (078 until the WS8 cutover).
- Forgetting the migrations-log head bump — the immutability hook reads it, so a stale head silently un-protects the newest applied migration.
