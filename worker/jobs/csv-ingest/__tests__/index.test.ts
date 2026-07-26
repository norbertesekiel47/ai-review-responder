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
  terminalizeUploadForInactiveSubscription: vi.fn(),
  acquireCsvIngestLock: vi.fn(),
  markOutboxCompleted: vi.fn(),
  markOutboxFailed: vi.fn(),
  extractOutboxHandle: vi.fn(() => ({ outboxId: 'outbox-1', attempt: 3 })),
  captureException: vi.fn(),
}));

// Only the entry points the worker orchestrates are stubbed. The lock owner is
// SPIED on the real implementation and `writeTerminalUploadState` stays real,
// so the SQL assertions below still exercise the shared owners' actual queries.
vi.mock('@/lib/solicitation/ingest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/solicitation/ingest')>()),
  ingestContactsCsvUpload: mocks.ingestContactsCsvUpload,
  terminalizeUploadForInactiveSubscription: mocks.terminalizeUploadForInactiveSubscription,
  acquireCsvIngestLock: mocks.acquireCsvIngestLock,
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

const { acquireCsvIngestLock: realAcquireCsvIngestLock } =
  await vi.importActual<typeof import('@/lib/solicitation/ingest')>('@/lib/solicitation/ingest');

const makeJob = (
  overrides: Partial<Job<CsvIngestPayload>> = {},
): Job<CsvIngestPayload> => ({
  id: 'bull-job-1',
  data: {
    upload_id: 'upload-1',
    business_id: 'business-1',
    outbox_id: 'outbox-1',
    outbox_attempt: 3,
  },
  attemptsMade: 1,
  opts: { attempts: 3 },
  ...overrides,
}) as unknown as Job<CsvIngestPayload>;

const run = (job = makeJob()) => handleCsvIngest(mockSql as unknown as Sql, job);

/** Row served to the REAL assertWritableSubscriptionForAccount (not mocked —
 *  the worker must share the upload route's exact predicate, so these tests
 *  exercise the genuine grace-window/entitlement rules). */
const accountRow = (overrides: Record<string, unknown> = {}) => ({
  subscription_status: 'active',
  past_due_at: null,
  flags: {},
  offboarding_id: null,
  offboarding_account_id: null,
  offboarding_mode: null,
  offboarding_status: null,
  offboarding_failed_step: null,
  offboarding_access_ends_at: null,
  offboarding_teardown_started_at: null,
  offboarding_purge_after: null,
  offboarding_purge_started_at: null,
  offboarding_purge_cancelled_at: null,
  ...overrides,
});

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mockLogger.log.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  resetMockSql();
  mocks.extractOutboxHandle.mockReturnValue({ outboxId: 'outbox-1', attempt: 3 });
  mocks.markOutboxFailed.mockResolvedValue(true);
  // Spy, not stub: the real lock statement must still hit the mock sql.
  mocks.acquireCsvIngestLock.mockImplementation(realAcquireCsvIngestLock);
});

describe('handleCsvIngest', () => {
  it('csv ingest worker processes uploads for past_due accounts in grace', async () => {
    sqlReturnQueue.push(
      [{ account_id: 'account-1' }],
      // Day 2 of the 7-day grace window: requireWritableOwner admits this
      // owner's upload, so the worker must process it, not strand it.
      [accountRow({
        subscription_status: 'past_due',
        past_due_at: new Date(Date.now() - 2 * 86_400_000),
      })],
    );
    mocks.ingestContactsCsvUpload.mockResolvedValue({
      contactsCreated: 1, contactsMerged: 0, visitsAdded: 1, duplicateVisits: 0,
      rejected: [], structuralFailure: null,
    });

    await run();

    expect(mocks.ingestContactsCsvUpload).toHaveBeenCalledWith(mockSql, 'upload-1', 'business-1');
    expect(mocks.terminalizeUploadForInactiveSubscription).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 3);
  });

  it('csv ingest worker terminalizes the upload when the subscription is inactive', async () => {
    sqlReturnQueue.push(
      [{ account_id: 'account-1' }],
      [accountRow({ subscription_status: 'cancelled' })],
    );

    await run();

    expect(mocks.ingestContactsCsvUpload).not.toHaveBeenCalled();
    expect(mocks.terminalizeUploadForInactiveSubscription)
      .toHaveBeenCalledWith(mockSql, 'upload-1', 'business-1');
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 3);
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('subscription not writable'),
      expect.objectContaining({ upload_id: 'upload-1', reason: 'subscription_inactive' }),
    );
  });

  it('completes the outbox row without ingesting when the upload row is missing or not paired to the payload business', async () => {
    // The gate binds the payload's business_id (u.business_id AND b.id), so a
    // deleted upload and a payload/row pairing mismatch are the same empty
    // read — both take this warn-and-complete branch.
    sqlReturnQueue.push([]);

    await run();

    expect(mocks.ingestContactsCsvUpload).not.toHaveBeenCalled();
    expect(mocks.terminalizeUploadForInactiveSubscription).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 3);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('missing or not paired'),
      expect.objectContaining({ upload_id: 'upload-1' }),
    );
  });

  it('delegates full-access uploads to the ingest module, then completes the outbox row', async () => {
    sqlReturnQueue.push([{ account_id: 'account-1' }], [accountRow()]);
    mocks.ingestContactsCsvUpload.mockResolvedValue({
      contactsCreated: 1, contactsMerged: 0, visitsAdded: 1, duplicateVisits: 0,
      rejected: [], structuralFailure: null,
    });

    await run();

    expect(mocks.ingestContactsCsvUpload).toHaveBeenCalledWith(mockSql, 'upload-1', 'business-1');
    expect(mocks.markOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 3);
    // The pairing gate reads from the upload row, with the payload
    // business_id bound into the WHERE (tenant scope by construction).
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
    // Statuses are bound values sourced from UPLOAD_STATUSES (single owner).
    expect(update!.text).toContain('AND status = ?');
    expect(update!.values).toContain('failed');
    expect(update!.values).toContain('pending');
    expect(update!.values).toContainEqual(expect.objectContaining({ error: 'ingest_failed' }));
  });

  it('the csv-ingest failed hook takes the advisory lock through acquireCsvIngestLock', async () => {
    await failedRun(makeJob({ attemptsMade: 3, opts: { attempts: 3 } } as Partial<Job<CsvIngestPayload>>));

    expect(mocks.acquireCsvIngestLock).toHaveBeenCalledTimes(1);
    expect(mocks.acquireCsvIngestLock).toHaveBeenCalledWith(mockSql, 'business-1');
    // Key VALUE pinned through the shared owner: it cannot silently change.
    expect(sqlCalls[0]!.values).toEqual(['csv_ingest_business-1']);
    // Statement order is the contract: lock FIRST, then the outbox CAS, then
    // the coupled terminal write.
    expect(mocks.acquireCsvIngestLock.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.markOutboxFailed.mock.invocationCallOrder[0]!);
    expect(sqlCalls.findIndex((call) => call.text.includes('UPDATE contact_csv_uploads')))
      .toBeGreaterThan(0);
  });

  it('skips the upload terminalization when a newer attempt owns the outbox row', async () => {
    mocks.markOutboxFailed.mockResolvedValue(false);

    await failedRun(makeJob({ attemptsMade: 3, opts: { attempts: 3 } } as Partial<Job<CsvIngestPayload>>));

    expect(sqlCalls.some((call) => call.text.includes('UPDATE contact_csv_uploads'))).toBe(false);
  });
});
