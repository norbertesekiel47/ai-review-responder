import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: vi.fn(),
}));
vi.mock('@/lib/db/server', () => ({
  sql: vi.fn(),
  jsonb: (value: unknown) => value,
}));
vi.mock('@/lib/zernio/client', () => ({
  zernioClient: {
    listReviews: vi.fn(),
  },
}));

import { lookupZernioReviewId, getCachedZernioReviewPage } from '../zernio-publisher';

describe('lookupZernioReviewId', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns cached value on hit', async () => {
    const { getCacheRedis } = await import('@/lib/db/redis-cache');
    const setex = vi.fn();
    (getCacheRedis as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn().mockResolvedValue('cached-zernio-id'),
      setex,
    });

    const result = await lookupZernioReviewId('biz1', 'our1', 'acct1', 'loc1');

    expect(result).toBe('cached-zernio-id');
    expect(setex).not.toHaveBeenCalled();
  });

  it('throws ZernioReviewNotFoundError when our internal review row is missing', async () => {
    const { getCacheRedis } = await import('@/lib/db/redis-cache');
    const { sql } = await import('@/lib/db/server');
    (getCacheRedis as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn().mockResolvedValue(null),
      setex: vi.fn(),
    });
    (sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await expect(
      lookupZernioReviewId('biz1', 'our1', 'acct1', 'loc1'),
    ).rejects.toMatchObject({ name: 'ZernioReviewNotFoundError' });
  });

  it('matches by displayName + rating + comment + createTime within ±24h and caches', async () => {
    const { getCacheRedis } = await import('@/lib/db/redis-cache');
    const { sql } = await import('@/lib/db/server');
    const clientModule = await import('@/lib/zernio/client');

    const setex = vi.fn();
    (getCacheRedis as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn().mockResolvedValue(null),
      setex,
    });
    (sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        reviewer_name: 'Jane Doe',
        review_date: new Date('2026-04-26T12:00:00Z'),
        review_text: 'Great service',
        star_rating: 5,
      },
    ]);

    // lookupZernioReviewId now calls listReviews (paged) instead of listAllReviews.
    // The mock returns { reviews, nextPageToken } per the ZernioReview page shape.
    (clientModule.zernioClient as unknown as { listReviews: ReturnType<typeof vi.fn> }).listReviews =
      vi.fn().mockResolvedValue({
        reviews: [
          {
            id: 'zernio-other',
            name: 'accounts/acct1/locations/loc1/reviews/zernio-other',
            reviewer: { displayName: 'John', profilePhotoUrl: null, isAnonymous: false },
            rating: 4,
            starRating: 'FOUR',
            comment: 'ok',
            createTime: '2026-04-26T12:00:00Z',
            updateTime: '2026-04-26T12:00:00Z',
            reviewReply: null,
          },
          {
            id: 'zernio-match',
            name: 'accounts/acct1/locations/loc1/reviews/zernio-match',
            reviewer: { displayName: 'Jane Doe', profilePhotoUrl: null, isAnonymous: false },
            rating: 5,
            starRating: 'FIVE',
            comment: 'Great service',
            createTime: '2026-04-26T11:00:00Z',
            updateTime: '2026-04-26T11:00:00Z',
            reviewReply: null,
          },
        ],
        nextPageToken: undefined,
      });

    const result = await lookupZernioReviewId('biz1', 'our1', 'acct1', 'loc1');

    expect(result).toBe('zernio-match');
    // review-id map cache
    expect(setex).toHaveBeenCalledWith('zernio_review_map:acct1:loc1:biz1:our1', 86400, 'zernio-match');
    // page-index cache (found on page 0)
    expect(setex).toHaveBeenCalledWith('zernio_review_page:acct1:loc1:zernio-match', 86400, '0');
  });

  it('page cache write includes locationId in key and getCachedZernioReviewPage reads it back', async () => {
    const { getCacheRedis } = await import('@/lib/db/redis-cache');
    const { sql } = await import('@/lib/db/server');
    const clientModule = await import('@/lib/zernio/client');

    const store: Record<string, string> = {};
    (getCacheRedis as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn().mockImplementation((key: string) => Promise.resolve(store[key] ?? null)),
      setex: vi.fn().mockImplementation((_k: string, _ttl: number, v: string) => {
        store[_k] = v;
        return Promise.resolve();
      }),
    });
    (sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        reviewer_name: 'Bob',
        review_date: new Date('2026-04-26T12:00:00Z'),
        review_text: 'Nice',
        star_rating: 4,
      },
    ]);
    (clientModule.zernioClient as unknown as { listReviews: ReturnType<typeof vi.fn> }).listReviews =
      vi.fn().mockResolvedValue({
        reviews: [
          {
            id: 'zr-page-test',
            name: 'accounts/acctA/locations/locB/reviews/zr-page-test',
            reviewer: { displayName: 'Bob', profilePhotoUrl: null, isAnonymous: false },
            rating: 4,
            starRating: 'FOUR',
            comment: 'Nice',
            createTime: '2026-04-26T12:00:00Z',
            updateTime: '2026-04-26T12:00:00Z',
            reviewReply: null,
          },
        ],
        nextPageToken: undefined,
      });

    await lookupZernioReviewId('biz2', 'our2', 'acctA', 'locB');

    // Page key must include locationId.
    const pageKey = 'zernio_review_page:acctA:locB:zr-page-test';
    expect(store[pageKey]).toBe('0');

    // getCachedZernioReviewPage reads back the stored value.
    const pageIdx = await getCachedZernioReviewPage('acctA', 'locB', 'zr-page-test');
    expect(pageIdx).toBe(0);
  });

  it('throws ZernioReviewNotFoundError when no Zernio candidate matches', async () => {
    const { getCacheRedis } = await import('@/lib/db/redis-cache');
    const { sql } = await import('@/lib/db/server');
    const clientModule = await import('@/lib/zernio/client');

    (getCacheRedis as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn().mockResolvedValue(null),
      setex: vi.fn(),
    });
    (sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        reviewer_name: 'Jane Doe',
        review_date: new Date('2026-04-26T12:00:00Z'),
        review_text: 'X',
        star_rating: 5,
      },
    ]);
    // Reviewer name 'John' does not match 'Jane Doe'.
    (clientModule.zernioClient as unknown as { listReviews: ReturnType<typeof vi.fn> }).listReviews =
      vi.fn().mockResolvedValue({
        reviews: [
          {
            id: 'zernio-other',
            name: 'accounts/acct1/locations/loc1/reviews/zernio-other',
            reviewer: { displayName: 'John', profilePhotoUrl: null, isAnonymous: false },
            rating: 5,
            starRating: 'FIVE',
            comment: 'X',
            createTime: '2026-04-26T11:00:00Z',
            updateTime: '2026-04-26T11:00:00Z',
            reviewReply: null,
          },
        ],
        nextPageToken: undefined,
      });

    await expect(
      lookupZernioReviewId('biz1', 'our1', 'acct1', 'loc1'),
    ).rejects.toMatchObject({ name: 'ZernioReviewNotFoundError' });
  });
});
