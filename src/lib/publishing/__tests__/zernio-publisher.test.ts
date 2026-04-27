import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/redis-cache');
vi.mock('@/lib/db/server');
vi.mock('@/lib/zernio/client');

import { lookupZernioReviewId } from '../zernio-publisher';

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

    const result = await lookupZernioReviewId('biz1', 'our1', 'acct1');

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
      lookupZernioReviewId('biz1', 'our1', 'acct1'),
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

    (clientModule.zernioClient as unknown as { listAllReviews: ReturnType<typeof vi.fn> }).listAllReviews =
      vi.fn().mockResolvedValue([
        {
          id: 'zernio-other',
          reviewer: { displayName: 'John', profilePhotoUrl: null, isAnonymous: false },
          rating: 4,
          comment: 'ok',
          createTime: '2026-04-26T12:00:00Z',
        },
        {
          id: 'zernio-match',
          reviewer: { displayName: 'Jane Doe', profilePhotoUrl: null, isAnonymous: false },
          rating: 5,
          comment: 'Great service',
          createTime: '2026-04-26T11:00:00Z',
        },
      ]);

    const result = await lookupZernioReviewId('biz1', 'our1', 'acct1');

    expect(result).toBe('zernio-match');
    expect(setex).toHaveBeenCalledWith('zernio_review_map:biz1:our1', 86400, 'zernio-match');
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
    (clientModule.zernioClient as unknown as { listAllReviews: ReturnType<typeof vi.fn> }).listAllReviews =
      vi.fn().mockResolvedValue([
        {
          id: 'zernio-other',
          reviewer: { displayName: 'John', profilePhotoUrl: null, isAnonymous: false },
          rating: 5,
          comment: 'X',
          createTime: '2026-04-26T11:00:00Z',
        },
      ]);

    await expect(
      lookupZernioReviewId('biz1', 'our1', 'acct1'),
    ).rejects.toMatchObject({ name: 'ZernioReviewNotFoundError' });
  });
});
