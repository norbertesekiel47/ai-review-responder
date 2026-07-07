import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spy on the outbox enqueue so we can assert the affected-row + auto_policy
// gating without a DB. The helper passes the tx straight through.
const { mockEnqueue } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(async () => 'outbox-1'),
}));
vi.mock('../../../../src/lib/shared/job-outbox-helpers', () => ({
  enqueueAutoPostNotice: mockEnqueue,
}));

// Seam-mock the run spine (same pattern as persist.test.ts): the checkpoint's
// contract is WHICH writers it calls with WHAT, not their SQL.
vi.mock('../../../../src/lib/agents/run-spine', () => ({
  findActiveReviewRun: vi.fn(),
  recordStep: vi.fn(),
  recordOutcome: vi.fn(),
  completeRun: vi.fn(),
}));

import { markPostedAndMaybeEnqueueAutoPostNotice } from '../mark-posted';
import { APPROVAL_METHOD } from '../../../../src/lib/auto-approval/types';
import {
  findActiveReviewRun,
  recordStep,
  recordOutcome,
  completeRun,
} from '../../../../src/lib/agents/run-spine';

// A tx is a tagged-template fn. The helper issues the reviews FOR UPDATE lock
// then the one UPDATE ... RETURNING, so returning a fixed array for every call
// models both. vi.fn so tests can inspect statement order.
function makeTx(updateResult: unknown[]) {
  return vi.fn(
    async (_strings: TemplateStringsArray, ..._values: unknown[]) => updateResult,
  ) as never;
}

// Per-call result queue, for tests where the lock and the UPDATE must differ.
function makeTxQueue(results: unknown[][]) {
  return vi.fn(
    async (_strings: TemplateStringsArray, ..._values: unknown[]) => results.shift() ?? [],
  ) as never;
}

const loggerMocks = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const logger = loggerMocks as never;

// Distinct from any input id so tests observe that outcome attribution comes
// from the run row, not from the caller's payload.
const ACTIVE_RUN = { id: 'run-1', account_id: 'run-acct-1' };

function baseInput(tx: unknown) {
  return {
    tx: tx as never,
    responseId: 'resp-1',
    reviewId: 'rev-1',
    businessId: 'biz-1',
    correlationId: 'c1',
    logger,
  };
}

function txTexts(tx: ReturnType<typeof vi.fn>): string[] {
  return tx.mock.calls.map((call) =>
    (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' '),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findActiveReviewRun).mockResolvedValue(ACTIVE_RUN);
});

