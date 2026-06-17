import { getJson } from 'serpapi';
import type { NormalizedReview, ReviewSource } from './types';
import { normalizeSerpApiReview } from './serpapi-normalize';

const DEFAULT_COUNT = 10;
const MAX_COUNT = 15;

// Bounded outbound timeout for SerpAPI (the client defaults to 60s). Kept under
// the 25s worker shutdown grace window so a stuck request fails fast inside the
// concurrency-1 queue slot instead of stalling the queue and blocking drain.
const SERPAPI_TIMEOUT_MS = 12_000;

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
      // Explicit bounded timeout — the serpapi client defaults to 60s, which
      // exceeds the 25s shutdown grace window and stalls the only slot on a
      // concurrency-1 worker. Fail fast so BullMQ retry/backoff handles it.
      timeout: SERPAPI_TIMEOUT_MS,
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
