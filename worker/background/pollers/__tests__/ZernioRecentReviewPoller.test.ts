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

vi.mock('../../../jobs/zernio/zernio-ingest-shared', () => ({
  reconcileExternallyAnsweredReview: mockReconcileExternallyAnsweredReview,
  openPhiReviewException: mockOpenPhiReviewException,
}));

vi.mock('../../../../src/lib/zernio/auth-error-fallback', () => ({
  applyIngestionAuthErrorFallback: mockApplyAuthErrorFallback,
}));

import { ZernioAuthError } from '../../../../src/lib/zernio/errors';
import { runOnce } from '../ZernioRecentReviewPoller';

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
    expect(mockProcessReview.mock.calls[0]?.[1]).toBe('business-1');
    expect(mockProcessReview.mock.calls[0]?.[2]).toContain('zernio-poll:');
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
      call.template.includes("status = 'deleted'"),
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
      call.template.includes("status = 'deleted'"),
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
      'business-1',
      'zernio-account-1',
      'location-1',
      'Zernio auth error (401): {"code":"token_refresh_failed"}',
    );
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
      'disconnected business=business-1 after Zernio auth failure',
    ));
    expect(mockProcessReview).not.toHaveBeenCalled();
  });
});
