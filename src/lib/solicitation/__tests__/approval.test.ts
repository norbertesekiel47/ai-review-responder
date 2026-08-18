import { readFile } from 'node:fs/promises';
import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../../worker/__tests__/helpers/mock-sql');
    return { ...helpers.createMockSql(), mkTaggedResult: helpers.mkTaggedResult };
  });

const mocks = vi.hoisted(() => ({
  acquireSolicitationBatchLock: vi.fn(),
  closeBatchIfSettled: vi.fn(),
  recordStep: vi.fn(),
}));

vi.mock('@/lib/agents/run-spine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/run-spine')>()),
  recordStep: mocks.recordStep,
}));
vi.mock('../batch-builder', () => ({
  acquireSolicitationBatchLock: mocks.acquireSolicitationBatchLock,
}));
vi.mock('../outreach', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../outreach')>()),
  closeBatchIfSettled: mocks.closeBatchIfSettled,
}));

import { BATCH_STATES, deriveBatchState, type BatchLifecycleRow } from '../outreach';
import {
  approveBatch,
  classifyWithdrawal,
  haltBatch,
  isWithdrawableState,
  ownerHaltReason,
  withdrawAsk,
  type CurrentAttempt,
  type OwnerHaltReason,
} from '../approval';
// NAMESPACE import for the admin arm (#865). A named `import { adminHaltBatch }`
// of an export that does not exist yet fails the whole FILE at collection —
// vite's ssr transform validates importedNames — which would run none of the
// titles this eval promises and would take the existing cases down with it.
// A namespace access is `undefined` until Task 1 lands, so each case fails on
// its own, with the missing export named in the error.
import * as approvalModule from '../approval';

const sql = mockSql as unknown as Sql;

const EPOCH = new Date('2026-08-16T12:00:00.000Z');
const ACCOUNT_ID = 'a0000000-0000-4000-8000-000000000001';
const BUSINESS_ID = 'b0000000-0000-4000-8000-000000000001';
const MIXED_CASE_BATCH_ID = '0190ABCD-0000-7000-8000-0000000000EF';
const CANONICAL_BATCH_ID = MIXED_CASE_BATCH_ID.toLowerCase();
const OWNER_ID = 'c0000000-0000-4000-8000-000000000001';
const SEND_PARENT_RUN_ID = 'd0000000-0000-4000-8000-000000000001';
/** The acting RepWorth operator's `users.id` (D1) — the GLOBAL users table, not
 *  a tenant member. `halt_reason='admin_halt'` is the actor-class discriminator;
 *  it is never inferred from this id. */
const ADMIN_ID = 'e0000000-0000-4000-8000-000000000001';

function normalizedSql(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  resetMockSql();
  mockSql.mockClear();
  mockSql.begin.mockClear();
  for (const mock of Object.values(mocks)) mock.mockReset();

  mocks.acquireSolicitationBatchLock.mockResolvedValue(undefined);
  mocks.closeBatchIfSettled.mockResolvedValue({ status: 'not_settled', liveCount: 2 });
  mocks.recordStep.mockResolvedValue(undefined);
});

function lifecycle(overrides: Partial<BatchLifecycleRow> = {}): BatchLifecycleRow {
  return {
    built_at: EPOCH,
    approved_at: null,
    veto_deadline_at: null,
    sending_started_at: null,
    send_closed_at: null,
    halted_at: null,
    ...overrides,
  };
}

