# Clean up `sales_partner` schema, data, and stale references

**Issue:** #50 (deferred follow-up from #43)
**Date:** 2026-05-28
**Status:** Approved — ready for implementation

## Background

PR #43 removed `sales_partner` as an accepted **runtime** authorization role: no
`sales_partner` can authenticate or reach any owner/admin/worker path. The
database, data, and naming cleanup was deliberately deferred because an
irreversible role migration should not be bundled with code-path authorization
changes.

This spec completes that deferred work.

## Findings that reshape the issue's framing

Three facts established during brainstorming change the issue's original plan:

1. **There is no enum or CHECK constraint on `users.role`.** It is a bare
   `VARCHAR(20)` with a code comment (`supabase/migrations/001_initial_schema.sql:49`).
   Role is app-enforced, per CLAUDE.md ("Auth scope is app-enforced, not
   RLS-enforced"). So the issue's "drop `sales_partner` from the enum/check
   constraint" rests on a false premise — there is nothing to *drop*. To make
   `sales_partner` "no longer a permitted value" at the DB layer we must *add* a
   CHECK constraint that did not previously exist.

2. **The migration number in the issue is stale.** The issue says "next is 043",
   but `043_step_1_keystones.sql` already exists and the head is
   `052_reviews_sentiment.sql`. The real next number is **053**.

3. **The live production DB is clean.** A read-only diagnostic returned: 1 total
   `users` row (a single `owner`), **0** `sales_partner` rows, 0 with `auth_id`,
   0 referenced by `businesses.onboarded_by`. The data-migration portion is
   therefore a **defensive no-op** in production.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| DB enforcement | **Add** `CHECK (role IN ('owner','admin'))` | Only way to literally satisfy "no longer a permitted value"; blocks regression/typos at the DB layer. Runtime allowlist stays as defense-in-depth. |
| Stray-row handling | **Auto-convert** `sales_partner` → `admin` before constraint | No-op in prod (0 rows); keeps the migration fully automatic and idempotent in other environments. |
| PR split | **One PR, two commits** | Schema reviewable in isolation via the commit boundary; the cleanup is zero-behavior-change. One CI cycle. |

## Scope

### Commit 1 — Schema

**`supabase/migrations/053_users_role_constraint.sql`** (new). Follows the file
convention used by `052` (transaction framing, header comment):

```sql
-- 053: retire legacy sales_partner role.
-- Defensive auto-convert (0 rows in prod; protects other environments and any
-- row created between deploy of this migration and #43's runtime block).
UPDATE users SET role = 'admin' WHERE role = 'sales_partner';

-- Enforce the role allowlist at the DB layer. No enum/CHECK existed before
-- (role was a bare VARCHAR(20)); this is an ADD, not a DROP. Guarded so the
-- migration is re-runnable (production.md: migrations restartable).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_role_check CHECK (role IN ('owner','admin'));
  END IF;
END $$;
```

**`src/lib/shared/__tests__/migration-053-structure.test.ts`** (new). Follows the
established `migration-0XX-structure.test.ts` pattern (asserts SQL content; no
live DB needed): asserts the file contains the defensive `UPDATE`, the
`users_role_check` CHECK on `role IN ('owner','admin')`, and the `IF NOT EXISTS`
re-run guard.

**Registry bumps:**
- `.claude/reference/migrations-log.md` — head → 053, next → 054, add a 053 entry.
- `.claude/CLAUDE.md:102` — "current head: migration **052** (next: **053**)" → "**053** (next: **054**)".

### Commit 2 — Stale references (zero behavior change)

**Runtime guards — delete two dead special-case branches, keep the allowlist.**
The two runtime `sales_partner` checks are *not* the guard; they are
error-message special-cases layered on an allowlist that already fails closed:

- `src/app/api/auth/callback/route.ts:174` — the `sales_partner` branch only
  swaps the error param (`unsupported_role` vs `account_incomplete`). The
  allowlist at `:185` (`role !== 'owner' && role !== 'admin'`) already rejects.
  **Delete the branch.** `unsupported_role` stays alive (emitted generically by
  `reset-password/route.ts:84`, consumed by `mapLoginError.ts`), so no dead code.
- `src/components/auth/hooks/useLoginSubmit.ts:104` — the `sales_partner` branch
  only swaps the message (`UNSUPPORTED_ROLE_MESSAGE`). The allowlist at `:102`
  (`!allowedRoles.includes(role)`) already rejects. **Delete the branch** and the
  now-unused `UNSUPPORTED_ROLE_MESSAGE` import. The constant stays alive via
  `mapLoginError.ts`.

This *increases* defense-in-depth (allowlist > denylist), removes the runtime
`sales_partner` literals the acceptance criterion forbids, and simplifies code.

**Comments — reword, preserve the real rationale:**
- `src/app/api/zernio/disconnect/route.ts` (lines ~30–35, ~59–60)
- `src/app/api/onboarding/select-plan/route.ts:151`
- `src/app/api/onboarding/business/route.ts` (lines ~105, ~107, ~121)

Drop the `sales_partner` framing; keep the genuine "admin session" reasoning
(e.g. admins have NULL `account_id`; admin business-detail routes don't scope by
`onboarded_by`).

**Renames — clarity only (these already query `role='admin'`):**
- `worker/jobs/OnboardingDripWorker.ts`: `salesPartnerName` → `supportContactName`,
  `scopedPartner` → `scopedAdmin`.
- `src/lib/notifications/email/templates/onboarding.ts`: the `salesPartnerName`
  field of `OnboardingDay30Params` and local `safeSalesPartner` →
  `supportContactName` / `safeSupportContact`.

**Tests — update the ~2 that assert the deleted special-case behavior:**
- `src/app/api/auth/__tests__/callback.test.ts` (3 cases asserting sales_partner →
  `unsupported_role`): re-point to assert the general fail-closed path
  (`account_incomplete`), or generalize to a non-owner/admin role.
- `src/components/auth/__tests__/LoginFormClient.test.tsx:100`: re-point to the
  general portal-mismatch path.

## Out of scope (deliberately kept)

- **Applied migrations `001`, `025`, `039`** are historical record — never edited.
- **~10 test files that seed `role='sales_partner'` to assert rejection**
  (`proxy`, `require-owner-access`, `guard`, `forgot-password`, `reset-password`,
  `signup-status`, `demo/page`, `start/page`, `business`, `select-plan`) stay as
  is. The issue explicitly exempts "fixtures asserting the role is rejected", and
  they remain valid allowlist regression guards. `grep` will still show these
  test/historical hits, which the acceptance criterion permits.

## Acceptance criteria (from #50)

- [x] No `users` row has `role = 'sales_partner'` (auto-convert in 053; 0 in prod).
- [x] `sales_partner` is no longer a permitted value — enforced by `users_role_check`.
- [x] `grep -ri sales_partner src worker supabase` returns no **runtime/schema**
      references (kept test fixtures + applied migrations are exempt).
- [x] `owner` and `admin` behavior unchanged.

## Risks & safety

- **Low risk.** Access already blocked since #43.
- The `ADD CONSTRAINT` takes a brief `ACCESS EXCLUSIVE` lock and scans `users` —
  instant on a 1-row table.
- Re-run-safe via the `pg_constraint` existence guard.
- Auto-convert grants `admin` login to any stray `sales_partner` row in a
  non-prod environment. Accepted tradeoff (prod has 0 rows); the runtime
  allowlist and #43's blocks bound the blast radius.

## Validation plan

- `pnpm lint && pnpm typecheck && pnpm test` (full).
- DB-touching change → also `pnpm ci:tenant-scope` and `pnpm ci:rls-audit`.
- Worktree is a **sibling outside the repo** (`RepWorth-issue50`), avoiding the
  documented nested-worktree module-resolution leak. Final CI validated on the
  GitHub runner via the PR.
