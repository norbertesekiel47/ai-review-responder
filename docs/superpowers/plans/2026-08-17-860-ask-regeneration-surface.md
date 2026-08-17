# Per-ask Ask regeneration surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make per-ask **Ask regeneration** reachable for the owner on a built **Solicitation batch** — a route, a per-ask control, its 3/day budget counter — and close #629 deviation **D3** by refusing regeneration once **Owner approval** is recorded.

**Architecture:** `requestAskRegeneration` joins `approveBatch`/`haltBatch` as a third owner verb in `src/lib/solicitation/approval.ts`, reusing `lockBatchForAction` and enqueueing through the existing `enqueueGenerateSolicitationAsks(tx, { askId })` helper in the same transaction as an `ask_regeneration_requested` run step. A new POST route is the fourth adapter at the `withScopedBatch` seam. `regenerateAsk`'s regenerable-state set narrows to `built` alone, which is the D3 decision and makes byte-for-byte approval unconditional. The read model gains a server-authoritative in-flight fact and a per-ask budget Record; the panel renders a row control and polls while a regeneration is in flight.

**Tech Stack:** TypeScript, Next.js 16 App Router, Postgres.js, BullMQ + transactional outbox, Redis (Upstash) for budget counters, Vitest + Testing Library, fast-check.

---

## Locked decisions this plan implements

| # | Decision | Where recorded |
|---|---|---|
| 1 | **Option (b)**: regeneration is refused once `approved_at` is set; `REGENERABLE_BATCH_STATES` narrows to `built` | ADR 0020 (Task 2), narrows amendment **B2** |
| 2 | `requestAskRegeneration` is a **third verb in `approval.ts`**, not a new module | Task 4 |
| 3 | The route **reuses** `enforceDashboardRegenRateLimit` — one owner wallet, three entrypoints | Task 4 |
| 4 | The actor rides an **`ask_regeneration_requested` run step**, never an outbox payload | Task 4 |
| 5 | Async feedback is **server-authoritative** (`SendLaneView.regeneratingAskId`) | Task 5 |
| 6 | The control appears on **`rendered` rows in `approvable` mode only**, disabled when deselected | Task 6 |
| 7 | The budget peek is a **second named door** in `tracker.ts`, merged into the read model | Tasks 3, 5 |
| 8 | Glossary coins **Ask regeneration**; **Owner approval** drops its conditional | Task 2 |

## Coordination — read before touching `approval.ts` or `batch-view.ts`

Merge order is **`codex/859-tenant-scope-subqueries` before this branch** (deviations D1). #859 collapses `lockBatchForAction`'s two-statement split back into one and `approveBatch`'s readiness anti-join back into `NOT EXISTS`. `lockBatchForAction`'s signature does not change, so Task 4's reuse is unaffected.

- **Before starting Task 4 or 5**, check whether #859 has merged to `main`. If it has, rebase first and write the new statements in the post-fix convention (correlated subqueries are legal again).
- If it has not, write them in the scanner-shaped form this file currently uses. #859 already reverts the #629 workarounds; one more is marginal.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/solicitation/ask-generation.ts` | Worker-side re-roll. Owns `isRegenerableBatchState` — the D3 decision in code | 2 |
| `docs/adr/0020-regeneration-refused-after-approval.md` | Why B2 was narrowed | 2 |
| `CONTEXT.md` | **Ask regeneration** coined; **Owner approval** rewritten | 2 |
| `src/lib/costs/tracker.ts` | Budget doors. Gains `peekAskRegenBudgetBatch` over an extracted primitive | 3 |
| `src/lib/shared/dashboard-regen-rate-limit.ts` | 429 shaping. Gains `enforceAskRegenBudget` | 3 |
| `src/lib/agents/run-spine.ts` | Step-key vocabulary. Gains `ask_regeneration_requested` | 4 |
| `src/lib/solicitation/approval.ts` | The three owner verbs. Gains `requestAskRegeneration` | 4 |
| `src/app/api/dashboard/solicitation/batch/regenerate/route.ts` | **New.** Fourth adapter at the `withScopedBatch` seam | 4 |
| `src/lib/solicitation/batch-view.ts` | Read model. Gains `regeneratingAskId` + `regenBudgets` | 5 |
| `src/app/(authenticated)/dashboard/requests/AskList.tsx` | Row control + counter | 6 |
| `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx` | Projection, write, exclusion pruning | 6 |
| `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx` | Poll trigger | 6 |
| `src/app/(authenticated)/dashboard/requests/requests.css` | Row-control styles | 6 |

## Task graph

```
Task 1 (eval, alone)
   ├── Task 2 (D3 narrowing + docs)  ─┐  mutually independent
   └── Task 3 (budget doors)         ─┘  → may run in parallel
                                        │
              ┌─────────────────────────┴─────────────────────────┐
         Task 4 (verb + route)                          Task 5 (read model)
         needs 1, 3                                     needs 1, 3
         disjoint files → parallel with 5               disjoint files → parallel with 4
              └─────────────────────────┬─────────────────────────┘
                                   Task 6 (panel)
                                   needs 4, 5
```

Task 1 runs **alone** — its completion is the enforcement spot check (step 4).

---

## Task 1: The eval task — all 32 promised tests, failing

**Files:**
- Modify: `src/lib/solicitation/__tests__/ask-generation.test.ts`
- Modify: `src/lib/solicitation/__tests__/approval.integration.test.ts`
- Modify: `src/lib/costs/__tests__/tracker.test.ts`
- Modify: `src/lib/solicitation/__tests__/batch-view.test.ts`
- Modify: `src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts`
- Modify: `src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx`

The verify gate's `promised-tests` row matches `tests_to_add` titles **verbatim and file-wide**. Copy each title character-for-character from `.feature/intake.json`; do not re-word.

- [ ] **Step 1: Add the four `ask-generation.test.ts` titles as `it.todo`**

Inside the existing `describe('regenerateAsk', …)` block:

```ts
  it.todo('refuses a regenerate once the batch is approved, leaving the live render untouched');
  it.todo('refuses a regenerate in veto_window and in sending, the two states amendment B2 previously allowed');
  it.todo('aborts the swap when the batch is approved between the pre-check and the locked re-check');

  describe('invariants', () => {
    it.todo('property: regeneration is accepted for the built batch state and refused for every other');
  });
```

- [ ] **Step 2: Add the six `approval.integration.test.ts` titles as `it.todo`**

Add a sibling `describe` after `describe('haltBatch', …)`:

```ts
  describe('requestAskRegeneration', () => {
    it.todo('enqueues one generate_solicitation_asks outbox row carrying the ask id for a built batch');
    it.todo('records ask_regeneration_requested on the send parent with the requesting owner');
    it.todo('refuses a regenerate for an approved batch without writing an outbox row');
    it.todo('refuses a regenerate for an ask whose current attempt is withheld');
    it.todo('returns already_in_flight when a generation is already in flight for the batch');
    it.todo('refuses a regenerate for a batch belonging to another tenant');
  });
```

- [ ] **Step 3: Add the two `tracker.test.ts` titles as `it.todo`**

```ts
describe('peekAskRegenBudgetBatch', () => {
  it.todo('peekAskRegenBudgetBatch reads the ask-keyed counter and never the review-keyed one');
  it.todo('peekAskRegenBudgetBatch resolves to an empty map when Redis is unavailable');
});
```

- [ ] **Step 4: Add the three `batch-view.test.ts` titles as `it.todo`**

```ts
  it.todo('reports the ask id of an in-flight per-ask regeneration on the send lane');
  it.todo('reports no in-flight regeneration for a whole-batch generation row');
  it.todo('carries the per-ask regenerate budget on the send lane, omitting asks whose counter is unknown');
```

- [ ] **Step 5: Add the six `approval-routes.test.ts` titles as `it.todo`**

```ts
describe('POST /api/dashboard/solicitation/batch/regenerate', () => {
  it.todo('POST regenerate enqueues for a built batch and answers 202');
  it.todo('POST regenerate answers 409 when the batch is already approved');
  it.todo('POST regenerate answers 429 when the ask has spent its daily regenerate budget');
  it.todo('POST regenerate answers 409 when a regeneration is already in flight for the batch');
  it.todo('POST regenerate answers 404 when the body carries no valid ask id');
  it.todo('POST regenerate is refused when SOLICITATION_SEND_ENABLED is off');
});
```

- [ ] **Step 6: Add the eleven `approval-panel.test.tsx` titles as `it.todo`**

```ts
describe('regenerate control', () => {
  it.todo('offers a regenerate control on every rendered ask while the batch is approvable');
  it.todo('offers no regenerate control on a withheld ask');
  it.todo('offers no regenerate control once the batch is approved');
  it.todo('disables the regenerate control on an ask the owner has deselected');
  it.todo('renders the per-ask regenerate counter and disables the control once the budget is spent');
  it.todo('renders no regenerate counter when the budget is unknown');
  it.todo('disables approve and every regenerate control while a regeneration is in flight');
  it.todo('reports that nothing changed when a regeneration settles without a new attempt');
  it.todo('drops a stale exclusion when a regenerated ask replaces its outreach id');
  it.todo('says the owner may ask for a new version but may not write one');

  describe('invariants', () => {
    it.todo('property: pruning an exclusion set never keeps an id absent from the sendable rows');
  });
});
```

- [ ] **Step 7: Extend the `sendLane()` fixture so it compiles against Task 5's shape**

`approval-panel.test.tsx` builds `SendLaneView` literals. Task 5 adds two required fields; add them to the fixture NOW so Task 6 does not have to touch this helper again:

