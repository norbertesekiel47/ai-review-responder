import { SerpApiSource } from '@/lib/reviews/serpapi-source';
import { MockReviewSource } from '@/lib/reviews/mock-source';
import type { NormalizedReview, ReviewSource } from '@/lib/reviews/types';

const useMocks = process.env.MOCK_EXTERNAL_APIS === 'true';
const serpApiKey = process.env.SERPAPI_API_KEY;

// Fail fast at module load when not in mock mode and the key is missing.
// Otherwise the non-null assertion below would defer the failure to first
// fetch, where it would surface as a confusing error from inside SerpApiSource.
// Tests that need this module reachable without a real key must set
// MOCK_EXTERNAL_APIS=true before importing (existing test files already do
// via vi.resetModules()).
if (!useMocks && !serpApiKey) {
  throw new Error(
    '[fetch-reviews] SERPAPI_API_KEY is required when MOCK_EXTERNAL_APIS!=true',
  );
}

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
    : new SerpApiSource(serpApiKey!);
  return source.fetchReviews(placeId, 15);
}
