# Plan review round 4 — triage

**Reviewer:** codex, same thread `01a0353b-3877-78d3-858a-c36c8fc5b35a`
**Verdict:** `REVISE` · **Full report:** `plan-round4-codex.md`
**Round counter:** `planReviewRounds=4` — one past the cap, by owner override.

Round 4 was verification-only. Its whole job was to check the four round-3
fixes, which had landed after the last review and carried no verification.

**Result: two of the four round-3 fixes were wrong or incomplete.** The owner's
override was justified. Task 0's eval-contract test would NOT have caught D1 —
the defect makes that very test report false green.

| # | Source | Finding | Verdict | Fix applied |
|---|---|---|---|---|
| D1 | codex (C1) | **The comment stripper is lexical, not syntax-aware, and fails OPEN.** `.replace(/(^\|[^:])\/\/.*$/gm, '$1')` turns `const marker = "//"; it.skip('t', fn)` into `const marker = "`, deleting the `it.skip` from the corpus. The block stripper does the same across two string literals holding `"/*"` and `"*/"`. Either case is a **false green** on the one test whose job is to prove no test is parked. | **ACCEPTED** | Replaced with a whole-line filter: drop only lines whose trimmed text starts `//`, `/*` or `*`. A marker never sits on a comment-only line, so the filter cannot hide one. A trailing comment naming a parked form now turns the test RED — the safe direction. |
| D2 | codex (C3) | **Task 0 and Task 4 file manifests disagree with their `git add`.** | **ACCEPTED, arbitrated** | Step 2's ownership table is the arbiter. **Task 0**: the two `Modify:` lines were stale — it owns no title in either unit suite — and four `Create:` targets were missing. Files now lists all nine homes and nothing else. **Task 4**: both `Modify:` lines are real and the `git add` was wrong; it now stages all eight paths. |
| D3 | codex (C4) | **Four task headers contradict the new budget table.** Task 3 claimed 8 and owns 16; Task 4 claimed 2 and owns 7; Task 6 claimed 4 and owns 5; Task 7 claimed 3 and owns 6. | **ACCEPTED** | All four corrected against the table. Tasks 1 and 5 had **no** `Turns green` line at all — added. Every task now states `all N of its budgeted titles`, so 4+10+16+7+5+5+6+1 = **54** is checkable per task, not only in the table. |
| D4 | codex (owner) | **The plan presented a resolved decision as open** at the rule-B note and in the follow-ups list. | **ACCEPTED** | Both rewritten to record the owner's 2026-08-24 call: the broad reading is FINAL, `compatible(firstA, firstB)` keeps its `isInitial` arm, and the narrowing is a **rejected alternative**, not a follow-up. |
| D5 | self | **Task 0's steps jump 4 → 8.** Steps 5, 6 and 7 do not exist. A subagent reading a gap stalls or invents work. | **ACCEPTED** | Commit step renumbered to Step 5. One prose reference to "step 5" was disambiguated to the WORKFLOW's step 5 gate. |
| D6 | self | **Task 4's verification runs only the integration suites — it never runs the mocked unit suite it breaks.** `process-review.test.ts` hand-counts transaction calls (`expect(tx).toHaveBeenCalledTimes(5)`, `tx.mock.calls[3]`). Task 4 adds a second `job_outbox` INSERT inside the same `sql.begin`, so every count and index shifts. Task 4 would report success and the breakage would surface at the step 5 gate, attributed to the wrong task. | **ACCEPTED** | A second run command added, plus a standing rule: fix the counts in Task 4, and never weaken one to `expect.any` — the exact count is what proves the enqueue joined the existing transaction (invariant #2). |
| D7 | self | **Task 5's Files block omits three files it stages and modifies** — both worker suites and `attribution.test.ts` (which owns `architecture:`). Same class as D2, missed by the reviewer because it only checked the `Create:`-to-`git add` direction for Tasks 0 and 4. | **ACCEPTED** | All three declared. |

**Rejected:** none.

## Verification of the fixes

A script cross-checks every task's `Files` block against its `git add`. Tasks 0
through 4 now match path-for-path. Tasks 5 through 8 stage by directory, which
covers their declared files. Grep confirms zero remaining hedges on the match
rule and eight `Turns green` lines whose counts sum to 53 + `eval contract:`.

## What round 4 changes about the plan's readiness

Round 3's claim was that its fixes were "mechanical and self-evident on
reading", and that Task 0's eval-contract test was a sufficient practical check
on them. **D1 disproves the second half of that claim.** The defect was inside
the eval-contract test itself and its failure mode is false green, so the test
could not have flagged it. D6 is the same shape: a task that verifies too
narrowly reports success while breaking a suite it never runs.

Both defects are now fixed. Neither round-4 fix is itself reviewer-verified —
that is the same honest limit round 3 had, one round further on. The difference
is that this round's fixes are **fail-closed by construction**: the whole-line
comment filter and the widened Task 4 command can only produce extra RED, never
a false green.

## Status

**The loop stops here.** There is no round 5. The remaining position is the
owner's: approve and release step 4, or direct further work.
