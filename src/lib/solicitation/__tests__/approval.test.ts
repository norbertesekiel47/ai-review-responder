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

import { deriveBatchState, type BatchLifecycleRow } from '../outreach';
import { approveBatch, ownerHaltReason } from '../approval';

const sql = mockSql as unknown as Sql;

const EPOCH = new Date('2026-08-16T12:00:00.000Z');
const ACCOUNT_ID = 'a0000000-0000-4000-8000-000000000001';
const BUSINESS_ID = 'b0000000-0000-4000-8000-000000000001';
const MIXED_CASE_BATCH_ID = '0190ABCD-0000-7000-8000-0000000000EF';
const CANONICAL_BATCH_ID = MIXED_CASE_BATCH_ID.toLowerCase();
const OWNER_ID = 'c0000000-0000-4000-8000-000000000001';
const SEND_PARENT_RUN_ID = 'd0000000-0000-4000-8000-000000000001';

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
