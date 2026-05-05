import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { IngestZernioReviewPayload } from '../../../../src/lib/shared/worker-types';

const { sqlReturnQueue, mockSql, mockMarkOutboxFailed } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? Object.assign([], { count: 0 });
    return Promise.resolve(result);
  });
  return { sqlReturnQueue, mockSql, mockMarkOutboxFailed: vi.fn() };
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
});

describe('handleIngestFailed', () => {
  describe('ZernioIngestReviewNotFoundError', () => {
    it('inserts review_exception with the error fields and marks outbox failed', async () => {
      const err = new ZernioIngestReviewNotFoundError(
        'biz-1', 'acct-1', 'loc-1', 'rev-abc', 2, 78,
      );

      await handleIngestFailed(makeJob(), err);

      // Verify the SQL template structure.
      expect(mockSql).toHaveBeenCalledTimes(1);
      const sqlCall = mockSql.mock.calls[0]!;
      const stringPart = (sqlCall[0] as TemplateStringsArray).join('?');
      expect(stringPart).toContain('INSERT INTO review_exceptions');
      expect(stringPart).toContain("'zernio_review_not_found'");
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
        'outbox-1',
        'zernio_review_not_found_after_retries',
        1,
      );
    });

    it('does not call sql when attemptsMade < max attempts (still retrying)', async () => {
      const err = new ZernioIngestReviewNotFoundError(
        'biz-1', 'acct-1', 'loc-1', 'rev-abc', 1, 25,
      );

      await handleIngestFailed(makeJob({}, 2, 5), err);

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

      await handleIngestFailed(makeJob({}, 4, 5), err);

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

      await handleIngestFailed(makeJob(), err);

      expect(mockSql).toHaveBeenCalledTimes(1);
      const sqlCall = mockSql.mock.calls[0]!;
      const stringPart = (sqlCall[0] as TemplateStringsArray).join('?');
      expect(stringPart).toContain('INSERT INTO review_exceptions');
      expect(stringPart).toContain("'zernio_pagination_cap_exhausted'");

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
        'outbox-1',
        'zernio_pagination_cap_exhausted',
        1,
      );
    });
  });
});
