# Issue #79 — Build-safe Dynamic Public Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `next build` succeed when `DATABASE_POOL_URL` is unset by opting the two DB-backed `(public)` pages out of build-time prerender, guarded by a regression test.

**Architecture:** Next 16 statically prerenders cookieless `(public)` pages at build time, executing their server components — including `await sql\`…\`` — which aborts the build when Postgres is absent. Both pages are inherently per-request, so we declare `export const dynamic = 'force-dynamic'` (the pattern every other DB-backed page already uses), and add a glob-derived Vitest guard so the rule is self-enforcing.

**Tech Stack:** Next.js 16 (App Router, Turbopack build), Vitest 4 (`environment: node`, `globals: true`), Postgres.js, pnpm.

**Spec:** `docs/superpowers/specs/2026-05-28-issue-79-build-safe-dynamic-pages-design.md`

**Worktree:** `~/.config/superpowers/worktrees/RepWorth/fix-issue-79` on branch `fix/issue-79-build-safe-dynamic-pages` (external to the repo — nested worktrees poison lint/test per project lab notes). Run all commands from the worktree root.

---

## File Structure

- **Create:** `src/app/(public)/__tests__/db-backed-pages-force-dynamic.test.ts` — the regression guard. Discovers every `(public)` page that directly imports `@/lib/db/server` and asserts it declares `force-dynamic`. One responsibility: enforce the build-safety invariant.
- **Modify:** `src/app/(public)/approve/[token]/page.tsx` — add one line after the imports.
- **Modify:** `src/app/(public)/demo/[slug]/page.tsx` — add one line after the imports.

No change to `src/lib/db/server.ts`.

---

## Task 1: Regression guard + fix (single green commit)

TDD note: we write the guard, watch it go **red** against the current tree (proving it detects the bug), then apply the one-line fix to each page and watch it go **green**. We commit the test and both edits together so every commit is green.

**Files:**
- Create: `src/app/(public)/__tests__/db-backed-pages-force-dynamic.test.ts`
- Modify: `src/app/(public)/approve/[token]/page.tsx`
- Modify: `src/app/(public)/demo/[slug]/page.tsx`

- [ ] **Step 1: Write the guard test**

Create `src/app/(public)/__tests__/db-backed-pages-force-dynamic.test.ts` with exactly:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard for issue #79. A page under src/app/(public)/ has no auth cookies, so
 * Next 16 tries to STATICALLY PRERENDER it at build time — executing its server
 * component, including any `await sql`…`` query. If such a page does not opt out
 * with `export const dynamic = 'force-dynamic'`, `next build` collects its page
 * data and hard-fails whenever DATABASE_POOL_URL is absent or the DB is
 * unreachable.
 *
 * This guard discovers every public page that DIRECTLY imports the Postgres
 * client module and asserts it declares force-dynamic. New public DB-backed
 * pages are covered automatically — no hand-maintained list.
 *
 * Scope limit: only DIRECT imports of '@/lib/db/server' are detected. A page
 * that reaches Postgres exclusively through a transitive helper is not covered;
 * direct `sql` use is the realistic prerender hazard.
 */
const PUBLIC_ROOT = join(process.cwd(), 'src', 'app', '(public)');
const DB_CLIENT_MODULE = '@/lib/db/server';
const FORCE_DYNAMIC = /export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/;

function dbBackedPublicPages(): string[] {
  return readdirSync(PUBLIC_ROOT, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('page.tsx'))
    .map((entry) => join(PUBLIC_ROOT, entry))
    .filter((file) => readFileSync(file, 'utf8').includes(DB_CLIENT_MODULE))
    .map((file) => relative(process.cwd(), file));
}

const pages = dbBackedPublicPages();

describe('(public) DB-backed pages declare force-dynamic (issue #79)', () => {
  it('discovers the known DB-backed public pages', () => {
    // Fail loudly if the glob matches nothing, so the suite can't pass vacuously.
    expect(pages.length).toBeGreaterThanOrEqual(2);
  });

  it.each(pages)('%s opts out of build-time prerender', (relPath) => {
    expect(readFileSync(join(process.cwd(), relPath), 'utf8')).toMatch(
      FORCE_DYNAMIC,
    );
  });
});
```

- [ ] **Step 2: Run the guard test — expect RED**

Run: `pnpm test -- db-backed-pages-force-dynamic`

Expected: the `discovers…` test PASSES (2 pages found), and **two** `… opts out of build-time prerender` cases FAIL — one for `src/app/(public)/approve/[token]/page.tsx`, one for `src/app/(public)/demo/[slug]/page.tsx` — because neither yet declares `force-dynamic`. This confirms the guard detects the bug.

- [ ] **Step 3: Fix `approve/[token]/page.tsx`**

In `src/app/(public)/approve/[token]/page.tsx`, insert the `force-dynamic` line after the import block.

Replace:

```ts
import { createHash } from 'node:crypto';
import { sql } from '@/lib/db/server';
import ApprovalClient from '@/components/approval/approval-client';

