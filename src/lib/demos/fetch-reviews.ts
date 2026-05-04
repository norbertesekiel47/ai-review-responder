import { SerpApiSource } from '@/lib/reviews/serpapi-source';
import { MockReviewSource } from '@/lib/reviews/mock-source';
import type { NormalizedReview, ReviewSource } from '@/lib/reviews/types';

const useMocks = process.env.MOCK_EXTERNAL_APIS === 'true';

/**
 * Fetches up to 15 reviews for a Google Place ID.
 *
 * In dev/test with MOCK_EXTERNAL_APIS=true, returns canned mock data via
 * MockReviewSource. Otherwise hits SerpAPI via SerpApiSource.
 *
 * Extracted from `generator.ts` so the worker (and any other caller) does
 * not need to know about source selection. Behavior must remain identical
 * to the inline version: env captured at module-load, max 15 results.
 */
export async function fetchSerpApiReviews(
  placeId: string,
): Promise<NormalizedReview[]> {
  const source: ReviewSource = useMocks
    ? new MockReviewSource()
    : new SerpApiSource(process.env.SERPAPI_API_KEY!);
  return source.fetchReviews(placeId, 15);
}
