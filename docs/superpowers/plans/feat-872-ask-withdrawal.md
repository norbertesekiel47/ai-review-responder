# Ask withdrawal (#872) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the owner an **Ask withdrawal** — cancel ONE approved Ask's live **Outreach row** (`rendered`/`queued` → `cancelled`/`owner_withdrawn`) in every **Batch state** where the **Halt latch** would cancel that row (`veto_window`, `approved`, `sending`), so one contact is lost instead of the whole cohort. Withdrawing the last live row settles the batch through `closeBatchIfSettled`.

**Architecture:** One new owner verb `withdrawAsk` appended to `src/lib/solicitation/approval.ts` (same `(sql, input) → discriminated result` interface as `haltBatch`; shares `lockBatchForAction`; B11 lock order; `recordStep` then `closeBatchIfSettled` in one transaction). One additive migration (109) widens the outreach status/reason CHECK's cancel arm by `owner_withdrawn`. One thin route (`batch/withdraw`) over the existing `withScopedBatch` adapter, sharing a hoisted `{ batchId, askId }` body reader with `regenerate`. The Requests panel's `askDisplay` facet gains a `withdrawable` value that renders a new `WithdrawableAskList` (per-row `Withdraw` control behind an inline two-tap confirm); the read-only `AskList` keeps its "structurally no controls" property.

**Tech Stack:** Next.js 16 route handler, Postgres.js (`sql.begin`), run-spine `recordStep`, vitest (+ fast-check property, jsdom + Testing Library for the panel), live-DB integration suite (`describeWithDb`).

