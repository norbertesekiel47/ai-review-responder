import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import type { IngestZernioReviewPayload } from '../../src/lib/shared/worker-types';
import type { ZernioReview } from '../../src/lib/zernio/types';
import { ZernioAuthError } from '../../src/lib/zernio/errors';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  sqlReturnQueue,
  mockSql,
  mockMarkOutboxCompleted,
  mockListReviews,
  mockProcessReview,
  mockReconcileExternallyAnsweredReview,
  mockHandleZernioIngestError,
  mockApplyIngestionAuthErrorFallback,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? Object.assign([], { count: 0 });
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));

  return {
    sqlReturnQueue,
    mockSql,
    mockMarkOutboxCompleted: vi.fn(),
    mockListReviews: vi.fn(),
    mockProcessReview: vi.fn(),
    mockReconcileExternallyAnsweredReview: vi.fn(),
    mockHandleZernioIngestError: vi.fn(),
    mockApplyIngestionAuthErrorFallback: vi.fn(),
  };
});

// ── Module mocks ─────────────────────────────────────────────────────────
vi.mock('../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: vi.fn(),
  extractOutboxHandle: (d: any, fallback: string) => ({
    outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback,
    attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined,
  }),
}));
vi.mock('../../src/lib/zernio/client', () => ({
  zernioClient: { listReviews: mockListReviews },
}));
vi.mock('../../src/lib/reviews/process-review', () => ({
  processReview: mockProcessReview,
}));
vi.mock('../jobs/zernio-ingest-shared', () => ({
  reconcileExternallyAnsweredReview: mockReconcileExternallyAnsweredReview,
  handleZernioIngestError: mockHandleZernioIngestError,
}));
vi.mock('../../src/lib/zernio/auth-error-fallback', () => ({
  applyIngestionAuthErrorFallback: mockApplyIngestionAuthErrorFallback,
}));

import {
  handleZernioReviewIngest,
  ZernioIngestReviewNotFoundError,
  ZernioIngestPaginationCapExhaustedError,
  ZernioIngestUnparseableLocationError,
} from '../jobs/ZernioReviewIngestWorker';

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<IngestZernioReviewPayload> = {}): Job<IngestZernioReviewPayload> {
  return {
    data: {
      business_id: 'biz-1',
      zernio_account_id: 'acct-1',
      zernio_location_id: 'loc-1',
      zernio_review_id: 'rev-abc',
      ...overrides,
    },
    id: 'outbox-ingest-1',
  } as Job<IngestZernioReviewPayload>;
}

function makeZernioReview(overrides: Partial<ZernioReview> = {}): ZernioReview {
  return {
    id: 'rev-abc',
    name: 'accounts/acct-1/locations/loc-1/reviews/rev-abc',
    reviewer: { displayName: 'Jane Smith', profilePhotoUrl: '', isAnonymous: false },
    rating: 5,
    starRating: 'FIVE',
    comment: 'Great service!',
    createTime: '2026-04-01T10:00:00Z',
    updateTime: '2026-04-01T10:00:00Z',
    reviewReply: null,
    ...overrides,
  };
}

function pushActiveBiz() {
  sqlReturnQueue.push([{ subscription_status: 'active', updated_at: new Date() }]);
}

