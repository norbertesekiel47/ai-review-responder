# Issue #79 — Build-safe dynamic public pages

**Date:** 2026-05-28
**Issue:** [#79](https://github.com/RepWorth/ai-review-responder/issues/79) — Next 16 build hard-fails when `DATABASE_POOL_URL` is absent (DB-backed dynamic routes)
**Branch:** `fix/issue-79-build-safe-dynamic-pages`

## Problem

After the Next 15 → 16 upgrade (#78), `next build` aborts when `DATABASE_POOL_URL`
is not set in the environment:

```
Error [PageNotFoundError]: Cannot find module for page: /demo/[slug]
Error [PageNotFoundError]: Cannot find module for page: /approve/[token]
> Build error occurred
Error: Failed to collect page data for /demo/[slug]
```

CI and Vercel production both set the var, so current builds are green. But any
environment **missing** it — a bare local `pnpm build`, a new preview/staging
project, or an accidentally-removed var — fails hard with no graceful
degradation.

## Root cause

Both failing pages live under `src/app/(public)/` — no auth, no cookies — so
Next 16 attempts to **statically prerender** them during the "collecting page
data" build phase. Prerendering executes the server component, which runs
`await sql\`…\`` against Postgres. With `DATABASE_POOL_URL` unset (or the DB
unreachable) the query fails and the build aborts.

**Differential evidence that pins the cause:** six other DB-backed pages import
the exact same `@/lib/db/server` module and build green in CI —
`onboarding/{start,business,demo,pay}`, `settings/locations`,
`dashboard/past-replies`. Every one of them declares
`export const dynamic = 'force-dynamic';`. The *only* two DB-backed pages
missing that line are exactly the two that fail.

This also rules out the issue's "lazy Postgres client" theory as the real cause:
module-level `postgres(process.env.DATABASE_POOL_URL!, …)` construction clearly
does **not** throw at import time, or those six sibling pages would fail too. The
failure is at render-during-collection, not at import. Making the client lazy
would not prevent the render-time query from executing, so it would not satisfy
the acceptance criterion on its own.

## Decision

Adopt the existing, authoritative codebase pattern. The two `(public)` pages
simply missed the `force-dynamic` declaration that every comparable DB-backed
page already carries. Declaring it states the truth about these routes — they
are inherently per-request (per-token / per-slug, with a view-count write side
effect) and must never be prerendered.

Rejected alternatives:
- **Lazy DB clients** (issue option 2): does not address the render-time query;
  would not make the build pass. Also touches a module imported everywhere.
- **`force-dynamic` + lazy clients** (defense-in-depth): unnecessary — import-time
  construction is already proven safe by the six green sibling pages. Adds blast
  radius for no benefit.
- **Build-time env guard** (issue option 3): made moot by `force-dynamic`, and
  vaguer than the established pattern.

## Changes

### Change 1 — opt the two pages out of build-time prerender

Add, immediately after the imports in each file (matching the exact existing
convention — bare line, no comment):

```ts
export const dynamic = 'force-dynamic';
```

Files:
- `src/app/(public)/approve/[token]/page.tsx`
- `src/app/(public)/demo/[slug]/page.tsx`

No change to `src/lib/db/server.ts`.

### Change 2 — self-maintaining regression guard

A Vitest test that globs `src/app/(public)/**/page.tsx`, and for every file that
imports `@/lib/db/server`, asserts its source matches
`export const dynamic = 'force-dynamic'`.

Rationale for glob-derived (vs. a hardcoded two-file list): it auto-covers any
*future* public DB-backed page, so the rule — "a public page that touches the DB
must be `force-dynamic`" — has one authoritative enforcer instead of a list
someone must remember to update. It is fast (no Next runtime, pure source-text
assertion), runs inside the existing `pnpm test`, and mirrors the audit-style
guard tests already in the repo (`model-pinning.test.ts`, tenant-scope audit).

The test fails today (two pages) and passes after Change 1.

**Location:** `src/app/(public)/__tests__/db-backed-pages-force-dynamic.test.ts`

**Scope limit (documented in the test):** the guard checks **direct** imports of
the db module. A public page that reaches the DB purely through a transitive
helper would not be caught. This is an accepted limit — direct `sql` use is the
realistic prerender hazard.

## Verification

1. Write the guard test first; confirm it goes **red** against the current tree
   (proves it actually detects the bug — TDD).
2. Apply Change 1; confirm the guard test goes **green**.
3. Run `DATABASE_POOL_URL= pnpm build` (var explicitly unset) — succeeds with no
   `PageNotFoundError`. This is the real acceptance check.
4. `pnpm lint && pnpm typecheck && pnpm test` all green.

All validation runs in an isolated worktree located **outside** the repo root
(`~/.config/superpowers/worktrees/RepWorth/fix-issue-79`), per the project's
nested-worktree hazard note (nested worktrees leak module resolution into the
parent `node_modules`/eslintrc and poison lint+test).

## Acceptance criteria

- `pnpm build` succeeds with `DATABASE_POOL_URL` unset (no `PageNotFoundError`).
- Production/CI builds (var present) remain green.
- New guard test passes and fails if either page loses its `force-dynamic`
  declaration.

## Out of scope

- No changes to `src/lib/db/server.ts` (client construction, lazy init).
- No new CI job for build-without-env (cheap unit guard chosen instead).
- No changes to the six already-correct sibling pages.