**Locked inputs (read these first, do not re-derive):**
- Intake: `docs/superpowers/plans/feat-872-ask-withdrawal-intake.json` (armed copy `.feature/intake.json`).
- Glossary: `CONTEXT.md` → **Ask withdrawal**, **Ask exclusion**, **Halt latch**, **Owner approval**, **Settled batch**, **Batch state**.
- Decision record: `docs/adr/0021-ask-withdrawal-is-restraint-not-reapproval.md`.
- Deviations: `docs/superpowers/plans/feat-872-ask-withdrawal-deviations.md` (D1: feat-865 lands first; #872 rebases).

**Seams (codebase-design):** `approval.ts` — deepened (one more verb, no interface change beyond the new export). `_shared/scoped-batch-route.ts` — deepened (the `{batchId, askId}` reader gains a second caller and moves in). `ApprovalPanel.tsx` — `AskDisplay` gains one value; `useLaneWrites` gains one write. `AskList.tsx` — one sibling component. `run-spine.ts` — one step key. `batch-view.ts` — untouched (rows already carry `askId`, `deliveryStatus`; cancelled rows are already filtered out, so a withdrawn row leaves the list by construction).

---

## Task map and blocking edges

| # | Task | Blocks on | Files (disjoint sets marked) | Turns green |
|---|---|---|---|---|
| 1 | Eval task — every promised test, failing | — | the four test files + `schema-ready` NOT touched (see Task 2 note) | nothing yet |
| 2 | Migration 109 + step key + `withdrawAsk` | 1 | `supabase/migrations/109_*.sql`, `.claude/reference/migrations-log.md`, `src/lib/agents/run-spine.ts`, `src/lib/solicitation/approval.ts` | integration + unit titles |
| 3 | Shared reader + withdraw route + directory row | 2 | `_shared/scoped-batch-route.ts`, `regenerate/route.ts`, `withdraw/route.ts`, `docs/directory.md` | route titles |
| 4 | Panel: `WithdrawableAskList` + wiring + copy + CSS | 2 | `AskList.tsx`, `ApprovalPanel.tsx`, `requests.css` | panel titles |
| 5 | Docs sweep + handoff | 3, 4 | `.claude/CLAUDE.md`, `docs/directory.md` (approval.ts row), handoff | — |

**Tasks 3 and 4 are mutually independent** (no edge between them, disjoint file sets) — dispatch in parallel after Task 2 lands. Task 1 runs alone first (enforcement spot check).

**Verbatim `tests_to_add` titles → file:**

| Title | File |
|---|---|
| withdraws one rendered ask owner_withdrawn in the same transaction and records ask_withdrawn on the send parent | `approval.integration.test.ts` |
| withdrawal is legal in veto_window, approved and sending and refused in built, halted and closed | `approval.integration.test.ts` |
| never withdraws a sending row and reports it not_live | `approval.integration.test.ts` |
| withdrawing the last live ask closes the batch exhausted and terminalizes the send parent completed | `approval.integration.test.ts` |
| a second withdrawal of the same ask is a no-op already_withdrawn that writes nothing | `approval.integration.test.ts` |
| an ask from another batch or tenant is not_found and nothing is written | `approval.integration.test.ts` |
| a withheld current attempt is not_live and nothing is written | `approval.integration.test.ts` |
| withdrawal never touches solicitation_asks or the batch approval columns | `approval.integration.test.ts` |
| the status reason CHECK admits owner_withdrawn only under cancelled | `approval.integration.test.ts` |
| withdrawable states are exactly the halt-cancellable states of an approved batch | `approval.test.ts` (fast-check) |
| withdrawAsk cancels only rendered or queued rows of the ask under the batch and tenant keys | `approval.test.ts` (query pin) |
| withdraw route maps withdrawn and already_withdrawn to 200, not_withdrawable and not_live to 409, not_found to 404 | `approval-routes.test.ts` |
| withdraw route answers 404 to a body without a valid batchId and askId | `approval-routes.test.ts` |
| withdraw wire never carries the send parent run id | `approval-routes.test.ts` |
| post-approval rows show Withdraw and the first tap asks for confirmation instead of posting | `approval-panel.test.tsx` |
| confirming a withdrawal posts batchId and askId and announces the remaining count | `approval-panel.test.tsx` |
| Keep reverts the pending confirmation without posting | `approval-panel.test.tsx` |
| no Withdraw control renders before approval | `approval-panel.test.tsx` |

---

## The domain contract (shared by every task)

```ts
// src/lib/solicitation/approval.ts — appended after requestAskRegeneration

/** The three Batch states in which the Halt latch would cancel a rendered/queued
 *  row — i.e. an approved batch that is neither halted nor closed. Pure, so the
 *  panel and the property test can share it. */
export function isWithdrawableState(state: BatchState): boolean {
  return state === 'veto_window' || state === 'approved' || state === 'sending';
}

/** The ask's CURRENT attempt as the verb reads it under the lock: null when the
 *  ask has no attempt at all. */
export interface CurrentAttempt {
  deliveryStatus: string;
  dispositionReason: string | null;
}

/** The decision, pure. `withdrawAsk` reads the batch state and the current
 *  attempt under the lock, then applies THIS and writes only on `withdraw`.
 *  Extracted so the whole state × attempt-status matrix is one property test
 *  rather than fifteen DB cases (plan review round 1, finding 1/3). */
export type WithdrawalDecision =
  | { kind: 'withdraw' }
  | { kind: 'already_withdrawn' }
  | { kind: 'not_withdrawable'; state: BatchState }
  | { kind: 'not_live'; deliveryStatus: string | null };

export function classifyWithdrawal(
  state: BatchState,
  attempt: CurrentAttempt | null,
): WithdrawalDecision {
  // Idempotence FIRST, before the state gate: withdrawing the last live row
  // closes the batch, so a retry on that very row arrives in `closed` — it is
  // still "already withdrawn" (a fact about the row) and must answer the 200
  // no-op, not a 409 (plan review round 2, finding 1).
  if (attempt?.deliveryStatus === 'cancelled' && attempt.dispositionReason === 'owner_withdrawn') {
    return { kind: 'already_withdrawn' };
  }
  if (!isWithdrawableState(state)) return { kind: 'not_withdrawable', state };
  if (attempt === null) return { kind: 'not_live', deliveryStatus: null };
  if (attempt.deliveryStatus === 'rendered' || attempt.deliveryStatus === 'queued') {
    return { kind: 'withdraw' };
  }
  return { kind: 'not_live', deliveryStatus: attempt.deliveryStatus };
}
```

The verb therefore reads the current attempt BEFORE it refuses on state (the batch is already proven the tenant's by `lockBatchForAction`, so the extra read on a refused state leaks nothing).

```ts
export interface WithdrawAskInput {
  batchId: string;
  askId: string;
  accountId: string;
  businessId: string;
  /** The acting owner, recorded on the run step. */
  withdrawnByUserId: string;
}

export type WithdrawAskResult =
  | {
      status: 'withdrawn';
      /** Rows still `rendered`/`queued`/`sending` in this batch AFTER the withdrawal. */
      remainingLive: number;
      close: CloseBatchIfSettledResult;
    }
  /** The ask's current attempt is already `cancelled`/`owner_withdrawn`: a double
   *  tap or a stale tab. Nothing is written. */
  | { status: 'already_withdrawn' }
  /** The batch is not in a withdrawable state (`pending`/`built`/`expired`/`halted`/`closed`). */
  | { status: 'not_withdrawable'; state: BatchState }
  /** The ask exists in this batch but its current attempt is not `rendered`/`queued`
   *  (`sending`/`sent`/`withheld`/`failed`/`unknown`/cancelled-for-another-reason),
   *  or it has no attempt at all (`null`). Nothing is written. */
  | { status: 'not_live'; deliveryStatus: string | null }
  /** Unknown batch, or ask not in this batch, or foreign tenant — indistinguishable. */
  | { status: 'not_found' };
```

Wire shape (route): `withdrawn` → `{ status, remainingLive, closed }` 200 · `already_withdrawn` → `{ status }` 200 · `not_withdrawable` → `{ status, state }` 409 · `not_live` → `{ status }` 409 (the row's status stays server-side; the panel has one sentence for it) · `not_found` → `errorResponse('Not found', 404)`.

Panel body: `POST /api/dashboard/solicitation/batch/withdraw` with `{ batchId, askId }`, `in_place` refetch.

---

### Task 1: Eval task — author every promised test, failing

**Files:**
- Modify: `src/lib/solicitation/__tests__/approval.integration.test.ts` (append a `describe('withdrawAsk')` block inside the existing `describeWithDb`, after `describe('haltBatch')`; add one `beforeAll` precondition + one helper)
- Modify: `src/lib/solicitation/__tests__/approval.test.ts` (one property in `describe('invariants')`, one new `describe('withdrawAsk query shapes')`)
- Modify: `src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts` (new `describe('POST /api/dashboard/solicitation/batch/withdraw')`)
- Modify: `src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx` (new `describe('withdraw control')`)

Precedents to read first: `describe('haltBatch')` in the integration file (`:915-1076`), `describe('invariants')` and `describe('approveBatch query shapes')` in the unit file, `describe('POST /api/dashboard/solicitation/batch/halt')` in the routes file, `it('stops the batch and sends no reason of its own')` in the panel file.

- [ ] **Step 1: Integration — precondition + helper.** In `approval.integration.test.ts`, add after `stampClosedBatch` (`:380-393`):

```ts
/** An approved batch inside its veto window — the state the panel calls
 *  `haltable` and the first of the three withdrawable states. */
async function stampVetoWindowBatch(batchId: string): Promise<void> {
  await sql()`
    UPDATE solicitation_batches
    SET approved_at = NOW() - INTERVAL '2 minutes',
        approval_method = 'owner',
        approved_by_user_id = ${userId()}::uuid,
        veto_deadline_at = NOW() + INTERVAL '13 minutes'
    WHERE id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
}

/** An approved batch whose veto window has elapsed and whose drip has not
 *  started — Batch state `approved`. */
async function stampApprovedBatch(batchId: string): Promise<void> {
  await sql()`
    UPDATE solicitation_batches
    SET approved_at = NOW() - INTERVAL '20 minutes',
        approval_method = 'owner',
        approved_by_user_id = ${userId()}::uuid,
        veto_deadline_at = NOW() - INTERVAL '5 minutes'
    WHERE id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
}

/** An auto-lane approval (#631's shape): `approval_method='auto_policy'`,
 *  no acting user. Withdrawal must not gate on the method. */
async function stampAutoApprovedBatch(batchId: string): Promise<void> {
  await sql()`
    UPDATE solicitation_batches
    SET approved_at = NOW() - INTERVAL '2 minutes',
        approval_method = 'auto_policy',
        approved_by_user_id = NULL,
        veto_deadline_at = NOW() + INTERVAL '58 minutes'
    WHERE id = ${batchId}::uuid
      AND account_id = ${accountId()}::uuid
      AND business_id = ${businessId}::uuid
  `;
}

/** The live status/reason CHECK, as Postgres renders it. */
async function statusReasonDefinition(db: postgresType.Sql): Promise<string> {
  const [row] = await db<{ definition: string }[]>`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conname = 'solicitation_outreach_status_reason_consistency'
      AND conrelid = 'solicitation_outreach'::regclass
  `;
  return row?.definition ?? '';
}

/** 109 REPLACES 108's status/reason CHECK under the SAME NAME, so
 *  `assertSchemaReady` cannot tell them apart (see the 108 note in
 *  schema-ready.ts). The distinguishing fact is the new member, and the only
 *  honest precondition is the constraint's DEFINITION — the same technique
 *  `assertAnalyticsEventNamesRegistered` uses. It asserts the value appears
 *  EXACTLY once and inside the `cancelled` arm, so a malformed 109 that admits
 *  it under another status fails here, loudly, not in a later UPDATE. Local to
 *  this suite because it is the only writer of the value. */
async function assertOwnerWithdrawnAdmitted(db: postgresType.Sql): Promise<void> {
  const definition = await statusReasonDefinition(db);
  const occurrences = definition.split(`'owner_withdrawn'`).length - 1;
  // Postgres renders `x IN (…)` as `x = ANY (ARRAY[…])`; the cancelled arm is
  // the one whose status literal is 'cancelled'.
  const cancelledArm = /delivery_status = 'cancelled'::text\)\s*AND\s*\(disposition_reason = ANY \(ARRAY\[[^\]]*\]/.exec(
    definition,
  );
  if (occurrences === 1 && cancelledArm !== null && cancelledArm[0].includes(`'owner_withdrawn'`)) {
    return;
  }
  throw new Error(
    'test database is behind head or 109 is malformed — ' +
      `solicitation_outreach_status_reason_consistency admits 'owner_withdrawn' ${occurrences} time(s) ` +
      `(${cancelledArm === null ? 'no cancelled arm found' : 'cancelled arm: ' + cancelledArm[0]}). ` +
      'Run `pnpm test:db:setup`.',
  );
}

/**
 * Every table a withdrawal may touch, as text, so a REFUSAL can be proven to
 * have written NOTHING — not just nothing on `solicitation_outreach`.
 * postgres.js commits on a normal callback return, so a refusal that had
 * already updated the batch, an ask or a step would commit that write while
 * reporting a refusal (plan review round 1, finding 4).
 */
async function snapshotWithdrawSurface(
  batchId: string,
  parentRunId: string,
): Promise<{ batch: string; outreach: string[]; asks: string; steps: string }> {
  const [asks] = await sql()<{ snapshot: string }[]>`
    SELECT COALESCE(string_agg(a::text, '|' ORDER BY a.id), '') AS snapshot
    FROM solicitation_asks a
    WHERE a.batch_id = ${batchId}::uuid
      AND a.account_id = ${accountId()}::uuid
      AND a.business_id = ${businessId}::uuid
  `;
  const [steps] = await sql()<{ snapshot: string }[]>`
    SELECT COALESCE(string_agg(s::text, '|' ORDER BY s.step_index), '') AS snapshot
    FROM agent_run_steps s
    WHERE s.agent_run_id = ${parentRunId}::uuid
  `;
  return {
    batch: await snapshotBatch(batchId),
    outreach: await snapshotOutreach(batchId),
    asks: asks?.snapshot ?? '',
    steps: steps?.snapshot ?? '',
  };
}
```

  Extend `readBatch` (`:318-338`) so `BatchApprovalRow` also carries `approved_by_user_id: string | null` and `veto_deadline_at: string | null`, selected as `approved_by_user_id::text` and `veto_deadline_at::text` — the approval quartet must be assertable byte-for-byte. Add `abortingExecutor` to the imports: `import { abortingExecutor } from '@/lib/shared/__tests__/helpers/abort-injection';`.

  and in the `beforeAll` (`:476-486`), directly after the `assertSchemaReady(...)` call:

```ts
    await assertOwnerWithdrawnAdmitted(db);
```

  Add `withdrawAsk` to the `'../approval'` import at `:31-36`.

- [ ] **Step 2: Integration — the nine cases.** Append inside the `describeWithDb` callback, after `describe('haltBatch', …)`'s closing `});`:

```ts
  describe('withdrawAsk', () => {
    function withdraw(
      batch: RenderedBatch,
      askId: string,
      overrides: Partial<{ accountId: string; businessId: string; batchId: string }> = {},
    ) {
      return withdrawAsk(sql(), {
        batchId: overrides.batchId ?? batch.batchId,
        askId,
        accountId: overrides.accountId ?? batch.accountId,
        businessId: overrides.businessId ?? batch.businessId,
        withdrawnByUserId: batch.userId,
      });
    }

    it('withdraws one rendered ask owner_withdrawn in the same transaction and records ask_withdrawn on the send parent', async () => {
      const batch = await seedRenderedBatch({ renders: 3 });
      await stampVetoWindowBatch(batch.batchId);
      const target = batch.asks[0]!;

      const result = await withdraw(batch, target.askId);

      expect(result).toMatchObject({
        status: 'withdrawn',
        remainingLive: 2,
        close: { status: 'not_settled', liveCount: 2 },
      });
      const rows = await readOutreach(batch.batchId);
      expect(rows.find((row) => row.id === batch.outreachIds[0])).toMatchObject({
        delivery_status: 'cancelled',
        disposition_reason: 'owner_withdrawn',
      });
      // The two untouched rows are still live — one row, not the cohort.
      expect(rows.filter((row) => row.delivery_status === 'rendered')).toHaveLength(2);

      const steps = await readSteps(batch.parentRunId, 'ask_withdrawn');
      expect(steps).toHaveLength(1);
      expect(stepDetail(steps[0]!)).toMatchObject({
        ask_id: target.askId,
        outreach_id: batch.outreachIds[0],
        withdrawn_by: batch.userId,
        delivery_status_before: 'rendered',
        remaining_live: 2,
        state_at_withdrawal: 'veto_window',
      });
      // The batch is still approved and its veto clock untouched: no per-ask
      // approval state, no re-minted deadline (ADR 0021 property 2).
      const after = await readBatch(batch.batchId);
      expect(after.approved_at).not.toBeNull();
      expect(after.gap_minutes).toBe(15);
      expect(after.send_closed_at).toBeNull();
    });

    it('withdrawal is legal in veto_window, approved and sending and refused in built, halted and closed', async () => {
      // Three separate batches so the one-active-send index never contends.
      const inVeto = await seedRenderedBatch({ renders: 1 });
      await stampVetoWindowBatch(inVeto.batchId);
      const halted = await seedRenderedBatch({ renders: 1 });
      const built = await seedRenderedBatch({ renders: 1 });
      const closed = await seedRenderedBatch({ renders: 1 });
      await stampClosedBatch(closed.batchId);
      // Past the 7-day approval window and never approved: `expired`.
      const expired = await seedRenderedBatch({ renders: 1, builtAgo: '8 days' });
      const refusedBefore = {
        built: await snapshotWithdrawSurface(built.batchId, built.parentRunId),
        closed: await snapshotWithdrawSurface(closed.batchId, closed.parentRunId),
        expired: await snapshotWithdrawSurface(expired.batchId, expired.parentRunId),
      };

      expect(await withdraw(inVeto, inVeto.asks[0]!.askId)).toMatchObject({ status: 'withdrawn' });
      // The veto batch is now settled (its only row is gone), so a second
      // batch may take the active-send slot for the `approved` case.
      const approved = await seedRenderedBatch({ renders: 1 });
      await stampApprovedBatch(approved.batchId);
      expect(await withdraw(approved, approved.asks[0]!.askId)).toMatchObject({ status: 'withdrawn' });
      const sending = await seedRenderedBatch({ renders: 1 });
      await stampSendingBatch(sending.batchId);
      expect(await withdraw(sending, sending.asks[0]!.askId)).toMatchObject({ status: 'withdrawn' });

      // Halt the `halted` fixture through the real latch, then probe it.
      await haltBatch(sql(), {
        batchId: halted.batchId,
        accountId: halted.accountId,
        businessId: halted.businessId,
        haltedByUserId: halted.userId,
      });
      // Snapshot AFTER the halt so the refusal below is judged against the
      // latched, settled state the halt left behind.
      const haltedBefore = await snapshotWithdrawSurface(halted.batchId, halted.parentRunId);
      expect(await withdraw(halted, halted.asks[0]!.askId)).toEqual({
        status: 'not_withdrawable',
        state: 'halted',
      });
      expect(await snapshotWithdrawSurface(halted.batchId, halted.parentRunId)).toEqual(haltedBefore);
      expect(await withdraw(built, built.asks[0]!.askId)).toEqual({
        status: 'not_withdrawable',
        state: 'built',
      });
      expect(await withdraw(closed, closed.asks[0]!.askId)).toEqual({
        status: 'not_withdrawable',
        state: 'closed',
      });
      expect(await withdraw(expired, expired.asks[0]!.askId)).toEqual({
        status: 'not_withdrawable',
        state: 'expired',
      });
      // A refusal writes NOTHING — batch, outreach, asks and steps alike.
      expect(await snapshotWithdrawSurface(built.batchId, built.parentRunId)).toEqual(refusedBefore.built);
      expect(await snapshotWithdrawSurface(closed.batchId, closed.parentRunId)).toEqual(refusedBefore.closed);
      expect(await snapshotWithdrawSurface(expired.batchId, expired.parentRunId)).toEqual(refusedBefore.expired);
    });

    it('withdraws a queued current attempt in an approved batch', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      const queuedAsk = await seedSendAsk(batch.batchId, batch.uploadId);
      const queuedId = await seedAttempt({ batchId: batch.batchId, ask: queuedAsk, deliveryStatus: 'queued' });
      await stampSendingBatch(batch.batchId);

      const result = await withdraw(batch, queuedAsk.askId);

      // `queued` is dispatched-but-not-sending: halt cancels it, so withdrawal
      // does too — the same predicate, one row.
      expect(result).toMatchObject({ status: 'withdrawn', remainingLive: 1 });
      expect((await readOutreach(batch.batchId)).find((row) => row.id === queuedId)).toMatchObject({
        delivery_status: 'cancelled',
        disposition_reason: 'owner_withdrawn',
      });
      expect(await readSteps(batch.parentRunId, 'ask_withdrawn')).toHaveLength(1);
    });

    it('never withdraws a sending row and reports it not_live', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      const sendingAsk = await seedSendAsk(batch.batchId, batch.uploadId);
      const sendingId = await seedAttempt({
        batchId: batch.batchId,
        ask: sendingAsk,
        deliveryStatus: 'sending',
      });
      await stampSendingBatch(batch.batchId);
      const before = await snapshotWithdrawSurface(batch.batchId, batch.parentRunId);

      const result = await withdraw(batch, sendingAsk.askId);

      // Past the point of no return: halt's "no further sends, not undo"
      // contract, inherited whole.
      expect(result).toEqual({ status: 'not_live', deliveryStatus: 'sending' });
      expect(await snapshotWithdrawSurface(batch.batchId, batch.parentRunId)).toEqual(before);
      expect((await readOutreach(batch.batchId)).find((row) => row.id === sendingId)).toMatchObject({
        delivery_status: 'sending',
      });
    });

    it('withdrawing the last waiting row does not settle while another outreach row is sending', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      const sendingAsk = await seedSendAsk(batch.batchId, batch.uploadId);
      await seedAttempt({ batchId: batch.batchId, ask: sendingAsk, deliveryStatus: 'sending' });
      await stampSendingBatch(batch.batchId);

      const result = await withdraw(batch, batch.asks[0]!.askId);

      // The in-flight row keeps the batch open: `remainingLive` counts it, and
      // the join reports `not_settled` — the row that resolves itself is the
      // one that will close the batch.
      expect(result).toMatchObject({
        status: 'withdrawn',
        remainingLive: 1,
        close: { status: 'not_settled', liveCount: 1 },
      });
      expect((await readBatch(batch.batchId)).send_closed_at).toBeNull();
      expect(await readRunStatus(batch.parentRunId)).toBe('running');
    });

    it('withdrawal selects the highest attempt_no and never an older superseded attempt', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      const ask = batch.asks[0]!;
      const olderId = batch.outreachIds[0]!;
      // The render lane's regenerate shape: the old row is `cancelled`/`superseded`,
      // the replacement is attempt 2 and live.
      await sql()`
        UPDATE solicitation_outreach
        SET delivery_status = 'cancelled', disposition_reason = 'superseded', updated_at = NOW()
        WHERE id = ${olderId}::uuid
          AND account_id = ${batch.accountId}::uuid
          AND business_id = ${batch.businessId}::uuid
      `;
      const newerId = await seedAttempt({ batchId: batch.batchId, ask, deliveryStatus: 'rendered', attemptNo: 2 });
      await stampVetoWindowBatch(batch.batchId);

      const result = await withdraw(batch, ask.askId);

      expect(result).toMatchObject({ status: 'withdrawn' });
      const rows = await readOutreach(batch.batchId);
      // Only the CURRENT attempt changes; the superseded one keeps its own reason.
      expect(rows.find((row) => row.id === newerId)).toMatchObject({
        delivery_status: 'cancelled',
        disposition_reason: 'owner_withdrawn',
      });
      expect(rows.find((row) => row.id === olderId)).toMatchObject({
        delivery_status: 'cancelled',
        disposition_reason: 'superseded',
      });
    });

    it('an ask in the owned batch with no outreach attempt is not_live with null status and writes nothing', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      // A second send Ask that generation never rendered — no attempt row at all.
      const bare = await seedSendAsk(batch.batchId, batch.uploadId);
      await stampVetoWindowBatch(batch.batchId);
      const before = await snapshotWithdrawSurface(batch.batchId, batch.parentRunId);

      const result = await withdraw(batch, bare.askId);

      // Told apart from `not_found`: the ask IS in this batch, it just has
      // nothing to withdraw — and the LEFT JOIN must not fall back to another
      // ask's row.
      expect(result).toEqual({ status: 'not_live', deliveryStatus: null });
      expect(await snapshotWithdrawSurface(batch.batchId, batch.parentRunId)).toEqual(before);
    });

    it('withdrawing the last live ask closes the batch exhausted and terminalizes the send parent completed', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      await stampVetoWindowBatch(batch.batchId);

      const result = await withdraw(batch, batch.asks[0]!.askId);

      // Same close as excluding every ask at approval: `exhausted`, parent
      // `completed`, and the join ran in THIS transaction (no separate call).
      expect(result).toMatchObject({
        status: 'withdrawn',
        remainingLive: 0,
        close: { status: 'closed', disposition: 'exhausted', parentStatus: 'completed' },
      });
      expect((await readBatch(batch.batchId)).send_closed_at).not.toBeNull();
      expect(await readRunStatus(batch.parentRunId)).toBe('completed');
      expect(await readSteps(batch.parentRunId, 'send_batch_closed')).toHaveLength(1);
    });

    it('a second withdrawal of the same ask is a no-op already_withdrawn that writes nothing', async () => {
      const batch = await seedRenderedBatch({ renders: 2 });
      await stampVetoWindowBatch(batch.batchId);
      const askId = batch.asks[0]!.askId;

      const first = await withdraw(batch, askId);
      const afterFirst = await snapshotWithdrawSurface(batch.batchId, batch.parentRunId);
      const second = await withdraw(batch, askId);

      expect(first).toMatchObject({ status: 'withdrawn' });
      expect(second).toEqual({ status: 'already_withdrawn' });
      // Idempotent means no observable second effect on ANY table — one step,
      // not two, and nothing on the batch, the asks or the outreach rows.
      expect(await snapshotWithdrawSurface(batch.batchId, batch.parentRunId)).toEqual(afterFirst);
      expect(await readSteps(batch.parentRunId, 'ask_withdrawn')).toHaveLength(1);
    });

    it('a second withdrawal after the first withdrawal settled the batch is already_withdrawn and writes nothing', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      await stampVetoWindowBatch(batch.batchId);
      const askId = batch.asks[0]!.askId;

      const first = await withdraw(batch, askId);
      const afterFirst = await snapshotWithdrawSurface(batch.batchId, batch.parentRunId);
      const second = await withdraw(batch, askId);

      // The first withdrawal CLOSED the batch (last live row). The retry
      // arrives in Batch state `closed` and must still read as already
      // withdrawn — a fact about the row that outranks the state gate — not
      // as a 409 `not_withdrawable` (plan review round 2, finding 1).
      expect(first).toMatchObject({ status: 'withdrawn', close: { status: 'closed' } });
      expect(second).toEqual({ status: 'already_withdrawn' });
      expect(await snapshotWithdrawSurface(batch.batchId, batch.parentRunId)).toEqual(afterFirst);
    });

    it('an ask from another batch or tenant is not_found and nothing is written', async () => {
      const mine = await seedRenderedBatch({ renders: 1 });
      await stampVetoWindowBatch(mine.batchId);
      const other = await seedRenderedBatch({ renders: 1 });
      const foreign = foreignTenantSeed();
      const mineBefore = await snapshotWithdrawSurface(mine.batchId, mine.parentRunId);
      const otherBefore = await snapshotWithdrawSurface(other.batchId, other.parentRunId);

      // Right batch, an ask that lives in ANOTHER batch of the same tenant.
      const crossBatch = await withdraw(mine, other.asks[0]!.askId);
      // Right batch and ask, wrong account key (`TenantSeed` carries the
      // account only; the batch's own business id with a foreign account is
      // exactly the mismatch the composite scope must refuse).
      const crossTenant = await withdraw(mine, mine.asks[0]!.askId, {
        accountId: foreign.accountId,
      });
      // Right owner, reaching for a batch under their OTHER location.
      const siblingLocation = await withdraw(mine, mine.asks[0]!.askId, {
        businessId: siblingBusinessId,
      });
      // An id that exists nowhere.
      const unknown = await withdraw(mine, randomUUID());

      // All four are the SAME public result — a probe cannot tell a foreign
      // account, another location, an other-batch ask or an unknown id apart.
      // The two boundaries are this suite's `tenant scope` precedent: the
      // foreign ACCOUNT against an owned batch, and the right owner reaching
      // for their OTHER location; the ask-key mismatch is `crossBatch`. (No
      // foreign batch is seeded — the suite's helpers are bound to the main
      // tenant, and a foreign ask id takes `crossBatch`'s path by construction:
      // the read is keyed on batch + both tenant keys.)
      for (const result of [crossBatch, crossTenant, siblingLocation, unknown]) {
        expect(result).toEqual({ status: 'not_found' });
      }
      // Both OWNED batches untouched on every table.
      expect(await snapshotWithdrawSurface(mine.batchId, mine.parentRunId)).toEqual(mineBefore);
      expect(await snapshotWithdrawSurface(other.batchId, other.parentRunId)).toEqual(otherBefore);
    });

    it('a withheld current attempt is not_live and nothing is written', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      const heldAsk = await seedSendAsk(batch.batchId, batch.uploadId);
      await seedAttempt({
        batchId: batch.batchId,
        ask: heldAsk,
        deliveryStatus: 'withheld',
        dispositionReason: 'lint_failed',
      });
      // A cancelled-for-another-reason attempt (a superseded row with no
      // live replacement) is also not withdrawable — and NOT idempotent-ok:
      // only `owner_withdrawn` says "already withdrawn".
      const supersededAsk = await seedSendAsk(batch.batchId, batch.uploadId);
      await seedAttempt({
        batchId: batch.batchId,
        ask: supersededAsk,
        deliveryStatus: 'cancelled',
        dispositionReason: 'superseded',
      });
      await stampVetoWindowBatch(batch.batchId);
      const before = await snapshotWithdrawSurface(batch.batchId, batch.parentRunId);

      const held = await withdraw(batch, heldAsk.askId);
      const superseded = await withdraw(batch, supersededAsk.askId);

      expect(held).toEqual({ status: 'not_live', deliveryStatus: 'withheld' });
      expect(superseded).toEqual({ status: 'not_live', deliveryStatus: 'cancelled' });
      expect(await snapshotWithdrawSurface(batch.batchId, batch.parentRunId)).toEqual(before);
    });

    it('withdrawal rolls back the outreach cancellation and the ask_withdrawn step when its transaction aborts', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      await stampVetoWindowBatch(batch.batchId);
      const before = await snapshotWithdrawSurface(batch.batchId, batch.parentRunId);
      // The poison must be a REAL Postgres error raised on the same tx AFTER
      // the writer's work (see abort-injection.ts): division by zero, 22012.
      const aborting = abortingExecutor(sql(), (tx) => tx`SELECT 1 / 0`);

      await expect(
        withdrawAsk(aborting, {
          batchId: batch.batchId,
          askId: batch.asks[0]!.askId,
          accountId: batch.accountId,
          businessId: batch.businessId,
          withdrawnByUserId: batch.userId,
        }),
      ).rejects.toMatchObject({ code: '22012' });

      // Cancellation, step AND the last-row close all disappear together —
      // proof that every write went through the ONE transaction handle.
      expect(await snapshotWithdrawSurface(batch.batchId, batch.parentRunId)).toEqual(before);
      expect((await readBatch(batch.batchId)).send_closed_at).toBeNull();
      expect(await readRunStatus(batch.parentRunId)).toBe('running');
    });

    it('auto_policy-approved batches allow the same withdrawal as owner-approved batches', async () => {
      const batch = await seedRenderedBatch({ renders: 2 });
      await stampAutoApprovedBatch(batch.batchId);

      const result = await withdraw(batch, batch.asks[0]!.askId);

      // No `approval_method` gate: withdrawal keys on Batch state, as halt does.
      expect(result).toMatchObject({ status: 'withdrawn', remainingLive: 1 });
      const after = await readBatch(batch.batchId);
      expect(after.approval_method).toBe('auto_policy');
      expect(after.approved_by_user_id).toBeNull();
    });

    it('withdrawal never touches solicitation_asks or the batch approval columns', async () => {
      const batch = await seedRenderedBatch({ renders: 2 });
      await stampVetoWindowBatch(batch.batchId);
      const asksBefore = await sql()<{ id: string; status: string; decided_at: string }[]>`
        SELECT id::text AS id, status, decided_at::text AS decided_at
        FROM solicitation_asks
        WHERE batch_id = ${batch.batchId}::uuid
          AND account_id = ${batch.accountId}::uuid
          AND business_id = ${batch.businessId}::uuid
        ORDER BY id
      `;
      const batchBefore = await readBatch(batch.batchId);

      await withdraw(batch, batch.asks[0]!.askId);

      const asksAfter = await sql()<{ id: string; status: string; decided_at: string }[]>`
        SELECT id::text AS id, status, decided_at::text AS decided_at
        FROM solicitation_asks
        WHERE batch_id = ${batch.batchId}::uuid
          AND account_id = ${batch.accountId}::uuid
          AND business_id = ${batch.businessId}::uuid
        ORDER BY id
      `;
      // The contact is NOT released: the ask keeps status='send' (090 welds
      // it), so a rebuild still sees it as a prior send — one contact's cost,
      // by design (ADR 0021).
      expect(asksAfter).toEqual(asksBefore);
      // The approval quartet, byte for byte: no per-ask approval state, no
      // re-minted deadline (ADR 0021 property 2).
      const batchAfter = await readBatch(batch.batchId);
      expect(batchAfter).toEqual(batchBefore);
      expect(batchAfter.approved_at).not.toBeNull();
      expect(batchAfter.approved_by_user_id).toBe(batch.userId);
      expect(batchAfter.veto_deadline_at).not.toBeNull();
    });

    it('the status reason CHECK admits owner_withdrawn only under cancelled', async () => {
      const batch = await seedRenderedBatch({ renders: 1 });
      const outreachId = batch.outreachIds[0]!;

      // 109 is 108 plus exactly one value, in the cancelled arm: every 108
      // member is still admitted, and the new one appears once, there.
      const definition = await statusReasonDefinition(sql());
      for (const kept of [
        'moderation_high', 'render_failed', 'lint_failed', 'no_consent', 'suppressed', 'unsubscribed',
        'owner_veto', 'owner_halt', 'admin_halt', 'owner_excluded', 'batch_expired',
        'send_window_elapsed', 'superseded', 'send_failed', 'send_exhausted', 'send_indeterminate',
      ]) {
        expect(definition).toContain(`'${kept}'`);
      }
      expect(definition.split(`'owner_withdrawn'`).length - 1).toBe(1);
      const cancelledArm = /delivery_status = 'cancelled'::text\)\s*AND\s*\(disposition_reason = ANY \(ARRAY\[[^\]]*\]/.exec(
        definition,
      );
      expect(cancelledArm?.[0]).toContain(`'owner_withdrawn'`);

      // Legal pairing: cancelled + owner_withdrawn.
      await expect(
        sql()`
          UPDATE solicitation_outreach
          SET delivery_status = 'cancelled', disposition_reason = 'owner_withdrawn'
          WHERE id = ${outreachId}::uuid
            AND account_id = ${batch.accountId}::uuid
            AND business_id = ${batch.businessId}::uuid
        `,
      ).resolves.toBeDefined();
      // Illegal pairing: a live status may carry no reason at all.
      await expect(
        sql()`
          UPDATE solicitation_outreach
          SET delivery_status = 'rendered', disposition_reason = 'owner_withdrawn'
          WHERE id = ${outreachId}::uuid
            AND account_id = ${batch.accountId}::uuid
            AND business_id = ${batch.businessId}::uuid
        `,
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
```

  Check the shape of `readBatch`'s row (`BatchApprovalRow`, `:318-338`): it must expose `approved_at`, `approval_method`, `veto_deadline_at`, `send_closed_at` as `::text`. If `send_closed_at` is not selected there, add it to that reader's SELECT (test-file edit, inside surface).

- [ ] **Step 3: Unit — two properties + query pin.** In `approval.test.ts`, extend the import at `:31`: `import { approveBatch, classifyWithdrawal, isWithdrawableState, ownerHaltReason, withdrawAsk, type CurrentAttempt } from '../approval';` and add `import { BATCH_STATES } from '../outreach';` next to the existing `deriveBatchState` import. Add inside `describe('invariants')`:

```ts
  it('withdrawable states are exactly the halt-cancellable states of an approved batch', () => {
    const stamp = fc.option(fc.date({ min: new Date('2026-01-01'), max: new Date('2027-01-01') }), {
      nil: null,
    });
    fc.assert(
      fc.property(stamp, stamp, stamp, stamp, stamp, stamp, (built, approved, veto, sending, closed, halted) => {
        // The NULL-IMPLICATION arms of migration 091's send_ordering CHECK
        // (approval implies built; the veto deadline and sending both imply
        // approval) — the arms whose violation changes `deriveBatchState`'s
        // answer. Without them the generator emits a row with only
        // `sending_started_at` set, which derives `sending` (precedence) while
        // `approved_at` is null — a row no database can hold, and one that
        // fails a CORRECT implementation (plan review round 1, finding 1).
        // 091's CHRONOLOGICAL arms (approved >= built, closed >= approved, …)
        // are deliberately NOT modelled: this property never compares two
        // stamps against each other, only null-ness and the precedence, so
        // ordering cannot change its truth (round 2, defect 2 — the claim
        // "schema-valid" was too broad; this is the honest scope).
        fc.pre(approved === null || built !== null);
        fc.pre(veto === null || approved !== null);
        fc.pre(sending === null || approved !== null);
        fc.pre(closed === null || built !== null);
        const row: BatchLifecycleRow = {
          built_at: built,
          approved_at: approved,
          veto_deadline_at: veto,
          sending_started_at: sending,
          send_closed_at: closed,
          halted_at: halted,
        };
        // Halt is legal iff the batch is neither halted nor closed; withdrawal
        // is that AND approved. Stated on the TIMESTAMPS, not the state names,
        // so the property constrains the predicate against the lifecycle
        // rather than restating its own member list.
        const haltCancellable = halted === null && closed === null;
        return isWithdrawableState(deriveBatchState(row, EPOCH)) === (haltCancellable && approved !== null);
      }),
    );
  });

  it('property: withdrawal classification is exact for every batch state and current-attempt status', () => {
    const DELIVERY_STATUSES = [
      'rendered', 'queued', 'sending', 'sent', 'withheld', 'cancelled', 'failed', 'unknown',
    ] as const;
    const REASONS = [
      null, 'owner_withdrawn', 'owner_excluded', 'owner_veto', 'owner_halt', 'superseded',
      'lint_failed', 'moderation_high', 'send_failed', 'send_indeterminate',
    ] as const;
    const attempt = fc.option(
      fc.record({
        deliveryStatus: fc.constantFrom(...DELIVERY_STATUSES),
        dispositionReason: fc.constantFrom(...REASONS),
      }),
      { nil: null },
    );
    fc.assert(
      fc.property(fc.constantFrom(...BATCH_STATES), attempt, (state, current) => {
        const decision = classifyWithdrawal(state, current as CurrentAttempt | null);
        // Idempotence wins in EVERY state — a retry after a last-row close
        // arrives in `closed` and must still read as already withdrawn. Then:
        // the ONE mutation arm exists only for a withdrawable state AND a
        // waiting row; every other pair refuses without writing.
        if (current?.deliveryStatus === 'cancelled' && current.dispositionReason === 'owner_withdrawn') {
          return decision.kind === 'already_withdrawn';
        }
        if (!isWithdrawableState(state)) {
          return decision.kind === 'not_withdrawable' && decision.state === state;
        }
        if (current === null) return decision.kind === 'not_live' && decision.deliveryStatus === null;
        if (current.deliveryStatus === 'rendered' || current.deliveryStatus === 'queued') {
          return decision.kind === 'withdraw';
        }
        return decision.kind === 'not_live' && decision.deliveryStatus === current.deliveryStatus;
      }),
    );
  });
```

  The FIRST title must be exactly `'withdrawable states are exactly the halt-cancellable states of an approved batch'` — the promised-tests gate matches VERBATIM titles, so it carries no `property: ` prefix (the precedent's prefix is a convention, not a requirement). `BATCH_STATES` is the exported tuple in `outreach.ts:55-63`.

  Add a new describe after `describe('approveBatch query shapes')`:

```ts
describe('withdrawAsk query shapes', () => {
  it('withdrawAsk cancels only rendered or queued rows of the ask under the batch and tenant keys', async () => {
    const OUTREACH_ID = 'e0000000-0000-4000-8000-000000000001';
    const MIXED_CASE_ASK_ID = '0190ABCD-0000-7000-8000-00000000A5C1';
    sqlReturnQueue.push(
      // lockBatchForAction: an approved batch inside its veto window.
      mkTaggedResult([
        {
          built_at: new Date(EPOCH.getTime() - 60 * 60_000),
          approved_at: new Date(Date.now() - 60_000),
          veto_deadline_at: new Date(Date.now() + 14 * 60_000),
          sending_started_at: null,
          send_closed_at: null,
          halted_at: null,
          send_parent_run_id: SEND_PARENT_RUN_ID,
        },
      ]),
      // current attempt
      mkTaggedResult([{ outreach_id: OUTREACH_ID, delivery_status: 'rendered', disposition_reason: null }]),
      // the cancel UPDATE
      mkTaggedResult([{ id: OUTREACH_ID }]),
      // remaining live
      mkTaggedResult([{ live: 1 }]),
    );

    await expect(
      withdrawAsk(sql, {
        batchId: MIXED_CASE_BATCH_ID,
        askId: MIXED_CASE_ASK_ID,
        accountId: ACCOUNT_ID,
        businessId: BUSINESS_ID,
        withdrawnByUserId: OWNER_ID,
      }),
    ).resolves.toEqual({
      status: 'withdrawn',
      remainingLive: 1,
      close: { status: 'not_settled', liveCount: 2 },
    });

    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    expect(sqlCalls).toHaveLength(4);
    expect(sqlCalls.every((call) => call.inTransaction)).toBe(true);

    const cancel = sqlCalls[2]!;
    const cancelText = normalizedSql(cancel.text);
    expect(cancelText).toContain('UPDATE solicitation_outreach SET delivery_status = ?,');
    expect(cancelText).toContain('WHERE id = ?::uuid');
    expect(cancelText).toContain('AND batch_id = ?::uuid AND account_id = ?::uuid AND business_id = ?::uuid');
    expect(cancelText).toContain("AND delivery_status IN ('rendered', 'queued')");
    expect(cancel.values).toEqual([
      'cancelled',
      'owner_withdrawn',
      OUTREACH_ID,
      CANONICAL_BATCH_ID,
      ACCOUNT_ID,
      BUSINESS_ID,
    ]);

    // The step is recorded on the SEND PARENT, then the join runs — the B11
    // order (`recordStep` before `closeBatchIfSettled`), asserted by call order.
    expect(mocks.recordStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: SEND_PARENT_RUN_ID,
        stepKey: 'ask_withdrawn',
        detail: expect.objectContaining({
          ask_id: MIXED_CASE_ASK_ID.toLowerCase(),
          outreach_id: OUTREACH_ID,
          withdrawn_by: OWNER_ID,
          delivery_status_before: 'rendered',
          remaining_live: 1,
          state_at_withdrawal: 'veto_window',
        }),
      }),
    );
    expect(mocks.closeBatchIfSettled).toHaveBeenCalledWith(
      expect.anything(),
      { batchId: CANONICAL_BATCH_ID, accountId: ACCOUNT_ID, businessId: BUSINESS_ID },
    );
    expect(mocks.recordStep.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.closeBatchIfSettled.mock.invocationCallOrder[0]!,
    );
  });
});
```

  Note for the implementer of Task 2: the query pin FIXES the SQL text and value order of the cancel UPDATE — write the UPDATE to match (`SET delivery_status = ${'cancelled'}, disposition_reason = ${'owner_withdrawn'}, updated_at = NOW() WHERE id = … AND batch_id = … AND account_id = … AND business_id = … AND delivery_status IN ('rendered', 'queued') RETURNING id`). Parameterising the two literals is what makes `values` carry them; the `IN` list stays literal like `haltBatch`'s.

- [ ] **Step 4: Route tests.** In `approval-routes.test.ts`: add `mockWithdrawAsk: vi.fn()` to the hoisted block and to the `@/lib/solicitation/approval` mock (`withdrawAsk: (...args: unknown[]) => mockWithdrawAsk(...args)`); widen `post()`'s `path` union to `'approve' | 'halt' | 'regenerate' | 'withdraw'` and its default body: `path === 'regenerate' || path === 'withdraw' ? { batchId: BATCH_ID, askId: ASK_ID } : { batchId: BATCH_ID }`; import `POST as WITHDRAW` from `'../withdraw/route'` next to the other three; in `beforeEach` add `mockWithdrawAsk.mockResolvedValue({ status: 'withdrawn', remainingLive: 2, close: { status: 'not_settled', liveCount: 2 } });`. Then append:

```ts
describe('POST /api/dashboard/solicitation/batch/withdraw', () => {
  it('withdraw route maps withdrawn and already_withdrawn to 200, not_withdrawable and not_live to 409, not_found to 404', async () => {
    const withdrawn = await WITHDRAW(post('withdraw'));
    expect(withdrawn.status).toBe(200);
    await expect(withdrawn.json()).resolves.toEqual({
      status: 'withdrawn',
      remainingLive: 2,
      closed: false,
    });
    // The route passes EXACTLY these five keys — no reason, no status, nothing
    // the client could use to dictate what the audit row says.
    const [, input] = mockWithdrawAsk.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(Object.keys(input).sort()).toEqual([
      'accountId',
      'askId',
      'batchId',
      'businessId',
      'withdrawnByUserId',
    ]);
    expect(input).toMatchObject({ batchId: BATCH_ID, askId: ASK_ID, withdrawnByUserId: USER_ID });

    mockWithdrawAsk.mockResolvedValue({ status: 'already_withdrawn' });
    const repeat = await WITHDRAW(post('withdraw'));
    expect(repeat.status).toBe(200);
    await expect(repeat.json()).resolves.toEqual({ status: 'already_withdrawn' });

    mockWithdrawAsk.mockResolvedValue({ status: 'not_withdrawable', state: 'halted' });
    const halted = await WITHDRAW(post('withdraw'));
    expect(halted.status).toBe(409);
    await expect(halted.json()).resolves.toEqual({ status: 'not_withdrawable', state: 'halted' });

    mockWithdrawAsk.mockResolvedValue({ status: 'not_live', deliveryStatus: 'sent' });
    const notLive = await WITHDRAW(post('withdraw'));
    expect(notLive.status).toBe(409);
    // The row's status stays server-side; the panel has one sentence for it.
    await expect(notLive.json()).resolves.toEqual({ status: 'not_live' });

    mockWithdrawAsk.mockResolvedValue({ status: 'not_found' });
    const unknown = await WITHDRAW(post('withdraw'));
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual({ error: 'Not found' });
  });

  it('withdraw route answers 404 to a body without a valid batchId and askId', async () => {
    const missingAsk = await WITHDRAW(post('withdraw', { body: { batchId: BATCH_ID } }));
    const missingBatch = await WITHDRAW(post('withdraw', { body: { askId: ASK_ID } }));
    const notUuid = await WITHDRAW(post('withdraw', { body: { batchId: BATCH_ID, askId: 'nope' } }));
    const wrongType = await WITHDRAW(post('withdraw', { body: { batchId: 42, askId: ASK_ID } }));

    for (const response of [missingAsk, missingBatch, notUuid, wrongType]) {
      expect(response.status).toBe(404);
    }
    // Refused at the parse boundary — no transaction is opened for a body the
    // route cannot trust.
    expect(mockWithdrawAsk).not.toHaveBeenCalled();
  });

  it('withdraw wire never carries the send parent run id', async () => {
    mockWithdrawAsk.mockResolvedValue({
      status: 'withdrawn',
      remainingLive: 0,
      close: SETTLED_CLOSE,
    });

    const response = await WITHDRAW(post('withdraw'));
    const raw = JSON.stringify(await response.json());

    // Substring, not key-walking: a nested or renamed field still fails.
    expect(raw).not.toContain(SETTLED_CLOSE.parentRunId);
    expect(raw).not.toContain('parentRunId');
    expect(raw).not.toContain('parentStatus');
    expect(raw).not.toContain('disposition');
    expect(raw).not.toContain('counts');
    // The one bit the panel could act on survives the projection.
    await expect(WITHDRAW(post('withdraw')).then((r) => r.json())).resolves.toMatchObject({
      status: 'withdrawn',
      closed: true,
    });
  });

  it('withdraw route is unavailable when either the watch or the send flag is off', async () => {
    // BOTH halves of the dual gate, independently — the send lane's verbs bind
    // `requireSolicitationSendWriteAccess`, which requires both flags.
    vi.stubEnv('SOLICITATION_SEND_ENABLED', 'false');
    const sendOff = await WITHDRAW(post('withdraw'));
    vi.stubEnv('SOLICITATION_SEND_ENABLED', 'true');
    vi.stubEnv('SOLICITATION_WATCH_ENABLED', 'false');
    const watchOff = await WITHDRAW(post('withdraw'));

    expect(sendOff.status).toBe(404);
    expect(watchOff.status).toBe(404);
    expect(mockWithdrawAsk).not.toHaveBeenCalled();
  });

  it('withdraw route passes the scoped session tenant ids and ignores client reason status and outreach fields', async () => {
    const response = await WITHDRAW(
      post('withdraw', {
        query: WITHDRAW_SCOPED,
        body: {
          batchId: BATCH_ID,
          askId: ASK_ID,
          // Everything below must be ignored — the reason is fixed server-side
          // and the row is resolved under the lock.
          outreachId: '01900000-0000-7000-8000-0000000000aa',
          reason: 'owner_veto',
          disposition_reason: 'owner_excluded',
          status: 'sent',
          accountId: '01900000-0000-7000-8000-0000000000bb',
          businessId: '01900000-0000-7000-8000-0000000000cc',
        },
      }),
    );

    expect(response.status).toBe(200);
    const [, input] = mockWithdrawAsk.mock.calls[0] as [unknown, Record<string, unknown>];
    // The VALUES, not just the key names: tenant ids come from the session and
    // the resolved location scope, never from the body.
    expect(input).toEqual({
      batchId: BATCH_ID,
      askId: ASK_ID,
      accountId: ACCOUNT_ID,
      businessId: DEFAULT_LOCATION_ID,
      withdrawnByUserId: USER_ID,
    });
  });

  it('rejects a cross-origin withdraw post', async () => {
    // Withdrawal is a destructive verb (cancelled is terminal), so it carries
    // the same CSRF pin approve, halt and regenerate already carry.
    const response = await WITHDRAW(
      post('withdraw', { query: WITHDRAW_SCOPED, origin: 'https://evil.example.com' }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'forbidden' });
    // withSameOrigin is the OUTERMOST wrapper: nothing behind it may run.
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockWithdrawAsk).not.toHaveBeenCalled();
  });
});
```

  `SCOPED` in the regenerate describe (`:419`) is BLOCK-scoped to that describe, so it is not visible here (plan review round 1, finding 6). Define the withdraw describe's own copy at its top: `const WITHDRAW_SCOPED = \`?${SOLICITATION_SCOPE_PARAM}=${DEFAULT_LOCATION_ID}\`;` — do NOT hoist the regenerate one (touching that describe is outside this task). Mirror the CSRF expectations of `'rejects a cross-origin regenerate post'` (`:528-545`) exactly as written above.

- [ ] **Step 5: Panel tests.** In `approval-panel.test.tsx`, add helpers next to `haltButton` (`:210-211`):

```ts
const WITHDRAW_CONTROL_NAME = /^Withdraw the message to /i;
const withdrawControls = () => screen.queryAllByRole('button', { name: WITHDRAW_CONTROL_NAME });
const confirmWithdrawButton = () =>
  screen.queryByRole('button', { name: /^Confirm: withdraw the message to /i });
const keepButton = () => screen.queryByRole('button', { name: /^Keep the message to /i });
```

  and append a describe:

```ts
describe('withdraw control', () => {
  const vetoLane = () =>
    sendLane({
      batchState: 'veto_window',
      approvedAt: '2026-08-16 12:00:00+00',
      vetoDeadlineAt: '2026-08-16 12:15:00+00',
    });

  it('post-approval rows show Withdraw and the first tap asks for confirmation instead of posting', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderPanel(vetoLane(), [rendered('1', 'Dana Reeve'), rendered('2', 'Sam Okafor')]);

    // One control per live row, and the copy names the recourse.
    expect(withdrawControls()).toHaveLength(2);
    expect(screen.getByText(/withdraw a single message/i)).toBeInTheDocument();
    expect(confirmWithdrawButton()).toBeNull();

    fireEvent.click(withdrawControls()[0]!);

    // The first tap ARMS: the confirm pair appears for that row, and nothing
    // was posted — a terminal act is never one mis-tap away.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(confirmWithdrawButton()).toHaveAccessibleName(/Dana Reeve/);
    expect(keepButton()).toBeInTheDocument();
    // Only ONE row is armed at a time: arming Sam moves the confirm.
    fireEvent.click(withdrawControls()[0]!);
    expect(confirmWithdrawButton()).toHaveAccessibleName(/Sam Okafor/);
    expect(screen.queryAllByRole('button', { name: /^Confirm: withdraw/i })).toHaveLength(1);
  });

  it('confirming a withdrawal posts batchId and askId and announces the remaining count', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: 'withdrawn', remainingLive: 1, closed: false }));
    vi.stubGlobal('fetch', fetchMock);
    const dana = rendered('1', 'Dana Reeve');
    const { onChanged } = renderPanel(vetoLane(), [dana, rendered('2', 'Sam Okafor')]);

    fireEvent.click(withdrawControls()[0]!);
    fireEvent.click(confirmWithdrawButton()!);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/dashboard/solicitation/batch/withdraw?scope=${SCOPE}`);
    expect(init.method).toBe('POST');
    // Keyed on the ASK: exactly these two keys, nothing the client could use
    // to name a reason or a row.
    expect(JSON.parse(String(init.body))).toEqual({ batchId: BATCH_ID, askId: dana.askId });
    // `in_place`: the owner is still in the same panel; a remount would drop
    // any other armed confirmation and flash the loading card. The count is
    // the SERVER's `remainingLive`, not a client subtraction.
    expect(onChanged).toHaveBeenCalledWith('Withdrawn. 1 message left to send.', 'settled', 'in_place');
  });

  it('announces the server remaining count when a sending row keeps the batch open', async () => {
    // Server truth: one row still in flight. A client that subtracted one
    // from the rendered/queued rows on screen would say the batch is finished.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: 'withdrawn', remainingLive: 1, closed: false }));
    vi.stubGlobal('fetch', fetchMock);
    const inFlight = { ...rendered('2', 'Sam Okafor'), deliveryStatus: 'sending' as const };
    const { onChanged } = renderPanel(
      sendLane({ batchState: 'sending', approvedAt: '2026-08-16 12:00:00+00' }),
      [rendered('1', 'Dana Reeve'), inFlight],
    );

    // Only Dana's row is withdrawable; Sam's is in flight.
    expect(withdrawControls()).toHaveLength(1);
    fireEvent.click(withdrawControls()[0]!);
    fireEvent.click(confirmWithdrawButton()!);
    await flush();

    expect(onChanged).toHaveBeenCalledWith('Withdrawn. 1 message left to send.', 'settled', 'in_place');
  });

  it('post-approval queued rows show Withdraw while sending sent withheld failed and unknown rows do not', () => {
    const attempts = [
      rendered('1', 'Rendered Row'),
      { ...rendered('2', 'Queued Row'), deliveryStatus: 'queued' as const },
      { ...rendered('3', 'Sending Row'), deliveryStatus: 'sending' as const },
      { ...rendered('4', 'Sent Row'), deliveryStatus: 'sent' as const },
      heldByLint('5', 'Held Row'),
      { ...rendered('6', 'Failed Row'), deliveryStatus: 'failed' as const, dispositionReason: 'send_failed' },
      { ...rendered('7', 'Unknown Row'), deliveryStatus: 'unknown' as const, dispositionReason: 'send_indeterminate' },
    ];
    renderPanel(sendLane({ batchState: 'sending', approvedAt: '2026-08-16 12:00:00+00' }), attempts);

    const names = withdrawControls().map((control) => control.getAttribute('aria-label'));
    expect(names).toEqual([
      'Withdraw the message to Rendered Row',
      'Withdraw the message to Queued Row',
    ]);
  });

  it('a refetch that drops an armed ask permanently disarms it even if the ask later reappears', () => {
    const dana = rendered('1', 'Dana Reeve');
    const sam = rendered('2', 'Sam Okafor');
    const { rerender } = render(
      <ApprovalPanel {...props({ sendLane: vetoLane(), attempts: [dana, sam] })} />,
    );
    fireEvent.click(withdrawControls()[0]!);
    expect(confirmWithdrawButton()).toHaveAccessibleName(/Dana Reeve/);

    // The refetch comes back without Dana (withdrawn in another tab, or sent).
    rerender(<ApprovalPanel {...props({ sendLane: vetoLane(), attempts: [sam] })} />);
    expect(confirmWithdrawButton()).toBeNull();

    // If that ask ever reappears, it needs a FRESH first tap — the arming did
    // not survive in hidden state.
    rerender(<ApprovalPanel {...props({ sendLane: vetoLane(), attempts: [dana, sam] })} />);
    expect(confirmWithdrawButton()).toBeNull();
    expect(withdrawControls()).toHaveLength(2);
  });

  it('Keep reverts the pending confirmation without posting', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderPanel(vetoLane(), [rendered('1', 'Dana Reeve')]);

    fireEvent.click(withdrawControls()[0]!);
    expect(confirmWithdrawButton()).toBeInTheDocument();
    fireEvent.click(keepButton()!);

    expect(confirmWithdrawButton()).toBeNull();
    expect(keepButton()).toBeNull();
    expect(withdrawControls()).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no Withdraw control renders before approval', () => {
    renderPanel(sendLane({ batchState: 'built', ready: true }), [rendered('1', 'Dana Reeve')]);
    expect(withdrawControls()).toHaveLength(0);
    // And none on a stopped batch either — there is nothing left to withdraw.
    render(
      <ApprovalPanel
        {...props({
          sendLane: sendLane({ batchState: 'halted', haltReason: 'owner_veto' }),
          attempts: [rendered('1', 'Dana Reeve')],
        })}
      />,
    );
    expect(withdrawControls()).toHaveLength(0);
    // And none on a finished batch.
    render(
      <ApprovalPanel
        {...props({
          sendLane: sendLane({ batchState: 'closed', approvedAt: '2026-08-16 12:00:00+00' }),
          attempts: [rendered('1', 'Dana Reeve')],
        })}
      />,
    );
    expect(withdrawControls()).toHaveLength(0);
  });

  it('announces the last withdrawal as the end of the batch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: 'withdrawn', remainingLive: 0, closed: true }));
    vi.stubGlobal('fetch', fetchMock);
    const { onChanged } = renderPanel(vetoLane(), [rendered('1', 'Dana Reeve')]);

    fireEvent.click(withdrawControls()[0]!);
    fireEvent.click(confirmWithdrawButton()!);
    await flush();

    // `closed` is the server's fact, so the sentence may say "finished".
    expect(onChanged).toHaveBeenCalledWith(
      'Withdrawn. That was the last one — this batch is finished.',
      'settled',
      'in_place',
    );
  });

  it('repeats the server sentence for a message that can no longer be withdrawn', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(409, { status: 'not_live' }));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel(vetoLane(), [rendered('1', 'Dana Reeve')]);

    fireEvent.click(withdrawControls()[0]!);
    fireEvent.click(confirmWithdrawButton()!);
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'This message is no longer waiting to send, so it cannot be withdrawn. Reload the page to see where the batch stands.',
    );
  });
});
```

  Check `sendLane()`'s fixture defaults (`:43-58`) for the field names `ready`, `haltReason`, `approvedAt`, `vetoDeadlineAt` and mirror whatever the existing veto-window tests pass; check `rendered()` (`:74`) returns an object exposing `askId` — if the fixture type hides it, read it from the `attempts[0].askId` you passed in.

- [ ] **Step 6: Run the four files to confirm they FAIL for the right reason** (missing exports / route module / no control), not for a fixture typo:

  `cd <worktree> && pnpm vitest run src/lib/solicitation/__tests__/approval.test.ts src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts "src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx" 2>&1 | tail -40`

  Expected: the new cases fail with `withdrawAsk is not a function` / `Cannot find module '../withdraw/route'` / `expected length 2, received 0`. Existing cases in `approval.test.ts` and `approval-panel.test.tsx` stay green; every case in `approval-routes.test.ts` fails to LOAD until Task 3 creates the route module (accepted: the eval commit is red by design).

  For the integration suite: `TEST_DATABASE_POOL_URL=<local> pnpm vitest run src/lib/solicitation/__tests__/approval.integration.test.ts 2>&1 | tail -20` — expected: `beforeAll` throws "test database is behind head … migration 109" (correct: 109 does not exist yet). If it instead skips silently, `TEST_DATABASE_POOL_URL` is unset — the #520 class; set it.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/solicitation/__tests__/approval.integration.test.ts src/lib/solicitation/__tests__/approval.test.ts src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts "src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx"
git commit -m "test(872): eval task — Ask withdrawal promised tests, failing"
```

