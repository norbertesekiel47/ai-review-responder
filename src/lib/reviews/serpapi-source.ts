import { getJson } from 'serpapi';
import type { NormalizedReview, ReviewSource } from './types';
import { normalizeSerpApiReview } from './serpapi-normalize';

const DEFAULT_COUNT = 10;
const MAX_COUNT = 15;

/**
 * Demo-mode ReviewSource: one-shot SerpAPI fetch, no dedup, no identity tracking.
 * Used during prospect demos and the initial onboarding sync.
 */
export class SerpApiSource implements ReviewSource {
  constructor(private readonly apiKey: string) {}

  async fetchReviews(
    placeId: string,
    maxResults: number = DEFAULT_COUNT,
  ): Promise<NormalizedReview[]> {
    const count = Math.min(Math.max(maxResults, 1), MAX_COUNT);

    const params: Record<string, unknown> = {
      engine: 'google_maps_reviews',
      place_id: placeId,
      sort_by: 'newestFirst',
      api_key: this.apiKey,
    };

    const response = await getJson(params);

    if (response.error) {
      const errorMsg = typeof response.error === 'string'
        ? response.error
        : JSON.stringify(response.error);
      throw new Error(`SerpAPI error: ${errorMsg}`);
    }

    const rawReviews: Record<string, unknown>[] = response.reviews ?? [];
    return rawReviews.slice(0, count).map(normalizeSerpApiReview);
  }
}
