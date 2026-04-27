import { getCacheRedis } from '@/lib/db/redis-cache';
import { sql } from '@/lib/db/server';
import { zernioClient } from '@/lib/zernio/client';
import { ZernioReviewNotFoundError } from '@/lib/zernio/errors';

const CACHE_TTL_SECONDS = 86_400;
const MATCH_WINDOW_MS = 86_400_000;

interface OurReviewRow {
  reviewer_name: string;
  review_date: Date;
  review_text: string | null;
  star_rating: number;
}

/**
 * Resolve our internal review id to Zernio's canonical review id.
 *
 * Per spec §4.3, our `provider_review_id` for SerpAPI-sourced reviews is a
 * synthetic SHA-256 hash that doesn't match Zernio's view of the same review.
 * We resolve the mapping at post time via a Redis-cached lookup that does a
 * field-match (displayName + rating + comment + createTime ±24h) against
 * Zernio's recent reviews.
 *
 * Reviewer-edit semantics: SerpAPI mutates `reviews.review_text` when a
 * reviewer edits their review; Zernio reflects the same edit in `comment`.
 * On first publish (cache miss) both sides see CURRENT text — match succeeds.
 * On re-publish (cache hit) the cached Zernio review id is still valid because
 * Zernio's review.id is stable across edits. No cache invalidation required.
 */
export async function lookupZernioReviewId(
  businessId: string,
  ourReviewId: string,
  accountId: string,
): Promise<string> {
  const redis = getCacheRedis();
  const cacheKey = `zernio_review_map:${businessId}:${ourReviewId}`;

  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  const [ourReview] = await sql<OurReviewRow[]>`
    SELECT reviewer_name, review_date, review_text, star_rating
    FROM reviews
    WHERE id = ${ourReviewId} AND business_id = ${businessId}
    LIMIT 1
  `;

  if (!ourReview) {
    throw new ZernioReviewNotFoundError({
      ourReviewId,
      accountId,
      reason: 'review_not_found_or_wrong_business',
    });
  }

  const zernioReviews = await zernioClient.listAllReviews(accountId, {
    pageSize: 50,
    maxPages: 4,
  });

  const ourComment = (ourReview.review_text ?? '').trim();
  const ourCreatedAtMs = new Date(ourReview.review_date).getTime();

  const match = zernioReviews.find((z) =>
    z.reviewer.displayName === ourReview.reviewer_name &&
    z.rating === ourReview.star_rating &&
    (z.comment ?? '').trim() === ourComment &&
    Math.abs(new Date(z.createTime).getTime() - ourCreatedAtMs) < MATCH_WINDOW_MS
  );

  if (!match) {
    throw new ZernioReviewNotFoundError({
      ourReviewId,
      accountId,
      candidatesChecked: zernioReviews.length,
      reason: 'no_field_match',
    });
  }

  await redis.setex(cacheKey, CACHE_TTL_SECONDS, match.id);
  return match.id;
}