describe('markPostedAndMaybeEnqueueAutoPostNotice', () => {
  it('enqueues the FYI when exactly one auto_policy row transitions to posted', async () => {
    const tx = makeTx([{ id: 'resp-1', approval_method: APPROVAL_METHOD.AUTO_POLICY }]);
    const res = await markPostedAndMaybeEnqueueAutoPostNotice(baseInput(tx));
    expect(res).toEqual({ transitioned: true, fyiEnqueued: true });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(tx, {
      responseId: 'resp-1', businessId: 'biz-1', correlationId: 'c1',
    });
  });

  it('does NOT enqueue for an owner-approved post (the owner clicked Approve)', async () => {
    const tx = makeTx([{ id: 'resp-1', approval_method: APPROVAL_METHOD.OWNER }]);
    const res = await markPostedAndMaybeEnqueueAutoPostNotice(baseInput(tx));
    expect(res).toEqual({ transitioned: true, fyiEnqueued: false });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('does NOT enqueue when ZERO rows transition (no-op / race retry — already posted)', async () => {
    const tx = makeTx([]);
    const res = await markPostedAndMaybeEnqueueAutoPostNotice(baseInput(tx));
    expect(res).toEqual({ transitioned: false, fyiEnqueued: false });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('does NOT enqueue when approval_method is null (ambiguous/legacy)', async () => {
    const tx = makeTx([{ id: 'resp-1', approval_method: null }]);
    const res = await markPostedAndMaybeEnqueueAutoPostNotice(baseInput(tx));
    expect(res.fyiEnqueued).toBe(false);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  describe('run-spine checkpoint', () => {
    it('owner-approved post records reply_posted step + outcome and completes the run', async () => {
      const tx = makeTx([{ id: 'resp-1', approval_method: APPROVAL_METHOD.OWNER }]);
      await markPostedAndMaybeEnqueueAutoPostNotice(baseInput(tx));

      expect(recordStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        runId: 'run-1',
        stepKey: 'reply_posted',
        detail: { response_id: 'resp-1', approval_method: APPROVAL_METHOD.OWNER },
      }));
      // Attribution comes from the run row (run-acct-1), not the input.
      expect(recordOutcome).toHaveBeenCalledTimes(1);
      expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        runId: 'run-1',
        accountId: 'run-acct-1',
        businessId: 'biz-1',
        attributedAgent: 'reply',
        outcomeKind: 'reply_posted',
      }));
      expect(completeRun).toHaveBeenCalledWith(expect.anything(), 'run-1', 'completed');
    });

    it('auto_policy post additionally emits reply_auto_posted', async () => {
      const tx = makeTx([{ id: 'resp-1', approval_method: APPROVAL_METHOD.AUTO_POLICY }]);
      await markPostedAndMaybeEnqueueAutoPostNotice(baseInput(tx));

      expect(recordOutcome).toHaveBeenCalledTimes(2);
      expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        outcomeKind: 'reply_posted',
      }));
      expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        runId: 'run-1',
        accountId: 'run-acct-1',
        attributedAgent: 'reply',
        outcomeKind: 'reply_auto_posted',
      }));
      expect(completeRun).toHaveBeenCalledWith(expect.anything(), 'run-1', 'completed');
    });

    it('skips spine writes when no running run exists (legacy rows)', async () => {
      vi.mocked(findActiveReviewRun).mockResolvedValue(null);
      const tx = makeTx([{ id: 'resp-1', approval_method: APPROVAL_METHOD.OWNER }]);
      const res = await markPostedAndMaybeEnqueueAutoPostNotice(baseInput(tx));

      expect(res.transitioned).toBe(true);
      expect(recordStep).not.toHaveBeenCalled();
      expect(recordOutcome).not.toHaveBeenCalled();
      expect(completeRun).not.toHaveBeenCalled();
    });

    it('skips spine writes entirely when ZERO rows transition (no-op / race retry)', async () => {
      const tx = makeTx([]);
      await markPostedAndMaybeEnqueueAutoPostNotice(baseInput(tx));

      expect(findActiveReviewRun).not.toHaveBeenCalled();
      expect(recordStep).not.toHaveBeenCalled();
      expect(completeRun).not.toHaveBeenCalled();
    });

    it('locks the review row FOR UPDATE as the FIRST tx statement, before the UPDATE and spine writes', async () => {
      const tx = makeTx([{ id: 'resp-1', approval_method: APPROVAL_METHOD.OWNER }]);
      await markPostedAndMaybeEnqueueAutoPostNotice(baseInput(tx));

      const texts = txTexts(tx as never);
      const lockIndex = texts.findIndex(
        (text) => text.includes('FROM reviews') && text.includes('FOR UPDATE'),
      );
      const updateIndex = texts.findIndex((text) => text.includes('UPDATE responses'));
      // run-spine.ts lock-ordering contract: the reviews FOR UPDATE must be the
      // transaction's first statement, before anything that could take an
      // implicit lock on the review tuple and before any agent_runs row lock.
      expect(lockIndex).toBe(0);
      expect(updateIndex).toBeGreaterThan(lockIndex);

      // And the lock precedes the first spine write (cross-mock global order).
      const lockInvocation = (tx as ReturnType<typeof vi.fn>).mock.invocationCallOrder[lockIndex]!;
      const firstSpineWriteInvocation = vi.mocked(recordStep).mock.invocationCallOrder[0]!;
      expect(lockInvocation).toBeLessThan(firstSpineWriteInvocation);
    });

    it('warns but proceeds when the review lock matches zero rows (orphan response)', async () => {
      // Lock SELECT no-ops (caller bug / corrupt state), UPDATE still transitions.
      const tx = makeTxQueue([
        [],
        [{ id: 'resp-1', approval_method: APPROVAL_METHOD.OWNER }],
      ]);
      const res = await markPostedAndMaybeEnqueueAutoPostNotice(baseInput(tx));

      expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
      expect(loggerMocks.warn.mock.calls[0]![0]).toContain('review lock no-oped');
      // Control flow unchanged: UPDATE ran and the transition completed.
      expect(res.transitioned).toBe(true);
      expect(completeRun).toHaveBeenCalledWith(expect.anything(), 'run-1', 'completed');
    });

    it('propagates a spine write failure (fails the job — BullMQ retries)', async () => {
      vi.mocked(recordStep).mockRejectedValueOnce(new Error('spine write failed'));
      const tx = makeTx([{ id: 'resp-1', approval_method: APPROVAL_METHOD.AUTO_POLICY }]);

      await expect(
        markPostedAndMaybeEnqueueAutoPostNotice(baseInput(tx)),
      ).rejects.toThrow('spine write failed');
      expect(completeRun).not.toHaveBeenCalled();
    });
  });
});
