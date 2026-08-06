import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlReturnQueue, mockSql, sqlCalls } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const sqlCalls: Array<{ template: string; values: unknown[] }> = [];
  const mockSql = vi.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ template: strings.join('?'), values });
      return Promise.resolve(sqlReturnQueue.shift() ?? []);
    },
  );
  // PHI quarantine runs inside sql.begin(); the mock runs the callback against
  // the same tagged-template stub so the wrapped call is exercised.
  (mockSql as unknown as { begin: unknown }).begin = vi.fn(
    async (cb: (tx: typeof mockSql) => unknown) => cb(mockSql),
  );
  return { sqlReturnQueue, mockSql, sqlCalls };
});

const {
  mockListReviews,
  mockProcessReview,
  mockReconcileExternallyAnsweredReview,
  mockOpenPhiReviewException,
  mockApplyAuthErrorFallback,
} = vi.hoisted(() => ({
  mockListReviews: vi.fn(),
  mockProcessReview: vi.fn(),
  mockReconcileExternallyAnsweredReview: vi.fn(),
  mockOpenPhiReviewException: vi.fn(),
  mockApplyAuthErrorFallback: vi.fn(),
}));

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('../../../../src/lib/zernio/client', () => ({
  zernioClient: {
    listReviews: mockListReviews,
  },
}));

vi.mock('../../../../src/lib/reviews/process-review', () => ({
  processReview: mockProcessReview,
}));

// liveIngestCutoff must stay the REAL implementation (re-exported via
// vi.importActual) so the ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS config seam
// stays live for this suite — a hard-coded 5-min reimplementation here would
// silently stop covering the poller's grace-boundary behavior.
vi.mock('../../../jobs/zernio/zernio-ingest-shared', async () => {
  const actual = await vi.importActual<
    typeof import('../../../jobs/zernio/zernio-ingest-shared')
  >('../../../jobs/zernio/zernio-ingest-shared');
  return {
    liveIngestCutoff: actual.liveIngestCutoff,
    reconcileExternallyAnsweredReview: mockReconcileExternallyAnsweredReview,
    openPhiReviewException: mockOpenPhiReviewException,
  };
});

vi.mock('../../../../src/lib/zernio/auth-error-fallback', () => ({
  applyIngestionAuthErrorFallback: mockApplyAuthErrorFallback,
}));

import { ZernioAuthError } from '../../../../src/lib/zernio/errors';
import { resetWorkerConfigForTests } from '../../../../src/lib/config/worker';
import { REVIEW_STATUS } from '../../../../src/lib/reviews/status';
import { runOnce, poll, resetConnectionCursorForTests } from '../ZernioRecentReviewPoller';

function makeReview(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'review-new',
    name: 'accounts/google-account/locations/location-1/reviews/review-new',
    reviewer: { displayName: 'Norbert Esekiel', profilePhotoUrl: null, isAnonymous: false },
    rating: 5,
    starRating: 'FIVE',
    comment: 'Great place and ambient vibes',
    createTime: '2026-05-10T06:30:04.403Z',
    updateTime: '2026-05-10T06:30:04.403Z',
    reviewReply: null,
    ...overrides,
  };
}