---

### Task 2: Migration 109 + `ask_withdrawn` step key + `withdrawAsk`

**Blocks on:** Task 1. **Turns green:** all `approval.integration.test.ts` and `approval.test.ts` titles.

**Files:**
- Create: `supabase/migrations/109_outreach_owner_withdrawn_disposition.sql`
- Modify: `.claude/reference/migrations-log.md` (head → 109, one entry)
- Modify: `src/lib/agents/run-spine.ts:55-76` (`STEP_PERSONA`)
- Modify: `src/lib/solicitation/approval.ts` (header comment + append after `requestAskRegeneration`)

Read first: `supabase/migrations/108_outreach_owner_excluded_disposition.sql` (the whole file — 109 is that file re-spelled), the `new-migration` skill, `haltBatch` in `approval.ts:409-485`.

- [ ] **Step 1: Migration 109.** Create `supabase/migrations/109_outreach_owner_withdrawn_disposition.sql`:

```sql
-- 109_outreach_owner_withdrawn_disposition.sql
--
-- Adds 'owner_withdrawn' to solicitation_outreach's CANCEL disposition set so
-- the owner approval lane can record a post-approval Ask withdrawal (#872,
-- ADR 0021). 108 added 'owner_excluded' for the at-approval act; this value is
-- deliberately distinct — Ask exclusion is defined by WHEN it is written (in
-- the approval transaction), and a post-approval row that borrowed its value
-- would misstate when and how it was cancelled.
--
-- Additive and re-runnable: one CHECK is replaced by a wider one. No data
-- change; no row can carry the new value until #872's writer ships. Rollback
-- is re-applying 108's constraint text verbatim — legal while no
-- 'owner_withdrawn' row exists.
--
-- The whole predicate is RE-SPELLED rather than patched: a CHECK cannot be
-- widened in place, and re-spelling keeps this file readable next to 108.
--
-- ONE TRANSACTION, load-bearing (108's reasoning verbatim): psql autocommits
-- each statement, so an unwrapped DROP that succeeds followed by an ADD that
-- fails would leave solicitation_outreach with NO status/reason constraint at
-- all. lock_timeout bounds the ACCESS EXCLUSIVE acquisition so a long
-- Supavisor session cannot make this migration queue behind it.

BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE solicitation_outreach
  DROP CONSTRAINT IF EXISTS solicitation_outreach_status_reason_consistency;

ALTER TABLE solicitation_outreach
  ADD CONSTRAINT solicitation_outreach_status_reason_consistency CHECK (
    (
      (delivery_status IN ('rendered', 'queued', 'sending', 'sent')
        AND disposition_reason IS NULL) OR
      (delivery_status = 'withheld' AND disposition_reason IN (
        'moderation_high', 'render_failed', 'lint_failed',
        'no_consent', 'suppressed', 'unsubscribed'
      )) OR
      (delivery_status = 'cancelled' AND disposition_reason IN (
        'owner_veto', 'owner_halt', 'admin_halt', 'owner_excluded', 'owner_withdrawn',
        'batch_expired', 'send_window_elapsed', 'superseded'
      )) OR
      (delivery_status = 'failed' AND disposition_reason IN (
        'send_failed', 'send_exhausted'
      )) OR
      (delivery_status = 'unknown' AND disposition_reason = 'send_indeterminate')
    ) IS TRUE
  );

COMMENT ON CONSTRAINT solicitation_outreach_status_reason_consistency ON solicitation_outreach IS
  'Status <-> reason totality. 109 added owner_withdrawn to the cancel set for post-approval Ask withdrawal (#872, ADR 0021); 108 added owner_excluded; every other arm is 091 verbatim.';

COMMIT;
```

