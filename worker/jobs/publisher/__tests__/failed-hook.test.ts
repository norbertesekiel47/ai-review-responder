import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PublishResponsePayload } from '../../../../src/lib/shared/worker-types';

const {
  txReturnQueue, mockSql, mockTx,
  mockMarkOutboxFailed, mockMarkOutboxCompleted,
  mockApplyTransientExhaustionFallback,
} = vi.hoisted(() => {
  const txReturnQueue: unknown[] = [];

  const mockTx: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = txReturnQueue.shift() ?? Object.assign([], { count: 0 });
    return Promise.resolve(result);
  });

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = txReturnQueue.shift() ?? Object.assign([], { count: 0 });
    return Promise.resolve(result);
  });
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockTx));

  return {
    txReturnQueue,
    mockSql,
    mockTx,
    mockMarkOutboxFailed: vi.fn(),
    mockMarkOutboxCompleted: vi.fn(),
    mockApplyTransientExhaustionFallback: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxFailed: mockMarkOutboxFailed,
  markOutboxCompleted: mockMarkOutboxCompleted,
  extractOutboxHandle: (d: any, fallback: string) => ({
    outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback,
    attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined,
  }),
}));
vi.mock('../../../../src/lib/publishing/zernio-publisher', () => ({
  applyTransientExhaustionFallback: mockApplyTransientExhaustionFallback,
}));
vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import { handlePublisherFailed } from '../failed-hook';
import { ZernioReplyVerificationIndeterminateError, PublisherTransientWithContext } from '../publisher-error-handlers';
import { ZernioTransientError } from '../../../../src/lib/zernio/errors';

function makeJob(
  overrides: Partial<PublishResponsePayload> = {},
  attemptsMade = 1,
  maxAttempts = 1,
): Job<PublishResponsePayload> {
  return {
    id: 'job-pub-1',
    data: {
      response_id: 'resp-1',
      business_id: 'biz-1',
      review_id: 'rev-1',
      correlation_id: 'corr-1',
      outbox_id: 'outbox-1',
      outbox_attempt: 1,
      ...overrides,
    },
    attemptsMade,
    opts: { attempts: maxAttempts },
  } as unknown as Job<PublishResponsePayload>;
}

beforeEach(() => {
  vi.resetAllMocks();
  txReturnQueue.length = 0;
  // Re-wire sql.begin since vi.resetAllMocks clears its implementation
  mockSql.begin.mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(mockTx));
});