```ts
function sendLane(overrides: Partial<SendLaneView> = {}): SendLaneView {
  return {
    batchState: 'built',
    ready: true,
    pendingRenders: 0,
    approvedAt: null,
    vetoDeadlineAt: null,
    haltedAt: null,
    haltReason: null,
    moderationWithheld: 0,
    regeneratingAskId: null,
    regenBudgets: {},
    ...overrides,
  };
}
```

This will not typecheck until Task 5 lands — that is correct for an eval task. Mark the two added lines with `// @ts-expect-error until Task 5 widens SendLaneView` if the repo's typecheck gate blocks the commit; remove both markers in Task 5.

- [ ] **Step 8: Run the suites and confirm 32 todos, 0 failures**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-860-ask-regeneration-surface
pnpm vitest run src/lib/solicitation/__tests__/ask-generation.test.ts src/lib/costs/__tests__/tracker.test.ts src/lib/solicitation/__tests__/batch-view.test.ts src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts 'src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx'
```

Expected: all pass, with **26 todo** across these five files (the six integration todos need `TEST_DATABASE_POOL_URL` and run in the live-DB project).

- [ ] **Step 9: Verify every promised title exists verbatim**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-860-ask-regeneration-surface
jq -r '.tests_to_add[]' .feature/intake.json | while IFS= read -r t; do
  grep -rqF "$t" src || echo "MISSING: $t"
done
```

Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "test(860): eval task — 32 failing/todo tests for the ask regeneration surface"
```

---

## Task 2: The D3 decision — regeneration is refused after approval

**Blocking edges:** Task 1.
**Turns green:** titles 1–4.

**Files:**
- Modify: `src/lib/solicitation/ask-generation.ts:1215-1232` (the state set), `:1343`, `:1409`, `:10` (module header), `:1356-1366` (the r6 comment)
- Modify: `src/lib/solicitation/__tests__/ask-generation.test.ts`
- Create: `docs/adr/0020-regeneration-refused-after-approval.md`
- Modify: `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` (§B2)
- Modify: `CONTEXT.md`

- [ ] **Step 1: Replace the state set with a predicate**

Delete lines 1215–1226 (the `AMEND B2` doc comment and `REGENERABLE_BATCH_STATES`) and put in their place:

```ts
// ── regenerateAsk ────────────────────────────────────────────────────────────

/**
 * A batch is regenerable in exactly ONE state: `built`, before Owner approval.
 *
 * This NARROWS amendment B2, which permitted post-approval regeneration of
 * still-`rendered` rows (`approved` / `veto_window` / `sending`). #628 built
 * that deliberately and #629 accepted it (deviation D3) only because no owner
 * entry point enqueued a per-ask regenerate — the path was unreachable in the
 * shipped surface. #860 builds that entry point, so the choice had to be made
 * rather than inherited.
 *
 * ADR 0020 records it. The short version: refusing after approval makes "what
 * was approved is byte-for-byte what sends" UNCONDITIONAL, where the
 * alternative — re-opening approval for the superseded ask — needs per-ask
 * approval state the schema does not have (`approved_at` is a BATCH column),
 * plus a release predicate #630 has not written yet.
 *
 * A predicate rather than a `ReadonlySet`: with one member a Set is a lookup
 * table for an equality check, and both call sites want the same question asked
 * the same way.
 */
function isRegenerableBatchState(state: BatchState): boolean {
  return state === 'built';
}
```

- [ ] **Step 2: Update both call sites**

At `:1343` (pre-check):

```ts
  const preState = deriveBatchState(ctx.lifecycle, new Date());
  if (!isRegenerableBatchState(preState)) {
    await refuse('batch_not_regenerable', { batch_state: preState });
    return;
  }
```

At `:1409` (locked re-check inside the swap):

```ts
      const lockedState = deriveBatchState(batchRow, new Date());
      if (!isRegenerableBatchState(lockedState)) {
        throw new RegenSwapAbort(`batch_not_regenerable:${lockedState}`);
      }
```

- [ ] **Step 3: Fix the two stale comments that still promise B2's old behaviour**

Module header, line 10:

```ts
 *  - `regenerateAsk` — the per-ask LLM re-roll (SPEC §8.2, AMEND B2 as narrowed
 *    by ADR 0020: `built` only), with NO
```

The `current_attempt_not_rendered` comment (~:1356):

```ts
    // SPEC §8.2 r6: blocked is terminal — a withheld row cannot be re-rolled
    // (that would launder the fail-closed lint). A released row
    // (queued/sending/sent) is never superseded either; since ADR 0020 that is
    // unreachable — a `built` batch has released nothing — and it is kept as
    // the second layer rather than the first.
```

- [ ] **Step 4: Write the three example tests**

In `describe('regenerateAsk', …)`, replacing the todos:

```ts
  it('refuses a regenerate once the batch is approved, leaving the live render untouched', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow({ approved_at: new Date(Date.now() - 60_000) })]),
    );

    await regenerateAsk(sql, REGEN_INPUT);

    // ADR 0020: approved bytes are final. No spend, no supersede, no insert —
    // and the outbox attempt still completes, because a refusal is a SUCCESS.
    expect(mocks.runLlmTask).not.toHaveBeenCalled();
    expect(mocks.supersedeLiveRender).not.toHaveBeenCalled();
    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledTimes(1);
  });

  it('refuses a regenerate in veto_window and in sending, the two states amendment B2 previously allowed', async () => {
    const approvedAt = new Date(Date.now() - 60_000);

    // veto_window: approved, deadline still ahead.
    sqlReturnQueue.push(
      mkTaggedResult([
        contextRow({
          approved_at: approvedAt,
          veto_deadline_at: new Date(Date.now() + 10 * 60_000),
        }),
      ]),
    );
    await regenerateAsk(sql, REGEN_INPUT);

    // sending: the drip has started.
    sqlReturnQueue.push(
      mkTaggedResult([
        contextRow({ approved_at: approvedAt, sending_started_at: approvedAt }),
      ]),
    );
    await regenerateAsk(sql, REGEN_INPUT);

    expect(mocks.runLlmTask).not.toHaveBeenCalled();
    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledTimes(2);
  });

  it('aborts the swap when the batch is approved between the pre-check and the locked re-check', async () => {
    // Pre-checks see `built`; the locked re-read sees `approved`. This is the
    // owner clicking regenerate and then approving before the worker ran.
    enqueuePreChecks('rendered');
    sqlReturnQueue.push(
      mkTaggedResult([contextRow({ approved_at: new Date() })]),
    );

    await regenerateAsk(sql, REGEN_INPUT);

    // The replacement was generated (spend happened, and is audited) but the
    // swap rolled back: nothing supersedes an approved render.
    expect(mocks.runLlmTask).toHaveBeenCalled();
    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
    expect(mocks.recordChildApiCost).toHaveBeenCalled();
  });
```

- [ ] **Step 5: Write the property test**

```ts
  describe('invariants', () => {
    it('property: regeneration is accepted for the built batch state and refused for every other', () => {
      const ALL_STATES: BatchState[] = [
        'pending', 'built', 'approved', 'veto_window',
        'sending', 'closed', 'halted', 'expired',
      ];

      fc.assert(
        fc.property(fc.constantFrom(...ALL_STATES), (state) => {
          expect(isRegenerableBatchState(state)).toBe(state === 'built');
        }),
      );
    });
  });
