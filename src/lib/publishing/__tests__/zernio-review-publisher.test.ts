import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/server', () => ({
  sql: vi.fn(),
}));
vi.mock('@/lib/zernio/client', () => ({
  zernioClient: {
    postReply: vi.fn(),
    deleteReply: vi.fn(),
    listAllReviews: vi.fn(),
  },
}));
vi.mock('../zernio-publisher', () => ({
  lookupZernioReviewId: vi.fn(),
  getCachedZernioReviewPage: vi.fn(),
}));

import { sql } from '@/lib/db/server';
import { ZernioReviewPublisher } from '../zernio-review-publisher';
import type { ReviewLocator, ReviewRef } from '../review-publisher';
import {
  ZernioAuthError,
  ZernioReviewNotFoundError,
  ZernioTransientError,
} from '@/lib/zernio/errors';

const REF: ReviewRef = { responseId: 'resp1', reviewId: 'rev1', businessId: 'biz1' };
const LOCATOR: ReviewLocator = {
  accountId: 'acct1',
  locationId: 'loc1',
  providerReviewId: 'z-rev-1',
};

function makeZernioReview(overrides: Record<string, unknown> = {}) {
  return {
    id: 'z-rev-1',
    name: 'accounts/acct1/locations/loc1/reviews/z-rev-1',
    reviewer: { displayName: 'Jane', profilePhotoUrl: null, isAnonymous: false },
    rating: 5,
    starRating: 'FIVE',
    comment: 'Great',
    createTime: '2026-04-26T12:00:00Z',
    updateTime: '2026-04-26T12:00:00Z',
    reviewReply: null,
    ...overrides,
  };
}

