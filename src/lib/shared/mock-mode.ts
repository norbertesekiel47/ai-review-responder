import { SerpApiMonitor } from '@/lib/reviews/serpapi-monitor';
import { MockSerpApiMonitor } from '@/lib/reviews/mock-monitor';

/**
 * Returns true when MOCK_EXTERNAL_APIS=true in the environment.
 * Workers use this to swap real API clients for mock implementations.
 */
export function isMockMode(): boolean {
  return process.env.MOCK_EXTERNAL_APIS === 'true';
}

/**
 * Returns the appropriate review monitor based on mock mode.
 * Both SerpApiMonitor and MockSerpApiMonitor expose the same
 * fetchReviews(placeId, maxResults?) → MonitorResult interface.
 */
export function getReviewMonitor(
  apiKey: string,
): SerpApiMonitor | MockSerpApiMonitor {
  if (isMockMode()) {
    return new MockSerpApiMonitor();
  }
  return new SerpApiMonitor(apiKey);
}
