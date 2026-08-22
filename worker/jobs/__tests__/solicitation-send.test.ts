// Composition root for the Solicitation send worker (#899).
//
// `worker/jobs/solicitation-send.ts` is a SHIM, and this suite exists to keep it
// one. Invariant #12: entry points orchestrate, modules own failure behaviour.
// The whole handler is: extract the outbox handle from the BullMQ payload, hand
// the singleton `sql` down (invariant #15 — this file is a composition root, so
// it is one of the few places allowed to import it), call `dispatchOutreach`,
// return. No gate logic, no adapter call, no transaction, no retry decision.
//
// None of the plan's promised titles belongs here: every one of them is a claim
// about the domain module, and asserting it through the root would test
// `dispatch.ts` twice while leaving the root's own thinness unpinned.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import type { SolicitationSendPayload } from '@/lib/shared/worker-types';

const mocks = vi.hoisted(() => ({
  dispatchOutreach: vi.fn(),
  getMessagingAdapter: vi.fn(),
  startOrGetSolicitationAskRun: vi.fn(),
  markOutboxCompletedIfOwned: vi.fn(),
}));

vi.mock('@/lib/solicitation/dispatch', () => ({
  dispatchOutreach: mocks.dispatchOutreach,
}));
// The three collaborators a root that had grown business logic would reach for.
// They are mocked ONLY so this suite can assert they stay untouched.
vi.mock('@/lib/messaging/messaging-adapter', () => ({
  getMessagingAdapter: mocks.getMessagingAdapter,
}));
vi.mock('@/lib/agents/run-spine', () => ({
  startOrGetSolicitationAskRun: mocks.startOrGetSolicitationAskRun,
}));
vi.mock('@/lib/shared/outbox', async (importOriginal) => ({
  // extractOutboxHandle is the root's ONE piece of real work, so it stays real.
  ...(await importOriginal<typeof import('@/lib/shared/outbox')>()),
  markOutboxCompletedIfOwned: mocks.markOutboxCompletedIfOwned,
}));

import { handleSolicitationSend } from '../solicitation-send';

const sql = Symbol('sql') as unknown as Sql;

function job(
  overrides: Partial<SolicitationSendPayload> = {},
  id = 'bullmq-job-1',
): Job<SolicitationSendPayload> {
  return {
    id,
    data: {
      batch_id: 'batch-1',
      business_id: 'business-1',
      outreach_id: 'outreach-1',
      outbox_id: 'outbox-1',
      outbox_attempt: 2,
      ...overrides,
    } as SolicitationSendPayload,
  } as Job<SolicitationSendPayload>;
}

describe('SolicitationSendWorker', () => {
  it('delegates to dispatchOutreach and touches nothing else', async () => {
    mocks.dispatchOutreach.mockResolvedValue(undefined);

    await handleSolicitationSend(sql, job({ correlation_id: 'corr-1' }));

    expect(mocks.dispatchOutreach).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchOutreach).toHaveBeenCalledWith(sql, {
      batchId: 'batch-1',
      businessId: 'business-1',
      outreachId: 'outreach-1',
      outboxHandle: { outboxId: 'outbox-1', attempt: 2 },
      correlationId: 'corr-1',
    });

    // Invariant #12, asserted rather than trusted: a root that had grown a gate
    // check, a send, or an outbox write would have reached one of these.
    expect(mocks.getMessagingAdapter).not.toHaveBeenCalled();
    expect(mocks.startOrGetSolicitationAskRun).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompletedIfOwned).not.toHaveBeenCalled();
  });

  it('falls back to the outbox row id when the producer sent no correlation id', async () => {
    mocks.dispatchOutreach.mockResolvedValue(undefined);

    await handleSolicitationSend(sql, job());

    // Every line this lane logs has to be joinable to the attempt that produced
    // it, so the correlation id is REQUIRED by the domain. The outbox row id is
    // the durable identity when the producer supplied none — #900 is the
    // producer and does not exist yet, so this is the live path today.
    expect(mocks.dispatchOutreach).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({ correlationId: 'outbox-1' }),
    );
  });

  it('propagates a domain error unchanged so BullMQ can retry and the failed hook can fire', async () => {
    const boom = new Error('tx2 did not commit');
    mocks.dispatchOutreach.mockRejectedValue(boom);

    // The root maps nothing and swallows nothing: retry classification lives in
    // the domain, and the terminal attempt is the failed hook's to own.
    await expect(handleSolicitationSend(sql, job())).rejects.toBe(boom);
  });
});
