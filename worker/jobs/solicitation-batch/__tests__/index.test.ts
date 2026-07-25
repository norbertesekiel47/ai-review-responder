import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildSolicitationBatchPayload } from '@/lib/shared/worker-types';

const mocks = vi.hoisted(() => ({
  buildSolicitationBatch: vi.fn(),
  extractOutboxHandle: vi.fn<
    () => { outboxId: string; attempt: number | undefined }
  >(() => ({ outboxId: 'outbox-1', attempt: 3 })),
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
}));
vi.mock('@/lib/shared/logger', () => ({
  createWorkerLogger: () => mocks.logger,
}));

import { handleSolicitationBatch } from '../index';

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
  mocks.logger.log.mockReset();
  mocks.logger.warn.mockReset();
  mocks.logger.error.mockReset();
  mocks.extractOutboxHandle.mockReturnValue({ outboxId: 'outbox-1', attempt: 3 });
  mocks.buildSolicitationBatch.mockResolvedValue({
    status: 'built',
    candidateCount: 30,
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
      candidate_count: 30,
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
    });
    const loggedAggregate = mocks.logger.log.mock.calls[0]![1];
    expect(loggedAggregate).not.toHaveProperty('batch_id');
    expect(loggedAggregate).not.toHaveProperty('business_id');
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
});
