import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { IngestZernioReviewPayload } from '../../../../src/lib/shared/worker-types';

const { sqlReturnQueue, mockSql, mockSqlBegin, mockMarkOutboxFailed } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? Object.assign([], { count: 0 });
    // Queueing an Error simulates a statement failing mid-transaction.
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  });
  // Identity pass-through for sql.json(...) (mirrors mock-sql.ts's createMockSql().json).
  mockSql.json = vi.fn((v: unknown) => v);
  // sql.begin hands the same executor back as tx, so assertions on statement
  // calls keep landing on mockSql; a rejecting statement rejects the tx.
  const mockSqlBegin = vi.fn(async (cb: (tx: unknown) => unknown) => cb(mockSql));
  mockSql.begin = mockSqlBegin;
  return { sqlReturnQueue, mockSql, mockSqlBegin, mockMarkOutboxFailed: vi.fn() };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (d: any, fallback: string) => ({
    outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback,
    attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined,
  }),
}));
vi.mock('@sentry/node', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import * as Sentry from '@sentry/node';
import { handleIngestFailed } from '../ingest-failed-hook';
import { ZernioIngestReviewNotFoundError } from '../ZernioReviewIngestWorker';

function makeJob(
  overrides: Partial<IngestZernioReviewPayload> = {},
  attemptsMade = 5,
  maxAttempts = 5,
): Job<IngestZernioReviewPayload> {
  return {
    id: 'job-1',
    data: {
      business_id: 'biz-1',
      zernio_account_id: 'acct-1',
      zernio_location_id: 'loc-1',
      zernio_review_id: 'rev-abc',
      outbox_id: 'outbox-1',
      outbox_attempt: 1,
      ...overrides,
    },
    attemptsMade,
    opts: { attempts: maxAttempts },
  } as unknown as Job<IngestZernioReviewPayload>;
}

beforeEach(() => {
  vi.resetAllMocks();
  sqlReturnQueue.length = 0;
  // CAS-first contract: handlers only write when they own the terminal
  // transition, so the default is a won CAS.
  mockMarkOutboxFailed.mockResolvedValue(true);
});

describe('handleIngestFailed', () => {
  describe('ZernioIngestReviewNotFoundError', () => {
    it('inserts review_exception with the error fields and marks outbox failed', async () => {
      const err = new ZernioIngestReviewNotFoundError(
        'biz-1', 'acct-1', 'loc-1', 'rev-abc', 2, 78,
      );

      await handleIngestFailed(mockSql, makeJob(), err);

      // Verify the SQL template structure.
      expect(mockSql).toHaveBeenCalledTimes(1);
      const sqlCall = mockSql.mock.calls[0]!;
      const stringPart = (sqlCall[0] as TemplateStringsArray).join('?');
      expect(stringPart).toContain('INSERT INTO review_exceptions');
      // The exception type is a bound value now (single-owner INSERT helper),
      // not a literal in the SQL text.
      expect(sqlCall.slice(1)).toContain('zernio_review_not_found');
      expect(stringPart).toContain("ON CONFLICT (business_id, type, (payload->>'provider_review_id'))");
      expect(stringPart).toContain('DO NOTHING');

      // Verify the error fields actually flow into the SQL interpolations.
      const interpolatedValues = sqlCall.slice(1);
      expect(interpolatedValues).toContain('biz-1');

      const jsonbValue = interpolatedValues.find(
        (v: unknown): v is Record<string, unknown> =>
          !!v && typeof v === 'object' && (v as any).provider === 'zernio',
      );
      expect(jsonbValue).toEqual({
        provider: 'zernio',
        provider_review_id: 'rev-abc',
        zernio_account_id: 'acct-1',
        zernio_location_id: 'loc-1',
        pages_walked: 2,
        reviews_seen: 78,
        retries_exhausted_at: expect.any(String),
      });

      // Verify outbox closure.
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        mockSql,
        'outbox-1',
        'zernio_review_not_found_after_retries',
        1,
      );
    });

    it('does not call sql when attemptsMade < max attempts (still retrying)', async () => {
      const err = new ZernioIngestReviewNotFoundError(
        'biz-1', 'acct-1', 'loc-1', 'rev-abc', 1, 25,
      );

      await handleIngestFailed(mockSql, makeJob({}, 2, 5), err);

      expect(mockSql).not.toHaveBeenCalled();
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    });

    it('does not act on the last-but-one attempt (attemptsMade=4, attempts=5 — still retrying)', async () => {
      // Boundary case: the guard is `attemptsMade < attempts`. attemptsMade=4
      // is the LAST allowed retry — BullMQ has not yet exhausted retries, so
      // the failed-hook must be a no-op. If the guard regressed to `<=`,
      // this test catches it.
      const err = new ZernioIngestReviewNotFoundError(
        'biz-1', 'acct-1', 'loc-1', 'rev-abc', 3, 100,
      );

      await handleIngestFailed(mockSql, makeJob({}, 4, 5), err);

      expect(mockSql).not.toHaveBeenCalled();
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    });
  });

  describe('ZernioIngestPaginationCapExhaustedError', () => {
    it('inserts cap-exhausted exception, captures Sentry warning, marks outbox failed', async () => {
      const Sentry = await import('@sentry/node');
      const { ZernioIngestPaginationCapExhaustedError } = await import('../ZernioReviewIngestWorker');

      // Constructor takes positional args: (businessId, zernioAccountId, zernioLocationId, zernioReviewId, cap, reviewsSeen).
      const err = new ZernioIngestPaginationCapExhaustedError(
        'biz-1', 'acct-1', 'loc-1', 'rev-abc', 4, 200,
      );

      await handleIngestFailed(mockSql, makeJob(), err);

      expect(mockSql).toHaveBeenCalledTimes(1);
      const sqlCall = mockSql.mock.calls[0]!;
      const stringPart = (sqlCall[0] as TemplateStringsArray).join('?');
      expect(stringPart).toContain('INSERT INTO review_exceptions');
      // Bound value, not SQL text — see the review_not_found test.
      expect(sqlCall.slice(1)).toContain('zernio_pagination_cap_exhausted');

      // Verify error fields flow into the SQL interpolations.
      const interpolatedValues = sqlCall.slice(1);
      expect(interpolatedValues).toContain('biz-1');
      const jsonbValue = interpolatedValues.find(
        (v: unknown): v is Record<string, unknown> =>
          !!v && typeof v === 'object' && (v as any).provider === 'zernio',
      );
      expect(jsonbValue).toEqual({
        provider: 'zernio',
        provider_review_id: 'rev-abc',
        zernio_account_id: 'acct-1',
        zernio_location_id: 'loc-1',
        cap: 4,
        // pages_walked == cap in the cap-exhausted branch (we walked
        // every page allowed); included alongside cap so ops can compare
        // payloads across exception types without special-casing.
        pages_walked: 4,
        reviews_seen: 200,
        retries_exhausted_at: expect.any(String),
      });

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'zernio_pagination_cap_exhausted',
        expect.objectContaining({
          level: 'warning',
          tags: expect.objectContaining({
            worker: 'ingest_zernio_review',
            kind: 'pagination_cap_exhausted',
          }),
          extra: expect.objectContaining({
            business_id: 'biz-1',
            zernio_account_id: 'acct-1',
            zernio_location_id: 'loc-1',
            zernio_review_id: 'rev-abc',
            cap: 4,
            reviews_seen: 200,
          }),
        }),
      );

      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        mockSql,
        'outbox-1',
        'zernio_pagination_cap_exhausted',
        1,
      );
    });
  });

  describe('ZernioIngestUnparseableLocationError', () => {
    it('inserts exception, enqueues admin notify, marks outbox failed', async () => {
      const { ZernioIngestUnparseableLocationError } = await import('../ZernioReviewIngestWorker');

      // First sql call: INSERT review_exceptions … RETURNING id (yields a row).
      // Second sql call: INSERT job_outbox notify_admin_review_exception.
      sqlReturnQueue.push(Object.assign([{ id: 'exc-1' }], { count: 1 }));
      sqlReturnQueue.push(Object.assign([], { count: 1 }));

      // Constructor takes positional args: (businessId, zernioAccountId, zernioLocationId, zernioReviewId, reviewName).
      const err = new ZernioIngestUnparseableLocationError(
        'biz-1', 'acct-1', 'loc-1', 'rev-abc', 'malformed/review/name',
      );

      await handleIngestFailed(mockSql, makeJob(), err);

      expect(mockSql).toHaveBeenCalledTimes(2);

      // First call: review_exceptions INSERT with RETURNING id.
      const firstSqlCall = mockSql.mock.calls[0]!;
      const firstSql = (firstSqlCall[0] as TemplateStringsArray).join('?');
      expect(firstSql).toContain('INSERT INTO review_exceptions');
      // Bound value, not SQL text — see the review_not_found test.
      expect(firstSqlCall.slice(1)).toContain('zernio_unparseable_review_name');
      expect(firstSql).toContain('RETURNING id');

      const firstInterpolated = firstSqlCall.slice(1);
      expect(firstInterpolated).toContain('biz-1');
      const jsonbValue = firstInterpolated.find(
        (v: unknown): v is Record<string, unknown> =>
          !!v && typeof v === 'object' && (v as any).provider === 'zernio',
      );
      expect(jsonbValue).toEqual({
        provider: 'zernio',
        provider_review_id: 'rev-abc',
        zernio_account_id: 'acct-1',
        zernio_location_id: 'loc-1',
        review_name_truncated: 'malformed/review/name',
        retries_exhausted_at: expect.any(String),
      });

      // Second call: notify_admin_review_exception outbox row. Topic is an
      // interpolated QUEUE_NAMES value, not a template literal — check the
      // bound values, not the raw strings array.
      const secondSqlCall = mockSql.mock.calls[1]!;
      const secondSql = (secondSqlCall[0] as TemplateStringsArray).join('?');
      expect(secondSql).toContain('INSERT INTO job_outbox');
      expect(secondSqlCall.slice(1)).toContain('notify_admin_review_exception');

      const secondInterpolated = secondSqlCall.slice(1);
      const outboxPayload = secondInterpolated.find(
        (v: unknown): v is Record<string, unknown> =>
          !!v && typeof v === 'object' && 'review_exception_id' in v,
      );
      expect(outboxPayload).toEqual({
        review_exception_id: 'exc-1',
        business_id: 'biz-1',
      });

      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        mockSql,
        'outbox-1',
        'zernio_unparseable_review_name',
        1,
      );
    });

    it('skips admin notify when exception INSERT was deduped (no row returned)', async () => {
      const { ZernioIngestUnparseableLocationError } = await import('../ZernioReviewIngestWorker');

      // INSERT review_exceptions returned 0 rows (existing open exception suppressed via ON CONFLICT).
      sqlReturnQueue.push(Object.assign([], { count: 0 }));

      const err = new ZernioIngestUnparseableLocationError(
        'biz-1', 'acct-1', 'loc-1', 'rev-abc', 'malformed/review/name',
      );

      await handleIngestFailed(mockSql, makeJob(), err);

      expect(mockSql).toHaveBeenCalledTimes(1);
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        mockSql,
        'outbox-1',
        'zernio_unparseable_review_name',
        1,
      );
    });

    it('truncates reviewName to 500 chars in the JSONB payload', async () => {
      const { ZernioIngestUnparseableLocationError } = await import('../ZernioReviewIngestWorker');

      // INSERT returns a row so the truncation is observable in the captured payload.
      sqlReturnQueue.push(Object.assign([{ id: 'exc-2' }], { count: 1 }));
      sqlReturnQueue.push(Object.assign([], { count: 1 }));

      const longName = 'A'.repeat(800);  // 800 chars > 500-char cap
      const err = new ZernioIngestUnparseableLocationError(
        'biz-1', 'acct-1', 'loc-1', 'rev-abc', longName,
      );

      await handleIngestFailed(mockSql, makeJob(), err);

      const firstSqlCall = mockSql.mock.calls[0]!;
      const interpolated = firstSqlCall.slice(1);
      const jsonbValue = interpolated.find(
        (v: unknown): v is Record<string, unknown> =>
          !!v && typeof v === 'object' && (v as any).provider === 'zernio',
      );
      expect((jsonbValue as any).review_name_truncated).toHaveLength(500);
      expect((jsonbValue as any).review_name_truncated).toBe('A'.repeat(500));
    });
  });

  describe('generic fall-through', () => {
    it('marks outbox failed with the error message for unknown error types', async () => {
      const err = new Error('something unexpected blew up');

      await handleIngestFailed(mockSql, makeJob(), err);

      expect(mockSql).not.toHaveBeenCalled();
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        mockSql,
        'outbox-1',
        'something unexpected blew up',
        1,
      );
    });

    it('stringifies non-Error throwables', async () => {
      await handleIngestFailed(mockSql, makeJob(), 'plain string error');

      expect(mockSql).not.toHaveBeenCalled();
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        mockSql,
        'outbox-1',
        'plain string error',
        1,
      );
    });

    it('returns without action when job is undefined', async () => {
      await handleIngestFailed(mockSql, undefined, new Error('whatever'));
      expect(mockSql).not.toHaveBeenCalled();
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    });
  });

  describe('last-resort crash guard', () => {
    // NON-coupled path (generic-error branch, bare markOutboxFailed): the crash
    // guard MAY best-effort-fail the row. (Coupled-tx behavior is tested below.)
    it('captures to Sentry and best-effort fails the row when the generic-branch markOutboxFailed throws', async () => {
      mockMarkOutboxFailed
        .mockRejectedValueOnce(new Error('pgbouncer down')) // generic-branch mark
        .mockResolvedValueOnce(true);                       // best-effort mark inside the capture
      await expect(
        handleIngestFailed(mockSql, makeJob(), new Error('some non-zernio failure')),
      ).resolves.toBeUndefined();
      expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: { worker: 'ingest_zernio_review', kind: 'on_failed_handler_crash' } }),
      );
      expect(mockMarkOutboxFailed).toHaveBeenLastCalledWith(
        mockSql, 'outbox-1', expect.stringContaining('on_failed_crash'), 1,
      );
    });

    it('resolves without rejecting even when the best-effort markOutboxFailed also throws', async () => {
      mockMarkOutboxFailed.mockRejectedValue(new Error('mark failed too'));
      await expect(
        handleIngestFailed(mockSql, makeJob(), new Error('boom')),
      ).resolves.toBeUndefined();
    });

    it('leaves the outbox row untouched when a coupled handler tx crashes (watchdog recovers atomically)', async () => {
      const { ZernioIngestUnparseableLocationError } = await import('../ZernioReviewIngestWorker');
      // handleUnparseableLocation runs inside sql.begin; make the tx reject.
      mockSqlBegin.mockRejectedValueOnce(new Error('deadlock'));
      await expect(
        handleIngestFailed(
          mockSql,
          makeJob(),
          new ZernioIngestUnparseableLocationError('biz-1', 'acct-1', 'loc-1', 'rev-abc', 'malformed/review/name'),
        ),
      ).resolves.toBeUndefined();
      expect(vi.mocked(Sentry.captureException)).toHaveBeenCalled();
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled(); // no split of the coupled tx
    });

    it('does not re-mark after the CAS wins but a later write in the coupled tx fails (rollback is atomic)', async () => {
      // CAS resolves true (beforeEach default), then the exception INSERT
      // rejects — the whole tx rolls back, so the row is still `dispatched`.
      sqlReturnQueue.push(new Error('insert blew up'));
      const err = new ZernioIngestReviewNotFoundError(
        'biz-1', 'acct-1', 'loc-1', 'rev-abc', 2, 78,
      );
      await expect(handleIngestFailed(mockSql, makeJob(), err)).resolves.toBeUndefined();
      expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: { worker: 'ingest_zernio_review', kind: 'on_failed_handler_crash' } }),
      );
      // Only the in-tx CAS ran; the crash guard must NOT re-mark a coupled tx.
      expect(mockMarkOutboxFailed).toHaveBeenCalledTimes(1);
      expect(mockMarkOutboxFailed).not.toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.stringContaining('on_failed_crash'), expect.anything(),
      );
    });

    it('performs no writes and no Sentry capture when the CAS loses (stale attempt)', async () => {
      const { ZernioIngestPaginationCapExhaustedError } = await import('../ZernioReviewIngestWorker');
      mockMarkOutboxFailed.mockResolvedValueOnce(false); // stale attempt / row not dispatched
      await expect(
        handleIngestFailed(
          mockSql,
          makeJob(),
          new ZernioIngestPaginationCapExhaustedError('biz-1', 'acct-1', 'loc-1', 'rev-abc', 4, 200),
        ),
      ).resolves.toBeUndefined();
      expect(mockSql).not.toHaveBeenCalled();                        // no exception INSERT
      expect(mockMarkOutboxFailed).toHaveBeenCalledTimes(1);         // just the losing CAS
      expect(vi.mocked(Sentry.captureMessage)).not.toHaveBeenCalled(); // trend signal only on ownership
      expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
    });
  });
});