```

`isRegenerableBatchState` is module-private. Export it from `ask-generation.ts` (`export function isRegenerableBatchState`) with a one-line comment saying the export exists for the invariant test — the alternative is asserting the decision through six layers of SQL mock, which tests the mocks. Confirm `ALL_STATES` matches `BatchState`'s union exactly by importing the type and letting tsc check the annotation.

- [ ] **Step 6: Run the suite**

```bash
pnpm vitest run src/lib/solicitation/__tests__/ask-generation.test.ts
```

Expected: PASS, 0 todo in this file.

- [ ] **Step 7: Write ADR 0020**

Create `docs/adr/0020-regeneration-refused-after-approval.md`, following the shape of `docs/adr/0019-kpi-review-time-anchor.md`. It must state:

- **Context** — B2 permits post-approval per-ask regeneration; #628 implemented it; #629 D3 accepted it as unreachable and made resolving it binding on #860.
- **Decision** — regeneration is refused once `approved_at` is set; `built` is the only regenerable state.
- **Consequences** — byte-for-byte becomes unconditional; the owner's post-approval recourse is the **Halt latch**; #630's releaser never has to coordinate row locks with a swap that could cancel a row it is about to release; an owner who dislikes one message after approving must stop the whole batch.
- **Rejected** — re-opening approval per ask: needs per-ask approval state (`approved_at` is a batch column), a partial-approval state machine with the veto clock running, and a release predicate in the unbuilt #630.
- **Amends** — B2's second bullet, last sentence.

- [ ] **Step 8: Strike the narrowed sentence in the amendments spec**

In `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` §B2, replace the final sentence of the second bullet:

```markdown
  ~~Regeneration is possible only while the batch is un-approved or (post-
  approval) for `rendered` rows the owner has not excluded — a released
  (`queued`/`sending`/`sent`) row is never superseded.~~
  **NARROWED by ADR 0020 (#860):** regeneration is possible **only while the
  batch is un-approved** (`built`). The post-approval clause is struck. #860
  built the owner entry point this amendment presumed, and shipping it with the
  post-approval clause live would have made the byte-for-byte approval contract
  conditional in the shipped product rather than only on paper (#629 D3).
```

- [ ] **Step 9: Update `CONTEXT.md` — rewrite **Owner approval**, coin **Ask regeneration****

In the **Owner approval** entry, replace the trailing conditional sentence ("The byte-for-byte guarantee is **conditional** … refused once `approved_at` is set.") with:

```markdown
The byte-for-byte guarantee is **unconditional**: amendment B2 once permitted per-ask regeneration after approval, and ADR 0020 (#860) struck that — `regenerateAsk` refuses in every state but `built`, so no path replaces approved bytes. The owner's post-approval recourse is the **Halt latch**, not a rewrite.
```

Add the new term immediately after **Ask exclusion**:

```markdown
- **Ask regeneration**: the owner asking for a new LLM draft of ONE rendered ask — `regenerateAsk` supersedes the live **Outreach row** (`cancelled`/`superseded`) and inserts its replacement at `attempt_no + 1` in the same transaction, so rejected copy stays auditable and the one-live-attempt index makes the swap atomic. It is **pre-approval only** (ADR 0020, narrowing amendment B2): `built` is the only regenerable **Batch state**, which is what makes **Owner approval**'s byte-for-byte guarantee unconditional. Bounded at **3 per ask per day**, charged per *logical request* (the `job_outbox` row id, so BullMQ replays are free) and enforced in the WORKER — an API-only limiter is bypassable via outbox replay, so the route's check is advisory and fails open while the worker's Lua INCR is authoritative. **A blocked ask is never regenerable** (spec §8.2 r6): re-rolling a `withheld` row would launder the fail-closed lint, and clicking three times to escape an `incentive_language` block is the same laundering as an automatic retry, only slower. The replacement inserts **unconditionally of its own verdict**, so a withheld replacement leaves the ask with no live render — terminal for this batch, and the contact stays a candidate for a later one. At most **one regeneration is in flight per batch**, because the enqueue dedups on `(topic, aggregate_id = batchId)`; that is also why "regenerate all" cannot exist as a fan-out. Distinct from **Ask exclusion**, which removes a message, and from owner editing, which D22 forbids outright — the owner may ask for new bytes, never write them. _Avoid_: edit, rewrite, redraft, retry, re-roll. *(coined in #860; `regenerateAsk` in `src/lib/solicitation/ask-generation.ts`, `requestAskRegeneration` in `src/lib/solicitation/approval.ts`)*
```

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat(860): regeneration is refused after approval — ADR 0020 narrows B2 to built-only"
```

---

## Task 3: The budget doors

**Blocking edges:** Task 1. **Independent of Task 2** — may run in parallel.
**Turns green:** titles 11–12.

**Files:**
- Modify: `src/lib/costs/tracker.ts` (the `peekRegenBudgetBatch` block)
- Modify: `src/lib/shared/dashboard-regen-rate-limit.ts`
- Modify: `src/lib/costs/__tests__/tracker.test.ts`

- [ ] **Step 1: Check whether any consumer asserts the peek failure log's `peek` field**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-860-ask-regeneration-surface
grep -rn "peek: 'batch'\|peek: \"batch\"\|regen_budget_peek_failed" src worker scripts
```

If only `tracker.ts` and its test appear, Step 2's rename of that field value is safe. If any other consumer matches on `'batch'`, keep `'batch'` for the review door and use `'ask'` for the new one, and say so in a comment.

- [ ] **Step 2: Extract the peek primitive and add the second door**

Replace the body of `peekRegenBudgetBatch` (keeping its whole doc comment, which is the fail-open contract, and re-pointing it at the primitive):

```ts
/**
 * The shared MGET-with-fail-open primitive behind both peek doors. One
 * mechanism, two named entry points — the same shape `enforceRegenBudget`
 * already gives the two ENFORCE doors in this file, and this is its second
 * use, which is when the extraction is earned rather than speculative.
 *
 * `keyFor` is what decides which per-subject daily counter is read; nothing
 * else differs between the doors.
 *
 * NEVER REJECTS. `getCacheRedis()` is called inside the try, so a synchronous
 * throw from it is caught here too, and callers need no catch of their own.
 */
async function peekBudgetBatch(
  subjectIds: readonly string[],
  keyFor: (subjectId: string) => string,
  peek: 'review' | 'ask',
): Promise<Map<string, RegenBudgetStatus>> {
  const out = new Map<string, RegenBudgetStatus>();
  if (subjectIds.length === 0) return out;

  let raw: (string | null)[];
  try {
    const keys = subjectIds.map(keyFor);
    raw = await getCacheRedis().mget(...keys);
  } catch (err) {
    createWorkerLogger('[RegenBudgetPeek]').warn({
      event: 'regen_budget_peek_failed',
      peek,
      subject_count: subjectIds.length,
      reason: err instanceof Error ? err.message : 'unknown',
    });
    return out;
  }

  subjectIds.forEach((subjectId, i) => {
    const parsed = Number.parseInt(raw[i] ?? '', 10);
    const used = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    out.set(subjectId, {
      used,
      limit: MAX_REGEN_PER_SUBJECT_PER_DAY,
      remaining: Math.max(0, MAX_REGEN_PER_SUBJECT_PER_DAY - used),
    });
  });

  return out;
}

export async function peekRegenBudgetBatch(
  reviewIds: readonly string[],
): Promise<Map<string, RegenBudgetStatus>> {
  return peekBudgetBatch(reviewIds, regenBudgetKey, 'review');
}

/**
 * The per-ASK daily cap's advisory peek (#860) — the send lane's counterpart to
 * `peekRegenBudgetBatch`. Keyed `regen:ask:{askId}:{date}` via
 * `askRegenBudgetKey`, so review and ask counters never collide.
 *
 * Two callers: the Requests read model, which needs one counter per rendered
 * ask on the batch, and the regenerate route, which passes exactly one id.
 * Read-only — no INCR, no eval, no LLM spend.
 *
 * FAILS OPEN, exactly like the review door: an outage yields an EMPTY map, and
 * a MISSING entry means UNKNOWN, never "0 remaining". Inverting that would
 * disable every Regenerate control during an Upstash outage. The authoritative
 * gate stays the worker's `checkAskRegenBudget`.
 */
export async function peekAskRegenBudgetBatch(
  askIds: readonly string[],
): Promise<Map<string, RegenBudgetStatus>> {
  return peekBudgetBatch(askIds, askRegenBudgetKey, 'ask');
}
```

Copy the existing `used`/`limit`/`remaining` derivation verbatim from the current `peekRegenBudgetBatch` tail — do not re-derive it from memory.

- [ ] **Step 3: Add the 429 door for asks**

Append to `src/lib/shared/dashboard-regen-rate-limit.ts`, and update the file's opening comment from "BOTH authenticated … entrypoints" to "the THREE authenticated … entrypoints":

```ts
// User-facing copy for the per-ASK daily cap (#860). Owner-facing language says
// "rewrite" because that is what the control offers; the code name stays
// `regenerate` everywhere, exactly as `halt` reads as "stop" on screen.
const ASK_REGEN_LIMIT_MESSAGE =
  'Daily rewrite limit reached for this message — you can try again tomorrow.';

/**
 * Returns a 429 `regen_limit_reached` NextResponse when this ask has used its
 * per-ask daily cap, or null when a regenerate may proceed. Call BEFORE
 * enqueueing, so the owner gets synchronous feedback instead of a spinner that
 * ends with unchanged copy.
 *
 * Same contract as `enforceRegenBudgetForReview`, and the same single fail-open
 * path: an ABSENT MAP ENTRY means the MGET failed and the regenerate proceeds;
 * an absent Redis KEY is a different fact and still yields `{ used: 0 }`.
 */
export async function enforceAskRegenBudget(
  askId: string,
): Promise<NextResponse | null> {
  const status = (await peekAskRegenBudgetBatch([askId])).get(askId);
  if (status === undefined || status.remaining > 0) {
    return null;
  }

  return NextResponse.json(
    {
      error: 'regen_limit_reached',
      message: ASK_REGEN_LIMIT_MESSAGE,
      remaining: 0,
      limit: status.limit,
    },
    { status: 429, headers: NO_STORE_HEADERS },
  );
}
```

Add `peekAskRegenBudgetBatch` to the existing `@/lib/costs/tracker` import.

- [ ] **Step 4: Add `mget` to the test's Redis mock**

`src/lib/costs/__tests__/tracker.test.ts`'s `mockRedis` has no `mget`. Add it in both places:

```ts
const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  incr: vi.fn(),
  decr: vi.fn(),
  expire: vi.fn(),
  eval: vi.fn(),
  mget: vi.fn(),
  pipeline: vi.fn().mockReturnValue(mockPipeline),
};

vi.mock('ioredis', () => ({
  default: class MockRedis {
    get = mockRedis.get;
    set = mockRedis.set;
    del = mockRedis.del;
    incr = mockRedis.incr;
    decr = mockRedis.decr;
    expire = mockRedis.expire;
    eval = mockRedis.eval;
    mget = mockRedis.mget;
    pipeline = mockRedis.pipeline;
  },
}));
```

- [ ] **Step 5: Write the two tests**

```ts
describe('peekAskRegenBudgetBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('peekAskRegenBudgetBatch reads the ask-keyed counter and never the review-keyed one', async () => {
    mockRedis.mget.mockResolvedValue(['2', null]);

    const result = await peekAskRegenBudgetBatch(['ask-1', 'ask-2']);

    // The key namespace is the WHOLE point of the second door: `regen:ask:…`
    // and `regen:…` are different counters, and a door reading the wrong one
    // would silently report a review's spend against an ask.
    const keys = mockRedis.mget.mock.calls[0] as string[];
    expect(keys[0]).toMatch(/^regen:ask:ask-1:/);
    expect(keys[1]).toMatch(/^regen:ask:ask-2:/);
    expect(keys.some((key) => /^regen:(?!ask:)/.test(key))).toBe(false);

    expect(result.get('ask-1')).toEqual({ used: 2, limit: 3, remaining: 1 });
    // An absent Redis KEY is "nothing spent yet", NOT unknown.
    expect(result.get('ask-2')).toEqual({ used: 0, limit: 3, remaining: 3 });
  });

  it('peekAskRegenBudgetBatch resolves to an empty map when Redis is unavailable', async () => {
    mockRedis.mget.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await peekAskRegenBudgetBatch(['ask-1']);

    // Fails OPEN: an EMPTY map means UNKNOWN, so no counter renders and every
    // control stays enabled. Reporting `{ used: 0 }` here would be a lie, and
    // reporting `remaining: 0` would disable every control during an outage.
    expect(result.size).toBe(0);
    await expect(peekAskRegenBudgetBatch(['ask-1'])).resolves.toBeInstanceOf(Map);
  });
});
```

- [ ] **Step 6: Run and commit**

```bash
pnpm vitest run src/lib/costs/__tests__/tracker.test.ts
git add -A && git commit -m "feat(860): per-ask regen budget peek door + advisory 429 for the send lane"
```

Expected: PASS, 0 todo in this file.

---

## Task 4: The owner verb and its route

**Blocking edges:** Tasks 1, 3. **Check the #859 merge state first** (see Coordination).
**Turns green:** titles 5–10, 16–21.

**Files:**
- Modify: `src/lib/agents/run-spine.ts` (`STEP_PERSONA`)
- Modify: `src/lib/solicitation/approval.ts` (header + append the verb)
- Create: `src/app/api/dashboard/solicitation/batch/regenerate/route.ts`
- Modify: `src/lib/solicitation/__tests__/approval.integration.test.ts`
- Modify: `src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts`
- Modify: `docs/directory.md` (a row for the new route file)

- [ ] **Step 1: Register the step key**

In `src/lib/agents/run-spine.ts`, add one line to `STEP_PERSONA`, after `batch_halted`:

```ts
  batch_halted: 'solicitation',
  ask_regeneration_requested: 'solicitation',
} as const satisfies Record<string, AttributedAgentPersona>;
```

Run `pnpm vitest run src/lib/agents/__tests__/run-spine.test.ts`. If that suite enumerates the map (a count or a snapshot), update it there and nowhere else.

- [ ] **Step 2: Rewrite `approval.ts`'s scope sentence**

The header currently says the file holds `approveBatch` and `haltBatch` "and nothing else". Replace that paragraph:

```ts
 * What lives here and nothing else: `approveBatch`, `haltBatch` and
 * `requestAskRegeneration`. All three are transactional writers with an actor;
 * all three return a discriminated result so their routes stay thin (invariant
 * #12) and none throws for an outcome the owner can cause.
 *
 * `requestAskRegeneration` belongs here rather than beside `regenerateAsk` in
 * ask-generation.ts, and the reason is the gate rather than the verb: since
 * ADR 0020 a regenerate is legal in exactly one Batch state, `built`, so its
 * ENTIRE refusal vocabulary is approval-lane lifecycle. ask-generation.ts is
 * the machine side and carries no actor in any signature; this file is the
 * human side and carries one in every signature.
```

- [ ] **Step 3: Add the imports**

```ts
import { enqueueGenerateSolicitationAsks } from '@/lib/shared/job-outbox-helpers';
```

- [ ] **Step 4: Append the verb**

```ts
export interface RequestAskRegenerationInput {
  batchId: string;
  askId: string;
  accountId: string;
  businessId: string;
  /** The acting owner, recorded on the run step. Regeneration spends money on
   *  the owner's behalf, so the act is attributable even when the worker later
   *  refuses it. */
  requestedByUserId: string;
}

export type RequestAskRegenerationResult =
  /** Enqueued. The work is ACCEPTED, not done — the worker may still refuse it
   *  (budget race, subscription lapse, a swap that loses its re-check). */
  | { status: 'accepted' }
  /** A generation is already in flight for this batch. The dedup is keyed
   *  `(topic, aggregate_id = batchId)`, so this is per BATCH, not per ask —
   *  which is also why "regenerate all" cannot exist as a fan-out. */
  | { status: 'already_in_flight' }
  /** ADR 0020: `built` is the only regenerable state. `approved`,
   *  `veto_window` and `sending` land here, and so do `halted` / `expired` /
   *  `closed`. */
  | { status: 'not_regenerable'; state: BatchState }
  /** The ask's current attempt is not `rendered` — a `withheld` row is terminal
   *  (§8.2 r6) and a released one is never superseded. */
  | { status: 'ask_not_regenerable'; deliveryStatus: string }
  | { status: 'not_found' };

/**
 * The owner asking for one new draft — **Ask regeneration**'s request half.
 *
 * Everything expensive happens in the worker (`regenerateAsk`): this writes no
 * domain state at all, only the `job_outbox` row and the step recording who
 * asked, both in ONE transaction (invariant #2). The gates below are therefore
 * ADVISORY — the worker re-checks every one of them under its own locks, which
 * is the only reason a refusal here can be cheap.
 *
 * LOCK ORDER (amendment B11), matching `regenerateAsk`'s swap exactly:
 * advisory batch lock -> `solicitation_batches` row -> `solicitation_outreach`
 * row -> `agent_runs` (taken by `recordStep`). Do not move the outreach lock
 * below the spine call; the swap holds them in this order and an inversion here
 * is an ABBA deadlock against the very worker this enqueues.
 *
 * VALIDATE BEFORE MUTATE, like `approveBatch`: postgres.js COMMITS when the
 * `sql.begin` callback resolves, so every refusal must return before the
 * enqueue. It does — the enqueue is the first write in the function.
 */
export async function requestAskRegeneration(
  sql: Sql,
  input: RequestAskRegenerationInput,
): Promise<RequestAskRegenerationResult> {
  const batchId = canonicalBatchId(input.batchId);
  return sql.begin(async (tx): Promise<RequestAskRegenerationResult> => {
    const batch = await lockBatchForAction(tx, {
      batchId,
      accountId: input.accountId,
      businessId: input.businessId,
    });
    if (batch === null) return { status: 'not_found' };

    const state = deriveBatchState(batch, new Date());
    if (state !== 'built') return { status: 'not_regenerable', state };

    // The ask's live attempt, locked for the duration. Ordered by attempt_no
    // DESC and excluding `cancelled` for the same reason `loadCurrentOutreach`
    // does: superseded attempts stay in the table, and the newest surviving row
    // is the one a regenerate would replace.
    const [current] = await tx<{ delivery_status: string }[]>`
      SELECT o.delivery_status
      FROM solicitation_outreach o
      WHERE o.ask_id = ${input.askId}::uuid
        AND o.batch_id = ${batchId}::uuid
        AND o.account_id = ${input.accountId}::uuid
        AND o.business_id = ${input.businessId}::uuid
        AND o.delivery_status <> 'cancelled'
      ORDER BY o.attempt_no DESC
      LIMIT 1
      FOR UPDATE
    `;
    // An ask id from another batch or another tenant produces no row and is
    // indistinguishable from an unknown one — the uniform 404.
    if (current === undefined) return { status: 'not_found' };
    if (current.delivery_status !== 'rendered') {
      return { status: 'ask_not_regenerable', deliveryStatus: current.delivery_status };
    }

    // ASSERT, do not branch: a live rendered row exists only because generation
    // ran under a send parent. `approveBatch` treats a null parent as a refusal
    // because its readiness gate passes VACUOUSLY over zero send asks; here we
    // have just read one of that parent's renders, so a null parent is a broken
    // invariant and must say so loudly.
    if (batch.send_parent_run_id === null) {
      throw new Error(
        `requestAskRegeneration: batch ${batchId} has a rendered ask but no send parent run`,
      );
    }

    const outboxId = await enqueueGenerateSolicitationAsks(tx, {
      batchId,
      businessId: input.businessId,
      askId: input.askId,
    });
    // `null` is the dedup arm — an in-flight row already exists and DO NOTHING
    // fired, so nothing has been written and returning here commits nothing.
    if (outboxId === null) return { status: 'already_in_flight' };

    await recordStep(tx, {
      runId: batch.send_parent_run_id,
      stepKey: 'ask_regeneration_requested',
      detail: {
        ask_id: input.askId,
        requested_by_user_id: input.requestedByUserId,
        outbox_id: outboxId,
      },
    });

    return { status: 'accepted' };
  });
}
```

- [ ] **Step 5: Create the route**

`src/app/api/dashboard/solicitation/batch/regenerate/route.ts`:

```ts
// POST /api/dashboard/solicitation/batch/regenerate — the owner asks for one
// new draft of one rendered ask (#860; **Ask regeneration**). Route
// orchestrates only: the send-lane flag gate, writable-owner auth, location
// resolution, body parse and the 500 mapping all live in `withScopedBatch`
// (../_shared/scoped-batch-route.ts); the transaction lives in
// src/lib/solicitation/approval.ts.
//
// TWO advisory gates run before the domain call and both fail OPEN:
// the per-owner regenerate limiter (the same keys the two Reviews-lane
// entrypoints use — one wallet, and the hour layer IS the spend bound), and the
// per-ask daily cap peek. Neither is authoritative: the worker's
// `checkAskRegenBudget` is, because an API-only limiter is bypassable via
// outbox replay (SPEC §8.2 r3). They exist so the owner sees "limit reached"
// synchronously instead of a spinner that ends with unchanged copy.

import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import { errorResponse, jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { isValidUuid } from '@/lib/shared/ids';
import {
  enforceAskRegenBudget,
  enforceDashboardRegenRateLimit,
} from '@/lib/shared/dashboard-regen-rate-limit';
import {
  requestAskRegeneration,
  type RequestAskRegenerationResult,
} from '@/lib/solicitation/approval';
import { requireSolicitationSendWriteAccess } from '@/app/api/dashboard/contacts/location-scope';
import { readJsonObject, withScopedBatch } from '../_shared/scoped-batch-route';

export const dynamic = 'force-dynamic';

/** The batch id plus the one ask being re-rolled, or null when either is
 *  absent or not a UUID. Like `approve`, this body is more than a batch id, so
 *  it reads the object itself rather than using the shared `readBatchId`. */
async function readRegenerateRequest(
  request: NextRequest,
): Promise<{ batchId: string; askId: string } | null> {
  const body = await readJsonObject(request);
  if (body === null) return null;
  const { batchId, askId } = body;
  if (typeof batchId !== 'string' || !isValidUuid(batchId)) return null;
  if (typeof askId !== 'string' || !isValidUuid(askId)) return null;
  return { batchId, askId };
}

/**
 * Everything the browser is allowed to learn, and nothing else. No outbox id,
 * no run id — ADR 0012: no internal id is ever rendered on the Requests
 * surface, and the panel refetches rather than tracking a job.
 */
interface RegenerateWire {
  status: RequestAskRegenerationResult['status'];
  state?: string;
  deliveryStatus?: string;
}

function toWire(result: RequestAskRegenerationResult): RegenerateWire {
  switch (result.status) {
    case 'not_regenerable':
      return { status: result.status, state: result.state };
    case 'ask_not_regenerable':
      return { status: result.status, deliveryStatus: result.deliveryStatus };
    default:
      return { status: result.status };
  }
}

export const POST = withSameOrigin()(
  withScopedBatch(
    sql,
    {
      endpoint: 'api/dashboard/solicitation/batch/regenerate',
      failureMessage: 'Failed to request a new version',
      // BOTH flags, exactly like approve/halt: regeneration is a send-lane act.
      requireWriteAccess: requireSolicitationSendWriteAccess,
      readInput: readRegenerateRequest,
    },
    async ({ accountId, locationId, actorUserId, input, logger }) => {
      const limited = await enforceDashboardRegenRateLimit(accountId);
      if (limited) return limited;

      const capped = await enforceAskRegenBudget(input.askId);
      if (capped) return capped;

      const result = await requestAskRegeneration(sql, {
        batchId: input.batchId,
        askId: input.askId,
        accountId,
        businessId: locationId,
        requestedByUserId: actorUserId,
      });

      // Ids and statuses only — no rendered subject or body is ever
      // interpolated into a log string (D6e: string args are logged verbatim).
      logger.log('ask_regeneration_requested', {
        status: result.status,
        batchId: input.batchId,
        askId: input.askId,
        businessId: locationId,
      });

      const wire = toWire(result);

      switch (result.status) {
        // 202, not 200: the work is accepted, not done. The panel starts
        // polling on this answer rather than announcing a completed act.
        case 'accepted':
          return jsonResponse(wire, 202);
        case 'already_in_flight':
        case 'not_regenerable':
        case 'ask_not_regenerable':
          return jsonResponse(wire, 409);
        case 'not_found':
          return errorResponse('Not found', 404);
      }
    },
  ),
);
```

- [ ] **Step 6: Write the six integration tests**

In `approval.integration.test.ts`, replacing the todos. Reuse the existing helpers (`seedRenderedBatch`, `seedSendParent`, `readSteps`, `stepDetail`, `snapshotOutreach`, `foreignTenantSeed`) — do not write new seeding.

```ts
  describe('requestAskRegeneration', () => {
    async function readInflightOutbox(batchId: string) {
      return writerSql()<{ id: string; payload: Record<string, unknown> }[]>`
        SELECT id, payload
        FROM job_outbox
        WHERE topic = 'generate_solicitation_asks'
          AND aggregate_id = ${batchId}
          AND status IN ('pending', 'dispatching', 'dispatched')
      `;
    }

    it('enqueues one generate_solicitation_asks outbox row carrying the ask id for a built batch', async () => {
      const seeded = await seedRenderedBatch('1 hour');

      const result = await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[0].askId,
        accountId: accountId(),
        businessId,
        requestedByUserId: userId(),
      });

      expect(result).toEqual({ status: 'accepted' });
      const rows = await readInflightOutbox(seeded.batchId);
      expect(rows).toHaveLength(1);
      expect(rows[0].payload.ask_id).toBe(seeded.asks[0].askId);
      // The request writes NO domain state: the live render is untouched and
      // the worker owns every mutation.
      expect(await snapshotOutreach(seeded.batchId)).toEqual(seeded.outreachSnapshot);
    });

    it('records ask_regeneration_requested on the send parent with the requesting owner', async () => {
      const seeded = await seedRenderedBatch('1 hour');

      await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[0].askId,
        accountId: accountId(),
        businessId,
        requestedByUserId: userId(),
      });

      const steps = await readSteps(seeded.sendParentRunId, 'ask_regeneration_requested');
      expect(steps).toHaveLength(1);
      expect(stepDetail(steps[0])).toMatchObject({
        ask_id: seeded.asks[0].askId,
        requested_by_user_id: userId(),
      });
    });

    it('refuses a regenerate for an approved batch without writing an outbox row', async () => {
      const seeded = await seedRenderedBatch('1 hour');
      await approveBatch(sql(), {
        batchId: seeded.batchId,
        accountId: accountId(),
        businessId,
        approvedByUserId: userId(),
        excludedOutreachIds: [],
      });

      const result = await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[0].askId,
        accountId: accountId(),
        businessId,
        requestedByUserId: userId(),
      });

      // ADR 0020, asserted against the DATABASE rather than the return value:
      // the refusal is only worth anything if nothing was enqueued.
      expect(result.status).toBe('not_regenerable');
      expect(await readInflightOutbox(seeded.batchId)).toHaveLength(0);
    });

    it('refuses a regenerate for an ask whose current attempt is withheld', async () => {
      const seeded = await seedRenderedBatch('1 hour');
      await writerSql()`
        UPDATE solicitation_outreach
        SET delivery_status = 'withheld', disposition_reason = 'lint_failed'
        WHERE ask_id = ${seeded.asks[0].askId}::uuid
      `;

      const result = await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[0].askId,
        accountId: accountId(),
        businessId,
        requestedByUserId: userId(),
      });

      // §8.2 r6: blocked is terminal. Re-rolling it would launder the
      // fail-closed lint.
      expect(result).toEqual({ status: 'ask_not_regenerable', deliveryStatus: 'withheld' });
      expect(await readInflightOutbox(seeded.batchId)).toHaveLength(0);
    });

    it('returns already_in_flight when a generation is already in flight for the batch', async () => {
      const seeded = await seedRenderedBatch('1 hour');
      const first = await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[0].askId,
        accountId: accountId(),
        businessId,
        requestedByUserId: userId(),
      });
      expect(first.status).toBe('accepted');

      // A DIFFERENT ask: the dedup is keyed on the batch, not the ask, which is
      // the fact that makes "regenerate all" impossible as a fan-out.
      const second = await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[1].askId,
        accountId: accountId(),
        businessId,
        requestedByUserId: userId(),
      });

      expect(second).toEqual({ status: 'already_in_flight' });
      expect(await readInflightOutbox(seeded.batchId)).toHaveLength(1);
    });

    it('refuses a regenerate for a batch belonging to another tenant', async () => {
      const seeded = await seedRenderedBatch('1 hour');
      const foreign = foreignTenantSeed();

      const result = await requestAskRegeneration(sql(), {
        batchId: seeded.batchId,
        askId: seeded.asks[0].askId,
        accountId: foreign.accountId,
        businessId: foreign.businessId,
        requestedByUserId: foreign.userId,
      });

      // A foreign batch id and an unknown one are indistinguishable.
      expect(result).toEqual({ status: 'not_found' });
      expect(await readInflightOutbox(seeded.batchId)).toHaveLength(0);
    });
  });