describe('ZernioRecentReviewPoller', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    sqlCalls.length = 0;
    process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
    delete process.env.ZERNIO_RECENT_REVIEW_POLL_MAX_PAGES;
    delete process.env.ZERNIO_RECENT_REVIEW_POLL_MAX_CONNECTIONS;
    delete process.env.ZERNIO_RECENT_REVIEW_POLL_CONCURRENCY;
    delete process.env.ZERNIO_RECENT_REVIEW_POLL_DEADLINE_MS;
    delete process.env.ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS;
    // readPositiveInt now reads the memoized getWorkerConfig(); clear the memo so
    // each test's ZERNIO_RECENT_REVIEW_POLL_* override is parsed fresh (#6).
    resetWorkerConfigForTests();
    resetConnectionCursorForTests();
  });

  it('imports recent connected-account reviews and ignores older reviews', async () => {
    sqlReturnQueue.push([
      {
        business_id: 'business-1',
        zernio_account_id: 'zernio-account-1',
        zernio_location_id: 'location-1',
        connected_at: new Date('2026-05-10T06:28:15.000Z'),
        subscription_status: 'active',
        updated_at: new Date('2026-05-10T06:28:15.000Z'),
      },
    ]);
    mockListReviews.mockResolvedValueOnce({
      reviews: [
        makeReview(),
        makeReview({
          id: 'review-old',
          name: 'accounts/google-account/locations/location-1/reviews/review-old',
          reviewer: { displayName: 'Older Reviewer', profilePhotoUrl: null, isAnonymous: false },
          createTime: '2026-05-10T06:07:06.162Z',
        }),
      ],
    });
    mockProcessReview.mockResolvedValue('new');

    const result = await runOnce();

    expect(result.connectionsChecked).toBe(1);
    expect(result.reviewsSeen).toBe(2);
    expect(result.reviewsProcessed).toBe(1);
    expect(mockProcessReview).toHaveBeenCalledTimes(1);
    expect(mockProcessReview.mock.calls[0]?.[2]).toBe('business-1');
    expect(mockProcessReview.mock.calls[0]?.[3]).toContain('zernio-poll:');
  });

  it('reconciles recent reviews that already have external replies', async () => {
    sqlReturnQueue.push([
      {
        business_id: 'business-1',
        zernio_account_id: 'zernio-account-1',
        zernio_location_id: 'location-1',
        connected_at: new Date('2026-05-10T06:28:15.000Z'),
        subscription_status: 'active',
        updated_at: new Date('2026-05-10T06:28:15.000Z'),
      },
    ]);
    mockListReviews.mockResolvedValueOnce({
      reviews: [
        makeReview({
          reviewReply: { comment: 'Thanks!', updateTime: '2026-05-10T06:31:00.000Z' },
        }),
      ],
    });
    mockReconcileExternallyAnsweredReview.mockResolvedValue(undefined);

    const result = await runOnce();

    expect(result.reviewsSeen).toBe(1);
    expect(result.reviewsProcessed).toBe(0);
    expect(result.reviewsReconciled).toBe(1);
    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockReconcileExternallyAnsweredReview).toHaveBeenCalledTimes(1);
  });

  it('quarantines likely PHI in recent unanswered reviews before processReview', async () => {
    sqlReturnQueue.push([
      {
        business_id: 'business-1',
        zernio_account_id: 'zernio-account-1',
        zernio_location_id: 'location-1',
        connected_at: new Date('2026-05-10T06:28:15.000Z'),
        subscription_status: 'active',
        updated_at: new Date('2026-05-10T06:28:15.000Z'),
      },
    ]);
    const phiReview = makeReview({
      id: 'review-phi',
      name: 'accounts/google-account/locations/location-1/reviews/review-phi',
      comment: 'Patient MRN 12345 needs diabetes treatment follow up',
    });
    mockListReviews.mockResolvedValueOnce({ reviews: [phiReview] });

    const result = await runOnce();

    expect(result.reviewsSeen).toBe(1);
    expect(result.reviewsProcessed).toBe(0);
    expect(result.reviewsSkipped).toBe(1);
    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockOpenPhiReviewException).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        businessId: 'business-1',
        accountId: 'zernio-account-1',
        locationId: 'location-1',
        review: phiReview,
        source: 'recent_poller',
        reasons: expect.arrayContaining(['mrn']),
      }),
      expect.anything(),
    );
    // The quarantine must run inside the caller-owned transaction; fail if the
    // poller bypasses sql.begin and writes the exception/outbox non-atomically.
    expect((mockSql as unknown as { begin: unknown }).begin).toHaveBeenCalledTimes(1);
  });

  it('marks recent local reviews deleted when Zernio no longer returns them', async () => {
    sqlReturnQueue.push([
      {
        business_id: 'business-1',
        zernio_account_id: 'zernio-account-1',
        zernio_location_id: 'location-1',
        connected_at: new Date('2026-05-10T06:28:15.000Z'),
        subscription_status: 'active',
        updated_at: new Date('2026-05-10T06:28:15.000Z'),
      },
    ]);
    mockListReviews.mockResolvedValueOnce({
      reviews: [makeReview()],
    });
    sqlReturnQueue.push([
      {
        id: 'local-deleted-review-id',
        provider_review_id: 'deleted-review-id',
      },
    ]);
    sqlReturnQueue.push([{ count: '1' }]);
    sqlReturnQueue.push([{ count: '1' }]);

    const result = await runOnce();

    expect(result.reviewsDeleted).toBe(1);
    expect(sqlCalls.some((call) =>
      call.template.includes('UPDATE reviews') &&
      call.template.includes('SET status =') &&
      call.values.includes(REVIEW_STATUS.DELETED),
    )).toBe(true);
    expect(sqlCalls.some((call) =>
      call.template.includes('UPDATE responses') &&
      call.template.includes("posting_error = 'review_deleted_at_source'"),
    )).toBe(true);
  });

  it('marks recent local reviews deleted when the complete Zernio feed is empty', async () => {
    sqlReturnQueue.push([
      {
        business_id: 'business-1',
        zernio_account_id: 'zernio-account-1',
        zernio_location_id: 'location-1',
        connected_at: new Date('2026-05-10T06:28:15.000Z'),
        subscription_status: 'active',
        updated_at: new Date('2026-05-10T06:28:15.000Z'),
      },
    ]);
    mockListReviews.mockResolvedValueOnce({ reviews: [] });
    sqlReturnQueue.push([
      {
        id: 'local-deleted-review-id',
        provider_review_id: 'deleted-review-id',
      },
    ]);
    sqlReturnQueue.push([{ count: '1' }]);
    sqlReturnQueue.push([{ count: '1' }]);

    const result = await runOnce();

    expect(result.reviewsDeleted).toBe(1);
    expect(sqlCalls.some((call) =>
      call.template.includes('UPDATE reviews') &&
      call.template.includes('SET status =') &&
      call.values.includes(REVIEW_STATUS.DELETED),
    )).toBe(true);
  });

  it('does not tombstone local reviews when pagination stops before the feed is complete', async () => {
    process.env.ZERNIO_RECENT_REVIEW_POLL_MAX_PAGES = '1';
    sqlReturnQueue.push([
      {
        business_id: 'business-1',
        zernio_account_id: 'zernio-account-1',
        zernio_location_id: 'location-1',
        connected_at: new Date('2026-05-10T06:28:15.000Z'),
        subscription_status: 'active',
        updated_at: new Date('2026-05-10T06:28:15.000Z'),
      },
    ]);
    mockListReviews.mockResolvedValueOnce({
      reviews: [makeReview()],
      nextPageToken: 'next-page',
    });

    const result = await runOnce();

    expect(result.reviewsDeleted).toBe(0);
    expect(sqlCalls.some((call) =>
      call.template.includes('provider_review_id <> ALL') ||
      call.template.includes('provider_review_id = ANY'),
    )).toBe(false);
  });

  it('applies the auth-error fallback when recent-review polling loses Zernio auth', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sqlReturnQueue.push([
      {
        business_id: 'business-1',
        zernio_account_id: 'zernio-account-1',
        zernio_location_id: 'location-1',
        connected_at: new Date('2026-05-10T06:28:15.000Z'),
        subscription_status: 'active',
        updated_at: new Date('2026-05-10T06:28:15.000Z'),
      },
    ]);
    mockListReviews.mockRejectedValueOnce(
      new ZernioAuthError(401, '{"code":"token_refresh_failed"}'),
    );

    const result = await runOnce();

    expect(result.errors).toBe(1);
    expect(mockApplyAuthErrorFallback).toHaveBeenCalledWith(
      mockSql,
      'business-1',
      'zernio-account-1',
      'location-1',
      'Zernio auth error (401): {"code":"token_refresh_failed"}',
    );
    expect(errorSpy).not.toHaveBeenCalled();
    // The structured logger emits one JSON line per call via console.warn.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
      '"message":"disconnected business after Zernio auth failure"',
    ));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"business_id":"business-1"'));
    expect(mockProcessReview).not.toHaveBeenCalled();
  });

  it('processes a review at the live-ingest cutoff and skips one below it under configured grace', async () => {
    process.env.ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS = '120000';
    const connectedAt = new Date('2026-05-10T06:30:00.000Z');
    sqlReturnQueue.push([
      {
        business_id: 'business-1',
        zernio_account_id: 'zernio-account-1',
        zernio_location_id: 'location-1',
        connected_at: connectedAt,
        subscription_status: 'active',
        updated_at: connectedAt,
      },
    ]);
    // cutoff = connectedAt - 120000ms. At-cutoff is processed; one ms below is skipped.
    const atCutoff = new Date(connectedAt.getTime() - 120_000).toISOString();
    const belowCutoff = new Date(connectedAt.getTime() - 120_001).toISOString();
    mockListReviews.mockResolvedValueOnce({
      reviews: [
        makeReview({ id: 'review-at-cutoff', createTime: atCutoff }),
        makeReview({
          id: 'review-below-cutoff',
          name: 'accounts/google-account/locations/location-1/reviews/review-below-cutoff',
          createTime: belowCutoff,
        }),
      ],
    });
    mockProcessReview.mockResolvedValue('new');

    const result = await runOnce();

    expect(result.reviewsSeen).toBe(2);
    expect(result.reviewsProcessed).toBe(1);
    expect(result.reviewsSkipped).toBe(1);
    expect(mockProcessReview).toHaveBeenCalledTimes(1);
  });

  describe('per-cycle bounds (deep-scan §3.7)', () => {
    function makeConnection(businessId: string) {
      return {
        business_id: businessId,
        zernio_account_id: 'zernio-account-1',
        zernio_location_id: 'location-1',
        connected_at: new Date('2026-05-10T06:28:15.000Z'),
        subscription_status: 'active',
        past_due_at: null,
        account_flags: {},
      };
    }

    function connectionLoadCalls() {
      return sqlCalls.filter((call) => call.template.includes('FROM zernio_connections'));
    }

    it('passes the connection cap and a null cursor to the first load query', async () => {
      process.env.ZERNIO_RECENT_REVIEW_POLL_MAX_CONNECTIONS = '2';
      sqlReturnQueue.push([makeConnection('business-1')]);
      mockListReviews.mockResolvedValue({ reviews: [] });

      await runOnce();

      const [load] = connectionLoadCalls();
      expect(load).toBeDefined();
      expect(load!.template).toContain('LIMIT');
      expect(load!.values).toEqual([null, null, 2]);
    });

    it('resumes from the last dispatched business_id and wraps after a full rotation', async () => {
      process.env.ZERNIO_RECENT_REVIEW_POLL_MAX_CONNECTIONS = '2';
      mockListReviews.mockResolvedValue({ reviews: [] });

      // Cycle 1: full batch (= cap) → cursor advances to business-2.
      sqlReturnQueue.push([makeConnection('business-1'), makeConnection('business-2')]);
      await runOnce();

      // Cycle 2: partial batch (< cap) → end of rotation → cursor wraps to null.
      sqlReturnQueue.push([makeConnection('business-3')]);
      await runOnce();

      // Cycle 3: starts from the top again.
      sqlReturnQueue.push([makeConnection('business-1')]);
      await runOnce();

      const loads = connectionLoadCalls();
      expect(loads).toHaveLength(3);
      expect(loads[0]!.values).toEqual([null, null, 2]);
      expect(loads[1]!.values).toEqual(['business-2', 'business-2', 2]);
      expect(loads[2]!.values).toEqual([null, null, 2]);
    });

    it('stops dispatching at the cycle deadline, logs and counts deferred connections', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      process.env.ZERNIO_RECENT_REVIEW_POLL_CONCURRENCY = '1';
      process.env.ZERNIO_RECENT_REVIEW_POLL_DEADLINE_MS = '50';
      sqlReturnQueue.push([
        makeConnection('business-1'),
        makeConnection('business-2'),
        makeConnection('business-3'),
      ]);
      // Each Zernio fetch outlasts the 50ms deadline, so only the first
      // connection is dispatched before the deadline check trips.
      mockListReviews.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ reviews: [] }), 100)),
      );

      const result = await runOnce();

      expect(result.connectionsChecked).toBe(1);
      expect(result.connectionsDeferred).toBe(2);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
        '"message":"Cycle deadline reached — deferring connections to the next cycle"',
      ));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"deferred":2'));

      // The cursor advanced only past the dispatched connection, so the
      // deferred ones lead the next cycle.
      sqlReturnQueue.push([makeConnection('business-2')]);
      mockListReviews.mockResolvedValue({ reviews: [] });
      delete process.env.ZERNIO_RECENT_REVIEW_POLL_DEADLINE_MS;
      await runOnce();

      const loads = connectionLoadCalls();
      expect(loads[1]!.values.slice(0, 2)).toEqual(['business-1', 'business-1']);
    });

    it('contains an unexpected throw from checkConnection: counts it, advances the cursor, finishes the cycle', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      process.env.ZERNIO_RECENT_REVIEW_POLL_CONCURRENCY = '1';
      sqlReturnQueue.push([makeConnection('business-1'), makeConnection('business-2')]);
      // First connection loses Zernio auth; the disconnect fallback then throws
      // (e.g. a transient Postgres blip) — that rejection must NOT escape the
      // pool worker and reject Promise.all.
      mockListReviews
        .mockRejectedValueOnce(new ZernioAuthError(401, '{"code":"token_refresh_failed"}'))
        .mockResolvedValueOnce({ reviews: [] });
      mockApplyAuthErrorFallback.mockRejectedValueOnce(new Error('postgres unreachable'));

      const result = await runOnce();

      // Both connections were still processed; the throw was contained.
      expect(result.connectionsChecked).toBe(2);
      expect(result.connectionsDeferred).toBe(0);
      expect(result.errors).toBeGreaterThanOrEqual(1);

      // Cursor advanced past the full batch despite the throw — the next cycle
      // wraps to the top rather than re-failing the same batch forever.
      sqlReturnQueue.push([makeConnection('business-1')]);
      mockListReviews.mockResolvedValue({ reviews: [] });
      await runOnce();
      const loads = connectionLoadCalls();
      expect(loads[1]!.values.slice(0, 2)).toEqual([null, null]);

      errorSpy.mockRestore();
    });

    it('bounds the Zernio fan-out to the configured concurrency', async () => {
      process.env.ZERNIO_RECENT_REVIEW_POLL_CONCURRENCY = '2';
      sqlReturnQueue.push([
        makeConnection('business-1'),
        makeConnection('business-2'),
        makeConnection('business-3'),
        makeConnection('business-4'),
      ]);

      let inFlight = 0;
      let maxInFlight = 0;
      mockListReviews.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return { reviews: [] };
      });

      const result = await runOnce();

      expect(result.connectionsChecked).toBe(4);
      expect(result.connectionsDeferred).toBe(0);
      expect(maxInFlight).toBe(2);
    });
  });

  describe('poll() self-healing watchdog', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('trips the watchdog when a cycle hangs on a stale connection and resets isPolling so the next tick recovers', async () => {
      vi.useFakeTimers();
      const connection = {
        business_id: 'business-1',
        zernio_account_id: 'zernio-account-1',
        zernio_location_id: 'location-1',
        connected_at: new Date('2026-05-10T06:28:15.000Z'),
        subscription_status: 'active',
      };

      // Cycle 1: an eligible review whose processReview never settles — the
      // stale-pooled-connection hang (server-side statement_timeout never fires).
      // Without the watchdog poll() would pend forever and pin isPolling=true.
      sqlReturnQueue.push([connection]);
      mockListReviews.mockResolvedValueOnce({ reviews: [makeReview()] });
      mockProcessReview.mockReturnValueOnce(new Promise(() => {}));

      const firstCycle = poll();
      // Advance past the watchdog (DEFAULT_CYCLE_DEADLINE_MS 60s + 60s buffer = 120s).
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      await firstCycle; // poll() caught the TimeoutError and released isPolling.

      expect(mockProcessReview).toHaveBeenCalledTimes(1);

      // Cycle 2: the next tick must proceed (isPolling released) and ingest.
      sqlReturnQueue.push([connection]);
      mockListReviews.mockResolvedValueOnce({ reviews: [makeReview()] });
      mockProcessReview.mockResolvedValueOnce('new');

      await poll();

      expect(mockListReviews).toHaveBeenCalledTimes(2);
      expect(mockProcessReview).toHaveBeenCalledTimes(2);
    });
  });
});
