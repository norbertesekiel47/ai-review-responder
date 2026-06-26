import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import { SKIP_REASON_ARCHIVED_LOCATION, type IngestZernioReviewPayload } from '../../../../src/lib/shared/worker-types';
import type { ZernioReview } from '../../../../src/lib/zernio/types';
import { ZernioAuthError } from '../../../../src/lib/zernio/errors';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  sqlReturnQueue,
  mockSql,
  resetMockSql,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockListReviews,
  mockProcessReview,
  mockReconcileExternallyAnsweredReview,
  mockOpenPhiReviewException,
  mockHandleZernioIngestError,
  mockApplyIngestionAuthErrorFallback,
  mockLogger,
} = await vi.hoisted(async () => {
  const { createMockSql, mockWorkerLogger } =
    await import('../../../__tests__/helpers/mock-sql');

  return {
    ...createMockSql(),
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockListReviews: vi.fn(),
    mockProcessReview: vi.fn(),
    mockReconcileExternallyAnsweredReview: vi.fn(),
    mockOpenPhiReviewException: vi.fn(),
    mockHandleZernioIngestError: vi.fn(),
    mockApplyIngestionAuthErrorFallback: vi.fn(),
    mockLogger: mockWorkerLogger(),
  };
});

// ── Module mocks ─────────────────────────────────────────────────────────
vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (d: any, fallback: string) => ({
    outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback,
    attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined,
  }),
}));
vi.mock('../../../../src/lib/zernio/client', () => ({
  zernioClient: { listReviews: mockListReviews },
}));
vi.mock('../../../../src/lib/reviews/process-review', () => ({
  processReview: mockProcessReview,
}));
vi.mock('../zernio-ingest-shared', () => ({
  reconcileExternallyAnsweredReview: mockReconcileExternallyAnsweredReview,
  openPhiReviewException: mockOpenPhiReviewException,
  handleZernioIngestError: mockHandleZernioIngestError,
}));
vi.mock('../../../../src/lib/zernio/auth-error-fallback', () => ({
  applyIngestionAuthErrorFallback: mockApplyIngestionAuthErrorFallback,
}));
vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => mockLogger,
}));

import {
  handleZernioReviewIngest,
  ZernioIngestReviewNotFoundError,
  ZernioIngestPaginationCapExhaustedError,
  ZernioIngestUnparseableLocationError,
} from '../ZernioReviewIngestWorker';
import { resetWorkerConfigForTests } from '../../../../src/lib/config/worker';

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
  sqlReturnQueue.push([{
    subscription_status: 'active',
    past_due_at: null,
    account_flags: {},
  }]);
}

function pushActiveConn() {
  sqlReturnQueue.push([{ id: 'conn-1' }]);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('ZernioReviewIngestWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
    // maxPages reads ZERNIO_INGEST_MAX_PAGES via the memoized getWorkerConfig();
    // clear the memo so each test re-parses the current env (the override test
    // below sets '2' then restores it) (Stage-3 #6).
    resetWorkerConfigForTests();
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
    resetWorkerConfigForTests(); // re-parse so the handler reads the '2' override
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
    sqlReturnQueue.push([{
      subscription_status: 'cancelled',
      past_due_at: null,
      account_flags: {},
    }]);

    await handleZernioReviewIngest(makeJob());

    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ingest-1', undefined);
  });

  // 6b. Location archived → markOutboxCompleted (skip-as-success), NO listReviews call.
  //     Defense-in-depth for ingest jobs already queued when a location is
  //     archived: the webhook fan-out (A1) stops enqueuing new jobs, this
  //     skips any that were already in flight. Mirrors the cancelled-
  //     subscription skip: complete the job, never fail/retry.
  it('marks outbox completed and skips when the location is archived', async () => {
    // Active subscription — only archived_at should trigger the skip.
    // The archived guard runs before the connection lookup, so no
    // zernio_connections row is queued. Without the guard, execution would
    // proceed to the connection query (empty queue → mismatch skip), so
    // listReviews staying uncalled alone wouldn't prove the archived gate;
    // the structured archived log below does.
    sqlReturnQueue.push([{
      subscription_status: 'active',
      past_due_at: null,
      account_flags: {},
      archived_at: '2026-06-01T00:00:00Z',
    }]);

    await handleZernioReviewIngest(makeJob());

    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: SKIP_REASON_ARCHIVED_LOCATION, business_id: 'biz-1' }),
    );
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ingest-1', undefined);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  // 6c. Ordering pin (Greptile 4/5 finding): archived is checked BEFORE the
  //     subscription guard. A location that is BOTH archived AND on a
  //     cancelled subscription must exit via the queryable archived path
  //     (structured { reason: SKIP_REASON_ARCHIVED_LOCATION } log), not the
  //     silent subscription skip.
  it('archived + cancelled exits via the archived path: structured log fires and outbox completes', async () => {
    sqlReturnQueue.push([{
      subscription_status: 'cancelled',
      past_due_at: null,
      account_flags: {},
      archived_at: '2026-06-01T00:00:00Z',
    }]);

    await handleZernioReviewIngest(makeJob());

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: SKIP_REASON_ARCHIVED_LOCATION, business_id: 'biz-1' }),
    );
    expect(mockListReviews).not.toHaveBeenCalled();
    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ingest-1', undefined);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
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

  it('still reconciles external replies when review text likely contains PHI', async () => {
    pushActiveBiz();
    pushActiveConn();

    const review = makeZernioReview({
      comment: 'Patient MRN 12345 needs diabetes treatment follow up',
      reviewReply: { comment: 'Handled directly.', updateTime: '2026-04-01T11:00:00Z' },
    });
    mockListReviews.mockResolvedValueOnce({ reviews: [review], nextPageToken: undefined });
    mockReconcileExternallyAnsweredReview.mockResolvedValueOnce(undefined);

    await handleZernioReviewIngest(makeJob());

    expect(mockReconcileExternallyAnsweredReview).toHaveBeenCalledTimes(1);
    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-ingest-1', undefined);
  });

  it('marks outbox completed and skips processing when target review likely contains PHI', async () => {
    pushActiveBiz();
    pushActiveConn();

    const review = makeZernioReview({
      comment: 'Patient MRN 12345 needs diabetes treatment follow up',
    });
    mockListReviews.mockResolvedValueOnce({ reviews: [review], nextPageToken: undefined });

    await handleZernioReviewIngest(makeJob());

    expect(mockReconcileExternallyAnsweredReview).not.toHaveBeenCalled();
    expect(mockProcessReview).not.toHaveBeenCalled();
    expect(mockOpenPhiReviewException).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        businessId: 'biz-1',
        accountId: 'acct-1',
        locationId: 'loc-1',
        review,
        source: 'webhook',
        reasons: expect.arrayContaining(['mrn']),
      }),
      expect.anything(),
    );
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
