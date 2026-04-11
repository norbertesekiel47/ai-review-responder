import { SerpApiSource } from '@/lib/reviews/serpapi-source';
import { MockReviewSource } from '@/lib/reviews/mock-source';
import { generateResponse } from '@/lib/responses/generator';
import { generateMockResponse } from '@/lib/responses/mock-generator';
import type { ReviewSource, NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';
import type { DemoGeneratorInput, DemoGeneratorResult } from './types';

const useMocks = process.env.MOCK_EXTERNAL_APIS === 'true';

/**
 * Core demo generation logic — called by DemoGenerationWorker on Railway.
 *
 * Fetches reviews via SerpAPI, generates an AI response for each one
 * using the LLM in demo mode (no cost guard, no Redis).
 *
 * Pure computation — does NOT write to the database.
 * The worker handles all persistence.
 */
export async function generateDemo(
  input: DemoGeneratorInput,
): Promise<DemoGeneratorResult> {
  const startTime = Date.now();

  // Fetch reviews
  const source: ReviewSource = useMocks
    ? new MockReviewSource()
    : new SerpApiSource(process.env.SERPAPI_API_KEY!);
  const reviews = await source.fetchReviews(input.placeId, 15);

  if (reviews.length === 0) {
    throw new Error('No reviews found for this business');
  }

  // Generate AI responses in parallel — partial failures are OK
  const businessContext = {
    name: input.businessName,
    category: input.category,
  };

  const generateFn = useMocks ? generateMockResponse : generateResponse;

  const settled = await Promise.allSettled(
    reviews.map((review) =>
      generateFn(review, businessContext, [], { mode: 'demo' }),
    ),
  );

  const responses: (GenerationResult | null)[] = settled.map(
    (result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      console.error(
        `[demo-generator] LLM failed for review ${index} (${reviews[index]?.reviewerName}):`,
        result.reason,
      );
      return null;
    },
  );

  const successful = responses.filter(
    (r): r is GenerationResult => r !== null,
  );

  return {
    placeId: input.placeId,
    reviews,
    responses,
    metadata: {
      totalReviews: reviews.length,
      successfulResponses: successful.length,
      failedResponses: reviews.length - successful.length,
      totalCostUsd: successful.reduce((sum, r) => sum + r.costUsd, 0),
      generationDurationMs: Date.now() - startTime,
    },
  };
}
