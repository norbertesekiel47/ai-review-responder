import { createHash } from 'node:crypto';
import { MockReviewSource } from './mock-source';
import { computeContentHash } from './types';
import type {
  MonitorResult,
  MonitoredReview,
  ReviewIdentity,
} from './types';

/**
 * Mock implementation of SerpApiMonitor for local development.
 * Same interface: fetchReviews(placeId, maxResults?) → MonitorResult.
 *
 * Reuses canned reviews from MockReviewSource and enriches each with
 * identity fields consistent with the real SerpApiMonitor's
 * name_date_hash strategy.
 */
export class MockSerpApiMonitor {
  private readonly source = new MockReviewSource();

  async fetchReviews(
    placeId: string,
    maxResults: number = 10,
  ): Promise<MonitorResult> {
    const reviews = await this.source.fetchReviews(placeId, maxResults);

    const monitored: MonitoredReview[] = reviews.map((review) => {
      const identity = buildMockIdentity(review.reviewerName, review.reviewDate, placeId);
      const contentHash = computeContentHash(review);
      return { review, identity, contentHash };
    });

    return { reviews: monitored, collisions: [] };
  }
}

function buildMockIdentity(
  reviewerName: string,
  reviewDate: string,
  placeId: string,
): ReviewIdentity {
  const input = `${reviewerName}|${reviewDate}`;
  const providerReviewId = createHash('sha256').update(input).digest('hex');

  return {
    provider: 'serpapi_poll',
    providerReviewId,
    providerReviewName: `serpapi://${placeId}/reviews/${providerReviewId}`,
    providerLocationName: `serpapi://${placeId}`,
    identityStrategy: 'name_date_hash',
  };
}
