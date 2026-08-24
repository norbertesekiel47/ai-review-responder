# Plan review round 2 — triage

**Reviewer:** codex, same thread `01a0353b-3877-78d3-858a-c36c8fc5b35a`
**Verdict:** `REVISE` · **Full report:** `plan-round2-codex.md`
**Round counter:** `planReviewRounds=2`

Verification-only round. Every finding is either a prior fix that did not fully
land or a defect a fix introduced — none opened a new front. **All six accepted.**

| # | Finding | Fix applied |
|---|---|---|
| B1 | **A11 still false-green.** The eval-contract checker looked for parked modifiers only on promised titles, so an obsolete unpromised `.todo` survived, and `describe.skip('group', () => it('promised title', …))` slipped through because the wrapper's argument is not a promised title. | The check now scans for **any** `it/test/describe.todo/skip/fails` in `SUITE_FILES` and asserts the list is empty. Not "no parked promised title" — no parked test at all. |
| B2 | **A11 also false-RED.** Intake titles carry prefixes (`matchAttribution: …`) but the plan's sample suite split them across `describe('matchAttribution')` + a short `it`. `corpus.includes(title)` would fail once the `.todo`s were filled — and the gate's `promised-tests` row greps the same literal. | Added the **title-discipline rule**: the full promised title lives in the `it(...)` string; `describe` groups only. All nine sample titles rewritten. |
| B3 | **Fix-introduced race.** The candidate query, guard and index moved to `attributed_at`, but the final write CAS still tested `attributed_review_id IS NULL`. A handler that loaded a candidate before another attribution *and* a later review deletion would see a NULL id and overwrite permanent provenance. | CAS moved to `attributed_at IS NULL`. **All four sites now agree** — candidate query, enqueue guard, index predicate, CAS — and the code comment says so. |
| B4 | **A22 fixed in the intake only.** The plan still carried the rejected "no eligible row in the window → no enqueue" `.todo` and told the implementer to fill just two helper tests. | Task 4 now unparks all four `enqueueSolicitationAttribution:` titles plus the three `processReview:`/`importReview:` titles, and states explicitly that the out-of-window case **asserts the row IS written**. |
| B5 | **The 28 added titles had no completion step.** The tasks never created the helper-integration, process-review-integration or worker suites and kept the old counts. | Task 0 Step 2 is now a **file → titles → unparked-by** table covering all 54 titles across nine files. Every task's test step names the titles it unparks and the count it expects. |
| B6 | **A10 partial.** Task 3 still pointed at `batch-view.integration.test.ts` fixtures. | Corrected to `approval-system-halt.integration.test.ts` + `@/lib/shared/__tests__/helpers/schema-ready`, matching Task 0. |

## Also corrected in this pass, unprompted

- The Architecture paragraph and the layering section still described the old
  window-bounded guard and `attributed_review_id` marker. Both now match the code.
- The File-structure table said migration 114 carries "2 indexes". It carries **3**.
- Task 5's steps were numbered 4, 5, 5. Renumbered.
- The eval-contract test reads the **committed** intake copy under
  `docs/superpowers/plans/`, never the gitignored `.feature/intake.json` — the
  latter is absent on a CI checkout and the test would have failed there. This
  was point 4 of the orchestrator's own round-2 brief, fixed before the verdict.

## Verified: zero `it.todo` residue

`grep -c "it.todo"` over the plan returns **0**. Every obsolete parked block from
the 26-title draft is gone.

## Round 3 is the last

Per the workflow, after round 3 the loop stops: the remaining disagreement goes
to the owner with both positions, and their call substitutes for `APPROVED`.
