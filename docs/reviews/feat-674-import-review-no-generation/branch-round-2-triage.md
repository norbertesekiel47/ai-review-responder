# Branch review round 2 — verification-only triage (#674)

**Round:** 2 of 3 (`branchReviewRounds=2`)
**Scope:** verification-only — confirm round-1 fixes landed and introduced nothing new. No new fronts against unchanged code.
**Axes re-run:** adversarial + standards (the two that had accepted findings). Spec had none, so it was not re-run.

Reports: `branch-round-2-adversarial-verify.md` · `branch-round-2-standards-verify.md`

## Verdicts

| # | Axis | Sev | Finding | Verdict |
|---|---|---|---|---|
| V1 | standards | low | `assertSchemaReady` asserts 071 only; the code under test writes `agent_runs.parent_run_id` from **088** | **ACCEPT — FIXED** |
| V2 | adversarial | low | The plan's embedded Task 2 code listing still carries the **pre-correction** JSDoc, and the decision table still says "race" | **ACCEPT — FIXED** |

## Round-1 fixes: both verified

- **A1's corrected characterization — VERIFIED, and it came back stronger.** The
  verifier attacked the absolute claim "never drafted by any lane" and it held:
  `ci:outbox-seam` makes `enqueueGenerateResponse` the exhaustive enqueue set,
  and all five non-`process-review` call sites require a pre-existing `responses`
  row. The one owner-triggered path from a review id (`past-replies/draft`) is
  stopped by `edit-existing.ts:147-152`, which throws `ResponseChangedError` when
  no `posted` row exists. It also found the correction **understated** itself:
  all three Zernio lanes converge on `processReview`, not just backfill.
- **S2 — landed, placed correctly, but incomplete.** See V1.
- **Nothing new introduced — VERIFIED** on both axes. The `process-review.ts`
  diff since `b6d841f8` is comment-only (JSDoc), and the only other code change
  is the disclosed test fix.
- **D16 is a faithful record of the A2 decision — VERIFIED.** The verifier noted
  it states the problem *harder* than the original finding did.

## V1 — ACCEPT, fixed

Verified independently before accepting: `startOrGetActiveRun` binds
`agent_runs.parent_run_id` (`run-spine.ts:120`); that column is **not** in
migration 071; `MIGRATION_071_RUN_SPINE` declares only
`tables: ['agent_runs','agent_run_steps','agent_outcomes']` with no columns,
while `agent_runs.parent_run_id` is declared by
`MIGRATION_088_SOLICITATION_BATCH_EXECUTOR`.

So a database at head 071–087 would **pass** the assertion and then fail at the
first `it` with the raw `column "parent_run_id" does not exist` — precisely the
failure mode S2 was added to eliminate. My round-1 fix asserted what the suite
*reads* and missed what the code under test *writes*.

Fixed by asserting both requirements, matching `run-spine.integration.test.ts`'s
own 071 + 088 pairing. The comment now records why 088 is in the list, so it
does not look like an unrelated solicitation import.

## V2 — ACCEPT, fixed

The round-1 correction updated the Hazards section and the real JSDoc in
`src/lib/reviews/process-review.ts`, but the plan **embeds** the implementation
code, and that listing still carried the superseded race paragraph — 435 lines
below the corrected Hazards section, in the same file #675 is pointed at. The
decision table also still read "Cross-lane lost-draft **race** deferred to #675".

Both corrected. This is the same failure the round-1 finding was about, one level
up: a stale copy of a superseded hazard description is exactly what sends a #675
implementer after the wrong fix.

## Corrections to my own round-1 triage

Round 2 caught two overstatements in the reasoning I recorded. Both are noted
inline in `branch-round-1-triage.md`; neither changes a verdict:

1. **S1** — I cited the plan's "Do not add `beforeEach` isolation" line against a
   finding that proposed a `beforeAll` **hoist**. The citation doesn't answer the
   finding; the rejection rests on its second reason (hoisting makes test #1
   assert state produced outside itself).
2. **S4** — I claimed the signature change would ripple into the canonical-order
   binding test. It would not: that test asserts `typeof params[0] === 'string'`,
   which survives either signature. The rejection rests on the plan-lock alone.

## Carried to #675 (added this round)

4. A later owner-generated response opens a **second** run for the same review,
   fragmenting the audit trail — a secondary clause of adversarial finding A2 not
   carried into D16, though the same mechanic is stated in the shipped JSDoc.

## Untriaged appendix items (unrelated, not acted on)

Recorded so they are not lost, per the verification-only scope rule:

- The older `insertImportedReview` in `zernio-ingest-shared.ts` computes its own
  content hash inline.
- The flag-gated external-reply → Past-Replies-regenerate chain is the one route
  by which an imported review could consume LLM budget.