describe('ZernioReviewPublisher', () => {
  const adapter = new ZernioReviewPublisher(sql);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('resolveTarget', () => {
    it('returns no_connection when there is no active connection', async () => {
      const { sql } = await import('@/lib/db/server');
      (sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await adapter.resolveTarget(REF);

      expect(result).toEqual({ kind: 'no_connection' });
    });

    it('returns resolved with provider coordinates on success', async () => {
      const { sql } = await import('@/lib/db/server');
      const { lookupZernioReviewId } = await import('../zernio-publisher');
      (sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
        { zernio_account_id: 'acct1', zernio_location_id: 'loc1' },
      ]);
      (lookupZernioReviewId as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('z-rev-1');

      const result = await adapter.resolveTarget(REF);

      expect(result).toEqual({
        kind: 'resolved',
        target: { ref: REF, locator: { accountId: 'acct1', locationId: 'loc1', providerReviewId: 'z-rev-1' } },
      });
      expect(lookupZernioReviewId).toHaveBeenCalledWith(sql, 'biz1', 'rev1', 'acct1', 'loc1');
    });

    it('locks the active connection for a transaction-bound publish lane', async () => {
      const tx = vi.fn().mockResolvedValue([
        { zernio_account_id: 'acct1', zernio_location_id: 'loc1' },
      ]);
      const { lookupZernioReviewId } = await import('../zernio-publisher');
      (lookupZernioReviewId as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValue('z-rev-1');
      const transactionalAdapter = new ZernioReviewPublisher(tx as never, {
        lockActiveConnection: true,
      });

      await transactionalAdapter.resolveTarget(REF);

      const query = (tx.mock.calls[0]![0] as TemplateStringsArray).join('?');
      expect(query).toContain('FROM zernio_connections');
      expect(query).toContain('FOR UPDATE');
      expect(lookupZernioReviewId).toHaveBeenCalledWith(
        tx,
        'biz1',
        'rev1',
        'acct1',
        'loc1',
      );
    });

    it('returns review_not_found (carrying meta) when the lookup cannot match', async () => {
      const { sql } = await import('@/lib/db/server');
      const { lookupZernioReviewId } = await import('../zernio-publisher');
      (sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
        { zernio_account_id: 'acct1', zernio_location_id: 'loc1' },
      ]);
      const meta = { ourReviewId: 'rev1', reason: 'no_field_match' };
      (lookupZernioReviewId as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ZernioReviewNotFoundError(meta),
      );

      const result = await adapter.resolveTarget(REF);

      expect(result).toEqual({ kind: 'review_not_found', meta });
    });

    it('returns transient (with coords + error) when the lookup fails transiently', async () => {
      const { sql } = await import('@/lib/db/server');
      const { lookupZernioReviewId } = await import('../zernio-publisher');
      (sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
        { zernio_account_id: 'acct1', zernio_location_id: 'loc1' },
      ]);
      const transient = new ZernioTransientError('rate_limited', {});
      (lookupZernioReviewId as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(transient);

      const result = await adapter.resolveTarget(REF);

      expect(result).toEqual({
        kind: 'transient',
        accountId: 'acct1',
        locationId: 'loc1',
        error: transient,
      });
    });

    it('rethrows non-transient terminal lookup errors (auth) to bubble as today', async () => {
      const { sql } = await import('@/lib/db/server');
      const { lookupZernioReviewId } = await import('../zernio-publisher');
      (sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
        { zernio_account_id: 'acct1', zernio_location_id: 'loc1' },
      ]);
      (lookupZernioReviewId as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ZernioAuthError(401, 'unauthorized'),
      );

      await expect(adapter.resolveTarget(REF)).rejects.toBeInstanceOf(ZernioAuthError);
    });
  });

  describe('publishReply / deleteReply', () => {
    it('publishReply posts to the resolved provider review id', async () => {
      const { zernioClient } = await import('@/lib/zernio/client');
      (zernioClient.postReply as ReturnType<typeof vi.fn>).mockResolvedValue({
        comment: 'hi',
        updateTime: 'now',
      });

      await adapter.publishReply(LOCATOR, 'hi there');

      expect(zernioClient.postReply).toHaveBeenCalledWith('acct1', 'z-rev-1', { comment: 'hi there' });
    });

    it('deleteReply deletes the resolved provider review id', async () => {
      const { zernioClient } = await import('@/lib/zernio/client');
      (zernioClient.deleteReply as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await adapter.deleteReply(LOCATOR);

      expect(zernioClient.deleteReply).toHaveBeenCalledWith('acct1', 'z-rev-1');
    });
  });

  describe('findReply', () => {
    it('returns found+reply when the review is in the feed with a reply', async () => {
      const { zernioClient } = await import('@/lib/zernio/client');
      const { getCachedZernioReviewPage } = await import('../zernio-publisher');
      (getCachedZernioReviewPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (zernioClient.listAllReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeZernioReview({ reviewReply: { comment: 'our reply', updateTime: 'now' } }),
      ]);

      const result = await adapter.findReply(LOCATOR);

      expect(result).toEqual({ kind: 'found', reply: { comment: 'our reply' } });
    });

    it('returns found+null reply when the review is present but unanswered', async () => {
      const { zernioClient } = await import('@/lib/zernio/client');
      const { getCachedZernioReviewPage } = await import('../zernio-publisher');
      (getCachedZernioReviewPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (zernioClient.listAllReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeZernioReview({ reviewReply: null }),
      ]);

      const result = await adapter.findReply(LOCATOR);

      expect(result).toEqual({ kind: 'found', reply: null });
    });

    it('returns review_absent with walk diagnostics when the review is not in the feed', async () => {
      const { zernioClient } = await import('@/lib/zernio/client');
      const { getCachedZernioReviewPage } = await import('../zernio-publisher');
      (getCachedZernioReviewPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (zernioClient.listAllReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeZernioReview({ id: 'someone-else' }),
        makeZernioReview({ id: 'another' }),
      ]);

      const result = await adapter.findReply(LOCATOR);

      expect(result).toEqual({ kind: 'review_absent', pagesWalked: 4, reviewsSeen: 2 });
    });

    it('bounds maxPages via the cached page index (page 1 → 2 pages)', async () => {
      const { zernioClient } = await import('@/lib/zernio/client');
      const { getCachedZernioReviewPage } = await import('../zernio-publisher');
      (getCachedZernioReviewPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(1);
      (zernioClient.listAllReviews as ReturnType<typeof vi.fn>).mockResolvedValue([makeZernioReview()]);

      await adapter.findReply(LOCATOR);

      expect(zernioClient.listAllReviews).toHaveBeenCalledWith('acct1', {
        locationId: 'loc1',
        pageSize: 50,
        maxPages: 2,
      });
    });

    it('falls back to the conservative cap when the page cache read throws', async () => {
      const { zernioClient } = await import('@/lib/zernio/client');
      const { getCachedZernioReviewPage } = await import('../zernio-publisher');
      (getCachedZernioReviewPage as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('redis down'),
      );
      (zernioClient.listAllReviews as ReturnType<typeof vi.fn>).mockResolvedValue([makeZernioReview()]);

      await adapter.findReply(LOCATOR);

      expect(zernioClient.listAllReviews).toHaveBeenCalledWith('acct1', {
        locationId: 'loc1',
        pageSize: 50,
        maxPages: 4,
      });
    });

    it('propagates a feed-fetch error so the worker can classify it', async () => {
      const { zernioClient } = await import('@/lib/zernio/client');
      const { getCachedZernioReviewPage } = await import('../zernio-publisher');
      (getCachedZernioReviewPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (zernioClient.listAllReviews as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ZernioTransientError('upstream_5xx', {}),
      );

      await expect(adapter.findReply(LOCATOR)).rejects.toBeInstanceOf(ZernioTransientError);
    });
  });
});