- [ ] **Step 2: migrations-log.** In `.claude/reference/migrations-log.md`, change line 4 to `Current head: **109** — next migration is **110**`, and add an entry for 109 in the same format as the 108 entry (find it with `grep -n "108_outreach" .claude/reference/migrations-log.md`): what it does (one CHECK re-spelled, cancel arm + `owner_withdrawn`), additive/re-runnable, rollback = 108's text, verification query:

  ```sql
  SELECT pg_get_constraintdef(oid) FROM pg_constraint
  WHERE conname = 'solicitation_outreach_status_reason_consistency';  -- must contain 'owner_withdrawn'
  ```

  Mark it **NOT YET APPLIED to staging or prod** — applied at step 8 (staging first).

- [ ] **Step 3: Provision the local test DB to head** so the integration suite's precondition passes: `cd <worktree> && pnpm test:db:setup 2>&1 | tail -5` (local container only; destructive to the local test schema by design). Expected: ends with 109 applied. (Only if `TEST_DATABASE_POOL_URL` resolves; otherwise the suite skips and Task 2's integration titles are verified by the step-5 gate.)

- [ ] **Step 4: Step key.** In `src/lib/agents/run-spine.ts` `STEP_PERSONA` (`:55-76`), add after `ask_regeneration_requested: 'solicitation',`:

