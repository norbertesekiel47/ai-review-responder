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

`settleGenerationExhaustion` (`src/lib/solicitation/ask-generation.ts:1742`)
fills every un-rendered `send` ask in the batch, then records one Refusal per
fill. Both writes sit in one `sql.begin` that already holds the per-Business
advisory lock and the `solicitation_batches` row lock.

```
src/lib/solicitation/ask-generation.ts:1824   for (const hole of holes) {
src/lib/solicitation/ask-generation.ts:1827     await insertOutreachRender(tx, {…})
src/lib/solicitation/ask-generation.ts:1851     await recordOutreachWithheldRefusal(…)   ← single-row, per iteration
```

`holes` is bounded only by the batch, and `loadCandidateWindow` bounds a batch
at `MAX_DATA_ROWS` = 5,000. `writeRefusalEvents`
(`src/lib/refusals/write.ts:584`, docblock from `:547`) is a real set insert over
`jsonb_to_recordset` and its docblock names this exact shape as the reason it
exists. It is not imported at this call site.

The other two `recordOutreachWithheldRefusal` sites are NOT loops:
`persistChildRender` (`:832`) and `regenerateAsk` (`:1632`) each settle one
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

- `refusalCalls()` (`:1232`) reads `mocks.writeRefusalEvent.mock.calls`. After
  T2 the W4 lane calls the set arm instead, so this helper must fold BOTH arms
  or the "all four render writers" matrix test (`:1399`) silently stops
  covering W4.
- Four assertions spell `expect(mocks.writeRefusalEvent).not.toHaveBeenCalled()`
  (`:1485`, `:1502`, `:1518`, `:1528`). A negative assertion naming one arm of
  a two-arm writer is the fragile-assertion class this repo's red-team pass
  hunts. Each must name both arms.

Steps:

1. Add `writeRefusalEvents` to the `mocks` object (`:40`) and to the
   `vi.mock('@/lib/refusals/write', …)` factory (`:98`), and give it a
   `mockResolvedValue(undefined)` in the same reset block as its sibling
   (`:271`).
2. Fold `refusalCalls()` to concatenate the single-row calls with the set
   arm's flattened input arrays, preserving call order.
3. Widen the four negative assertions to cover both arms.
4. Author the four `tests_to_add` titles verbatim.

Honest note on red: of the four, only test 1 fails before T2. Tests 2, 3 and 4
are regression guards for edge cases the intake resolved — they are green both
before and after, and their value is that they stay green. Test 1 is the
driver. The matrix test at `:1399` is the strongest guard of the four writers'
shape and goes red if step 2 above is skipped.

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

The existing integration guard at
`src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1461` — one
`refusal_events` row per hole, id SETS compared, not counts — is untouched. It
is the behavioural net under T2 and must stay green unedited.

### T2 — the implementation: one mapping owner, two arms, one statement

1. Extract a pure input builder from `recordOutreachWithheldRefusal`
   (`:691`):

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
   second one.

2. `recordOutreachWithheldRefusal` becomes a one-line call:
   `writeRefusalEvent(tx, outreachWithheldRefusalInput(…))`. Its two callers
   (`:832`, `:1632`) do not change.

3. In `settleGenerationExhaustion`'s loop, collect
   `WriteRefusalEventInput` values instead of awaiting a write per iteration,
   then issue one `writeRefusalEvents(tx, refusals)` after the loop closes and
   before `recordGenerationSteps`. Carry a comment naming the lock window, in
   the shape `batch-builder.ts:655-668` already uses.

   No private `recordOutreachWithheldRefusals` wrapper: it would have one
   caller, which the repo working rules ban.

4. Do NOT touch `src/lib/refusals/write.ts`. Both arms already ship.

Precedent followed: `src/lib/solicitation/batch-builder.ts:670`, the repo's
only other `writeRefusalEvents` call site — array built at the call site, one
call, a comment naming the lock window it protects.

## Verification

`bash scripts/verify-gate.sh --review` from the worktree root. `db_touching`
is true, so the integration rows must RUN, not SKIP: a gate carrying the
live-DB SKIP warning is not review-ready for this branch.