```

If `seedRenderedBatch` does not already return `sendParentRunId`, `asks[]` or an `outreachSnapshot`, read its current signature and adapt these tests to what it does return — **do not** change the helper, five existing tests depend on it.

- [ ] **Step 7: Write the six route tests**

In `approval-routes.test.ts`. Extend the hoisted mock block with `mockRequestAskRegeneration`, add it to the `@/lib/solicitation/approval` factory, add `'regenerate'` to `post`'s path union, and default the body to `{ batchId: BATCH_ID, askId: ASK_ID }` for that path. Then:

```ts
describe('POST /api/dashboard/solicitation/batch/regenerate', () => {
  it('POST regenerate enqueues for a built batch and answers 202', async () => {
    mockRequestAskRegeneration.mockResolvedValue({ status: 'accepted' });

    const response = await REGENERATE(post('regenerate', { query: `?${SOLICITATION_SCOPE_PARAM}=${DEFAULT_LOCATION_ID}` }));

    // 202, not 200: accepted, not done.
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: 'accepted' });
    expect(mockRequestAskRegeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        batchId: BATCH_ID,
        askId: ASK_ID,
        businessId: DEFAULT_LOCATION_ID,
        requestedByUserId: USER_ID,
      }),
    );
  });

  it('POST regenerate answers 409 when the batch is already approved', async () => {
    mockRequestAskRegeneration.mockResolvedValue({ status: 'not_regenerable', state: 'approved' });

    const response = await REGENERATE(post('regenerate', { query: `?${SOLICITATION_SCOPE_PARAM}=${DEFAULT_LOCATION_ID}` }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      status: 'not_regenerable',
      state: 'approved',
    });
  });

  it('POST regenerate answers 429 when the ask has spent its daily regenerate budget', async () => {
    mockPeekAskRegenBudget.mockResolvedValue(new Map([[ASK_ID, { used: 3, limit: 3, remaining: 0 }]]));

    const response = await REGENERATE(post('regenerate', { query: `?${SOLICITATION_SCOPE_PARAM}=${DEFAULT_LOCATION_ID}` }));

    expect(response.status).toBe(429);
    // Refused BEFORE the domain call: the point of the advisory gate is that
    // the owner learns synchronously, not after a spinner.
    expect(mockRequestAskRegeneration).not.toHaveBeenCalled();
  });

  it('POST regenerate answers 409 when a regeneration is already in flight for the batch', async () => {
    mockRequestAskRegeneration.mockResolvedValue({ status: 'already_in_flight' });

    const response = await REGENERATE(post('regenerate', { query: `?${SOLICITATION_SCOPE_PARAM}=${DEFAULT_LOCATION_ID}` }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ status: 'already_in_flight' });
  });

  it('POST regenerate answers 404 when the body carries no valid ask id', async () => {
    const response = await REGENERATE(
      post('regenerate', {
        query: `?${SOLICITATION_SCOPE_PARAM}=${DEFAULT_LOCATION_ID}`,
        body: { batchId: BATCH_ID, askId: 'not-a-uuid' },
      }),
    );

    // The uniform 404: a malformed body reveals nothing an unknown batch would
    // not, and never reaches the domain.
    expect(response.status).toBe(404);
    expect(mockRequestAskRegeneration).not.toHaveBeenCalled();
  });

  it('POST regenerate is refused when SOLICITATION_SEND_ENABLED is off', async () => {
    vi.stubEnv('SOLICITATION_SEND_ENABLED', 'false');

    const response = await REGENERATE(post('regenerate', { query: `?${SOLICITATION_SCOPE_PARAM}=${DEFAULT_LOCATION_ID}` }));

    expect(response.status).toBe(404);
    expect(mockRequestAskRegeneration).not.toHaveBeenCalled();
  });
});
```

Add near the other constants: `const ASK_ID = '01900000-0000-7000-8000-0000000000f1';`. Mock the budget peek by adding `@/lib/costs/tracker`'s `peekAskRegenBudgetBatch` to the hoisted block (`mockPeekAskRegenBudget`, defaulting to an empty `Map` so the fail-open path is the default in every other test). Import `POST as REGENERATE` from `../regenerate/route`.

- [ ] **Step 8: Add the `docs/directory.md` row**

`ci:directory-map` fails on a production file under `src/lib/` or `worker/` with no row. The new file is under `src/app/`, so it is not CI-required — add the row anyway, in the `api/dashboard/solicitation/batch/` section, matching the neighbouring `approve/route.ts` row's wording.

- [ ] **Step 9: Run and commit**

```bash
export TEST_DATABASE_POOL_URL=... DATABASE_POOL_URL=...
pnpm vitest run src/lib/solicitation/__tests__/approval.integration.test.ts src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts src/lib/agents/__tests__/run-spine.test.ts
git add -A && git commit -m "feat(860): requestAskRegeneration owner verb + POST regenerate route"
```

Expected: PASS, 0 todo in those files.

---

## Task 5: The read model

**Blocking edges:** Tasks 1, 3. Disjoint files from Task 4 — may run in parallel with it. **Check the #859 merge state first.**
**Turns green:** titles 13–15.

**Files:**
- Modify: `src/lib/solicitation/batch-view.ts` (`SendLaneView` + the send-lane read)
- Modify: `src/lib/solicitation/__tests__/batch-view.test.ts`

- [ ] **Step 1: Widen `SendLaneView`**

Add to the interface, after `moderationWithheld`:

```ts
  /**
   * The ask whose regeneration is in flight, or null. Read from the in-flight
   * `job_outbox` row, so it survives a reload and cannot disagree with the
   * enqueue's `already_in_flight` refusal — both read the same row.
   *
   * At most ONE per batch: the dedup is keyed `(topic, aggregate_id = batchId)`.
   * A WHOLE-BATCH generation row carries no `ask_id`, so this is null during
   * `preparing` and the panel offers no control there anyway.
   */
  regeneratingAskId: string | null;
  /**
   * Per-ask daily regenerate budget, keyed by ask id. An ABSENT key means
   * UNKNOWN (Redis unreachable), never "0 remaining" — the panel renders no
   * counter and leaves the control enabled. A plain Record rather than the Map
   * `peekAskRegenBudgetBatch` returns, because this crosses the wire.
   */
  regenBudgets: Record<string, RegenBudgetStatus>;