describe('invariants', () => {
  it('property: deriveBatchState returns the highest-precedence state for any lifecycle timestamp combination', () => {
    const stamp = fc.option(fc.date({ min: new Date('2026-01-01'), max: new Date('2027-01-01') }), {
      nil: null,
    });
    fc.assert(
      fc.property(stamp, stamp, stamp, stamp, stamp, stamp, (built, approved, veto, sending, closed, halted) => {
        const row: BatchLifecycleRow = {
          built_at: built,
          approved_at: approved,
          veto_deadline_at: veto,
          sending_started_at: sending,
          send_closed_at: closed,
          halted_at: halted,
        };
        // EVERY arm names ONE expected state. An earlier draft allowed
        // "veto_window OR approved" and "built OR expired", which an
        // implementation that never recognises an elapsed deadline passes —
        // the property has to constrain the boundary, not restate the
        // precedence list.
        const state = deriveBatchState(row, EPOCH);
        if (halted !== null) return state === 'halted';
        if (closed !== null) return state === 'closed';
        if (sending !== null) return state === 'sending';
        if (approved !== null) {
          const inWindow = veto !== null && EPOCH.getTime() < veto.getTime();
          return state === (inWindow ? 'veto_window' : 'approved');
        }
        if (built === null) return state === 'pending';
        const deadline = built.getTime() + 7 * 24 * 60 * 60 * 1000;
        return state === (EPOCH.getTime() >= deadline ? 'expired' : 'built');
      }),
    );
  });

  it('property: the owner halt reason is owner_veto exactly when sending has not started', () => {
    // Driven from a LIFECYCLE ROW, not from a hand-listed state set: the
    // helper's contract is about the batch, and a property over five literals
    // only restates the function body.
    const stamp = fc.option(fc.date({ min: new Date('2026-01-01'), max: new Date('2027-01-01') }), {
      nil: null,
    });
    fc.assert(
      fc.property(stamp, stamp, stamp, stamp, (built, approved, veto, sending) => {
        const row: BatchLifecycleRow = {
          built_at: built,
          approved_at: approved,
          veto_deadline_at: veto,
          sending_started_at: sending,
          send_closed_at: null,
          halted_at: null,
        };
        const state = deriveBatchState(row, EPOCH);
        const reason = ownerHaltReason(state);
        // A halt is owner_halt exactly when email may already have left, and
        // `sending` is the only state in which that is true.
        return sending !== null
          ? reason === 'owner_halt'
          : reason === 'owner_veto';
      }),
    );
  });

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

  it('invariants: halting is a fixed point and preserves every outreach status except rendered and queued for arbitrary outreach-status multisets', async () => {
    // The state space with real content (#865): 091's eight-member
    // `delivery_status` vocabulary, in arbitrary multiplicity. Two claims, and
    // both are about the Halt latch rather than about a hand-listed example —
    //
    //   1. A first halt changes EXACTLY the `rendered` and `queued` members.
    //      `sending` is the load-bearing survivor: halt means "no further
    //      sends", not "undo a dispatch the provider may already have taken".
    //   2. A second halt is a FIXED POINT — the CAS on `halted_at IS NULL`
    //      makes it add no audit row and no `batch_halted` spine step.
    const outreachStatus = fc.constantFrom(
      'rendered', 'queued', 'sending', 'sent',
      'withheld', 'cancelled', 'failed', 'unknown',
    );

    await fc.assert(
      fc.asyncProperty(fc.array(outreachStatus, { maxLength: 12 }), async (statuses) => {
        resetMockSql();
        // mockClear, NOT mockReset: the implementations primed in beforeEach
        // have to survive every generated run.
        for (const mock of Object.values(mocks)) mock.mockClear();

        const cancellable = statuses.filter(
          (status) => status === 'rendered' || status === 'queued',
        );
        const live = lifecycle({ built_at: new Date(Date.now() - 60_000) });

        // First halt: the batch is live, so the latch takes.
        sqlReturnQueue.push(
          mkTaggedResult([{ ...live, send_parent_run_id: SEND_PARENT_RUN_ID }]),
          mkTaggedResult([{ id: CANONICAL_BATCH_ID }]),
          mkTaggedResult(cancellable.map((_, index) => ({ id: `outreach-${index}` }))),
        );
        const first = await approvalModule.adminHaltBatch(sql, {
          batchId: CANONICAL_BATCH_ID,
          accountId: ACCOUNT_ID,
          businessId: BUSINESS_ID,
          actorUserId: ADMIN_ID,
          note: 'Support stopped this batch.',
        });

        // Second halt: the SAME batch, now latched. Only the lock read runs.
        sqlReturnQueue.push(
          mkTaggedResult([
            { ...live, halted_at: new Date(), send_parent_run_id: SEND_PARENT_RUN_ID },
          ]),
        );
        const second = await approvalModule.adminHaltBatch(sql, {
          batchId: CANONICAL_BATCH_ID,
          accountId: ACCOUNT_ID,
          businessId: BUSINESS_ID,
          actorUserId: ADMIN_ID,
          note: 'Support stopped this batch.',
        });

        const outreachWrites = sqlCalls.filter((call) =>
          /UPDATE\s+solicitation_outreach/.test(normalizedSql(call.text)));
        const auditWrites = sqlCalls.filter((call) =>
          /INSERT INTO account_audit_log/.test(normalizedSql(call.text)));

        return (
          first.status === 'halted'
          && first.cancelledCount === cancellable.length
          && second.status === 'already_halted'
          // Cardinality one, across BOTH calls.
          && auditWrites.length === 1
          && mocks.recordStep.mock.calls.length === 1
          // Exactly one outreach write, and it names exactly the two statuses
          // the latch may touch. A second write, or a widened IN list, is the
          // regression this property exists to catch.
          && outreachWrites.length === 1
          && normalizedSql(outreachWrites[0]!.text)
            .includes("delivery_status IN ('rendered', 'queued')")
        );
      }),
      { numRuns: 40 },
    );
  });
});

