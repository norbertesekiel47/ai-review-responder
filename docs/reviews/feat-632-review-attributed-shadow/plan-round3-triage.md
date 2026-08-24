# Plan review round 3 — triage · THE LOOP STOPS HERE

**Reviewer:** codex, same thread `01a0353b-3877-78d3-858a-c36c8fc5b35a`
**Verdict:** `REVISE` · **Full report:** `plan-round3-codex.md`
**Round counter:** `planReviewRounds=3` — the workflow's cap.

All four findings **accepted and fixed**. None was a disagreement; all four were
mechanical defects, three of them self-inflicted by the round-2 fixes.

| # | Finding | Fix applied |
|---|---|---|
| C1 | **The parked-test scan matched its own comment.** The round-2 comment explaining the check literally contained `describe.skip(`, so `parked` was permanently non-empty and the test could never go green. It also missed `skipIf`, `xit`/`xtest`/`xdescribe`, and chained forms like `it.concurrent.skip` and `it.skip.each`. | Comments are stripped before scanning (block and line), and the pattern now covers chained, `skipIf` and `x`-prefixed forms. A standing note tells future editors not to name parked forms in these suites' comments. |
| C2 | **`SUITE_FILES` omitted `worker/__tests__/solicitation-attribution.integration.test.ts`**, so two promised titles had no searchable home — `handleSolicitationAttribution: concurrent replay …` and `SolicitationAttributionWorker: completes the owned outbox attempt …`. | Added to `SUITE_FILES`. |
| C3 | **Task 0 and Task 4's `git add` commands omitted the newly created suites**, leaving `job-outbox-helpers-attribution.integration.test.ts`, `process-review-attribution.integration.test.ts` and both worker suites uncommitted. | Both commit steps now list every file they create. |
| C4 | **The per-task pass counts totalled 50, not 54.** Task 1 expected 2 of 4 migration titles, Task 2 expected 8 of 10, and `matchAttribution: one matching candidate among unrelated non-matches attributes that candidate` had no unparking body. | Task 1 → 4, Task 2 → 10, and a **title-budget table** in Task 0 Step 2 makes the arithmetic checkable: 4 + 10 + 16 + 7 + 5 + 5 + 6 + 1 = **54**. |

## Status: fixed, but unverified

The workflow caps the plan-review loop at three rounds. Round 3's fixes went in
**after** the last review, so they carry no reviewer verification. That is the
cap working as designed, not an oversight — but it is the honest state, and the
owner should know it before execution starts.

**What the three rounds bought.** Round 1 found the vacuous eval task, the
missing outbox completion, the enqueue wired into the excluded import lane, the
per-business uniqueness hole, the review-delete resurrection bug and the
off-by-one window boundary. Round 2 caught three fixes that had not fully
landed and one race a fix introduced. Round 3 caught four mechanical slips in
round 2's own work. The trend is the right shape: findings got smaller and more
local each round.

**Owner's call substitutes for APPROVED.** Per the workflow, after round 3 the
remaining position goes to the owner. The orchestrator's position: the plan is
sound and executable, the four round-3 fixes are mechanical and self-evident on
reading, and Task 0 is itself a verification mechanism — the eval-contract test
will fail loudly if the parked scan or the title budget is wrong, on the first
run of Task 0. That makes a fourth review round redundant with the first
execution step.