```

Import the type: `import { peekAskRegenBudgetBatch, type RegenBudgetStatus } from '@/lib/costs/tracker';`

- [ ] **Step 2: Read the in-flight row**

Add near the other send-lane reads:

```ts
/**
 * The ask id of the one in-flight per-ask regeneration for this batch, or null.
 *
 * NO tenant predicate, and that is correct rather than an oversight:
 * `job_outbox` is absent from `scripts/ci/tenant-tables.ts`, so this statement
 * is not auditable by `ci:tenant-scope` and needs no allowlist entry. Its
 * safety comes from the caller — `readLatestBatch` has already resolved this
 * batch through account- and business-scoped reads, so `batchId` is proven, and
 * the only value returned is an ask id belonging to a batch the caller owns.
 * Do NOT "fix" this by joining `solicitation_batches`: that pulls a tenant
 * table into the statement, makes it auditable, and demands scope keys on a
 * query whose proof lives upstream.
 *
 * The status list is spelled by hand, in this order. `ci:outbox-status` checks
 * members AND order at every site naming `'dispatching'`/`'dispatched'`, and
 * the set cannot be parameterized (a bind parameter inside `ON CONFLICT … WHERE`
 * defeats partial-index inference, so every site re-spells it).
 */
async function readRegeneratingAskId(
  sql: Sql | TransactionSql,
  batchId: string,
): Promise<string | null> {
  const [row] = await sql<{ ask_id: string | null }[]>`
    SELECT payload->>'ask_id' AS ask_id
    FROM job_outbox
    WHERE topic = ${QUEUE_NAMES.GENERATE_SOLICITATION_ASKS}
      AND aggregate_id = ${batchId}
      AND status IN ('pending', 'dispatching', 'dispatched')
    LIMIT 1
  `;
  return row?.ask_id ?? null;
}
```

Import `QUEUE_NAMES` from `@/lib/shared/queue-names`. `payload->>'ask_id'` returns TEXT, so this is outside the PgBouncer JSONB-as-string carve-out — no parse, no guard.

- [ ] **Step 3: Populate both fields where `SendLaneView` is built**

At the point the send lane is assembled (only when `options.sendLane` is on), after the attempts are read:

```ts
    // Both are advisory presentation facts, not part of any gate, so they are
    // read AFTER the tenant-scoped statements rather than woven into them.
    const regeneratingAskId = await readRegeneratingAskId(sql, batchId);
    // Only rendered asks can be regenerated, so only they need a counter — and
    // an empty id list short-circuits inside the peek without touching Redis.
    const regenBudgetIds = attempts
      .filter((attempt) => attempt.deliveryStatus === 'rendered')
      .map((attempt) => attempt.askId);
    const regenBudgets = Object.fromEntries(await peekAskRegenBudgetBatch(regenBudgetIds));