describe('the admin arm of the Halt latch', () => {
  /**
   * Exact, BIDIRECTIONAL type equality. A one-way `extends` check passes for a
   * WIDENED union, which is the exact regression `OwnerHaltReason stays two
   * members` is guarding against — `'owner_veto' | 'owner_halt'` extends
   * `'owner_veto' | 'owner_halt' | 'admin_halt'`.
   */
  type TypeEqual<X, Y> =
    (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

  function assertExactType<Actual, Expected>(
    proof: TypeEqual<Actual, Expected>,
  ): TypeEqual<Actual, Expected> {
    return proof;
  }

  it('haltBatch still derives owner_veto and owner_halt after the latch extraction', async () => {
    const built = lifecycle({ built_at: new Date(Date.now() - 60_000) });
    const sending = lifecycle({
      built_at: new Date(Date.now() - 3_600_000),
      approved_at: new Date(Date.now() - 1_800_000),
      veto_deadline_at: new Date(Date.now() - 900_000),
      sending_started_at: new Date(Date.now() - 600_000),
    });

    sqlReturnQueue.push(
      mkTaggedResult([{ ...built, send_parent_run_id: SEND_PARENT_RUN_ID }]),
      mkTaggedResult([{ id: CANONICAL_BATCH_ID }]),
      mkTaggedResult([{ id: 'o1' }, { id: 'o2' }]),
    );
    const veto = await haltBatch(sql, {
      batchId: MIXED_CASE_BATCH_ID,
      accountId: ACCOUNT_ID,
      businessId: BUSINESS_ID,
      haltedByUserId: OWNER_ID,
    });
    const ownerCalls = [...sqlCalls];

    resetMockSql();
    sqlReturnQueue.push(
      mkTaggedResult([{ ...sending, send_parent_run_id: SEND_PARENT_RUN_ID }]),
      mkTaggedResult([{ id: CANONICAL_BATCH_ID }]),
      mkTaggedResult([{ id: 'o3' }]),
    );
    const halt = await haltBatch(sql, {
      batchId: MIXED_CASE_BATCH_ID,
      accountId: ACCOUNT_ID,
      businessId: BUSINESS_ID,
      haltedByUserId: OWNER_ID,
    });

    // The owner arm's derivation is UNCHANGED by the extraction — that is the
    // whole claim of "no behaviour change" in Task 1.
    expect(veto).toMatchObject({ status: 'halted', reason: 'owner_veto', cancelledCount: 2 });
    expect(halt).toMatchObject({ status: 'halted', reason: 'owner_halt', cancelledCount: 1 });

    resetMockSql();
    sqlReturnQueue.push(
      mkTaggedResult([{ ...built, send_parent_run_id: SEND_PARENT_RUN_ID }]),
      mkTaggedResult([{ id: CANONICAL_BATCH_ID }]),
      mkTaggedResult([{ id: 'o4' }, { id: 'o5' }]),
    );
    await approvalModule.adminHaltBatch(sql, {
      batchId: MIXED_CASE_BATCH_ID,
      accountId: ACCOUNT_ID,
      businessId: BUSINESS_ID,
      actorUserId: ADMIN_ID,
      note: 'Support stopped this batch.',
    });
    const adminCalls = [...sqlCalls];

    // ONE latch, two arms: the CAS and the cancel are byte-identical SQL in
    // both, and only the bound reason differs. Two hand-maintained copies is
    // exactly what the extraction removes, and asserting the reasons alone
    // would not notice them drifting back apart.
    expect(normalizedSql(adminCalls[1]!.text)).toBe(normalizedSql(ownerCalls[1]!.text));
    expect(normalizedSql(adminCalls[2]!.text)).toBe(normalizedSql(ownerCalls[2]!.text));
    expect(ownerCalls[1]!.values).toContain('owner_veto');
    expect(adminCalls[1]!.values).toContain('admin_halt');
    expect(adminCalls[1]!.values).not.toContain('owner_veto');

    // The owner arm writes NO audit row: `latchHalt` takes its audit as a
    // nullable parameter and the owner passes null (D7 is admin-only).
    expect(ownerCalls.filter((call) => /account_audit_log/.test(call.text))).toHaveLength(0);
    expect(adminCalls.filter((call) => /account_audit_log/.test(call.text))).toHaveLength(1);
  });

  it('type contract: OwnerHaltReason is exactly owner_veto | owner_halt and LatchHaltReason is not exported', async () => {
    // Compile-time half. `assertExactType` is bidirectional, so this fails if
    // OwnerHaltReason ever grows `admin_halt` — the write union the owner arm
    // may spell must stay two members while the READ union (`HaltReason` in
    // batch-view.ts) stays five.
    expect(assertExactType<OwnerHaltReason, 'owner_veto' | 'owner_halt'>(true)).toBe(true);
    expect(Object.keys(approvalModule)).not.toContain('OwnerHaltReason');

    // Source half, and it has to be: a type erases at run time, so "not
    // exported" is only observable in the source and in `pnpm typecheck`.
    // Importing `LatchHaltReason` to prove it is unimportable would leave a
    // permanent type error behind, which is not an assertion.
    const source = await readFile('src/lib/solicitation/approval.ts', 'utf8');

    expect(source).toContain("export type OwnerHaltReason = 'owner_veto' | 'owner_halt';");
    expect(source).toMatch(/(^|\n)type LatchHaltReason = OwnerHaltReason \| 'admin_halt';/);
    expect(source).not.toContain('export type LatchHaltReason');
    // The admin arm's reason is a CONSTANT, never a parameter: no exported
    // signature may accept a halt reason from its caller.
    expect(source).not.toMatch(/export .*\breason\s*:\s*LatchHaltReason/);
  });
});

describe('deriveBatchState send-lane arms', () => {
  it('reports the derived batch state and approval readiness on the built batch view', () => {
    expect(deriveBatchState(lifecycle(), EPOCH)).toBe('built');
    expect(
      deriveBatchState(
        lifecycle({ approved_at: EPOCH, veto_deadline_at: new Date(EPOCH.getTime() + 60_000) }),
        EPOCH,
      ),
    ).toBe('veto_window');
  });
});

describe('approveBatch query shapes', () => {
  it('pins the restored approval scalar parent and NOT EXISTS readiness queries', async () => {
    const vetoDeadlineAt = '2026-08-17 12:15:00+00';
    sqlReturnQueue.push(
      mkTaggedResult([
        {
          built_at: new Date(Date.now() - 60_000),
          approved_at: null,
          veto_deadline_at: null,
          sending_started_at: null,
          send_closed_at: null,
          halted_at: null,
          send_parent_run_id: SEND_PARENT_RUN_ID,
        },
      ]),
      mkTaggedResult([{ missing: 0 }]),
      mkTaggedResult([{ veto_deadline_at: vetoDeadlineAt }]),
      mkTaggedResult([{ approved: 2 }]),
    );

    await expect(
      approveBatch(sql, {
        batchId: MIXED_CASE_BATCH_ID,
        accountId: ACCOUNT_ID,
        businessId: BUSINESS_ID,
        approvedByUserId: OWNER_ID,
        excludedOutreachIds: [],
      }),
    ).resolves.toEqual({
      status: 'approved',
      approvedCount: 2,
      excludedCount: 0,
      vetoDeadlineAt,
      close: null,
    });

    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    expect(sqlCalls).toHaveLength(4);
    expect(sqlCalls.every((call) => call.inTransaction)).toBe(true);

    const lockQuery = sqlCalls[0]!;
    const lockText = normalizedSql(lockQuery.text);
    expect(lockText).toContain('( SELECT r.id FROM agent_runs r');
    expect(lockText).toContain('r.subject_id = b.id::text');
    expect(lockText).toContain('r.account_id = ?::uuid');
    expect(lockText).toContain('r.business_id = ?::uuid');
    expect(lockText).toContain(') AS send_parent_run_id FROM solicitation_batches b');
    expect(lockText).toContain('FOR UPDATE OF b');
    expect(lockQuery.values).toEqual([
      ACCOUNT_ID,
      BUSINESS_ID,
      CANONICAL_BATCH_ID,
      ACCOUNT_ID,
      BUSINESS_ID,
    ]);
    expect(sqlCalls.filter((call) => /FROM\s+agent_runs\s+r/.test(call.text))).toHaveLength(1);

    const readinessQuery = sqlCalls[1]!;
    const readinessText = normalizedSql(readinessQuery.text);
    expect(readinessText).toContain('FROM solicitation_asks a');
    expect(readinessText).toContain('AND NOT EXISTS ( SELECT 1 FROM solicitation_outreach o');
    expect(readinessText).toContain('o.ask_id = a.id');
    expect(readinessText).toContain('o.batch_id = a.batch_id');
    expect(readinessText).toContain('o.account_id = ?::uuid');
    expect(readinessText).toContain('o.business_id = ?::uuid');
    expect(readinessText).toContain("o.delivery_status <> 'cancelled'");
    expect(readinessQuery.values).toEqual([
      CANONICAL_BATCH_ID,
      ACCOUNT_ID,
      BUSINESS_ID,
      ACCOUNT_ID,
      BUSINESS_ID,
    ]);

    expect(mocks.acquireSolicitationBatchLock).toHaveBeenCalledWith(mockSql, BUSINESS_ID);
    expect(mocks.recordStep).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        runId: SEND_PARENT_RUN_ID,
        stepKey: 'batch_approved',
      }),
    );
    expect(mocks.closeBatchIfSettled).toHaveBeenCalledWith(mockSql, {
      batchId: CANONICAL_BATCH_ID,
      accountId: ACCOUNT_ID,
      businessId: BUSINESS_ID,
    });
  });
});

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
