# #1082 — the generation-exhaustion settlement writes its Refusals in one statement

Ticket: <https://github.com/RepWorth/ai-review-responder/issues/1082>
Intake: `docs/superpowers/plans/perf-1082-exhaustion-refusal-batch-intake.json` (locked, owner sign-off 2026-09-03)
Audit that found it: `docs/reviews/refusal-ledger-audit/quality.md`

## Lane note — why there is no Codex plan-skeptic round

This branch is SIZE = small, RISK = high. `.claude/commands/feature.md` routes
that pair to an abbreviated lane: intake with sign-off → setup → implement in
the root session → step 5 gate → the full step 7 review wave including the
red-team pass → the high-risk ship lane. The step 3 plan gate is not in that
enumeration, and the decisions a plan-skeptic round would test are already
locked in the intake: 8 invariants, 11 resolved edge cases, 7 non-goals. The
full review wave and the red-team pass still run.

## The defect

> **CITATIONS INTO FILES THIS BRANCH EDITS ARE BY SYMBOL; A LINE CITATION IS
> ONLY EVER USED FOR A FILE THIS BRANCH DOES NOT TOUCH.** That is the rule,
> and the flat "no line numbers anywhere" version of this banner was itself
> false when written — two bare line citations survived it (red-team round 2).
> The first version of this plan cited `path:line` throughout; eight of those
> went stale inside this branch's own commits, and `prevalidate-plan.py` passed
> them because it resolves FILES, not lines. Note the corollary: a plan with
> zero line citations makes that check report "0 citations checked", so its
> PASS proves nothing either. The #1080 arch-review row records the identical
> failure class. Symbols move with the code; line numbers do not.

`settleGenerationExhaustion` (`src/lib/solicitation/ask-generation.ts`) fills
every un-rendered `send` ask in the batch, then records one Refusal per fill.
Both writes sit in one `sql.begin` that already holds the per-Business advisory
lock and the `solicitation_batches` row lock.

```
for (const hole of holes) {
  await insertOutreachRender(tx, {…})
  await recordOutreachWithheldRefusal(…)   ← single-row, per iteration
}
```

`writeRefusalEvents` (`src/lib/refusals/write.ts`) is a real set insert over
`jsonb_to_recordset` and its docblock names this exact shape as the reason it
exists. It was not imported at this call site.

**HOW BIG IS `holes`? 25, NOT 5,000 — and this plan shipped with it wrong.**
The first version said `loadCandidateWindow` bounds a batch at `MAX_DATA_ROWS`
= 5,000. That bounds the CANDIDATE WINDOW. `holes` filters
`ask.status = 'send'`; `commitAskDecisions` writes `status = decision.decision`
and `evaluateBatch` (`restraint-policy.ts`) keeps at most `BATCH_CAP` = 25 send
decisions per batch, while the sole `UPDATE solicitation_asks` touches
`agent_run_id` and never `status`. So at most 25 asks in a batch can ever be a
hole, and the saving is at most 24 round trips rather than 4,999 — a 200-fold
overstatement, carried in from the `ask_withheld` lane where withheld
candidates genuinely are uncapped. The reason to batch survives the correction;
the size of the number does not.

The other two `recordOutreachWithheldRefusal` sites are NOT loops:
`persistChildRender` and `regenerateAsk` each settle one
render per transaction. This branch does not touch them.

## What stays out

`insertOutreachRender` keeps its per-hole call. Batching it too would make a
second writer of `solicitation_outreach` against that module's own docblock,
which names `insertOutreachRender` and `supersedeLiveRender` as the only two.
Owner confirmed the ticket's scope on 2026-09-03. The residual — N inserts
still inside the lock window — is filed as a follow-up at step 8.

## Tracers

Two vertical slices. T1 blocks T2.

### T1 — the eval: both arms are visible to the unit suite, and four tests pin the shape

The unit suite (`src/lib/solicitation/__tests__/ask-generation.test.ts`) mocks
`@/lib/refusals/write` but names only `writeRefusalEvent`. That is the trap in
this change and T1 exists to disarm it before T2 writes a line:

- `refusalCalls()` reads `mocks.writeRefusalEvent.mock.calls`. After T2 the W4
  lane calls the set arm instead, so this helper must fold BOTH arms or the
  matrix test `'all four render writers carry the paired outreach's tenant
  category subject and occurred_at shape'` silently stops covering W4.
- Four assertions spell `expect(mocks.writeRefusalEvent).not.toHaveBeenCalled()`.
  A negative assertion naming one arm of a two-arm writer is the
  fragile-assertion class this repo's red-team pass hunts. Each must name both
  arms.

Steps:

1. Add `writeRefusalEvents` to the `mocks` object and to the
   `vi.mock('@/lib/refusals/write', …)` factory, and give it a
   `mockResolvedValue(undefined)` in the same `beforeEach` as its sibling.