interface PageProps {
```

with:

```ts
import { createHash } from 'node:crypto';
import { sql } from '@/lib/db/server';
import ApprovalClient from '@/components/approval/approval-client';

export const dynamic = 'force-dynamic';

interface PageProps {
```

- [ ] **Step 4: Fix `demo/[slug]/page.tsx`**

In `src/app/(public)/demo/[slug]/page.tsx`, insert the `force-dynamic` line after the import block (before the existing TODO comment).

Replace:

```ts
import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

// TODO Sprint 4: debounce view_count with Redis INCR instead of direct Postgres write
```

with:

```ts
import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

export const dynamic = 'force-dynamic';

// TODO Sprint 4: debounce view_count with Redis INCR instead of direct Postgres write
```

- [ ] **Step 5: Run the guard test — expect GREEN**

Run: `pnpm test -- db-backed-pages-force-dynamic`

Expected: all cases PASS (3 passing: the discovery sanity check + both page assertions).

- [ ] **Step 6: Commit the test and both fixes together**

```bash
git add "src/app/(public)/__tests__/db-backed-pages-force-dynamic.test.ts" \
        "src/app/(public)/approve/[token]/page.tsx" \
        "src/app/(public)/demo/[slug]/page.tsx"
git commit -m "$(cat <<'EOF'
fix(build): force-dynamic on DB-backed (public) pages (#79)

Next 16 prerenders cookieless (public) pages at build time, executing
their server components — including await sql`…` — which aborts the build
when DATABASE_POOL_URL is absent. Declare force-dynamic on the two pages
that query Postgres (the pattern every other DB-backed page already uses),
and add a glob-derived guard so future public DB-backed pages are covered.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Acceptance & verification

**Files:** none modified — verification only.

- [ ] **Step 1: Lint + typecheck (full, deterministic)**

Run: `pnpm lint && pnpm typecheck`
Expected: both exit 0. The new test file uses only `node:fs`/`node:path` and Vitest globals — no `any`, no unused vars.

- [ ] **Step 2: Acceptance — build with `DATABASE_POOL_URL` absent**

This reproduces issue #79's environment: every build var present **except** `DATABASE_POOL_URL`. We also drop `SENTRY_AUTH_TOKEN` so the build does not attempt a network source-map upload (orthogonal to this fix). The command never prints secret values, and `.env.local` is gitignored in the worktree.

```bash
grep -vE '^(DATABASE_POOL_URL|SENTRY_AUTH_TOKEN)=' \
  /Users/norbertesekiel/Developer/startups/RepWorth/.env.local > .env.local
env -u DATABASE_POOL_URL pnpm build
```

Expected: build **succeeds** with no `PageNotFoundError` and no "Failed to collect page data". In the route table, `/demo/[slug]` and `/approve/[token]` are marked `ƒ` (Dynamic / server-rendered on demand), not `○`/`●` (static/prerendered).

Troubleshooting: if the build fails for a reason unrelated to `/demo/[slug]` or `/approve/[token]` (e.g. another missing var surfaced by your stripped env), add that var back into the worktree `.env.local` — it is not part of issue #79.

- [ ] **Step 3: Confirm production-shaped build still works (regression check)**

Run a build with the full env (the var present), proving the fix doesn't break the green path:

```bash
cp /Users/norbertesekiel/Developer/startups/RepWorth/.env.local .env.local
pnpm build
```

Expected: build succeeds (as it does in CI today). Then remove the copied env so secrets don't linger in the worktree: `rm -f .env.local`.

- [ ] **Step 4: Push and open the PR (full suite runs in CI)**

`main` is protected; the authoritative full-suite gate is the 4 CI checks (`lint`, `typecheck`, `test`, `build`) on the PR. Hand off to the `superpowers:finishing-a-development-branch` skill to push the branch and open the PR referencing issue #79. Do not merge until all four checks are green.

---

## Notes

- This plan does **not** modify `src/lib/db/server.ts`; the lazy-client theory in the issue is not the cause (six sibling DB-backed pages import the same module and build green).
- The fix is additive and tiny; no existing tests should change behavior. If `pnpm test` (full suite) shows failures locally, confirm they also fail on `origin/main` before treating them as regressions — they are almost certainly environmental (missing test DB), per the project's worktree-test-artifact note.
