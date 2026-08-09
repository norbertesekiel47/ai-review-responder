# #706 live-DB helper scan — deviations from the plan

Deviations from `2026-08-08-706-live-db-helper-scan.md`, recorded as they were hit.

## Triage (orchestrator, step 6 — before review dispatch)

| # | Entry | Verdict |
|---|---|---|
| D1 | Three plan-literal JSDoc numbers false against the tree | **ACCEPT** — all three re-verified independently by the orchestrator (4 of 13 glob-alone, 5 of 6 `import type`, 074 shape suite + 3 others). Shipping a corrected count over a plan-literal false one is the only reading consistent with this module's stated review criterion. The intake's own "two files newly enter the scanned set" was likewise an undercount — true but incomplete; the invariant it guards (no `naming` finding on a helper) is unaffected. |
| D2 | Stale `_SUITES` symbol names left for Task 4 | **ACCEPT** — correct task-boundary call. Task 4's brief was widened to the two sites outside its declared file list; both are inside `allowed_edit_surface`, so this is a task-scope correction, **not** a surface amendment, and does not count toward the abort budget. |
| D3 | Three prose sites stale by MEANING, not by symbol | **ACCEPT** — the module's opening definition read exhaustively over two reachability routes when there are now three; leaving it would have been the #694 R1 defect exactly. The deliberate non-change to the R2 census recount method is right: that census is a claim about marker-passing suites, not about the audited file set, and widening it would silently change what the figure means. |
| D4 | Lab-notes entry shipped as a dated section; bound closed in place | **ACCEPT** — matches the file's real convention over the plan's approximation of it, and the "one authoritative owner per fact" rule: #694's record owns this story, so a second ship section would split one fact across two owners. |
| D5 | The two "no occurrence today" claims verified before shipping | **ACCEPT** — this is the convention working. A `BOUND:` paragraph asserting "neither has an occurrence today" is a checkable claim, and it was checked rather than assumed. |

No RE-PLAN. No locked intake decision invalidated; abort criteria not triggered (0 gate-fail rounds, 0 surface amendments).

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

## 2026-08-08 — Task 4: three prose sites the plan's steps do not reach

All three are claims #706 falsifies, none named by a Task 4 step, all fixed here.
The grep in Step 6 catches none of them — they are stale by MEANING, not by
symbol name.

1. **`live-db-suites-audit.ts` lines 3–6** — the module's opening definition read
   *"A 'live-DB suite' is any test file that reaches the shared local Postgres —
   whether it names TEST_DATABASE_POOL_URL itself or … gets there through the
   shared helpers."* Two problems after #706: the term is now `live-DB file` (the
   header's own inserted paragraph defines *suite* narrowly, two blocks below),
   and the `whether … or …` enumeration reads exhaustive while there are now
   three routes. Rewritten to name the third (`HELPER_DB_MARKER`) and point at
   its JSDoc rather than restate the mechanics.
2. **`.claude/reference/lab-notes.md`, the Postgres.js-fragment entry** — closed
   with *"`ci:live-db-suites` … is blind to a fragment built in a file outside
   its glob (#706)"*. Narrowed to "outside `__tests__/` altogether", which is
   what is still true.
3. **`docs/currents.md:166`** — the #694 file table named
   `DDL_PROBE_SUITES`/`MIGRATION_SHAPE_SUITES`. Renamed, with a parenthetical
   saying why.

Left alone deliberately: the R2 census recount method ("walk every git-tracked
`*.test.ts` that contains a LIVE_DB_MARKERS string") still describes how the
`~770 of ~1470` figure was produced, which is a claim about the marker-passing
suites and not about the audited file set. Widening it would change what the
census means.

## 2026-08-08 — Task 4: lab-notes entry placement, and closing the bound in place

**Lab notes.** Step 4 supplies the entry as a single `- [2026-08-08] X → Y → Z`
bullet and says to use "the `## 2026-07-26 — #573 …` section's format". That
section's actual format is a `### [DATE] title` heading followed by prose in
`FAIL → … WHY → … CORRECT →` form, and every ship since is its own
`## <date> — #NNN <topic> ship` section. Shipped that way: a new
`## 2026-08-08 — #706 live-DB helper scan ship` section at the end of the file
(directly following its #694 predecessor's siblings), carrying one
`### [2026-08-08] #706 — …` entry with the plan's content restructured into
FAIL/WHY/CORRECT. No content dropped.

**currents.md / progresstracking.md.** Both stated #706 as an OPEN bound inside
the **#694** ship record. Both now read as closed **in place** — the file's
existing convention for retiring a previously-stated bound (`docs/currents.md:342`
"**CLOSED at PR #701**", and the two "**Release constraint DISCHARGED at #679
(PR #698)**" markers in the lead paragraph). Deliberately NOT done: a new
`## Quick summary — Live-DB helper scan` section in currents.md or a new
progresstracking section. Two reasons — this branch has no PR number, and every
ship record in both files carries one or an explicit "PR pending"; and #694's
record is the single owner of this story, so a second section would split one
fact across two owners. The lead paragraph (currents.md:10) carries the full
"what shipped" text at the point where it previously carried the open bound.

## 2026-08-08 — Task 4: the plan's two "no occurrence today" claims, verified

The `hidesStatementStart` BOUND paragraph shipped verbatim, including *"Neither
has an occurrence today"* for the two remaining bounds. Both halves checked
against the tree before the prose was written:

- **Fragment built outside `__tests__/`** — a DDL-verb sweep of every `.ts`/`.tsx`
  in `src/` and `worker/` outside `__tests__/` returns only comment text in
  `scripts/ci/*-audit.ts`. No production module builds a DDL fragment.
- **`e2e/` lane** — a DDL-verb sweep of `e2e/` returns zero hits of any kind. (One
  `e2e/` file, `e2e/fixtures/__tests__/zernio-fixture-server.test.ts`, IS audited
  and always was, via the `*.test.ts` pathspec.)
