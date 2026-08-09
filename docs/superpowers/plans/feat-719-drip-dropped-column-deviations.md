# feat-719-drip-dropped-column — deviations

Entries the plan did not anticipate. Every entry gets a triage verdict (ACCEPT / RE-PLAN)
logged inline at step 6, before any review agent sees this file.

---

## D1 — `allowed_edit_surface` amendment (auto-approved, step 2 rule)

**When:** step 3, before planning completed.

**What:** added `worker/jobs/WeeklySummaryWorker.ts` and `worker/jobs/MonthlyImpactWorker.ts`
to `allowed_edit_surface` in both intake copies.

**Why:** the `codebase-design` pass found that `ownerHasDashboardAuth` and `buildDashboardUrl`
are composed verbatim at every call site (`WeeklySummaryWorker.ts:213-216`,
`MonthlyImpactWorker.ts:294-297`), and the drip worker would have been the third. Collapsing
them into one `resolveDashboardUrl` removes `Array<{exists: number}>` from the interface and is
net-negative, but it edits the two sibling call sites.

**Rule applied:** step 2's auto-approve clause — exactly 2 files, both inside `worker/jobs/`,
a tree the surface already covers. Recorded, not escalated.

**Amendment count: 1.** A second amendment triggers the step 5 abort criteria.

**Containment:** the collapse is isolated as Task 4, blocked on Task 3, and turns no promised
test green. It can be dropped without touching the correctness fix.

**Verdict:** _(pending step 6)_

---

## D2 — `origin/main` moved mid-setup

**When:** step 2, before `pnpm worktree:new`.

**What:** the branch is based on `39c94ed1` (#720, "audit live-DB helpers, not just suites"),
which landed after this session started, not on the `main` the parent checkout had.

**Why it matters:** #720 hardened `ci:live-db-suites` to audit helper files, not only
`*.integration.test.ts` suites. Task 1 adds `seedLocation` / `cleanupLocation` to
`src/lib/shared/__tests__/live-db-tenant.ts` — a helper file now inside that audit's scope.
The helpers contain INSERTs only and no DDL, so they should pass, but Task 1 Step 6 runs
`pnpm ci:live-db-suites` explicitly rather than assuming it.

**Verdict:** _(pending step 6)_
