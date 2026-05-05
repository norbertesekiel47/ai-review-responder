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
      expect(jsonbValue).toMatchObject({
        provider: 'zernio',
        provider_review_id: 'rev-abc',
        zernio_account_id: 'acct-1',
        zernio_location_id: 'loc-1',
        pages_walked: 2,
        reviews_seen: 78,
      });
      expect(typeof (jsonbValue as any).retries_exhausted_at).toBe('string');

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
  });
});