function pushActiveConn() {
  sqlReturnQueue.push([{ id: 'conn-1' }]);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('ZernioReviewIngestWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
  });

  // 1. Page 1 hit → processReview called
  it('calls processReview and marks outbox completed when target found on page 1', async () => {
    pushActiveBiz();
    pushActiveConn();

    const review = makeZernioReview();
    mockListReviews.mockResolvedValueOnce({ reviews: [review], nextPageToken: undefined });
    mockProcessReview.mockResolvedValueOnce(undefined);

    await handleZernioReviewIngest(makeJob());

    expect(mockListReviews).toHaveBeenCalledTimes(1);
    expect(mockListReviews).toHaveBeenCalledWith('acct-1', {
      locationId: 'loc-1',
      pageSize: 50,
      pageToken: undefined,
    });
    expect(mockProcessReview).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ingest-1', undefined);
  });

  // 2. Page 2 hit → processReview called
  it('calls processReview when target is found on page 2', async () => {
    pushActiveBiz();
    pushActiveConn();

    const review = makeZernioReview();
    const otherReview = makeZernioReview({ id: 'other-rev', name: 'accounts/acct-1/locations/loc-1/reviews/other-rev' });

    mockListReviews
      .mockResolvedValueOnce({ reviews: [otherReview], nextPageToken: 'page2token' })
      .mockResolvedValueOnce({ reviews: [review], nextPageToken: undefined });

    mockProcessReview.mockResolvedValueOnce(undefined);

    await handleZernioReviewIngest(makeJob());

    expect(mockListReviews).toHaveBeenCalledTimes(2);
    expect(mockListReviews).toHaveBeenNthCalledWith(1, 'acct-1', {
      locationId: 'loc-1',
      pageSize: 50,
      pageToken: undefined,
    });
    expect(mockListReviews).toHaveBeenNthCalledWith(2, 'acct-1', {
      locationId: 'loc-1',
      pageSize: 50,
      pageToken: 'page2token',
    });
    expect(mockProcessReview).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ingest-1', undefined);
  });

  // 3a. Walked entire feed without finding → durable ZernioIngestReviewNotFoundError.
  //     Distinguished from cap-exhausted by the absence of nextPageToken at
  //     the last page Zernio returned. Failed-hook escalates to
  //     review_exceptions type='zernio_review_not_found'.
  it('throws ZernioIngestReviewNotFoundError when entire feed walked without nextPageToken', async () => {
    pushActiveBiz();
    pushActiveConn();

    const other = makeZernioReview({ id: 'other-id', name: 'accounts/acct-1/locations/loc-1/reviews/other-id' });
    mockListReviews
      .mockResolvedValueOnce({ reviews: [other], nextPageToken: 'page2token' })
      // Last page returns no nextPageToken → feed truly exhausted.
      .mockResolvedValueOnce({ reviews: [], nextPageToken: undefined });

    await expect(handleZernioReviewIngest(makeJob())).rejects.toMatchObject({
      name: 'ZernioIngestReviewNotFoundError',
      pagesWalked: 2,
      reviewsSeen: 1,
    });

    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  // 3b. Hit pagination cap with nextPageToken still set → indeterminate
  //     ZernioIngestPaginationCapExhaustedError. Failed-hook escalates to
  //     review_exceptions type='zernio_pagination_cap_exhausted'. Default
  //     cap is 4 pages; mock 4 pages with token still returned on the last.
  it('throws ZernioIngestPaginationCapExhaustedError when cap is hit and Zernio still has more pages', async () => {
    pushActiveBiz();
    pushActiveConn();

    // 4 pages × 50 reviews each, every page returns a nextPageToken so the
    // worker exits the loop on the cap, not on Zernio's exhaustion signal.
    const otherPage = (token: string | undefined) => ({
      reviews: Array.from({ length: 50 }, (_unused, i) => makeZernioReview({
        id: `other-${i}`,
        name: `accounts/acct-1/locations/loc-1/reviews/other-${i}`,
      })),
      nextPageToken: token,
    });
    mockListReviews
      .mockResolvedValueOnce(otherPage('page2'))
      .mockResolvedValueOnce(otherPage('page3'))
      .mockResolvedValueOnce(otherPage('page4'))
      .mockResolvedValueOnce(otherPage('page5'));  // still has more pages

    await expect(handleZernioReviewIngest(makeJob())).rejects.toMatchObject({
      name: 'ZernioIngestPaginationCapExhaustedError',
      cap: 4,
      reviewsSeen: 200,
    });

    expect(mockListReviews).toHaveBeenCalledTimes(4);
    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  // 3c. ZERNIO_INGEST_MAX_PAGES env var honored when set.
  it('honors ZERNIO_INGEST_MAX_PAGES env var override', async () => {
    const prev = process.env.ZERNIO_INGEST_MAX_PAGES;
    process.env.ZERNIO_INGEST_MAX_PAGES = '2';
    try {
      pushActiveBiz();
      pushActiveConn();

      mockListReviews
        .mockResolvedValueOnce({ reviews: [], nextPageToken: 'page2' })
        .mockResolvedValueOnce({ reviews: [], nextPageToken: 'page3' });

      await expect(handleZernioReviewIngest(makeJob())).rejects.toMatchObject({
        name: 'ZernioIngestPaginationCapExhaustedError',
        cap: 2,
      });

      expect(mockListReviews).toHaveBeenCalledTimes(2);
    } finally {
      if (prev === undefined) delete process.env.ZERNIO_INGEST_MAX_PAGES;
      else process.env.ZERNIO_INGEST_MAX_PAGES = prev;
    }
  });

  // 4. Location parseable but != payload location → no-op + markOutboxCompleted
  it('no-ops and marks outbox completed when review location does not match payload', async () => {
    pushActiveBiz();
    pushActiveConn();

    // Review name has loc-2 but payload says loc-1
    const review = makeZernioReview({
      name: 'accounts/acct-1/locations/loc-2/reviews/rev-abc',
    });
    mockListReviews.mockResolvedValueOnce({ reviews: [review], nextPageToken: undefined });

    await handleZernioReviewIngest(makeJob());

    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ingest-1', undefined);
  });

  // 5. Location unparseable → throws ZernioIngestUnparseableLocationError
  it('throws ZernioIngestUnparseableLocationError when review.name is unparseable', async () => {
    pushActiveBiz();
    pushActiveConn();

    const review = makeZernioReview({ name: 'not-a-valid-resource-name' });
    mockListReviews.mockResolvedValueOnce({ reviews: [review], nextPageToken: undefined });

    await expect(handleZernioReviewIngest(makeJob())).rejects.toMatchObject({
      name: 'ZernioIngestUnparseableLocationError',
    });

    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  // 6. Subscription cancelled → markOutboxCompleted, NO listReviews call
  it('marks outbox completed and skips listReviews when subscription is cancelled', async () => {
    sqlReturnQueue.push([{ subscription_status: 'cancelled', updated_at: new Date() }]);

    await handleZernioReviewIngest(makeJob());

    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ingest-1', undefined);
  });

  // 7. Connection no longer active → markOutboxCompleted, NO listReviews call
  it('marks outbox completed and skips listReviews when connection is not active', async () => {
    pushActiveBiz();
    sqlReturnQueue.push([]); // empty conn result

    await handleZernioReviewIngest(makeJob());

    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ingest-1', undefined);
  });

  // 8. MOCK_EXTERNAL_APIS=true → short-circuit
  it('marks outbox completed and skips all Zernio calls in mock mode', async () => {
    const original = process.env.MOCK_EXTERNAL_APIS;
    process.env.MOCK_EXTERNAL_APIS = 'true';

    try {
      pushActiveBiz();
      pushActiveConn();

      await handleZernioReviewIngest(makeJob());

      expect(mockListReviews).not.toHaveBeenCalled();
      expect(mockProcessReview).not.toHaveBeenCalled();
      expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ingest-1', undefined);
    } finally {
      if (original === undefined) {
        delete process.env.MOCK_EXTERNAL_APIS;
      } else {
        process.env.MOCK_EXTERNAL_APIS = original;
      }
    }
  });

  // 9. reviewReply present → reconcileExternallyAnsweredReview called, processReview NOT
  it('calls reconcileExternallyAnsweredReview and skips processReview when review has a reply', async () => {
    pushActiveBiz();
    pushActiveConn();

    const review = makeZernioReview({
      reviewReply: { comment: 'Thanks!', updateTime: '2026-04-01T11:00:00Z' },
    });
    mockListReviews.mockResolvedValueOnce({ reviews: [review], nextPageToken: undefined });
    mockReconcileExternallyAnsweredReview.mockResolvedValueOnce(undefined);

    await handleZernioReviewIngest(makeJob());

    expect(mockReconcileExternallyAnsweredReview).toHaveBeenCalledTimes(1);
    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ingest-1', undefined);
  });

  // 10. ZernioAuthError on listReviews → handleZernioIngestError called
  it('delegates to handleZernioIngestError on ZernioAuthError from listReviews', async () => {
    pushActiveBiz();
    pushActiveConn();

    const authError = new ZernioAuthError(401, 'Unauthorized');
    mockListReviews.mockRejectedValueOnce(authError);
    mockHandleZernioIngestError.mockResolvedValueOnce(undefined);

    await handleZernioReviewIngest(makeJob());

    expect(mockHandleZernioIngestError).toHaveBeenCalledWith(
      authError,
      'outbox-ingest-1',
      undefined,
      {
        business_id: 'biz-1',
        zernio_account_id: 'acct-1',
        zernio_location_id: 'loc-1',
      },
      expect.anything(), // logger
    );
    expect(mockProcessReview).not.toHaveBeenCalled();
  });

  // 11. ZernioReviewNormalizationError → markOutboxCompleted (no retry), warning logged
  it('marks outbox completed without retry on ZernioReviewNormalizationError', async () => {
    pushActiveBiz();
    pushActiveConn();

    // Review with invalid rating → buildZernioMonitoredReview will throw ZernioReviewNormalizationError
    const malformedReview = makeZernioReview({ rating: 0 }); // invalid: rating < 1
    mockListReviews.mockResolvedValueOnce({ reviews: [malformedReview], nextPageToken: undefined });

    await handleZernioReviewIngest(makeJob());

    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ingest-1', undefined);
  });
});