```

and add `regeneratingAskId, regenBudgets` to the returned `SendLaneView` literal.

- [ ] **Step 4: Write the three tests**

```ts
  it('reports the ask id of an in-flight per-ask regeneration on the send lane', async () => {
    // …seed a built batch with a rendered attempt, then a pending outbox row
    // whose payload carries ask_id…
    const view = await readLatestBatch(sql, accountId, businessId, { sendLane: true });

    expect(view.state).toBe('built');
    expect(view.sendLane?.regeneratingAskId).toBe(askId);
  });

  it('reports no in-flight regeneration for a whole-batch generation row', async () => {
    // A whole-batch row's payload has no ask_id, so `payload->>'ask_id'` is
    // NULL — the panel must not spin a row for it.
    const view = await readLatestBatch(sql, accountId, businessId, { sendLane: true });

    expect(view.sendLane?.regeneratingAskId).toBeNull();
  });

  it('carries the per-ask regenerate budget on the send lane, omitting asks whose counter is unknown', async () => {
    mockPeekAskRegenBudgetBatch.mockResolvedValue(
      new Map([[renderedAskId, { used: 1, limit: 3, remaining: 2 }]]),
    );

    const view = await readLatestBatch(sql, accountId, businessId, { sendLane: true });

    expect(view.sendLane?.regenBudgets[renderedAskId]).toEqual({ used: 1, limit: 3, remaining: 2 });
    // UNKNOWN is an ABSENT KEY, never `{ remaining: 0 }` — inverting that
    // would disable every control during an Upstash outage.
    expect(view.sendLane?.regenBudgets[unknownAskId]).toBeUndefined();
  });