```ts
  ask_withdrawn: 'solicitation',
```

  Run `pnpm vitest run src/lib/agents/__tests__/run-spine.test.ts 2>&1 | tail -5` — if a case enumerates the keys, update its expectation (file is in surface).

- [ ] **Step 5: `withdrawAsk`.** In `src/lib/solicitation/approval.ts`: update the header comment's first paragraph to name four verbs ("`approveBatch`, `haltBatch`, `requestAskRegeneration` and `withdrawAsk`" — and one sentence: "`withdrawAsk` (#872, ADR 0021) is the Halt latch at ask granularity: same lock order, same row predicate, one row."). Then append at the end of the file:

```ts
/**
 * The three Batch states in which the **Halt latch** would cancel a
 * `rendered`/`queued` row: an approved batch that is neither halted nor closed.
 * Exported so the panel and the property test can share the predicate; the
 * authoritative check is the locked re-check inside `withdrawAsk`.
 */
export function isWithdrawableState(state: BatchState): boolean {
  return state === 'veto_window' || state === 'approved' || state === 'sending';
}

export interface WithdrawAskInput {
  batchId: string;
  askId: string;
  accountId: string;
  businessId: string;
  /** The acting owner, recorded on the run step. */
  withdrawnByUserId: string;
}

export type WithdrawAskResult =
  | {
      status: 'withdrawn';
      /** Rows still `rendered`/`queued`/`sending` in this batch AFTER the
       *  withdrawal — the count the panel announces as "left to send". */
      remainingLive: number;
      close: CloseBatchIfSettledResult;
    }
  /** The ask's current attempt is already `cancelled`/`owner_withdrawn`: a
   *  double tap or a stale tab. Nothing is written — idempotent means no
   *  observable second effect, so no step either. */
  | { status: 'already_withdrawn' }
  /** `pending`, `built`, `expired`, `halted` or `closed`. `built` is Ask
   *  exclusion's job; the panel never offers Withdraw there. */
  | { status: 'not_withdrawable'; state: BatchState }
  /** The ask is in this batch but its current attempt is not `rendered`/
   *  `queued` — `sending` (past the point of no return), `sent`, `withheld`,
   *  `failed`, `unknown`, or cancelled for another reason — or it has no
   *  attempt at all (`null`). Nothing is written. */
  | { status: 'not_live'; deliveryStatus: string | null }
  /** Unknown batch, ask not in this batch, or foreign tenant — indistinguishable. */
  | { status: 'not_found' };

/** The ask's CURRENT attempt as the verb reads it under the lock; the caller
 *  passes null when the ask has no attempt at all. */
export interface CurrentAttempt {
  deliveryStatus: string;
  dispositionReason: string | null;
}

/**
 * The decision, PURE. `withdrawAsk` reads the Batch state and the current
 * attempt under the lock, applies this, and writes only on `withdraw`.
 * Extracted so the whole state × attempt-status matrix is one property test
 * (`approval.test.ts` invariants) rather than fifteen DB cases; the DB suite
 * then proves the READS (lock, LATERAL ordering, tenant keys) and the WRITES.
 */
export type WithdrawalDecision =
  | { kind: 'withdraw' }
  | { kind: 'already_withdrawn' }
  | { kind: 'not_withdrawable'; state: BatchState }
  | { kind: 'not_live'; deliveryStatus: string | null };

export function classifyWithdrawal(
  state: BatchState,
  attempt: CurrentAttempt | null,
): WithdrawalDecision {
  // Idempotence FIRST, before the state gate. Withdrawing the last live row
  // CLOSES the batch, so a retry on that very row arrives in `closed`; it is
  // still "already withdrawn" — a fact about the row — and must answer the
  // 200 no-op, not a 409. Only a row THIS verb cancelled reads this way; a row
  // cancelled for any other reason (superseded, a halt) is simply not live.
  if (attempt?.deliveryStatus === 'cancelled' && attempt.dispositionReason === 'owner_withdrawn') {
    return { kind: 'already_withdrawn' };
  }
  if (!isWithdrawableState(state)) return { kind: 'not_withdrawable', state };
  if (attempt === null) return { kind: 'not_live', deliveryStatus: null };
  // `rendered`/`queued` — the Halt latch's own row predicate. `sending` is past
  // the point of no return and lands below.
  if (attempt.deliveryStatus === 'rendered' || attempt.deliveryStatus === 'queued') {
    return { kind: 'withdraw' };
  }
  return { kind: 'not_live', deliveryStatus: attempt.deliveryStatus };
}

interface CurrentAttemptRow {
  outreach_id: string | null;
  delivery_status: string | null;
  disposition_reason: string | null;
}

/**
 * **Ask withdrawal** (#872, ADR 0021): cancel ONE approved Ask's live Outreach
 * row. It is the Halt latch at ask granularity and Ask exclusion after
 * approval — it removes a message and never replaces one, so it needs no
 * re-lint, no re-moderation and no per-ask approval state.
 *
 * Legal in exactly the states where the latch would cancel that row
 * (`isWithdrawableState`); the row must be `rendered` or `queued`, never
 * `sending` — halt's "no further sends, not undo" contract, inherited whole.
 *
 * LOCK ORDER is `haltBatch`'s: advisory batch lock -> `solicitation_batches`
 * row (inside `lockBatchForAction`) -> the outreach UPDATE -> `recordStep` ->
 * `closeBatchIfSettled`. Nothing here locks an `agent_runs` row before the
 * spine call. The releaser (#630) takes the batch lock before dispatching, so a
 * row this cancels can never be mid-dispatch under it — the same guarantee
 * halt already relies on.
 *
 * Validate-before-write, like `approveBatch`'s exclusion block: every refusal
 * below returns BEFORE the UPDATE, so postgres.js committing on a normal return
 * commits nothing.
 *
 * Keyed on the ASK: the current attempt is resolved here, under the batch
 * lock, so a stale tab holding a pre-regeneration view still withdraws the
 * right message.
 */
export async function withdrawAsk(
  sql: Sql,
  input: WithdrawAskInput,
): Promise<WithdrawAskResult> {
  const batchId = canonicalBatchId(input.batchId);
  // Same normalisation as the batch id and for the same reason: the step
  // detail records it as text.
  const askId = input.askId.toLowerCase();
  return sql.begin(async (tx): Promise<WithdrawAskResult> => {
    const locked = await lockBatchForAction(tx, batchId, input);
    if (locked === null) return { status: 'not_found' };
    const { batch, state } = locked;

    // NO early state refusal here: the current attempt is read first so a
    // retry after a last-row close (batch now `closed`) can still answer
    // `already_withdrawn`. The batch is already proven the tenant's, so the
    // read on a refused state leaks nothing; `classifyWithdrawal` orders it.
    // The ask's CURRENT attempt, joined from the ASK so an ask with no attempt
    // at all (a withhold ask, or a send ask whose only attempts were all
    // superseded away) is told apart from an ask that is not in this batch.
    // Both tenant keys are proven on the ask AND inside the lateral block —
    // the query-block tenant-scope audit checks each block independently.
    const [current] = await tx<CurrentAttemptRow[]>`
      SELECT
        cur.id AS outreach_id,
        cur.delivery_status,
        cur.disposition_reason
      FROM solicitation_asks a
      LEFT JOIN LATERAL (
        SELECT att.id, att.delivery_status, att.disposition_reason
        FROM solicitation_outreach att
        WHERE att.ask_id = a.id
          AND att.batch_id = a.batch_id
          AND att.account_id = ${input.accountId}::uuid
          AND att.business_id = ${input.businessId}::uuid
        ORDER BY att.attempt_no DESC
        LIMIT 1
      ) cur ON TRUE
      WHERE a.id = ${askId}::uuid
        AND a.batch_id = ${batchId}::uuid
        AND a.account_id = ${input.accountId}::uuid
        AND a.business_id = ${input.businessId}::uuid
    `;
    if (current === undefined) return { status: 'not_found' };

    // The decision is pure and property-tested; every refusal below returns
    // BEFORE any write.
    const attempt: CurrentAttempt | null =
      current.outreach_id === null || current.delivery_status === null
        ? null
        : { deliveryStatus: current.delivery_status, dispositionReason: current.disposition_reason };
    const decision = classifyWithdrawal(state, attempt);
    switch (decision.kind) {
      case 'not_withdrawable':
        return { status: 'not_withdrawable', state: decision.state };
      case 'not_live':
        return { status: 'not_live', deliveryStatus: decision.deliveryStatus };
      case 'already_withdrawn':
        return { status: 'already_withdrawn' };
      case 'withdraw':
        break;
    }
    // `withdraw` implies a non-null attempt row; the compiler cannot see it.
    if (current.outreach_id === null || current.delivery_status === null) {
      throw new Error(`withdrawAsk: classify said withdraw over a missing attempt for ask ${askId}`);
    }

    // The status literals are PARAMETERS so the query-shape pin can assert
    // them by value; the IN list stays literal, as in `haltBatch`.
    const cancelled = await tx<{ id: string }[]>`
      UPDATE solicitation_outreach
      SET delivery_status = ${'cancelled'},
          disposition_reason = ${'owner_withdrawn'},
          updated_at = NOW()
      WHERE id = ${current.outreach_id}::uuid
        AND batch_id = ${batchId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND business_id = ${input.businessId}::uuid
        AND delivery_status IN ('rendered', 'queued')
      RETURNING id
    `;
    // Losing this write is IMPOSSIBLE under the batch lock — every writer that
    // moves an outreach row past `queued` (halt, the future releaser) takes it
    // first, and the row was read `rendered`/`queued` above under that lock.
    // Throwing rolls back and keeps the claim honest, exactly like the approval
    // CAS in `approveBatch`.
    if (cancelled.count === 0) {
      throw new Error(
        `withdrawAsk: outreach ${current.outreach_id} left ${current.delivery_status} under the batch lock`,
      );
    }

    const [live] = await tx<{ live: number }[]>`
      SELECT COUNT(*)::int AS live
      FROM solicitation_outreach
      WHERE batch_id = ${batchId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND business_id = ${input.businessId}::uuid
        AND delivery_status IN ('rendered', 'queued', 'sending')
    `;
    const remainingLive = live?.live ?? 0;

    // An approved batch always has a send parent: `approveBatch` refuses
    // `no_send_parent` before it approves. Asserted, not branched around.
    if (batch.send_parent_run_id === null) {
      throw new Error(`withdrawAsk: approved batch ${batchId} has no send parent run`);
    }
    await recordStep(tx, {
      runId: batch.send_parent_run_id,
      stepKey: 'ask_withdrawn',
      detail: {
        ask_id: askId,
        outreach_id: current.outreach_id,
        withdrawn_by: input.withdrawnByUserId,
        delivery_status_before: current.delivery_status,
        remaining_live: remainingLive,
        state_at_withdrawal: state,
      },
    });

    // The last live row settles the batch — same transaction, same single
    // owner of parent terminalization as every other terminal writer.
    const close = await closeBatchIfSettled(tx, {
      batchId,
      accountId: input.accountId,
      businessId: input.businessId,
    });

    return { status: 'withdrawn', remainingLive, close };
  });
}
```

  If `pnpm ci:tenant-scope` (run in Step 7) flags the LATERAL block, restructure to a scalar-subquery form (`(SELECT id …) AS outreach_id`, `(SELECT delivery_status …)`, `(SELECT disposition_reason …)`, each with both tenant keys) rather than allowlisting — record the change in the deviations file.

- [ ] **Step 6: Run the unit + integration suites.**

  `pnpm vitest run src/lib/solicitation/__tests__/approval.test.ts 2>&1 | tail -15` — expected: all green including the two new titles.

  `pnpm vitest run src/lib/solicitation/__tests__/approval.integration.test.ts 2>&1 | tail -25` — expected: all green (existing + 9 new). If the mock queue in the query-pin test is out of order with the real call sequence (lock, current attempt, UPDATE, live count), fix the TEST's queue order — the pin's `sqlCalls[2]` index must point at the UPDATE.

- [ ] **Step 7: Audits that touch this file.** `pnpm typecheck 2>&1 | tail -5 && pnpm ci:tenant-scope 2>&1 | tail -5 && pnpm ci:db-imports 2>&1 | tail -3` — expected: clean.

- [ ] **Step 8: Commit.**

```bash
git add supabase/migrations/109_outreach_owner_withdrawn_disposition.sql .claude/reference/migrations-log.md src/lib/agents/run-spine.ts src/lib/solicitation/approval.ts src/lib/agents/__tests__/run-spine.test.ts
git commit -m "feat(872): withdrawAsk — cancel one approved ask owner_withdrawn (migration 109, ask_withdrawn step)"
```

---

### Task 3: Shared `{ batchId, askId }` reader + withdraw route + directory row

**Blocks on:** Task 2. **Independent of Task 4** (disjoint files). **Turns green:** the route titles.

**Files:**
- Modify: `src/app/api/dashboard/solicitation/batch/_shared/scoped-batch-route.ts` (add `readBatchAsk`)
- Modify: `src/app/api/dashboard/solicitation/batch/regenerate/route.ts:30-46` (delete `readRegenerateRequest`, import `readBatchAsk`)
- Create: `src/app/api/dashboard/solicitation/batch/withdraw/route.ts`
- Modify: `docs/directory.md` (one row after the `regenerate/route.ts` row at `:359`)

Read first: `halt/route.ts` (whole file — the wire allowlist and mapping are the precedent), `regenerate/route.ts:30-46`, `_shared/scoped-batch-route.ts:45-67`.

- [ ] **Step 1: Hoist the reader.** In `_shared/scoped-batch-route.ts`, after `readBatchId` (`:62-67`), add:

```ts
/**
 * The batch id plus ONE ask id, or null when either is absent or not a UUID.
 * The two per-ask verbs — regenerate (#860) and withdraw (#872) — read exactly
 * this body; anything else in it is ignored, so neither route can be handed a
 * reason, a row id or a status by the client.
 */
export async function readBatchAsk(
  request: NextRequest,
): Promise<{ batchId: string; askId: string } | null> {
  const body = await readJsonObject(request);
  if (body === null) return null;
  const { batchId, askId } = body;
  if (typeof batchId !== 'string' || !isValidUuid(batchId)) return null;
  if (typeof askId !== 'string' || !isValidUuid(askId)) return null;
  return { batchId, askId };
}
```

  (Confirm `isValidUuid` and `NextRequest` are already imported in that file; if not, import them the way `regenerate/route.ts` does.) In `regenerate/route.ts` delete `readRegenerateRequest` (`:35-46`) and its now-unused imports, import `readBatchAsk` from `'../_shared/scoped-batch-route'`, and pass `readInput: readBatchAsk`. Run `pnpm vitest run src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts -t regenerate 2>&1 | tail -8` — the regenerate cases must stay green.

- [ ] **Step 2: The route.** Create `src/app/api/dashboard/solicitation/batch/withdraw/route.ts`:

```ts
// POST /api/dashboard/solicitation/batch/withdraw — the owner withdraws ONE
// approved ask (#872; ADR 0021, **Ask withdrawal**). Route orchestrates only:
// the send-lane flag gate, writable-owner auth, location resolution, body parse
// and the 500 mapping all live in `withScopedBatch`
// (../_shared/scoped-batch-route.ts); the verb lives in
// src/lib/solicitation/approval.ts.
//
// The body carries `batchId` and `askId` and NOTHING else (`readBatchAsk`):
// the disposition reason is fixed server-side (`owner_withdrawn`) and the row
// is resolved under the batch lock, so nothing client-supplied can name a
// reason, a row or a status.

import { sql } from '@/lib/db/server';
import { errorResponse, jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { withdrawAsk, type WithdrawAskResult } from '@/lib/solicitation/approval';
import { requireSolicitationSendWriteAccess } from '@/app/api/dashboard/contacts/location-scope';
import { readBatchAsk, withScopedBatch } from '../_shared/scoped-batch-route';

export const dynamic = 'force-dynamic';

/**
 * Everything the browser is allowed to learn from a withdrawal, and nothing
 * else. `WithdrawAskResult.close` carries `parentRunId` — an internal
 * `agent_runs` UUID — plus the spine's `disposition`/`parentStatus` vocabulary
 * and raw counts. No internal id reaches the Requests surface — the halt and
 * approve routes' `toWire` precedent (#629 round-2 finding F10; the "ADR 0012"
 * those files cite for it is a misattribution — 0012 is the sentiment-blind
 * withhold enum). `not_live`'s `deliveryStatus` stays server-side too: the panel has
 * one sentence for it, and the row's status is not the owner's to act on.
 */
interface WithdrawWire {
  status: WithdrawAskResult['status'];
  remainingLive?: number;
  closed?: boolean;
  state?: string;
}

function toWire(result: WithdrawAskResult): WithdrawWire {
  switch (result.status) {
    case 'withdrawn':
      return {
        status: result.status,
        remainingLive: result.remainingLive,
        closed: result.close.status !== 'not_settled',
      };
    case 'not_withdrawable':
      return { status: result.status, state: result.state };
    default:
      return { status: result.status };
  }
}

export const POST = withSameOrigin()(
  withScopedBatch(
    sql,
    {
      endpoint: 'api/dashboard/solicitation/batch/withdraw',
      failureMessage: 'Failed to withdraw ask',
      // BOTH flags, like approve/halt/regenerate: withdrawal is a send-lane verb.
      requireWriteAccess: requireSolicitationSendWriteAccess,
      readInput: readBatchAsk,
    },
    async ({ accountId, locationId, actorUserId, input, logger }) => {
      const result = await withdrawAsk(sql, {
        batchId: input.batchId,
        askId: input.askId,
        accountId,
        businessId: locationId,
        withdrawnByUserId: actorUserId,
      });

      // Ids, statuses and counts only — never a subject or body (D6e: string
      // args are logged verbatim).
      logger.log('ask_withdrawn', {
        status: result.status,
        batchId: input.batchId,
        askId: input.askId,
        businessId: locationId,
        remainingLive: result.status === 'withdrawn' ? result.remainingLive : null,
      });

      const wire = toWire(result);
      switch (result.status) {
        case 'withdrawn':
        case 'already_withdrawn':
          return jsonResponse(wire);
        case 'not_withdrawable':
        case 'not_live':
          return jsonResponse(wire, 409);
        case 'not_found':
          return errorResponse('Not found', 404);
      }
    },
  ),
);
```

- [ ] **Step 3: Run the routes suite.** `pnpm vitest run src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts 2>&1 | tail -15` — expected: every case green (the three promised titles + the two extra CSRF/flag cases + all pre-existing).

- [ ] **Step 4: Directory row.** In `docs/directory.md` after the `solicitation/batch/regenerate/route.ts` row (`:359`) add:

```
| `solicitation/batch/withdraw/route.ts` | **(#872)** POST: the owner withdraws ONE approved ask (**Ask withdrawal**, ADR 0021). Fifth `withScopedBatch` adapter — same `requireSolicitationSendWriteAccess` gate as approve/halt/regenerate, the shared `readBatchAsk` body reader (batch id **and** ask id, both UUIDs or a uniform 404), then one `withdrawAsk` call: withdrawn/already_withdrawn → 200, not_withdrawable/not_live → 409, not_found → 404. The reason (`owner_withdrawn`) is fixed server-side and the row is resolved under the batch lock, so nothing client-supplied names a reason, a row or a status; the wire projects `remainingLive` + `closed` and never the send parent run id (the halt/approve `toWire` precedent). Logs ids and statuses only. |
```

  Update the `regenerate/route.ts` row's phrase "its own `readRegenerateRequest` body reader" → "the shared `readBatchAsk` body reader (hoisted to `_shared/` by #872)". Update the `_shared/scoped-batch-route.ts` row (`:356`): "the four batch POSTs share" → "the five batch POSTs share", add `readBatchAsk` to its reader list, and add `withdraw` to the `requireSolicitationSendWriteAccess` group. Update the file's own header comment (`scoped-batch-route.ts:3-5, :14`) — it still says "three POST routes"; make it name all five with their tickets. In `regenerate/route.ts:50` replace the "ADR 0012" attribution with "the halt/approve `toWire` precedent (#629 round-2 F10)" while you are in that file — 0012 is the sentiment-blind withhold enum and carries no such rule (the same misattribution in `halt/route.ts:26` and `approve/route.ts:104` is outside this surface; noted in the deviations file for a follow-up). Then `pnpm ci:directory-map 2>&1 | tail -3` — expected: clean (routes are outside its enforced roots, but the rows keep the map honest).

- [ ] **Step 5: Commit.**

```bash
git add src/app/api/dashboard/solicitation/batch/_shared/scoped-batch-route.ts src/app/api/dashboard/solicitation/batch/regenerate/route.ts src/app/api/dashboard/solicitation/batch/withdraw/route.ts docs/directory.md
git commit -m "feat(872): withdraw route over withScopedBatch; readBatchAsk shared with regenerate"
```

---

### Task 4: Panel — `WithdrawableAskList`, lane write, copy, CSS

**Blocks on:** Task 2 (imports `WithdrawAskResult`). **Independent of Task 3.** **Turns green:** the panel titles.

**Files:**
- Modify: `src/app/(authenticated)/dashboard/requests/AskList.tsx` (new exported `WithdrawableAskList` + two constants + one name helper; header comment)
- Modify: `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx` (`WITHDRAW_PATH`; `AskDisplay` + `askDisplay`; `haltableBody` copy; `LaneStatus`, `LANE_REFUSAL_COPY`; `withdrawnAnnounce`; `useLaneWrites.withdraw`; render arm)
- Modify: `src/app/(authenticated)/dashboard/requests/requests.css` (`.rq-ask-withdraw*` mirroring `.rq-ask-regen*` at `:359-389`)

Read first: `AskList.tsx` whole file; `ApprovalPanel.tsx:128-330` (modes/facets/copy), `:429-560` (statuses/refusal copy), `:560-780` (lane writes), `:893-982` (render); `requests.css:340-390`.

- [ ] **Step 1: `AskList.tsx` — the sibling list.** Add after `REGENERATING_LABEL`:

```ts
/** The resting label of the per-ask withdraw control (**Ask withdrawal**,
 *  #872). Plain English — unlike "halt" it needs no owner-facing carve-out. */
const WITHDRAW_LABEL = 'Withdraw';
/** The armed state's question. The pair below it is the only way to answer. */
const WITHDRAW_CONFIRM_PROMPT = 'Withdraw this message?';
const WITHDRAW_CONFIRM_LABEL = 'Withdraw';
const WITHDRAW_KEEP_LABEL = 'Keep';

/** Accessible names carry the contact (WCAG 2.5.3 Label in Name), like the
 *  regenerate control's. The confirm name is prefixed so a test — or a screen
 *  reader — can tell the armed control from the resting one. */
function withdrawControlName(contactName: string): string {
  return `${WITHDRAW_LABEL} the message to ${contactName}`;
}
function withdrawConfirmName(contactName: string): string {
  return `Confirm: withdraw the message to ${contactName}`;
}
function withdrawKeepName(contactName: string): string {
  return `Keep the message to ${contactName}`;
}
```

  Add after `AskList`:

```tsx
export interface WithdrawableAskListProps {
  /** Every non-cancelled attempt of the batch — the same rows the read-only
   *  list shows post-approval. Only `rendered`/`queued` rows get a control. */
  rows: readonly AskRowView[];
  /** The ONE ask whose control is armed (first tap taken), or null. Owned by
   *  the panel so a refetch that drops the row also drops the arming. */
  pendingAskId: string | null;
  /** First tap: arm this ask (moves the arming if another was armed). */
  onArm: (askId: string) => void;
  /** Second tap: post the withdrawal. */
  onWithdraw: (askId: string) => void;
  /** Disarm without posting. */
  onKeep: () => void;
  /** True while any lane write is in flight. */
  disabled: boolean;
}

/**
 * The list once the batch is approved and still live: the same read-only rows,
 * plus ONE control per row that is still waiting to send — **Ask withdrawal**
 * (#872), behind an inline two-tap confirm because, unlike the pre-approval
 * checkbox, cancelling is terminal. Rows that are not `rendered`/`queued`
 * (withheld, sending, sent) render exactly as `AskList` renders them.
 *
 * A THIRD component rather than a flag on `AskList`, for `AskList`'s own
 * reason: the read-only list is structurally unable to offer a control, and it
 * must stay that way for the halted and settled screens.
 */
export function WithdrawableAskList({
  rows,
  pendingAskId,
  onArm,
  onWithdraw,
  onKeep,
  disabled,
}: WithdrawableAskListProps) {
  if (rows.length === 0) return null;

  return (
    <ul className="rq-asks">
      {rows.map((row) => {
        const live = row.deliveryStatus === 'rendered' || row.deliveryStatus === 'queued';
        const armed = pendingAskId === row.askId;
        return (
          <li key={row.outreachId} className="rq-ask">
            <span className="rq-ask-name">{displayName(row)}</span>
            <span className="rq-ask-status">{STATUS_LABEL[row.deliveryStatus]}</span>
            {live && !armed && (
              <span className="rq-ask-withdraw">
                <button
                  type="button"
                  className="btn btn-secondary rq-ask-withdraw-btn"
                  onClick={() => onArm(row.askId)}
                  disabled={disabled}
                  aria-label={withdrawControlName(displayName(row))}
                >
                  {WITHDRAW_LABEL}
                </button>
              </span>
            )}
            {live && armed && (
              <span className="rq-ask-withdraw rq-ask-withdraw-armed" role="group">
                <span className="rq-ask-withdraw-prompt">{WITHDRAW_CONFIRM_PROMPT}</span>
                <button
                  type="button"
                  className="btn btn-danger rq-ask-withdraw-btn"
                  onClick={() => onWithdraw(row.askId)}
                  disabled={disabled}
                  aria-label={withdrawConfirmName(displayName(row))}
                >
                  {WITHDRAW_CONFIRM_LABEL}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary rq-ask-withdraw-btn"
                  onClick={onKeep}
                  disabled={disabled}
                  aria-label={withdrawKeepName(displayName(row))}
                >
                  {WITHDRAW_KEEP_LABEL}
                </button>
              </span>
            )}
            <AskMessage row={row} />
          </li>
        );
      })}
    </ul>
  );
}
```

  Check `btn-danger` exists in the app's button styles (`grep -rn "btn-danger" src/app/globals.css src/app/**/*.css | head -3`); if it does not, use `btn btn-secondary` for both and note it. Update the file's header comment: "in its THREE forms" and one sentence naming `WithdrawableAskList` and why it is a third component.

- [ ] **Step 2: `ApprovalPanel.tsx` — path, facet, copy.**
  - After `REGENERATE_PATH` (`:70`): `const WITHDRAW_PATH = '/api/dashboard/solicitation/batch/withdraw';`
  - Import `WithdrawableAskList` next to `AskList`/`SelectableAskList`; import `type WithdrawAskResult` next to the other three result types from `'@/lib/solicitation/approval'`.
  - `AskDisplay` (`:214`): `type AskDisplay = 'selectable' | 'withdrawable' | 'read_only' | 'count' | 'none';` and in `askDisplay`, move `case 'haltable':` to its own arm returning `'withdrawable'`; `halted` and `nothing_to_send` stay `'read_only'`. Update the docblock: "`withdrawable` — approved and still live: the owner may withdraw single messages (#872)".
  - `haltableBody` (`:243-250`) — the three sentences become:

```ts
    case 'veto_window':
      return 'Approved. Nothing has left yet, and you can still stop this batch or withdraw a single message.';
    case 'approved':
      return 'Approved and waiting to go out. Stopping cancels everything that has not left yet; you can also withdraw a single message.';
    case 'sending':
      return 'These messages are going out now. Stopping cancels everything that has not left yet; you can also withdraw a single message that has not left.';
```

  (The existing per-state test matches `/Nothing has left yet/`, `/waiting to go out/`, `/going out now/` — all preserved.)

- [ ] **Step 3: `ApprovalPanel.tsx` — statuses and refusal copy.** `LaneStatus` (`:429-432`) gains `| WithdrawAskResult['status']`. `LANE_REFUSAL_COPY` (`:489-518`) gains, before the closing brace:

```ts
  // #872 Ask withdrawal. The two 2xx arms have no refusal copy.
  withdrawn: null,
  already_withdrawn: null,
  not_withdrawable:
    'This message can no longer be withdrawn. Reload the page to see where the batch stands.',
  not_live:
    'This message is no longer waiting to send, so it cannot be withdrawn. Reload the page to see where the batch stands.',
```

- [ ] **Step 4: `ApprovalPanel.tsx` — carry the server's count, announce, lane write.**

  The server answers a withdrawal with `remainingLive` and `closed`; today `postLaneAction` (`:568-606`) discards everything but `status`. A client-side subtraction over the rows on screen would be WRONG the moment a `sending` row exists (server counts it, the screen's rendered/queued rows do not — plan review round 1, finding 2). So the `done` outcome carries the two fields and the withdraw sentence reads them:

  - `LaneOutcome` (`:536-559`): change the first arm to
    ```ts
    /** The server settled the request: 2xx, carrying its result discriminant
     *  and, for the verbs that report one, its counts. `remainingLive`/`closed`
     *  are read from the body when present and `null` otherwise — approve, halt
     *  and regenerate do not send them. */
    | { kind: 'done'; status: LaneStatus | null; remainingLive: number | null; closed: boolean | null }
    ```
  - `postLaneAction`: widen the parsed body type with `remainingLive?: unknown; closed?: unknown;` and return
    ```ts
      return response.ok
        ? {
            kind: 'done',
            status,
            remainingLive: typeof result.remainingLive === 'number' ? result.remainingLive : null,
            closed: typeof result.closed === 'boolean' ? result.closed : null,
          }
        : { kind: 'refused', status, message, state: toRefusedState(result.state) };
    ```
  - `Announce` (`:632`): `type Announce = (status: LaneStatus | null, done: { remainingLive: number | null; closed: boolean | null }) => string;` — the existing three announces take one parameter and stay assignable unchanged.
  - `perform` (`:718-748`): the settle line becomes `onChanged(announce(outcome.status, outcome), 'settled', refresh);`.
  - After `haltedAnnounce` add:

```ts
/** The withdraw sentence, from the SERVER's counts — never a client
 *  subtraction over the rows on screen, which cannot see an in-flight row.
 *  "Left to send" is factual for waiting AND in-flight rows and promises
 *  nothing about rows the owner may still stop or withdraw. The idempotent arm
 *  claims nothing new happened; the no-count arm (a server deployed behind
 *  this browser) claims only what it knows. */
const withdrawnAnnounce: Announce = (status, done) => {
  if (status === 'already_withdrawn') return 'This message was already withdrawn.';
  if (done.closed === true) return 'Withdrawn. That was the last one — this batch is finished.';
  if (done.remainingLive === null) return 'Withdrawn.';
  return `Withdrawn. ${countPhrase(done.remainingLive)} left to send.`;
};
```

  In `LaneWrites` add `withdraw: (askId: string) => void;` and update its docblock ("four writes"). In `useLaneWrites` add after `regenerate` (no new input is needed — the count comes back on the wire):

```ts
  const withdraw = useCallback(
    (askId: string) => {
      // `in_place`: the owner is still in the same panel with the rest of the
      // batch; a remount would drop another armed confirmation and flash the
      // loading card. The withdrawn row leaves the list on the refetch because
      // the read model already filters cancelled rows.
      void perform(WITHDRAW_PATH, { batchId, askId }, withdrawnAnnounce, 'in_place');
    },
    [batchId, perform],
  );

  return { busy, error, approve, halt, regenerate, withdraw };
```

- [ ] **Step 5: `ApprovalPanel.tsx` — render.** In `ApprovalPanel` (`:893+`): after `sendable`, add

```ts
  const live = useMemo(
    () => rows.filter((row) => row.deliveryStatus === 'rendered' || row.deliveryStatus === 'queued'),
    [rows],
  );
  // The armed withdraw confirmation. Held here, not in the list, and CLEARED
  // — not merely hidden — the moment a refetch no longer shows the armed row:
  // an ask that later reappears must need a fresh first tap (plan review
  // round 1, finding 9).
  const [armedAskId, setArmedAskId] = useState<string | null>(null);
  useEffect(() => {
    if (armedAskId !== null && !live.some((row) => row.askId === armedAskId)) {
      setArmedAskId(null);
    }
  }, [armedAskId, live]);
```

  (`useEffect` is already imported in this file — check the React import at the top; add it if not.) Destructure `withdraw` from `useLaneWrites`, and add the render arm after the `selectable` block:

```tsx
      {asks === 'withdrawable' && (
        <WithdrawableAskList
          rows={rows}
          pendingAskId={armedAskId}
          onArm={setArmedAskId}
          onWithdraw={(askId) => {
            setArmedAskId(null);
            withdraw(askId);
          }}
          onKeep={() => setArmedAskId(null)}
          disabled={busy}
        />
      )}
```

  Update the file header's "THREE kinds of control" paragraph (`:60-64`) to name the fourth (per-ask withdraw, post-approval).

- [ ] **Step 6: CSS.** In `requests.css` after `.rq-ask-regen-btn:disabled:active` (`:389`) add, mirroring the regen rules' tokens exactly (copy their values — do not invent new colours):

```css
.rq-ask-withdraw { /* same layout as .rq-ask-regen */ }
.rq-ask-withdraw-armed { /* prompt + two buttons inline, gap like .rq-ask-regen */ }
.rq-ask-withdraw-prompt { /* same font as .rq-ask-regen-count */ }
.rq-ask-withdraw-btn { /* same as .rq-ask-regen-btn */ }
.rq-ask-withdraw-btn:focus-visible { /* same as .rq-ask-regen-btn:focus-visible */ }
.rq-ask-withdraw-btn:disabled { /* same as .rq-ask-regen-btn:disabled */ }
```

  Replace each comment with the copied declarations from the corresponding `.rq-ask-regen*` rule (Console system tokens; invoke `repworth-brand-design` if unsure which tokens the regen rules use).

- [ ] **Step 7: Run panel + client suites.** `pnpm vitest run "src/app/(authenticated)/dashboard/requests/__tests__/" 2>&1 | tail -20` — expected: all green, including the six `withdraw control` cases and every pre-existing case (`tells the owner what has already left, per haltable state`, `shows the stop control while the batch is in its veto window`, `offers no regenerate control once the batch is approved`).

- [ ] **Step 8: Lint + typecheck + build.** `pnpm lint 2>&1 | tail -5 && pnpm typecheck 2>&1 | tail -5` (the gate runs `pnpm build` for the ui surface).

- [ ] **Step 9: Commit.**

```bash
git add "src/app/(authenticated)/dashboard/requests/AskList.tsx" "src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx" "src/app/(authenticated)/dashboard/requests/requests.css"
git commit -m "feat(872): per-ask Withdraw control behind an inline two-tap confirm; post-approval copy names the recourse"
```

---

### Task 5: Docs sweep + handoff

**Blocks on:** Tasks 3 and 4.

**Files:**
- Modify: `.claude/CLAUDE.md:109` (owner approval lane row — add `withdrawAsk` and **Ask withdrawal**; keep ≤ 80 words: shorten trap (a) to "exclusions validate BEFORE any write" if needed; the shape test `src/__tests__/claude-md-shape.test.ts` enforces it)
- Modify: `docs/directory.md` `src/lib/solicitation/approval.ts` row (name the fourth verb) and the `AskList.tsx`/`ApprovalPanel.tsx` rows if present (grep `AskList.tsx` in the file)
- Create: `docs/superpowers/plans/feat-872-ask-withdrawal-handoff.md` (references, not restatements: intake, plan, ADR 0021, deviations, glossary term; current phase; task ledger)

- [ ] **Step 1:** Edit the CLAUDE.md row; run `pnpm vitest run src/__tests__/claude-md-shape.test.ts 2>&1 | tail -5` — expected green.
- [ ] **Step 2:** Edit the directory rows; `pnpm ci:directory-map 2>&1 | tail -3`.
- [ ] **Step 3:** Write the handoff doc.
- [ ] **Step 4:** Commit: `git add .claude/CLAUDE.md docs/directory.md docs/superpowers/plans/feat-872-ask-withdrawal-handoff.md && git commit -m "docs(872): CLAUDE.md lane row, directory rows, handoff"`.

---

## Verify gate (step 5) — what must be true

- `scripts/verify-gate.sh --review` green: lint, typecheck, test (with coverage), every `ci:*` audit, `pnpm build` (ui surface), `promised-tests` (18 titles verbatim), `diff-coverage` ≥ 80 %, changed integration suite RUN (not SKIP — set `TEST_DATABASE_POOL_URL` and `DATABASE_POOL_URL`), `reclassify` within 2× (prod ±400 / test ±800).
- The gate provisions the test DB itself (`db_touching: true`) — do NOT put `test:db:setup` in `verification_commands`.

## Self-review (writing-plans checklist)

- **Spec coverage:** every `user_visible_behavior` item maps to Task 4 (control, confirm, announce, copy) or Task 3 (status codes); every `invariants` item to Task 2 (1–7, 9) or Task 3 (8); every `edge_cases` item to an integration case in Task 1 or to Task 4's derived `pendingWithdrawAskId`; the two intake questions the reviewer left open (last-row settle, veto clock) are the fourth integration case + ADR 0021.
- **Placeholder scan:** none — the CSS step copies concrete rules from named lines; the CSRF case mirrors a named precedent.
- **Type consistency:** `WithdrawAskInput` (5 keys) / `WithdrawAskResult` (5 arms) are identical in the contract block, Task 2, Task 3's `toWire`, and Task 1's tests; the wire fields are `status`, `remainingLive`, `closed`, `state`; the panel posts `{ batchId, askId }`; the step key is `ask_withdrawn`; the reason value is `owner_withdrawn`.

---

## Review appendix

### Plan review round 1 — codex, `VERDICT: REVISE` (`docs/reviews/feat-872-ask-withdrawal/plan-round1-codex.md`)

12 findings; 11 accepted (one partially), 1 rejected. What changed in this plan (revision 2):

- **Decision extracted as a pure function.** `classifyWithdrawal(state, currentAttempt)` in `approval.ts`; `withdrawAsk` reads under the lock, applies it, writes only on `withdraw`. Second fast-check property over the whole state × attempt-status matrix; the first property's generator now emits only 091-valid lifecycle rows (`fc.pre`).
- **Server count on the wire is READ, not re-derived.** `LaneOutcome.done` carries `remainingLive`/`closed`; `Announce` takes them; copy is "N messages left to send" / "That was the last one — this batch is finished."
- **Eval hardened:** 13 added cases (see deviations D3 for the list); refusals snapshot four tables; abort-injection rollback; CHECK precondition asserts location + count of the new value; route asserts tenant VALUES + dual flag; panel status matrix, closed batch, disarm-on-refetch (arming cleared by effect).
- **Citations repaired:** halt-describe range, `readBatch` shape, `SCOPED` scoping, `TenantSeed` fields, ADR 0012 misattribution (pre-existing; documented), ADR 0020 Consequences amended.

Rejected: "required skills do not exist" — they exist in the orchestrator's catalog; the read-only reviewer's sandbox cannot see them.

### Plan review round 2 — codex, verification-only, `VERDICT: REVISE` (`plan-round2-codex.md`)

9/12 addressed; 2 fix-introduced defects + 2 not-addressed. Revision 3:

- **Idempotence outranks the state gate.** `classifyWithdrawal` returns `already_withdrawn` for a `cancelled`/`owner_withdrawn` current attempt BEFORE checking the state; `withdrawAsk` reads the attempt before refusing on state. New case: retry after a last-row close is `already_withdrawn`, writes nothing.
- Halted refusal and the `already_withdrawn` case snapshot the full four-table surface.
- Generator comment states its honest scope (null-implication arms; chronology irrelevant to the property); `closed ⇒ built` added.
- Foreign-tenant: "seed a real foreign ask" rejected — this suite's `tenant scope` precedent and helper shape; comment names the boundaries and the reason.