2. Fold `refusalCalls()` to concatenate the single-row calls with the set
   arm's flattened input arrays, preserving call order.
3. Widen the four negative assertions to cover both arms
   (`expectNoRefusalWrite`), and the mapping test's mid-test
   `mocks.writeRefusalEvent.mockClear()` calls likewise (`clearRefusalCalls`) —
   a one-armed clear leaves an earlier phase's set call sorting ahead of the
   current phase's.
4. Author the four `tests_to_add` titles verbatim.

Honest note on red: of the four, only test 1 fails before T2. Tests 2, 3 and 4
are regression guards for edge cases the intake resolved — they are green both
before and after, and their value is that they stay green. Test 1 is the
driver. The matrix test is the strongest guard of the four writers' shape and
goes red if step 2 above is skipped.

Tests, verbatim from the intake:

| # | Title | Suite |
|---|---|---|
| 1 | a generation exhaustion records every hole's Refusal in ONE writeRefusalEvents call, never one call per hole | unit |
| 2 | a generation exhaustion that finds no holes issues no Refusal write through either arm | unit |
| 3 | a stale generation-exhaustion attempt writes no Refusal through either the single-row or the set arm | unit |
| 4 | a generation exhaustion that aborts after its fills records neither the outreach rows nor their refusal_events rows | integration |

Test 4 uses `abortingExecutor` from
`src/lib/shared/__tests__/helpers/abort-injection.ts` — the sanctioned way to
force an abort in a live-DB suite, and the reason the suite may not reach for a
temporary constraint.

The existing integration guard
`'a generation exhaustion writes one refusal_events row per outreach hole it
settles as withheld'` — one `refusal_events` row per hole, id SETS compared,
not counts — is untouched. It is the behavioural net under T2 and must stay
green unedited.

Test 4 is NOT the only guard on its claim, and the plan said otherwise until
red team measured it. `'a refusal written by each render writer does not
survive a later rollback of its outreach transaction'` already settles W4 under
`abortAfterLedgerWrite` and kills the same mutation. Test 4 earns its place on
two differences that are the batching change's own: that case aborts ONE hole
with a JS throw; test 4 aborts TWO with a real Postgres error (22012) that
leaves the transaction in aborted state.

### T2 — the implementation: one mapping owner, two arms, one statement

1. Extract a pure input builder from `recordOutreachWithheldRefusal`:

   ```ts
   function outreachWithheldRefusalInput(
     ids: { accountId: string; businessId: string },
     outreachId: string,
     reason: RenderWithholdReason,
     decidedAt: Date,
   ): WriteRefusalEventInput
   ```

   It is the single reader of `OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES`
   after this change. `recordOutreachWithheldRefusal` keeps its docblock — the
   lane's mapping contract has one place, and the builder does not become a
   second one. Its call-site census must be corrected in the SAME change: it
   said "THREE PHYSICAL CALL SITES" and this branch removes one of them.

2. `recordOutreachWithheldRefusal` becomes a one-line call:
   `writeRefusalEvent(tx, outreachWithheldRefusalInput(…))`. Its two callers,
   inside `persistChildRender` and `regenerateAsk`, do not change.

   It is KEPT rather than inlined, and branch review raised the alternative:
   as a pure pass-through it could be deleted and both sites could spell
   `writeRefusalEvent(tx, outreachWithheldRefusalInput(…))` directly. Rejected
   because half of its docblock — the no-catch rule, migration 116's CHECKs,
   the `dispatch.ts` counterpart — describes the WRITE and would sit wrongly on
   a pure value builder that performs none.

3. In `settleGenerationExhaustion`'s loop, collect
   `WriteRefusalEventInput` values instead of awaiting a write per iteration,
   then issue one `writeRefusalEvents(tx, refusals)` after the loop closes and
   before `recordGenerationSteps`. Carry a comment naming the lock window, in
   the shape `commitAskDecisions` in `batch-builder.ts` already uses — and
   state the bound as `BATCH_CAP`, not `MAX_DATA_ROWS`.

   No private `recordOutreachWithheldRefusals` wrapper: it would have one
   caller, which the repo working rules ban.

4. Do NOT touch `src/lib/refusals/write.ts`. Both arms already ship.

Precedent followed: the `writeRefusalEvents` call inside `commitAskDecisions`
(`src/lib/solicitation/batch-builder.ts`), the repo's only other call site —
array built at the call site, one call, a comment naming the lock window it
protects.

## Verification

`bash scripts/verify-gate.sh --review` from the worktree root. `db_touching`
is true, so the integration rows must RUN, not SKIP: a gate carrying the
live-DB SKIP warning is not review-ready for this branch.
