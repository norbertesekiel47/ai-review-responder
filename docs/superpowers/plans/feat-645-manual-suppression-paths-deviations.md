# Deviations — feat-645-manual-suppression-paths

Entries the plan did not anticipate. Every one gets a triage verdict (ACCEPT /
RE-PLAN) at step 6, before any review agent is dispatched.

---

## D-A1 · Surface amendment #1 (of 2 before abort criteria fire) — plan time

**What:** added `src/lib/shared/__tests__/**` to `allowed_edit_surface` in both
intake copies.

**Why:** the repo's live-DB convention (#573, `ci:live-db-suites`) puts migration
shape suites at `src/lib/shared/__tests__/migration-NNN-*.integration.test.ts`
and their schema requirements in
`src/lib/shared/__tests__/helpers/schema-ready.ts`. Migration 098 needs both.
Two test files in one tree, mechanically required by a documented convention —
no production code is in scope there.

**Status:** applied; surfaced to the owner in the plan summary for veto.

---

## D-A2 · Known cross-worktree conflict — `scripts/ci/tenant-scope-allowlist.ts`

**What:** the `admin-console-phase3` worktree (branch `admin-console-phase3`,
4 commits + uncommitted work at plan time) also appends entries to
`TENANT_SCOPE_ALLOWLIST` and bumps `ALLOWLIST_BASELINE`.

**Agreed handling:** append-only list, so no merge order is imposed. Whichever
branch merges second rebases and **re-appends its own entries, then recomputes
the baseline from the actual entry count** — never reverting the other branch's
entries and never reusing its baseline number. The audit fails on a count
mismatch in either direction, so a botched resolution is caught by CI rather
than shipped.

**Also noted:** `src/components/admin/ui/DataTable.tsx` is owned by that
worktree right now. Task 6 reads it but must not modify it; if the admin
suppressions client needs something DataTable lacks, it renders a plain table
locally and records that here.