describe('handlePublisherFailed', () => {
  describe('ZernioReplyVerificationIndeterminateError', () => {
    it('runs the full terminal sequence: UPDATE responses, INSERT review_exception, INSERT outbox, markOutboxCompleted', async () => {
      // tx call 1: UPDATE responses RETURNING 1 → 1 row.
      txReturnQueue.push(Object.assign([{ '?column?': 1 }], { count: 1 }));
      // tx call 2: INSERT review_exceptions RETURNING id → 1 row.
      txReturnQueue.push(Object.assign([{ id: 'exc-1' }], { count: 1 }));
      // tx call 3: INSERT job_outbox notify_admin_review_exception.
      txReturnQueue.push(Object.assign([], { count: 1 }));

      const err = new ZernioReplyVerificationIndeterminateError({
        response_id: 'resp-1',
        business_id: 'biz-1',
        review_id: 'rev-1',
        account_id: 'acct-1',
        location_id: 'loc-1',
        zernio_review_id: 'zrv-1',
        reason: 'verifier_unknown_error',
        underlying_error: 'connection refused',
      });

      await handlePublisherFailed(makeJob(), err);

      expect(mockSql.begin).toHaveBeenCalledTimes(1);
      expect(mockTx).toHaveBeenCalledTimes(3);

      const firstCallSql = (mockTx.mock.calls[0]![0] as TemplateStringsArray).join('?');
      expect(firstCallSql).toContain('UPDATE responses');
      expect(firstCallSql).toContain("status = 'failed'");
      expect(firstCallSql).toContain("posting_error = 'zernio_reply_verification_indeterminate'");

      const secondCallSql = (mockTx.mock.calls[1]![0] as TemplateStringsArray).join('?');
      expect(secondCallSql).toContain('INSERT INTO review_exceptions');
      expect(secondCallSql).toContain("'zernio_reply_verification_indeterminate'");

      const thirdCallSql = (mockTx.mock.calls[2]![0] as TemplateStringsArray).join('?');
      expect(thirdCallSql).toContain("'notify_admin_review_exception'");

      expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    });

    it('skips review_exception INSERT and outbox enqueue when UPDATE responses returned 0 rows (already terminal)', async () => {
      // tx call 1: UPDATE responses → 0 rows.
      txReturnQueue.push(Object.assign([], { count: 0 }));

      const err = new ZernioReplyVerificationIndeterminateError({
        response_id: 'resp-1',
        business_id: 'biz-1',
        review_id: 'rev-1',
        account_id: 'acct-1',
        location_id: 'loc-1',
        zernio_review_id: 'zrv-1',
        reason: 'review_not_found_after_pagination',
      });

      await handlePublisherFailed(makeJob(), err);

      expect(mockTx).toHaveBeenCalledTimes(1); // only the UPDATE
      expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
    });
  });

  describe('bare ZernioTransientError (defensive — missing PublisherTransientWithContext wrap)', () => {
    it('captures Sentry with kind unwrapped_transient and marks outbox failed with prefix', async () => {
      const Sentry = await import('@sentry/node');
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const err = new ZernioTransientError('http_5xx', { httpStatus: 503 });

      await handlePublisherFailed(makeJob(), err);

      expect(consoleErrSpy).toHaveBeenCalledWith(
        expect.stringContaining('bare ZernioTransientError reached failed-hook'),
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(
        err,
        expect.objectContaining({
          tags: { worker: 'publisher', kind: 'unwrapped_transient' },
          level: 'error',
          extra: expect.objectContaining({ response_id: 'resp-1', business_id: 'biz-1' }),
        }),
      );
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        expect.stringMatching(/^unwrapped_transient_no_context: /),
        1,
      );

      consoleErrSpy.mockRestore();
    });
  });

  describe('PublisherTransientWithContext (success path)', () => {
    it('calls applyTransientExhaustionFallback with attempt context, marks outbox failed', async () => {
      mockApplyTransientExhaustionFallback.mockResolvedValueOnce(undefined);

      const inner = new ZernioTransientError('timeout', { httpStatus: 504 });
      const wrapped = new PublisherTransientWithContext(inner, {
        response_id: 'resp-1',
        business_id: 'biz-1',
        account_id: 'acct-X',
        location_id: 'loc-Y',
      });

      await handlePublisherFailed(makeJob(), wrapped);

      expect(mockApplyTransientExhaustionFallback).toHaveBeenCalledWith({
        response_id: 'resp-1',
        business_id: 'biz-1',
        correlation_id: 'corr-1',
        account_id: 'acct-X',
        location_id: 'loc-Y',
      });
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        'zernio_transient_max_attempts',
        1,
      );
    });
  });

  describe('PublisherTransientWithContext (fallback throws)', () => {
    it('captures Sentry, marks outbox failed with fallback_failed prefix', async () => {
      const Sentry = await import('@sentry/node');
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fallbackErr = new Error('disconnect call exploded');
      mockApplyTransientExhaustionFallback.mockRejectedValueOnce(fallbackErr);

      const inner = new ZernioTransientError('timeout', { httpStatus: 504 });
      const wrapped = new PublisherTransientWithContext(inner, {
        response_id: 'resp-1',
        business_id: 'biz-1',
        account_id: 'acct-X',
        location_id: 'loc-Y',
      });

      await handlePublisherFailed(makeJob(), wrapped);

      expect(Sentry.captureException).toHaveBeenCalledWith(
        fallbackErr,
        expect.objectContaining({
          tags: { worker: 'publisher', kind: 'transient_exhaustion_fallback' },
        }),
      );
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        'zernio_transient_max_attempts_fallback_failed: disconnect call exploded',
        1,
      );

      consoleErrSpy.mockRestore();
    });
  });
});
