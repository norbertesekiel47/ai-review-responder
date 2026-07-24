import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import type { CsvIngestPayload } from '@/lib/shared/worker-types';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mockLogger } = await vi.hoisted(async () => {
  const { createMockSql, mockWorkerLogger } = await import('../../../__tests__/helpers/mock-sql');
  return { ...createMockSql(), mockLogger: mockWorkerLogger() };
});

const mocks = vi.hoisted(() => ({
  ingestContactsCsvUpload: vi.fn(),
  markOutboxCompleted: vi.fn(),
  markOutboxFailed: vi.fn(),
  extractOutboxHandle: vi.fn(() => ({ outboxId: 'outbox-1', attempt: 3 })),
  captureException: vi.fn(),
}));

vi.mock('@/lib/solicitation/ingest', () => ({
  ingestContactsCsvUpload: mocks.ingestContactsCsvUpload,
}));
vi.mock('@/lib/shared/outbox', () => ({
  markOutboxCompleted: mocks.markOutboxCompleted,
  markOutboxFailed: mocks.markOutboxFailed,
  extractOutboxHandle: mocks.extractOutboxHandle,
}));
vi.mock('@/lib/shared/logger', () => ({ createWorkerLogger: () => mockLogger }));
vi.mock('@sentry/node', () => ({ captureException: mocks.captureException }));

import { handleCsvIngest } from '../index';
import { handleCsvIngestFailed } from '../failed-hook';

const makeJob = (
  overrides: Partial<Job<CsvIngestPayload>> = {},
): Job<CsvIngestPayload> => ({
  id: 'bull-job-1',
  data: {
    uploadId: 'upload-1',
    businessId: 'business-1',
    outbox_id: 'outbox-1',
    outbox_attempt: 3,
  },
  attemptsMade: 1,
  opts: { attempts: 3 },
  ...overrides,
}) as unknown as Job<CsvIngestPayload>;

const run = (job = makeJob()) => handleCsvIngest(mockSql as unknown as Sql, job);

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mockLogger.log.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  resetMockSql();
  mocks.extractOutboxHandle.mockReturnValue({ outboxId: 'outbox-1', attempt: 3 });
  mocks.markOutboxFailed.mockResolvedValue(true);
});

describe('handleCsvIngest', () => {
  it('csv ingest worker no-ops for subscriptions without full access', async () => {
    sqlReturnQueue.push([{ subscription_status: 'pending_payment' }]);

    await run();

    expect(mocks.ingestContactsCsvUpload).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 3);
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('subscription lacks full access'),
      expect.objectContaining({ subscription_status: 'pending_payment' }),
    );
  });

  it('completes the outbox row without ingesting when the upload row is missing or not paired to the payload business', async () => {
    // The gate binds the payload's businessId (u.business_id AND b.id), so a
    // deleted upload and a payload/row pairing mismatch are the same empty
    // read — both take this warn-and-complete branch.
    sqlReturnQueue.push([]);

    await run();

    expect(mocks.ingestContactsCsvUpload).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 3);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('missing or not paired'),
      expect.objectContaining({ upload_id: 'upload-1' }),
    );
  });

  it('delegates full-access uploads to the ingest module, then completes the outbox row', async () => {
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    mocks.ingestContactsCsvUpload.mockResolvedValue({
      contactsCreated: 1, contactsMerged: 0, visitsAdded: 1, duplicateVisits: 0,
      rejected: [], structuralFailure: null,
    });

    await run();

    expect(mocks.ingestContactsCsvUpload).toHaveBeenCalledWith(mockSql, 'upload-1', 'business-1');
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 3);
    // The subscription gate reads the pairing from the upload row, with the
    // payload businessId bound into the WHERE (tenant scope by construction).
    expect(sqlCalls[0]!.text).toContain('FROM contact_csv_uploads');
    expect(sqlCalls[0]!.values).toEqual(['upload-1', 'business-1', 'business-1']);
  });
});

describe('handleCsvIngestFailed', () => {
  const failedRun = (job: Job<CsvIngestPayload> | undefined, err: unknown = new Error('boom')) =>
    handleCsvIngestFailed(mockSql as unknown as Sql, job, err);

  it('does nothing before BullMQ retries are exhausted', async () => {
    await failedRun(makeJob({ attemptsMade: 2, opts: { attempts: 3 } } as Partial<Job<CsvIngestPayload>>));

    expect(mocks.markOutboxFailed).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(0);
  });

  it('terminalizes a still-pending upload under the advisory lock on exhaustion', async () => {
    await failedRun(makeJob({ attemptsMade: 3, opts: { attempts: 3 } } as Partial<Job<CsvIngestPayload>>));

    expect(sqlCalls[0]!.text).toContain('pg_advisory_xact_lock');
    expect(sqlCalls[0]!.values).toEqual(['csv_ingest_business-1']);
    expect(mocks.markOutboxFailed).toHaveBeenCalledWith(
      mockSql, 'outbox-1', 'csv_ingest_exhausted:Error', 3,
    );
    const update = sqlCalls.find((call) => call.text.includes('UPDATE contact_csv_uploads'));
    expect(update).toBeDefined();
    expect(update!.text).toContain("status = 'pending'");
    expect(update!.values).toContainEqual(expect.objectContaining({ error: 'ingest_failed' }));
  });

  it('skips the upload terminalization when a newer attempt owns the outbox row', async () => {
    mocks.markOutboxFailed.mockResolvedValue(false);

    await failedRun(makeJob({ attemptsMade: 3, opts: { attempts: 3 } } as Partial<Job<CsvIngestPayload>>));

    expect(sqlCalls.some((call) => call.text.includes('UPDATE contact_csv_uploads'))).toBe(false);
  });
});
