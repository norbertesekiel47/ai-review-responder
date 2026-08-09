# #706 live-DB helper scan — deviations from the plan

Deviations from `2026-08-08-706-live-db-helper-scan.md`, recorded as they were hit.

## 2026-08-08 — Task 3: three plan-literal JSDoc numbers were false against the tree

The plan's literal code blocks for Task 3 Steps 1 and 3 carry four numeric claims
about the tree. Three were wrong when checked. They were shipped **corrected**, not
verbatim, because this module's stated review criterion is that no comment asserts
something untrue — #694's only Medium finding was exactly that defect, and a false
count in the JSDoc of the mechanism #706 adds would repeat it one ticket later.
The `BOUND:` paragraph the handoff required verbatim carries none of these numbers
and is untouched.

| Plan text (Step) | Claim | Verified | Shipped as |
|---|---|---|---|
| Step 1, `HELPER_DB_MARKER` ¶1 | glob alone "reached **2** of the 13 new files" | **4** of 13 match `LIVE_DB_MARKERS` (`describe-with-db.ts`, `abort-injection.ts`, `live-db-lock.ts`, `live-db-tenant.ts`) | "reached 4 of the 13 new files — none of them the one that executes DDL" |
| Step 1, `HELPER_DB_MARKER` ¶2 | "**four** of the six DB-reaching helpers use `import type`" | **5** of 6; the sole value import is `helpers/live-db-lock.ts` | "five of the six … (the exception is `helpers/live-db-lock.ts`, which CONSTRUCTS a connection rather than being handed one)" |
| Step 3, `MIGRATION_SHAPE_FILES` | `apply-migration-074.ts` is delegated to by "**five of them** and the wider tree" | 4 importers: the 074 shape suite + `auto-approval/settings`, `publisher/veto-window-gate`, `response-generation/auto-approval-daily-cap` | "the 074 shape suite and three further integration suites delegate to" |

Verified correct and shipped verbatim: 13 newly scanned non-suite files (exact list
matches the plan's table), 6 importing `postgres`, and
`db.unsafe(readMigration074Sql())` at `apply-migration-074.ts:55` being the DDL the
walk cannot read. `withMigration074ApplyLock` is *defined* at line 23 of that same
file, so the own-text lock check is satisfied by definition — as the `OWN_APPLY_LOCK`
JSDoc claims.

**Consequence for Task 4:** do not "restore" the plan's numbers when re-reading its
literal blocks.

## 2026-08-08 — Task 3: stale symbol names left for Task 4

Renaming `MIGRATION_SHAPE_SUITES`→`MIGRATION_SHAPE_FILES` and
`DDL_PROBE_SUITES`→`DDL_PROBE_FILES` left five prose mentions of the old names,
all outside the JSDoc blocks Task 3 owns and so deliberately not touched:
`live-db-suites-audit.ts` lines 12, 50, 51 (module header — Task 4 Step 2),
line ~167 (`DDL_VERB` JSDoc) and line ~218 (`hidesStatementStart` JSDoc — Task 4
Step 1), plus `scripts/ci/__tests__/live-db-suites-audit.test.ts:237`.

Task 4 Step 6's grep is written to catch all of these and expects zero hits, but
two are outside the steps that enumerate edits: the `DDL_VERB` JSDoc is in no
Task 4 step, and the **test file is in neither Task 3's nor Task 4's "Files"
list**. Task 4 must widen its own surface to that file or the Step 6 grep cannot
reach zero.
