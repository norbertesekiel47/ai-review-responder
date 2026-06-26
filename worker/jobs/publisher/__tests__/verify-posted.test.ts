import { describe, it, expect, vi, beforeEach } from 'vitest';

// Heavy transitive deps of publisher-error-handlers (which we import for the
// real error classes) are mocked so importing the module has no side effects.
vi.mock('../../../../src/lib/db/server', () => ({ sql: vi.fn(), jsonb: (v: unknown) => v }));
vi.mock('@sentry/node', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('../../../../src/lib/shared/outbox', () => ({ markOutboxCompleted: vi.fn() }));
vi.mock('../activation', () => ({ maybeCaptureActivationCompleted: vi.fn() }));

const { mockListAllReviews, mockGetCachedZernioReviewPage } = vi.hoisted(() => ({
  mockListAllReviews: vi.fn(),
  mockGetCachedZernioReviewPage: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../../src/lib/zernio/client', () => ({
  zernioClient: { listAllReviews: mockListAllReviews },
}));
vi.mock('../../../../src/lib/publishing/zernio-publisher', () => ({
  getCachedZernioReviewPage: mockGetCachedZernioReviewPage,
  // The Zernio adapter statically imports this too (used only by resolveTarget,
  // which this suite never invokes); mock it so the module surface is complete.
  lookupZernioReviewId: vi.fn(),
}));

import { verifyOwnReplyAttached } from '../verify-posted';
import {
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
} from '../publisher-error-handlers';
import { ZernioTransientError } from '../../../../src/lib/zernio/errors';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

function zReview(id: string, replyComment: string | null = null) {
  return {
    id,
    name: `accounts/acct-1/locations/loc-1/reviews/${id}`,
    reviewer: { displayName: 'Reviewer', profilePhotoUrl: null, isAnonymous: false },
    rating: 5,
    starRating: 'FIVE' as const,
    comment: 'Lovely stay',
    createTime: '2026-05-31T07:00:00Z',
    updateTime: '2026-05-31T07:00:00Z',
    reviewReply: replyComment === null ? null : { comment: replyComment, updateTime: '2026-05-31T07:04:00Z' },
  };
}

const target = {
  ref: { responseId: 'resp-1', businessId: 'biz-1', reviewId: 'rev-1' },
  locator: { accountId: 'acct-1', locationId: 'loc-1', providerReviewId: 'ZID-ours' },
};

const baseArgs = {
  target,
  approvedText: 'Dear guest, thank you for the kind words!',
  logger,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCachedZernioReviewPage.mockResolvedValue(null);
});

describe('verifyOwnReplyAttached', () => {
  // THE bug: postReply returned 2xx for a review id that is not in the live
  // feed (stale/phantom id). We must NOT treat that as posted.
  it('throws indeterminate(review_not_found_after_pagination) when our review id is absent from the feed', async () => {
    mockListAllReviews.mockResolvedValue([zReview('ZID-other-1', 'someone elses reply'), zReview('ZID-other-2')]);
    await expect(verifyOwnReplyAttached(baseArgs)).rejects.toMatchObject({
      name: 'ZernioReplyVerificationIndeterminateError',
      meta: { reason: 'review_not_found_after_pagination' },
    });
  });

  it('resolves (confirmed) when our review is found with a reply matching our text', async () => {
    mockListAllReviews.mockResolvedValue([zReview('ZID-ours', 'Dear guest, thank you for the kind words!')]);
    await expect(verifyOwnReplyAttached(baseArgs)).resolves.toBeUndefined();
  });

  it('matches across whitespace/CRLF differences (canonicalized compare)', async () => {
    mockListAllReviews.mockResolvedValue([zReview('ZID-ours', 'Dear guest, thank you for the kind words!\r\n')]);
    await expect(verifyOwnReplyAttached(baseArgs)).resolves.toBeUndefined();
  });

  it('throws indeterminate(review_found_but_reply_null) when the review exists but has no reply', async () => {
    mockListAllReviews.mockResolvedValue([zReview('ZID-ours', null)]);
    await expect(verifyOwnReplyAttached(baseArgs)).rejects.toMatchObject({
      meta: { reason: 'review_found_but_reply_null' },
    });
  });

  it('throws indeterminate(reply_text_mismatch) when the attached reply is not ours', async () => {
    mockListAllReviews.mockResolvedValue([zReview('ZID-ours', 'A completely different reply')]);
    await expect(verifyOwnReplyAttached(baseArgs)).rejects.toMatchObject({
      meta: { reason: 'reply_text_mismatch' },
    });
  });

  // Verification list call failing must NOT mark the (already-succeeded) post as
  // failed — retry instead; the next attempt's postReply 409 routes to the
  // existing verify409 path.
  it('throws PublisherTransientWithContext when the verification list call errors', async () => {
    mockListAllReviews.mockRejectedValue(new ZernioTransientError('http_503', { status: 503 }));
    await expect(verifyOwnReplyAttached(baseArgs)).rejects.toBeInstanceOf(PublisherTransientWithContext);
  });

  it('bounds the walk using the cached page index', async () => {
    mockGetCachedZernioReviewPage.mockResolvedValue(0);
    mockListAllReviews.mockResolvedValue([zReview('ZID-ours', 'Dear guest, thank you for the kind words!')]);
    await verifyOwnReplyAttached(baseArgs);
    expect(mockListAllReviews).toHaveBeenCalledWith('acct-1', expect.objectContaining({ maxPages: 1 }));
  });
});
