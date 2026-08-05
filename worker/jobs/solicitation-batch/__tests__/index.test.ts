import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildSolicitationBatchPayload } from '@/lib/shared/worker-types';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../__tests__/helpers/mock-sql');
    return {
      ...helpers.createMockSql(),
      mkTaggedResult: helpers.mkTaggedResult,
    };
  });

const mocks = vi.hoisted(() => ({
  buildSolicitationBatch: vi.fn(),
  extractOutboxHandle: vi.fn<
    () => { outboxId: string; attempt: number | undefined }
  >(() => ({ outboxId: 'outbox-1', attempt: 3 })),
  markOutboxFailed: vi.fn(),
  failSolicitationBatchRun: vi.fn(),
  logger: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/solicitation/batch-builder', () => ({
  buildSolicitationBatch: mocks.buildSolicitationBatch,
}));
vi.mock('@/lib/shared/outbox', () => ({
  extractOutboxHandle: mocks.extractOutboxHandle,
  markOutboxFailed: mocks.markOutboxFailed,
}));
vi.mock('@/lib/agents/run-spine', () => ({
  failSolicitationBatchRun: mocks.failSolicitationBatchRun,
}));
vi.mock('@/lib/shared/logger', () => ({
  createWorkerLogger: () => mocks.logger,
}));

import { handleSolicitationBatch } from '../index';
import { handleSolicitationBatchFailed } from '../failed-hook';

const job = {
  id: 'bull-job-1',
  data: {
    batch_id: 'batch-1',
    business_id: 'business-1',
    correlation_id: 'corr-1',
    outbox_id: 'outbox-1',
    outbox_attempt: 3,
  },
} as unknown as Job<BuildSolicitationBatchPayload>;

beforeEach(() => {
  mocks.buildSolicitationBatch.mockReset();
  mocks.extractOutboxHandle.mockReset();
  mocks.markOutboxFailed.mockReset();
  mocks.failSolicitationBatchRun.mockReset();
  mocks.logger.log.mockReset();
  mocks.logger.warn.mockReset();
  mocks.logger.error.mockReset();
  mocks.extractOutboxHandle.mockReturnValue({ outboxId: 'outbox-1', attempt: 3 });
  mocks.markOutboxFailed.mockResolvedValue(true);
  mocks.failSolicitationBatchRun.mockResolvedValue(undefined);
  resetMockSql();
  mocks.buildSolicitationBatch.mockResolvedValue({
    status: 'built',
    candidateCount: 30,
    poolCount: 42,
    sendCount: 25,
    withholdCount: 5,
    withheldByReason: {
      no_consent: 0,
      suppressed: 0,
      already_reviewed: 0,
      stale_visit: 2,
      over_contacted: 1,
      velocity_banked: 2,
    },
    sendHandoff: { status: 'not_applicable' },
  });
});