```

Mock `@/lib/costs/tracker`'s `peekAskRegenBudgetBatch` in this suite (it is a Redis call in a DB read model; the other tests need it to resolve to an empty Map by default). Follow the existing mock style in this file rather than inventing one.

- [ ] **Step 5: Remove Task 1's `@ts-expect-error` markers**

If Step 7 of Task 1 added them to `approval-panel.test.tsx`'s `sendLane()` fixture, delete both now — the fields exist.

- [ ] **Step 6: Run and commit**

```bash
pnpm vitest run src/lib/solicitation/__tests__/batch-view.test.ts
git add -A && git commit -m "feat(860): send lane reports in-flight regeneration + per-ask budgets"
```

---

## Task 6: The panel

**Blocking edges:** Tasks 4, 5.
**Turns green:** titles 22–32.

**Files:**
- Modify: `src/app/(authenticated)/dashboard/requests/AskList.tsx`
- Modify: `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx`
- Modify: `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx`
- Modify: `src/app/(authenticated)/dashboard/requests/requests.css`
- Modify: `src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx`

- [ ] **Step 1: Rewrite the three doc comments that assert no regenerate control exists**

All three are load-bearing prose, not decoration, and all three are now false:

1. `ApprovalPanel.tsx` — "There is no edit affordance and no regenerate control anywhere here (D22). The lane renders exactly two kinds of control…" becomes:

```tsx
 * There is no edit affordance anywhere here, and that is still D22: the owner
 * may ask for new bytes, never write them. What changed at #860 is that asking
 * is now possible — the lane renders THREE kinds of control: the approve/stop
 * button in `ApprovalActions`, and per rendered ask, the exclude checkbox and
 * the regenerate button in `SelectableAskList`. Both per-ask controls are row
 * controls, not batch verbs, which is why `ApprovalVerb` still names two.
```

2. `AskList.tsx` — "Neither form renders an edit or a regenerate affordance (D22); the checkbox below is the lane's only control outside `ApprovalActions`." becomes:

```tsx
 * Neither form renders an EDIT affordance (D22). `SelectableAskList` renders
 * two per-ask controls — the exclude checkbox and the regenerate button (#860);
 * `AskList` renders none and is structurally unable to, which is the whole
 * reason the two components are separate.
```

3. `ApprovalActions.tsx` — the paragraph claiming the pair "is the whole surface: no edit affordance and no regenerate affordance exists (D22)" becomes:

```tsx
 * There are exactly two BATCH verbs — approve, or stop — and this file owns
 * both. Per-ask controls (exclude, regenerate) are row controls in
 * `SelectableAskList` and deliberately not verbs here: a third entry in
 * `ApprovalVerb` would mean a third batch-wide button, which no decision asks
 * for. What D22 still forbids is an EDIT affordance, and none exists.
```

- [ ] **Step 2: Widen `AskRowView` and add the control to `SelectableAskList`**

In `AskList.tsx`, add to `AskRowView`:

```ts
  /** The ask this attempt belongs to — the key for its regenerate budget and
   *  the id the regenerate route takes. `outreachId` cannot serve: a
   *  regeneration mints a new one. */
  askId: string;
  /** 1-based. The panel compares it across a refetch to tell a landed
   *  regeneration from one that settled without changing anything. */
  attemptNo: number;
```

Extend `SelectableAskListProps`:

```ts
  /** Per-ask budget, keyed by askId. An ABSENT entry means UNKNOWN: no counter
   *  renders and the control stays enabled (F6, the PastReplyCard precedent). */
  regenBudgets: Record<string, RegenBudgetStatus>;
  /** The ask being regenerated right now, or null. */
  regeneratingAskId: string | null;
  onRegenerate: (askId: string) => void;
```

and render, after the status span:

```tsx
          <RegenerateControl
            row={row}
            budget={regenBudgets[row.askId]}
            regenerating={regeneratingAskId === row.askId}
            /* Disabled while ANY regeneration is in flight (one per batch), and
               on a deselected row: regenerating it would mint a new outreachId,
               silently dropping the deselection and re-selecting the contact. */
            disabled={disabled || regeneratingAskId !== null || excluded.has(row.outreachId)}
            onRegenerate={onRegenerate}
          />
```

with:

```tsx
/** The per-ask regenerate control and its budget counter. Split out so the
 *  three reasons it can be unavailable read as three conditions rather than one
 *  boolean expression buried in the list. */
function RegenerateControl({
  row,
  budget,
  regenerating,
  disabled,
  onRegenerate,
}: {
  row: AskRowView;
  budget?: RegenBudgetStatus;
  regenerating: boolean;
  disabled: boolean;
  onRegenerate: (askId: string) => void;
}) {
  const exhausted = budget != null && budget.remaining === 0;

  return (
    <span className="rq-ask-regen">
      <button
        type="button"
        className="rq-ask-regen-btn"
        onClick={() => onRegenerate(row.askId)}
        disabled={disabled || exhausted || regenerating}
        aria-label={`Ask for a new version of the message to ${displayName(row)}`}
      >
        {regenerating ? 'Rewriting…' : 'Regenerate'}
      </button>
      {/* No counter at all when the budget is UNKNOWN (F6). */}
      {budget && (
        <span className="rq-ask-regen-count">
          {budget.used} of {budget.limit} today
        </span>
      )}
    </span>
  );
}
```

- [ ] **Step 3: Project `askId` and `attemptNo` in `toRows`**

```ts
    rows.push({
      outreachId: attempt.outreachId,
      askId: attempt.askId,
      attemptNo: attempt.attemptNo,
      contactName: attempt.contactName,
      deliveryStatus: attempt.deliveryStatus,
      subject: attempt.subject,
      body: attempt.body,
    });
```

`toRows` stays the single choke point — redacted attempts are still dropped before this line, so no held ask can acquire a control.

- [ ] **Step 4: Add the exclusion-pruning effect**

In `ApprovalPanel`, after `sendable` is computed:

```tsx
  /**
   * Drop exclusions whose outreach row no longer exists.
   *
   * NOT defensive tidying: a regeneration supersedes the live row and inserts
   * its replacement at a NEW `outreachId`, so an id the owner deselected before
   * a rewrite is gone after it. `approveBatch` validates the exclusion list
   * fail-closed — one unknown id refuses the WHOLE approval `unknown_exclusion`
   * — so a stale id here does not lose one deselection, it blocks the batch.
   * A halt or an exclusion committed in another tab reaches this the same way.
   */
  useEffect(() => {
    setExcluded((current) => pruneExclusions(current, sendable));
  }, [sendable]);
```

with the pure helper exported for its property test:

```ts
/** Exported for the invariant test — the alternative is asserting this through
 *  a full render plus a refetch, which tests the harness. */
export function pruneExclusions(
  current: ReadonlySet<string>,
  rows: readonly AskRowView[],
): ReadonlySet<string> {
  const live = new Set(rows.map((row) => row.outreachId));
  const next = new Set([...current].filter((id) => live.has(id)));
  // Returning the SAME reference when nothing changed keeps the effect above
  // from looping: setState with an identical value still re-renders once, and a
  // fresh Set every time would make that permanent.
  return next.size === current.size ? current : next;
}
```

- [ ] **Step 5: Add the regenerate write**

Extend `LaneStatus` so the totality guarantee covers the third verb:

```ts
type LaneStatus =
  | ApproveBatchResult['status']
  | HaltBatchResult['status']
  | RequestAskRegenerationResult['status'];
```

Add the four new arms to `LANE_REFUSAL_COPY` (tsc will demand them):

```ts
  accepted: null,
  already_in_flight:
    'We are already writing a new version for this batch. Wait for it to finish, then try again.',
  not_regenerable:
    'This batch has been approved, so its messages can no longer be changed. Stop the batch if you need to.',
  ask_not_regenerable:
    'This message cannot be rewritten. Nothing changed.',
```

Add to `useLaneWrites`, alongside `approve` and `halt`:

```ts
  const regenerate = useCallback(
    (askId: string) => {
      // Deliberately NOT routed through `perform`: the other two verbs announce
      // a completed act, and this one is 202 Accepted. The sentence says what
      // was ASKED for; the poll loop reports what happened.
      void perform(REGENERATE_PATH, { batchId, askId }, regenerateAnnounce);
    },
    [batchId, perform],
  );
```

```ts
/** A regeneration is accepted, not done. The sentence must not describe a
 *  result the server has not produced. */
const regenerateAnnounce: Announce = (status) =>
  status === 'accepted'
    ? 'Writing a new version. It will replace the message below in a moment.'
    : 'Nothing changed.';
```

- [ ] **Step 6: Report a regeneration that settled without changing anything**

`ApprovalPanel` records the ask it asked to regenerate and that ask's `attemptNo` at click time. When `regeneratingAskId` goes from that ask back to `null`, compare the row's current `attemptNo`:

```tsx
  /**
   * A worker-side refusal (budget race, subscription lapse, a swap that lost
   * its re-check) completes the outbox row and leaves the copy untouched. The
   * spinner would simply stop and the same words would still be on screen,
   * which reads as "nothing happened" — so say it.
   */
  useEffect(() => {
    const pending = pendingRegen.current;
    if (pending === null || sendLane.regeneratingAskId !== null) return;
    pendingRegen.current = null;
    const row = sendable.find((candidate) => candidate.askId === pending.askId);
    if (row !== undefined && row.attemptNo === pending.attemptNo) {
      onChanged('We could not write a new version. The message below is unchanged.', 'settled');
    }
  }, [sendLane.regeneratingAskId, sendable, onChanged]);
```

- [ ] **Step 7: Disable approve while a regeneration is in flight**

Pass `busy || sendLane.regeneratingAskId !== null` as `ApprovalActions`' `busy`. Approving mid-flight is safe — the swap's locked re-check refuses and only the spend is lost — but it silently throws away work the owner asked for.

- [ ] **Step 8: Update the approvable-mode copy**

```ts
    case 'approvable':
      return {
        heading: 'Ready for your approval',
        body: 'Read each message below — this is exactly what will be sent. Nothing sends until you approve. You can ask for a new version of any message, but you cannot write one yourself. Deselect anyone you would rather skip.',
      };
```

- [ ] **Step 9: Poll while a regeneration is in flight**

In `RequestsClient.tsx`'s `useLatestBatch`, the loop stops on every non-`building` outcome. Widen the continue condition:

```ts
        const building = outcome.kind === 'ready' && outcome.view.state === 'building';
        // #860: a built batch also polls while a regeneration is in flight, so
        // the new copy appears without a reload. Same bounded ceiling and the
        // same abort-on-scope-switch — only the predicate widens.
        const regenerating =
          outcome.kind === 'ready' &&
          outcome.view.state === 'built' &&
          outcome.view.sendLane?.regeneratingAskId != null;
        …
        if (!building && !regenerating) stop();
```

Update the numbered doc comment above `useLatestBatch` (point 3, "Polling runs only while the batch is `building`") to name both conditions.

- [ ] **Step 10: Add the styles**

Append to `requests.css`, following the existing `rq-` naming and the Console tier tokens (`repworth-brand-design` skill — read the Console Style Reference before picking any colour):

```css
.rq-ask-regen { display: inline-flex; align-items: center; gap: var(--space-2); }
.rq-ask-regen-btn { /* secondary, small; disabled state must read as disabled, not absent */ }
.rq-ask-regen-count { font-size: var(--text-xs); color: var(--color-text-muted); }
```

- [ ] **Step 11: Write the eleven tests**

Replace the todos. Representative shapes — the panel is rendered directly, as the file's header explains:

```tsx
  it('offers a regenerate control on every rendered ask while the batch is approvable', () => {
    render(<ApprovalPanel {...props({ attempts: [rendered('1', 'Ana'), rendered('2', 'Bo')] })} />);

    expect(screen.getAllByRole('button', { name: /ask for a new version/i })).toHaveLength(2);
  });

  it('offers no regenerate control on a withheld ask', () => {
    render(<ApprovalPanel {...props({ attempts: [rendered('1', 'Ana'), heldByLint('2', 'Bo')] })} />);

    // §8.2 r6: blocked is terminal. The control's absence is the UI half of the
    // rule the worker enforces.
    const controls = screen.getAllByRole('button', { name: /ask for a new version/i });
    expect(controls).toHaveLength(1);
    expect(controls[0]).toHaveAccessibleName(/Ana/);
  });

  it('offers no regenerate control once the batch is approved', () => {
    render(<ApprovalPanel {...props({
      sendLane: sendLane({ batchState: 'approved', approvedAt: '2026-08-17 10:00:00+00' }),
      attempts: [rendered('1', 'Ana')],
    })} />);

    // ADR 0020 on screen: approved bytes cannot be replaced, so the affordance
    // is gone rather than present-and-failing.
    expect(screen.queryByRole('button', { name: /ask for a new version/i })).toBeNull();
  });

  it('disables the regenerate control on an ask the owner has deselected', () => {
    render(<ApprovalPanel {...props({ attempts: [rendered('1', 'Ana')] })} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Send to Ana/ }));

    // Regenerating a deselected ask mints a new outreachId, which would drop
    // the deselection and silently re-select the contact.
    expect(screen.getByRole('button', { name: /ask for a new version/i })).toBeDisabled();
  });

  it('renders the per-ask regenerate counter and disables the control once the budget is spent', () => {
    render(<ApprovalPanel {...props({
      sendLane: sendLane({ regenBudgets: { 'ask-1': { used: 3, limit: 3, remaining: 0 } } }),
      attempts: [rendered('1', 'Ana')],
    })} />);

    expect(screen.getByText('3 of 3 today')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ask for a new version/i })).toBeDisabled();
  });

  it('renders no regenerate counter when the budget is unknown', () => {
    render(<ApprovalPanel {...props({ attempts: [rendered('1', 'Ana')] })} />);

    // An ABSENT entry is UNKNOWN (Redis down), never "0 remaining": no counter,
    // control enabled. Inverting this disables every control during an outage.
    expect(screen.queryByText(/today$/)).toBeNull();
    expect(screen.getByRole('button', { name: /ask for a new version/i })).toBeEnabled();
  });

  it('disables approve and every regenerate control while a regeneration is in flight', () => {
    render(<ApprovalPanel {...props({
      sendLane: sendLane({ regeneratingAskId: 'ask-1' }),
      attempts: [rendered('1', 'Ana'), rendered('2', 'Bo')],
    })} />);

    expect(screen.getByRole('button', { name: /Approve and send/ })).toBeDisabled();
    // BOTH — the dedup is per batch, so a second request would 409 anyway.
    for (const control of screen.getAllByRole('button', { name: /ask for a new version/i })) {
      expect(control).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: /Ana/ })).toHaveTextContent('Rewriting…');
  });

  it('drops a stale exclusion when a regenerated ask replaces its outreach id', () => {
    const { rerender } = render(<ApprovalPanel {...props({ attempts: [rendered('1', 'Ana'), rendered('2', 'Bo')] })} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Send to Ana/ }));
    expect(screen.getByRole('button', { name: /Approve and send 1 message/ })).toBeInTheDocument();

    // The refetch after a regeneration: Ana's attempt is attempt 2 with a NEW
    // outreachId. A surviving stale id would refuse the whole approval
    // `unknown_exclusion`, so it must be dropped and Ana re-counted.
    const regenerated = { ...rendered('9', 'Ana'), askId: 'ask-1', attemptNo: 2 };
    rerender(<ApprovalPanel {...props({ attempts: [regenerated, rendered('2', 'Bo')] })} />);

    expect(screen.getByRole('button', { name: /Approve and send 2 messages/ })).toBeInTheDocument();
  });

  it('says the owner may ask for a new version but may not write one', () => {
    render(<ApprovalPanel {...props({ attempts: [rendered('1', 'Ana')] })} />);

    // D22 survives #860 and the panel has to keep saying so.
    expect(
      screen.getByText(/ask for a new version of any message, but you cannot write one yourself/i),
    ).toBeInTheDocument();
  });

  describe('invariants', () => {
    it('property: pruning an exclusion set never keeps an id absent from the sendable rows', () => {
      fc.assert(
        fc.property(
          fc.array(fc.uuid()),
          fc.array(fc.uuid()),
          (excludedIds, liveIds) => {
            const rows = liveIds.map((id) => ({ ...rendered('1', 'Ana'), outreachId: id }));
            const pruned = pruneExclusions(new Set(excludedIds), rows);

            for (const id of pruned) expect(liveIds).toContain(id);
            // And nothing live was dropped: pruning removes, never filters down
            // an owner's live deselections.
            for (const id of excludedIds) {
              if (liveIds.includes(id)) expect(pruned.has(id)).toBe(true);
            }
          },
        ),
      );
    });
  });
