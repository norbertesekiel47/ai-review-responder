import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  // tx.json stands in for Postgres.js's JSONB bind (identity pass-through) —
  // handleVerificationIndeterminate builds review_exception + outbox payloads.
  mockTx.json = vi.fn((v: unknown) => v);

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
  // Re-wire sql.begin + tx.json since vi.resetAllMocks clears their implementations
  mockSql.begin.mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(mockTx));
  mockTx.json.mockImplementation((v: unknown) => v);
  // Default: flag OFF, so the orphan-conversion block is skipped entirely and
  // these legacy tests exercise today's byte-for-byte behavior.
  delete process.env.EDIT_REPLIES_ENABLED;
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

      await handlePublisherFailed(mockSql, makeJob(), err);

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
      expect(thirdCallSql).toContain('INSERT INTO job_outbox');
      // Topic is an interpolated QUEUE_NAMES value, not a template literal —
      // check the bound values, not the raw strings array.
      expect(mockTx.mock.calls[2]!.slice(1)).toContain('notify_admin_review_exception');

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

      await handlePublisherFailed(mockSql, makeJob(), err);

      expect(mockTx).toHaveBeenCalledTimes(1); // only the UPDATE
      expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
    });
  });

  describe('bare ZernioTransientError (defensive — missing PublisherTransientWithContext wrap)', () => {
    it('captures Sentry with kind unwrapped_transient and marks outbox failed with prefix', async () => {
      const Sentry = await import('@sentry/node');
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const err = new ZernioTransientError('http_5xx', { httpStatus: 503 });

      await handlePublisherFailed(mockSql, makeJob(), err);

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

      await handlePublisherFailed(mockSql, makeJob(), wrapped);

      expect(mockApplyTransientExhaustionFallback).toHaveBeenCalledWith(mockSql, {
        response_id: 'resp-1',
        business_id: 'biz-1',
        correlation_id: 'corr-1',
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

      await handlePublisherFailed(mockSql, makeJob(), wrapped);

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

  describe('generic fall-through', () => {
    it('marks outbox failed with the error message for unknown error types', async () => {
      const err = new Error('something else broke');
      await handlePublisherFailed(mockSql, makeJob(), err);

      expect(mockSql.begin).not.toHaveBeenCalled();
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        'something else broke',
        1,
      );
    });

    it('does not act when attemptsMade < max attempts', async () => {
      const err = new Error('transient retry not exhausted');
      await handlePublisherFailed(mockSql, makeJob({}, 0, 5), err);

      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
      expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    });

    it('returns silently when job is undefined', async () => {
      await handlePublisherFailed(mockSql, undefined, new Error('whatever'));
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    });
  });

  describe('orphan-marker retry-exhaustion conversion (spec §4.5)', () => {
    afterEach(() => {
      delete process.env.EDIT_REPLIES_ENABLED;
    });

    function makeWrappedTransient() {
      const inner = new ZernioTransientError('timeout', { httpStatus: 504 });
      return new PublisherTransientWithContext(inner, {
        response_id: 'resp-1',
        business_id: 'biz-1',
        account_id: 'acct-X',
        location_id: 'loc-Y',
      });
    }

    it('FLAG ON + orphan marker + row publishable → converts to failed + markOutboxFailed, no fallback', async () => {
      process.env.EDIT_REPLIES_ENABLED = 'true';
      // Step 1: SELECT review_id → found.
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      // Step 2: SELECT reviews FOR UPDATE → found.
      txReturnQueue.push([{ id: 'rev-1' }]);
      // Step 3: SELECT responses FOR UPDATE → orphan marker, publishable.
      txReturnQueue.push([{ status: 'approved', posting_error: 'pending_after_delete_succeeded' }]);
      // Step 5: UPDATE responses RETURNING 1 → 1 row affected.
      txReturnQueue.push(Object.assign([{ '?column?': 1 }], { count: 1 }));

      await handlePublisherFailed(mockSql, makeJob(), makeWrappedTransient());

      expect(mockApplyTransientExhaustionFallback).not.toHaveBeenCalled();
      expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        'post_after_delete_failed_retry_exhausted',
        1,
      );

      const updateCall = mockTx.mock.calls.find((c: any[]) => {
        const text = (c[0] as TemplateStringsArray).join('?');
        return /UPDATE responses/.test(text) && /status = 'failed'/.test(text);
      });
      expect(updateCall).toBeDefined();
      // The terminal marker is bound as a SQL parameter, not template text.
      expect(updateCall!.slice(1)).toContain('post_after_delete_failed_retry_exhausted');
    });

    it('FLAG ON + orphan marker + status=awaiting_owner_connect → converts to failed', async () => {
      process.env.EDIT_REPLIES_ENABLED = 'true';
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([
        { status: 'awaiting_owner_connect', posting_error: 'zernio_auth_error_after_delete_succeeded' },
      ]);
      txReturnQueue.push(Object.assign([{ '?column?': 1 }], { count: 1 }));

      await handlePublisherFailed(mockSql, makeJob(), makeWrappedTransient());

      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        'post_after_delete_failed_retry_exhausted',
        1,
      );
      expect(mockApplyTransientExhaustionFallback).not.toHaveBeenCalled();
    });

    it('FLAG ON + status no longer publishable (processReview won the race) → markOutboxCompleted, no fallback', async () => {
      process.env.EDIT_REPLIES_ENABLED = 'true';
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ status: 'superseded', posting_error: 'pending_after_delete_succeeded' }]);

      await handlePublisherFailed(mockSql, makeJob(), makeWrappedTransient());

      expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
      expect(mockApplyTransientExhaustionFallback).not.toHaveBeenCalled();
    });

    it('FLAG ON + no orphan marker + transient → falls through to the existing transient fallback', async () => {
      process.env.EDIT_REPLIES_ENABLED = 'true';
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ status: 'approved', posting_error: null }]);

      await handlePublisherFailed(mockSql, makeJob(), makeWrappedTransient());

      expect(mockApplyTransientExhaustionFallback).toHaveBeenCalledTimes(1);
      expect(mockApplyTransientExhaustionFallback).toHaveBeenCalledWith(mockSql, {
        response_id: 'resp-1',
        business_id: 'biz-1',
        correlation_id: 'corr-1',
      });
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-1', 'zernio_transient_max_attempts', 1);
    });

    it('FLAG ON + response row not visible to business (tenant mismatch) → markOutboxCompleted, no fallback', async () => {
      process.env.EDIT_REPLIES_ENABLED = 'true';
      txReturnQueue.push([]); // step 1: no row.

      await handlePublisherFailed(mockSql, makeJob(), makeWrappedTransient());

      expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
      expect(mockApplyTransientExhaustionFallback).not.toHaveBeenCalled();
    });

    it('FLAG ON + review row missing under lock → markOutboxCompleted + Sentry warning', async () => {
      process.env.EDIT_REPLIES_ENABLED = 'true';
      const Sentry = await import('@sentry/node');
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([]); // review not found under FOR UPDATE.

      await handlePublisherFailed(mockSql, makeJob(), makeWrappedTransient());

      expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
      expect(mockApplyTransientExhaustionFallback).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'orphan_response_review',
        expect.objectContaining({ extra: { response_id: 'resp-1', business_id: 'biz-1' } }),
      );
    });

    it('FLAG ON + response deleted between read and lock → markOutboxCompleted', async () => {
      process.env.EDIT_REPLIES_ENABLED = 'true';
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([]); // race: response gone under FOR UPDATE.

      await handlePublisherFailed(mockSql, makeJob(), makeWrappedTransient());

      expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
      expect(mockApplyTransientExhaustionFallback).not.toHaveBeenCalled();
    });

    it('FLAG OFF + orphan marker would match → block skipped entirely, straight to transient fallback', async () => {
      // Flag is unset by the outer beforeEach.
      await handlePublisherFailed(mockSql, makeJob(), makeWrappedTransient());

      // The orphan-conversion tx never ran.
      expect(mockSql.begin).not.toHaveBeenCalled();
      expect(mockApplyTransientExhaustionFallback).toHaveBeenCalledTimes(1);
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-1', 'zernio_transient_max_attempts', 1);
    });

    function makeIndeterminate() {
      return new ZernioReplyVerificationIndeterminateError({
        response_id: 'resp-1',
        business_id: 'biz-1',
        review_id: 'rev-1',
        account_id: 'acct-1',
        location_id: 'loc-1',
        zernio_review_id: 'zrv-1',
        reason: 'verifier_unknown_error',
        underlying_error: 'connection refused',
      });
    }

    it('FLAG ON + orphan marker + ZernioReplyVerificationIndeterminateError at exhaustion → converted to failed w/ retry_exhausted (recoverable), NOT zernio_reply_verification_indeterminate', async () => {
      process.env.EDIT_REPLIES_ENABLED = 'true';
      // Orphan conversion runs FIRST (before the indeterminate branch).
      // Step 1: SELECT review_id → found.
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      // Step 2: SELECT reviews FOR UPDATE → found.
      txReturnQueue.push([{ id: 'rev-1' }]);
      // Step 3: SELECT responses FOR UPDATE → orphan marker, publishable.
      txReturnQueue.push([{ status: 'approved', posting_error: 'pending_after_delete_succeeded' }]);
      // Step 5: UPDATE responses RETURNING 1 → 1 row affected.
      txReturnQueue.push(Object.assign([{ '?column?': 1 }], { count: 1 }));

      await handlePublisherFailed(mockSql, makeJob(), makeIndeterminate());

      // Converted via the recoverable orphan path — NOT the indeterminate path.
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        'outbox-1',
        'post_after_delete_failed_retry_exhausted',
        1,
      );
      expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();

      // No UPDATE wrote the indeterminate posting_error (the marker is preserved
      // for /retry by overwriting with the recoverable retry_exhausted marker only).
      const indeterminateUpdate = mockTx.mock.calls.find((c: any[]) => {
        const text = (c[0] as TemplateStringsArray).join('?');
        return /posting_error = 'zernio_reply_verification_indeterminate'/.test(text);
      });
      expect(indeterminateUpdate).toBeUndefined();
    });

    it('FLAG ON + NON-orphan + ZernioReplyVerificationIndeterminateError → falls through to handleVerificationIndeterminate (today behavior)', async () => {
      process.env.EDIT_REPLIES_ENABLED = 'true';
      // attemptOrphanConversion: row is publishable but has NO orphan marker →
      // returns false → falls through to the indeterminate branch.
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ status: 'approved', posting_error: null }]);
      // handleVerificationIndeterminate: UPDATE responses RETURNING 1 → 1 row,
      // then INSERT review_exceptions RETURNING id, then INSERT job_outbox.
      txReturnQueue.push(Object.assign([{ '?column?': 1 }], { count: 1 }));
      txReturnQueue.push(Object.assign([{ id: 'exc-1' }], { count: 1 }));
      txReturnQueue.push(Object.assign([], { count: 1 }));

      await handlePublisherFailed(mockSql, makeJob(), makeIndeterminate());

      // The indeterminate terminal sequence ran and completed the outbox.
      expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
      const indeterminateUpdate = mockTx.mock.calls.find((c: any[]) => {
        const text = (c[0] as TemplateStringsArray).join('?');
        return /posting_error = 'zernio_reply_verification_indeterminate'/.test(text);
      });
      expect(indeterminateUpdate).toBeDefined();
    });
  });

  describe('last-resort handler-crash', () => {
    it('captures Sentry with kind on_failed_handler_crash and best-effort marks outbox failed', async () => {
      const Sentry = await import('@sentry/node');
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Force markOutboxFailed (called from the generic fall-through) to throw the FIRST time.
      // The catch block then re-attempts a best-effort call — we let the second succeed.
      mockMarkOutboxFailed
        .mockRejectedValueOnce(new Error('outbox write exploded'))
        .mockResolvedValueOnce(undefined);

      await handlePublisherFailed(mockSql, makeJob(), new Error('initial'));

      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { worker: 'publisher', kind: 'on_failed_handler_crash' },
        }),
      );
      // Best-effort second call uses the on_failed_crash prefix.
      expect(mockMarkOutboxFailed).toHaveBeenLastCalledWith(
        'outbox-1',
        expect.stringMatching(/^on_failed_crash: /),
        1,
      );

      consoleErrSpy.mockRestore();
    });
  });
});