describe('Solicitation batch worker success path', () => {
  it('extracts exact ownership, delegates construction, and logs only PII-free aggregates', async () => {
    const sql = vi.fn() as unknown as Sql;

    await handleSolicitationBatch(sql, job);

    expect(mocks.extractOutboxHandle).toHaveBeenCalledWith(job.data, job.id);
    expect(mocks.buildSolicitationBatch).toHaveBeenCalledWith(sql, {
      batchId: 'batch-1',
      businessId: 'business-1',
      outboxId: 'outbox-1',
      attempt: 3,
      correlationId: 'corr-1',
    });
    expect(mocks.logger.log).toHaveBeenCalledWith('solicitation batch build finished', {
      status: 'built',
      batch_id: 'batch-1',
      business_id: 'business-1',
      outbox_attempt: 3,
      selected_count: 30,
      pool_count: 42,
      truncated_count: 12,
      send_count: 25,
      withhold_count: 5,
      withheld_by_reason: {
        no_consent: 0,
        suppressed: 0,
        already_reviewed: 0,
        stale_visit: 2,
        over_contacted: 1,
        velocity_banked: 2,
      },
      send_handoff: { status: 'not_applicable' },
    });
    const loggedAggregate = mocks.logger.log.mock.calls[0]![1];
    expect(loggedAggregate).toMatchObject({
      batch_id: 'batch-1',
      business_id: 'business-1',
    });
    expect(loggedAggregate).not.toHaveProperty('outbox_id');
  });

  it('rejects a build job that lacks an exact dispatched attempt', async () => {
    mocks.extractOutboxHandle.mockReturnValue({
      outboxId: 'outbox-1',
      attempt: undefined,
    });

    await expect(
      handleSolicitationBatch(vi.fn() as unknown as Sql, job),
    ).rejects.toThrow('requires an exact outbox_attempt');
    expect(mocks.buildSolicitationBatch).not.toHaveBeenCalled();
  });

  it('swallows best-effort aggregate logging failures after construction commits', async () => {
    mocks.logger.log.mockImplementationOnce(() => {
      throw new Error('observability unavailable');
    });

    await expect(
      handleSolicitationBatch(mockSql as unknown as Sql, job),
    ).resolves.toBeUndefined();
    expect(mocks.buildSolicitationBatch).toHaveBeenCalledOnce();
  });

  // #656 T6 — the withheld Send handoff rides the EXISTING structured log
  // object as one more field (`send_handoff`), carrying a status and a reason
  // code and no address: the signal that a location is silently not sending.
  // The worker is the emitter, not batch-builder.ts, which returns results and
  // deliberately does no logging (deviations D4). Note the success-path
  // assertion above is an EXACT `toHaveBeenCalledWith` object — T6 widened it
  // in the same change, or this suite would go red on the new field.
  it('the solicitation batch worker logs the send handoff status and location-level reason', async () => {
    mocks.buildSolicitationBatch.mockResolvedValue({
      status: 'built',
      candidateCount: 4,
      poolCount: 4,
      sendCount: 3,
      withholdCount: 1,
      withheldByReason: {
        no_consent: 1,
        suppressed: 0,
        already_reviewed: 0,
        stale_visit: 0,
        over_contacted: 0,
        velocity_banked: 0,
      },
      sendHandoff: { status: 'withheld', reason: 'postal_address_missing' },
    });

    await handleSolicitationBatch(vi.fn() as unknown as Sql, job);

    const loggedAggregate = mocks.logger.log.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(loggedAggregate.send_handoff).toEqual({
      status: 'withheld',
      reason: 'postal_address_missing',
    });
    // The batch still built and still reported its per-candidate counts: the
    // precondition withholds the handoff, never the build.
    expect(loggedAggregate).toMatchObject({
      status: 'built',
      send_count: 3,
      withhold_count: 1,
    });
    // A status and a reason code and NOTHING else — the address itself must
    // never reach a log line. Asserting the key set (not merely "it does not
    // contain a ZIP") is what keeps a future widening of the field honest.
    expect(Object.keys(loggedAggregate.send_handoff as object).sort()).toEqual([
      'reason',
      'status',
    ]);
  });
});

describe('Solicitation batch worker exhausted failure path', () => {
  const failedJob = (overrides: Partial<Job<BuildSolicitationBatchPayload>> = {}) => ({
    ...job,
    attemptsMade: 3,
    opts: { attempts: 3 },
    ...overrides,
  }) as unknown as Job<BuildSolicitationBatchPayload>;

  it('does nothing terminal before BullMQ retries are exhausted', async () => {
    await handleSolicitationBatchFailed(
      mockSql as unknown as Sql,
      failedJob({ attemptsMade: 2 }),
      new Error('retryable'),
    );

    expect(mocks.markOutboxFailed).not.toHaveBeenCalled();
    expect(mocks.failSolicitationBatchRun).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(0);
  });

  it('claims the exact outbox attempt before failing only its active parent', async () => {
    sqlReturnQueue.push(mkTaggedResult([{ id: 'parent-run-1' }]));

    await handleSolicitationBatchFailed(
      mockSql as unknown as Sql,
      failedJob(),
      new Error('private@example.test'),
    );

    expect(mocks.markOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-1',
      'build_solicitation_batch_exhausted:Error',
      3,
    );
    expect(sqlCalls[0]?.text).toContain('JOIN agent_runs');
    expect(sqlCalls[0]?.text).toContain("status = 'running'");
    expect(sqlCalls[0]?.values).toEqual([
      'batch-1',
      'business-1',
      'business-1',
    ]);
    expect(mocks.failSolicitationBatchRun).toHaveBeenCalledWith(
      mockSql,
      {
        runId: 'parent-run-1',
        failure: { code: 'build_failed', errorClass: 'Error' },
      },
    );
    expect(
      mocks.markOutboxFailed.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.failSolicitationBatchRun.mock.invocationCallOrder[0]!);
  });

  it('writes no parent terminal state when the outbox attempt is stale', async () => {
    mocks.markOutboxFailed.mockResolvedValue(false);

    await handleSolicitationBatchFailed(
      mockSql as unknown as Sql,
      failedJob(),
      new Error('stale'),
    );

    expect(mocks.failSolicitationBatchRun).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(0);
  });

  it('swallows best-effort failure logging after the terminal transaction commits', async () => {
    sqlReturnQueue.push(mkTaggedResult([{ id: 'parent-run-1' }]));
    mocks.logger.error.mockImplementationOnce(() => {
      throw new Error('observability unavailable');
    });

    await expect(
      handleSolicitationBatchFailed(
        mockSql as unknown as Sql,
        failedJob(),
        new Error('boom'),
      ),
    ).resolves.toBeUndefined();
    expect(mocks.failSolicitationBatchRun).toHaveBeenCalledOnce();
  });
});