```

Write `'reports that nothing changed when a regeneration settles without a new attempt'` by rerendering with `regeneratingAskId` back to `null` and the SAME `attemptNo`, asserting `onChanged` received the "could not write a new version" sentence; and rerendering with an incremented `attemptNo`, asserting it did not.

Add a `props()` helper if the file does not have one, so these eleven do not each spell the full prop set.

- [ ] **Step 12: Run and commit**

```bash
pnpm vitest run 'src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx'
git add -A && git commit -m "feat(860): per-ask regenerate control, budget counter and exclusion pruning"
```

Expected: PASS, 0 todo repo-wide.

---

## After the last task

1. Run the full gate: `bash scripts/verify-gate.sh` (then `--review` before step 7). `db_touching` is true, so it provisions the test DB itself — never add `test:db:setup` to `verification_commands`.
2. `pnpm ci:tenant-scope && pnpm ci:rls-audit` are in the gate's audit set; if `ci:tenant-scope` flags the `job_outbox` read, **stop** — that contradicts deviations D3 and means the audit's table list changed under us.
3. Step 6 reads the deviations file end to end and logs ACCEPT / RE-PLAN per entry.
4. Step 8 lane is **RISK = high**: ride `staging` first. The feature ships **inert** — `SOLICITATION_SEND_ENABLED` is unset everywhere, so the verification is that the Requests screen stays byte-identical to watch-mode. Do not flip the flag: `assertSolicitationSendEnv` would crash the staging worker, and standing up the send identity is #633.

## Self-review

**Spec coverage.** Issue #860 asks for three things: the route + owner affordance (Tasks 4, 6), the 3/day budget UI (Tasks 3, 5, 6), and the (a)/(b) decision with tests pinning it (Task 2, plus the property test). The glossary update it names is Task 2, Step 9. All four covered.

**Type consistency.** `RequestAskRegenerationResult` (Task 4) is imported by the route (Task 4, Step 5) and by `LaneStatus` (Task 6, Step 5). `RegenBudgetStatus` flows `tracker.ts` (Task 3) → `SendLaneView` (Task 5) → `SelectableAskListProps` (Task 6). `isRegenerableBatchState` is defined and exported in Task 2 and used by its own property test only. `pruneExclusions` is defined in Task 6, Step 4 and used in Step 11. `regeneratingAskId` and `regenBudgets` are named identically in Tasks 1 (fixture), 5 (definition) and 6 (consumption).

**Known soft spots, flagged rather than papered over.** Task 4, Step 6 assumes `seedRenderedBatch` returns `sendParentRunId`, `asks[]` and an `outreachSnapshot`; the step says to read the real signature and adapt the tests rather than change the helper. Task 6, Step 10 gives CSS structure but not final values — the `repworth-brand-design` Console reference owns those and must be read first.
