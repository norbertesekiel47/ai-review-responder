import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PublishResponsePayload } from '../../../../src/lib/shared/worker-types';

const {
  txReturnQueue, mockSql, mockTx,
  mockMarkOutboxFailed, mockMarkOutboxCompleted, mockMarkOutboxCompletedIfOwned,
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
    mockMarkOutboxCompletedIfOwned: vi.fn(),
    mockApplyTransientExhaustionFallback: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxFailed: mockMarkOutboxFailed,
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxCompletedIfOwned: mockMarkOutboxCompletedIfOwned,
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
  mockMarkOutboxFailed.mockResolvedValue(true);
  mockMarkOutboxCompletedIfOwned.mockResolvedValue(true);
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
    it('runs CAS-owned review-business-response-child-run terminal sequence in one transaction', async () => {
      // tx call 1: anchor pre-read SELECT review_id FROM responses.
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      // tx call 2: anchor SELECT reviews FOR UPDATE.
      txReturnQueue.push([{ id: 'rev-1' }]);
      // tx call 3: businesses FOR UPDATE pre-lock.
      txReturnQueue.push([{ id: 'biz-1' }]);
      // tx call 4: responses FOR UPDATE pre-lock.
      txReturnQueue.push([{ id: 'resp-1' }]);
      // tx call 5: UPDATE responses RETURNING 1 → 1 row.
      txReturnQueue.push(Object.assign([{ '?column?': 1 }], { count: 1 }));
      // tx call 6: INSERT review_exceptions RETURNING id → 1 row.
      txReturnQueue.push(Object.assign([{ id: 'exc-1' }], { count: 1 }));
      // tx call 7: INSERT job_outbox notify_admin_review_exception.
      txReturnQueue.push(Object.assign([], { count: 1 }));
      // tx call 8: live-draft guard → the row just went failed, nothing live.
      txReturnQueue.push([]);
      // tx call 9: findActiveReviewRun → running run.
      txReturnQueue.push([{ id: 'run-1', account_id: 'acct-1' }]);
      // tx call 10: completeRun UPDATE agent_runs → 1 row.
      txReturnQueue.push(Object.assign([{ id: 'run-1' }], { count: 1 }));

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
      expect(mockTx).toHaveBeenCalledTimes(10);

      const txSql = mockTx.mock.calls.map((call: any[]) =>
        (call[0] as TemplateStringsArray).join('?'),
      );
      // Lock-order law: the anchor's reviews FOR UPDATE precedes the
      // responses UPDATE (only the pre-read, which takes no lock, comes first).
      expect(txSql[0]).toContain('FROM responses');
      expect(txSql[1]).toContain('FROM reviews');
      expect(txSql[1]).toContain('FOR UPDATE');
      expect(txSql[2]).toContain('FROM businesses');
      expect(txSql[2]).toContain('FOR UPDATE');
      expect(txSql[3]).toContain('FROM responses');
      expect(txSql[3]).toContain('FOR UPDATE');
      expect(mockMarkOutboxCompletedIfOwned).toHaveBeenCalledWith(mockTx, 'outbox-1', 1);
      expect(mockTx.mock.invocationCallOrder[3]).toBeLessThan(
        mockMarkOutboxCompletedIfOwned.mock.invocationCallOrder[0]!,
      );
      expect(mockMarkOutboxCompletedIfOwned.mock.invocationCallOrder[0]).toBeLessThan(
        mockTx.mock.invocationCallOrder[4]!,
      );
      expect(txSql[4]).toContain('UPDATE responses');
      expect(txSql[4]).toContain("status = 'failed'");
      expect(txSql[4]).toContain("posting_error = 'zernio_reply_verification_indeterminate'");
      expect(txSql[5]).toContain('INSERT INTO review_exceptions');
      expect(txSql[5]).toContain("'zernio_reply_verification_indeterminate'");
      expect(txSql[6]).toContain('INSERT INTO job_outbox');
      // Topic is an interpolated QUEUE_NAMES value, not a template literal —
      // check the bound values, not the raw strings array.
      expect(mockTx.mock.calls[6]!.slice(1)).toContain('notify_admin_review_exception');
      expect(txSql[7]).toContain('FROM responses');
      expect(txSql[8]).toContain('FROM agent_runs');
      expect(txSql[9]).toContain('UPDATE agent_runs');
      expect(mockTx.mock.calls[9]!.slice(1)).toEqual(expect.arrayContaining([
        'run-1',
        'failed',
        { reason: 'zernio_reply_verification_indeterminate' },
      ]));

      expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    });

    it('skips review_exception INSERT, run completion, and outbox enqueue when UPDATE responses returned 0 rows (already terminal)', async () => {
      // tx call 1: anchor pre-read. tx call 2: anchor reviews FOR UPDATE.
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'biz-1' }]);
      txReturnQueue.push([{ id: 'resp-1' }]);
      // tx call 5: UPDATE responses → 0 rows.
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

      expect(mockTx).toHaveBeenCalledTimes(5);
      expect(mockTx.mock.calls.some((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' ').includes('agent_runs')),
      ).toBe(false);
      expect(mockMarkOutboxCompletedIfOwned).toHaveBeenCalledWith(mockTx, 'outbox-1', 1);
      expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    });

    it('leaves the run running when another owner-actionable draft is still live (guard symmetry)', async () => {
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'biz-1' }]);
      txReturnQueue.push([{ id: 'resp-1' }]);
      txReturnQueue.push(Object.assign([{ '?column?': 1 }], { count: 1 }));
      txReturnQueue.push(Object.assign([{ id: 'exc-1' }], { count: 1 }));
      txReturnQueue.push(Object.assign([], { count: 1 }));
      // Live-draft guard finds a live response → skip completeRun.
      txReturnQueue.push([{ live: 1 }]);

      const err = new ZernioReplyVerificationIndeterminateError({
        response_id: 'resp-1',
        business_id: 'biz-1',
        review_id: 'rev-1',
        account_id: 'acct-1',
        location_id: 'loc-1',
        zernio_review_id: 'zrv-1',
        reason: 'verifier_unknown_error',
      });

      await handlePublisherFailed(mockSql, makeJob(), err);

      expect(mockTx).toHaveBeenCalledTimes(8);
      expect(mockTx.mock.calls.some((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' ').includes('agent_runs')),
      ).toBe(false);
      expect(mockMarkOutboxCompletedIfOwned).toHaveBeenCalledWith(mockTx, 'outbox-1', 1);
      expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    });

    it('stale attempt loses completion CAS and performs zero domain/child/run mutation', async () => {
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'biz-1' }]);
      txReturnQueue.push([{ id: 'resp-1' }]);
      mockMarkOutboxCompletedIfOwned.mockResolvedValueOnce(false);
      const err = new ZernioReplyVerificationIndeterminateError({
        response_id: 'resp-1',
        business_id: 'biz-1',
        review_id: 'rev-1',
        account_id: 'acct-1',
        location_id: 'loc-1',
        zernio_review_id: 'zrv-1',
        reason: 'review_found_but_reply_null',
      });

      await handlePublisherFailed(mockSql, makeJob(), err);

      expect(mockTx).toHaveBeenCalledTimes(4);
      const issued = mockTx.mock.calls.map((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' '),
      );
      expect(issued.some((text: string) => /UPDATE responses/.test(text))).toBe(false);
      expect(issued.some((text: string) => /INSERT INTO review_exceptions/.test(text))).toBe(false);
      expect(issued.some((text: string) => /agent_runs/.test(text))).toBe(false);
      expect(issued.map((text: string) => text.includes('FOR UPDATE'))).toEqual([
        false, true, true, true,
      ]);
      expect(mockTx.mock.invocationCallOrder[3]).toBeLessThan(
        mockMarkOutboxCompletedIfOwned.mock.invocationCallOrder[0]!,
      );
      expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    });
  });

  describe('bare ZernioTransientError (defensive — missing PublisherTransientWithContext wrap)', () => {
    it('captures Sentry with kind unwrapped_transient and marks outbox failed with prefix', async () => {
      const Sentry = await import('@sentry/node');
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'run-1', account_id: 'acct-1' }]);
      txReturnQueue.push(Object.assign([{ id: 'run-1' }], { count: 1 }));

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
        mockTx,
        'outbox-1',
        expect.stringMatching(/^unwrapped_transient_no_context: /),
        1,
      );
      expect(mockSql.begin).toHaveBeenCalledOnce();
      expect(mockTx.mock.calls.some((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' ').includes('UPDATE agent_runs')),
      ).toBe(true);

      consoleErrSpy.mockRestore();
    });
  });

  describe('PublisherTransientWithContext (success path)', () => {
    it('claims the attempt before transient fallback in one transaction', async () => {
      mockApplyTransientExhaustionFallback.mockResolvedValueOnce(undefined);
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'biz-1' }]);
      txReturnQueue.push([{ id: 'resp-1' }]);

      const inner = new ZernioTransientError('timeout', { httpStatus: 504 });
      const wrapped = new PublisherTransientWithContext(inner, {
        response_id: 'resp-1',
        business_id: 'biz-1',
        account_id: 'acct-X',
        location_id: 'loc-Y',
      });

      await handlePublisherFailed(mockSql, makeJob(), wrapped);

      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        mockTx,
        'outbox-1',
        'zernio_transient_max_attempts',
        1,
      );
      expect(mockApplyTransientExhaustionFallback).toHaveBeenCalledWith(mockTx, {
        response_id: 'resp-1',
        business_id: 'biz-1',
        correlation_id: 'corr-1',
      });
      expect(mockMarkOutboxFailed.mock.invocationCallOrder[0]).toBeLessThan(
        mockApplyTransientExhaustionFallback.mock.invocationCallOrder[0]!,
      );
      const txSql = mockTx.mock.calls.map((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' '),
      );
      expect(txSql).toHaveLength(4);
      expect(txSql[0]).toContain('FROM responses');
      expect(txSql[1]).toContain('FROM reviews');
      expect(txSql[2]).toContain('FROM businesses');
      expect(txSql[3]).toContain('FROM responses');
      expect(txSql.slice(1).every((text: string) => text.includes('FOR UPDATE'))).toBe(true);
      expect(mockTx.mock.invocationCallOrder[3]).toBeLessThan(
        mockMarkOutboxFailed.mock.invocationCallOrder[0]!,
      );
      expect(mockSql.begin).toHaveBeenCalledOnce();
      expect(mockTx.mock.calls.some((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' ').includes('agent_runs')),
      ).toBe(false);
      // The park branch must not touch agent_runs through the BARE sql client
      // either — a rogue non-tx completeRun would evade the mockTx assertion.
      expect(mockSql.mock.calls.some((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' ').includes('agent_runs')),
      ).toBe(false);
    });

    it('stale attempt performs zero transient fallback mutation', async () => {
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockMarkOutboxFailed.mockResolvedValueOnce(false);
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'biz-1' }]);
      txReturnQueue.push([{ id: 'resp-1' }]);

      const inner = new ZernioTransientError('timeout', { httpStatus: 504 });
      const wrapped = new PublisherTransientWithContext(inner, {
        response_id: 'resp-1',
        business_id: 'biz-1',
        account_id: 'acct-X',
        location_id: 'loc-Y',
      });

      await handlePublisherFailed(mockSql, makeJob(), wrapped);

      expect(mockApplyTransientExhaustionFallback).not.toHaveBeenCalled();
      expect(mockMarkOutboxFailed).toHaveBeenCalledOnce();
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        mockTx, 'outbox-1', 'zernio_transient_max_attempts', 1,
      );
      expect(mockSql.begin).toHaveBeenCalledOnce();
      expect(mockTx).toHaveBeenCalledTimes(4);
      expect(mockTx.mock.invocationCallOrder[3]).toBeLessThan(
        mockMarkOutboxFailed.mock.invocationCallOrder[0]!,
      );
      expect(mockTx.mock.calls.some((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' ').includes('UPDATE responses')),
      ).toBe(false);
      expect(mockTx.mock.calls.some((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' ').includes('agent_runs')),
      ).toBe(false);
      consoleErrSpy.mockRestore();
    });
  });

  describe('PublisherTransientWithContext (fallback throws)', () => {
    it('captures Sentry, marks outbox failed with fallback_failed prefix', async () => {
      const Sentry = await import('@sentry/node');
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fallbackErr = new Error('disconnect call exploded');
      mockApplyTransientExhaustionFallback.mockRejectedValueOnce(fallbackErr);
      // First tx: review -> business -> response lane before failed-attempt CAS.
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'biz-1' }]);
      txReturnQueue.push([{ id: 'resp-1' }]);
      // Recovery checkpoint tx after the first transaction rolls back.
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'run-1', account_id: 'acct-1' }]);
      txReturnQueue.push(Object.assign([{ id: 'run-1' }], { count: 1 }));

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
        mockTx,
        'outbox-1',
        'zernio_transient_max_attempts_fallback_failed: disconnect call exploded',
        1,
      );
      expect(mockSql.begin).toHaveBeenCalledTimes(2);
      expect(mockTx.mock.calls.some((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' ').includes('UPDATE agent_runs')),
      ).toBe(true);

      consoleErrSpy.mockRestore();
    });
  });

  describe('generic fall-through', () => {
    it('atomically fails the active review run and outbox for unknown terminal errors', async () => {
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'run-1', account_id: 'acct-1' }]);
      txReturnQueue.push(Object.assign([{ id: 'run-1' }], { count: 1 }));

      const err = new Error('something else broke');
      await handlePublisherFailed(mockSql, makeJob(), err);

      expect(mockSql.begin).toHaveBeenCalledOnce();
      const txSql = mockTx.mock.calls.map((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' '),
      );
      expect(txSql[0]).toContain('FROM responses');
      expect(txSql[1]).toContain('FROM reviews');
      expect(txSql[1]).toContain('FOR UPDATE');
      expect(txSql[2]).toContain('FROM agent_runs');
      expect(txSql[3]).toContain('UPDATE agent_runs');
      expect(mockTx.mock.calls[3]!.slice(1)).toEqual(expect.arrayContaining([
        'run-1',
        'failed',
        { reason: 'something else broke' },
      ]));
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        mockTx,
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
      expect(mockSql.begin).not.toHaveBeenCalled();
    });

    it('still fails the outbox when the response belongs to a legacy review with no active run', async () => {
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([]);

      await handlePublisherFailed(mockSql, makeJob(), new Error('legacy terminal'));

      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        mockTx,
        'outbox-1',
        'legacy terminal',
        1,
      );
      expect(mockTx.mock.calls.some((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' ').includes('UPDATE agent_runs')),
      ).toBe(false);
    });

    it('does not fail the run when a stale outbox attempt loses the guarded transition', async () => {
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      mockMarkOutboxFailed.mockResolvedValueOnce(false);

      await handlePublisherFailed(mockSql, makeJob(), new Error('stale terminal'));

      const txSql = mockTx.mock.calls.map((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' '),
      );
      expect(txSql).toHaveLength(2);
      expect(txSql[1]).toContain('FROM reviews');
      expect(txSql.some((text: string) => text.includes('agent_runs'))).toBe(false);
      expect(mockMarkOutboxFailed).toHaveBeenCalledOnce();
    });

    it('does not retry outbox closure outside a failed coupled checkpoint transaction', async () => {
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      mockMarkOutboxFailed.mockRejectedValueOnce(new Error('coupled tx failed'));

      await handlePublisherFailed(mockSql, makeJob(), new Error('terminal'));

      expect(mockSql.begin).toHaveBeenCalledOnce();
      expect(mockMarkOutboxFailed).toHaveBeenCalledOnce();
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        mockTx,
        'outbox-1',
        'terminal',
        1,
      );
      expect(mockTx.mock.calls.some((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' ').includes('agent_runs')),
      ).toBe(false);
      consoleErrSpy.mockRestore();
    });

    it('does not close outbox standalone when run completion fails after the coupled CAS', async () => {
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'run-1', account_id: 'acct-1' }]);
      txReturnQueue.push(Object.assign([], { count: 0 }));
      txReturnQueue.push([]);

      await handlePublisherFailed(mockSql, makeJob(), new Error('terminal'));

      expect(mockMarkOutboxFailed).toHaveBeenCalledOnce();
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        mockTx,
        'outbox-1',
        'terminal',
        1,
      );
      expect(mockTx.mock.calls.some((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' ').includes('UPDATE agent_runs')),
      ).toBe(true);
      expect(consoleErrSpy).toHaveBeenCalledWith(
        '[publisherWorker.on(failed)] handler crashed:',
        expect.any(Error),
      );
      consoleErrSpy.mockRestore();
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
      // Step 6: active review run.
      txReturnQueue.push([{ id: 'run-1', account_id: 'acct-1' }]);
      // Step 7: complete run failed.
      txReturnQueue.push(Object.assign([{ id: 'run-1' }], { count: 1 }));

      await handlePublisherFailed(mockSql, makeJob(), makeWrappedTransient());

      expect(mockApplyTransientExhaustionFallback).not.toHaveBeenCalled();
      expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        mockTx,
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

      const txSql = mockTx.mock.calls.map((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' '),
      );
      expect(txSql[1]).toContain('FROM reviews');
      expect(txSql[1]).toContain('FOR UPDATE');
      expect(txSql[2]).toContain('FROM responses');
      expect(txSql[2]).toContain('FOR UPDATE');
      expect(txSql[4]).toContain('FROM agent_runs');
      expect(txSql[5]).toContain('UPDATE agent_runs');
      expect(mockTx.mock.calls[5]!.slice(1)).toEqual(expect.arrayContaining([
        'run-1',
        'failed',
        { reason: 'post_after_delete_failed_retry_exhausted' },
      ]));
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
        mockTx,
        'outbox-1',
        'post_after_delete_failed_retry_exhausted',
        1,
      );
      expect(mockApplyTransientExhaustionFallback).not.toHaveBeenCalled();
    });

    it('FLAG ON + stale outbox attempt leaves orphan response and run unchanged', async () => {
      process.env.EDIT_REPLIES_ENABLED = 'true';
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ status: 'approved', posting_error: 'pending_after_delete_succeeded' }]);
      txReturnQueue.push(Object.assign([{ '?column?': 1 }], { count: 1 }));
      mockMarkOutboxFailed.mockResolvedValueOnce(false);

      await handlePublisherFailed(mockSql, makeJob(), makeWrappedTransient());

      const txSql = mockTx.mock.calls.map((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' '),
      );
      expect(txSql.some((text: string) => text.includes('UPDATE responses'))).toBe(false);
      expect(txSql.some((text: string) => text.includes('agent_runs'))).toBe(false);
      expect(mockMarkOutboxFailed).toHaveBeenCalledOnce();
      expect(mockApplyTransientExhaustionFallback).not.toHaveBeenCalled();
    });

    it('FLAG ON + coupled orphan tx failure never retries outbox closure standalone', async () => {
      process.env.EDIT_REPLIES_ENABLED = 'true';
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ status: 'approved', posting_error: 'pending_after_delete_succeeded' }]);
      txReturnQueue.push(Object.assign([{ '?column?': 1 }], { count: 1 }));
      mockMarkOutboxFailed.mockRejectedValueOnce(new Error('orphan coupled tx failed'));

      await handlePublisherFailed(mockSql, makeJob(), makeWrappedTransient());

      expect(mockMarkOutboxFailed).toHaveBeenCalledOnce();
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        mockTx,
        'outbox-1',
        'post_after_delete_failed_retry_exhausted',
        1,
      );
      expect(mockTx.mock.calls.some((call: any[]) =>
        (call[0] as TemplateStringsArray).join(' ').includes('UPDATE responses')),
      ).toBe(false);
      consoleErrSpy.mockRestore();
    });

    it('FLAG ON + status no longer publishable (processReview won the race) → markOutboxCompleted, no fallback', async () => {
      process.env.EDIT_REPLIES_ENABLED = 'true';
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ status: 'superseded', posting_error: 'pending_after_delete_succeeded' }]);

      await handlePublisherFailed(mockSql, makeJob(), makeWrappedTransient());

      expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 1);
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
      expect(mockApplyTransientExhaustionFallback).not.toHaveBeenCalled();
    });

    it('FLAG ON + no orphan marker + transient → falls through to the existing transient fallback', async () => {
      process.env.EDIT_REPLIES_ENABLED = 'true';
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ status: 'approved', posting_error: null }]);
      // Transient fallback lane: review -> business -> response before CAS.
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'biz-1' }]);
      txReturnQueue.push([{ id: 'resp-1' }]);

      await handlePublisherFailed(mockSql, makeJob(), makeWrappedTransient());

      expect(mockApplyTransientExhaustionFallback).toHaveBeenCalledTimes(1);
      expect(mockApplyTransientExhaustionFallback).toHaveBeenCalledWith(mockTx, {
        response_id: 'resp-1',
        business_id: 'biz-1',
        correlation_id: 'corr-1',
      });
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(mockTx, 'outbox-1', 'zernio_transient_max_attempts', 1);
    });

    it('FLAG ON + response row not visible to business (tenant mismatch) → markOutboxCompleted, no fallback', async () => {
      process.env.EDIT_REPLIES_ENABLED = 'true';
      txReturnQueue.push([]); // step 1: no row.

      await handlePublisherFailed(mockSql, makeJob(), makeWrappedTransient());

      expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 1);
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
      expect(mockApplyTransientExhaustionFallback).not.toHaveBeenCalled();
    });

    it('FLAG ON + review row missing under lock → markOutboxCompleted + Sentry warning', async () => {
      process.env.EDIT_REPLIES_ENABLED = 'true';
      const Sentry = await import('@sentry/node');
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([]); // review not found under FOR UPDATE.

      await handlePublisherFailed(mockSql, makeJob(), makeWrappedTransient());

      expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 1);
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

      expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 1);
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
      expect(mockApplyTransientExhaustionFallback).not.toHaveBeenCalled();
    });

    it('FLAG OFF + orphan marker would match → block skipped entirely, straight to transient fallback', async () => {
      // Flag is unset by the outer beforeEach.
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'biz-1' }]);
      txReturnQueue.push([{ id: 'resp-1' }]);
      await handlePublisherFailed(mockSql, makeJob(), makeWrappedTransient());

      // The orphan-conversion tx never ran; only the locked transient fallback tx did.
      expect(mockSql.begin).toHaveBeenCalledOnce();
      expect(mockApplyTransientExhaustionFallback).toHaveBeenCalledTimes(1);
      expect(mockApplyTransientExhaustionFallback).toHaveBeenCalledWith(mockTx, expect.anything());
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(mockTx, 'outbox-1', 'zernio_transient_max_attempts', 1);
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
        mockTx,
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

    it('FLAG ON + NON-orphan + ZernioReplyVerificationIndeterminateError → falls through to handleVerificationIndeterminate, which completes the run failed in the same tx', async () => {
      process.env.EDIT_REPLIES_ENABLED = 'true';
      // attemptOrphanConversion: row is publishable but has NO orphan marker →
      // returns false → falls through to the indeterminate branch.
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ status: 'approved', posting_error: null }]);
      // handleVerificationIndeterminate: anchor pre-read + reviews FOR UPDATE,
      // UPDATE responses RETURNING 1 → 1 row, INSERT review_exceptions
      // RETURNING id, INSERT job_outbox, live-draft guard (nothing live),
      // findActiveReviewRun, completeRun failed.
      txReturnQueue.push([{ review_id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'rev-1' }]);
      txReturnQueue.push([{ id: 'biz-1' }]);
      txReturnQueue.push([{ id: 'resp-1' }]);
      txReturnQueue.push(Object.assign([{ '?column?': 1 }], { count: 1 }));
      txReturnQueue.push(Object.assign([{ id: 'exc-1' }], { count: 1 }));
      txReturnQueue.push(Object.assign([], { count: 1 }));
      txReturnQueue.push([]);
      txReturnQueue.push([{ id: 'run-1', account_id: 'acct-1' }]);
      txReturnQueue.push(Object.assign([{ id: 'run-1' }], { count: 1 }));

      await handlePublisherFailed(mockSql, makeJob(), makeIndeterminate());

      // The indeterminate terminal sequence CAS-completed in the same tx.
      expect(mockMarkOutboxCompletedIfOwned).toHaveBeenCalledWith(mockTx, 'outbox-1', 1);
      expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
      const indeterminateUpdate = mockTx.mock.calls.find((c: any[]) => {
        const text = (c[0] as TemplateStringsArray).join('?');
        return /posting_error = 'zernio_reply_verification_indeterminate'/.test(text);
      });
      expect(indeterminateUpdate).toBeDefined();
      // WS5 §3: the branch no longer strands the run — it completes 'failed'
      // in the SAME tx as the terminal responses write.
      const completeRunCall = mockTx.mock.calls.find((c: any[]) =>
        (c[0] as TemplateStringsArray).join(' ').includes('UPDATE agent_runs'));
      expect(completeRunCall).toBeDefined();
      expect(completeRunCall!.slice(1)).toEqual(expect.arrayContaining([
        'run-1',
        'failed',
        { reason: 'zernio_reply_verification_indeterminate' },
      ]));
    });
  });

  describe('last-resort handler-crash', () => {
    it('captures a coupled checkpoint crash without retrying outbox closure standalone', async () => {
      const Sentry = await import('@sentry/node');
      const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockMarkOutboxFailed.mockRejectedValueOnce(new Error('outbox write exploded'));

      await handlePublisherFailed(mockSql, makeJob(), new Error('initial'));

      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { worker: 'publisher', kind: 'on_failed_handler_crash' },
        }),
      );
      expect(mockMarkOutboxFailed).toHaveBeenCalledOnce();
      expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
        mockTx,
        'outbox-1',
        'initial',
        1,
      );

      consoleErrSpy.mockRestore();
    });
  });
});
