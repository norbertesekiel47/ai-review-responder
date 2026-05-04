import type { DemoGeneratorInput, DemoGeneratorResult } from './types';
import { fetchSerpApiReviews } from './fetch-reviews';
import { generateResponsesForReviews } from './generate-responses';

/**
 * Core demo generation logic — called by DemoGenerationWorker on Railway.
 *
 * Composition: fetch → generate. ALL fetched reviews flow through to the
 * generator (today's behavior — up to 15 reviews per prospect demo).
 *
 * NOTE: PR #1 deliberately does NOT introduce review selection on the prospect
 * path. The `selectQualifyingReviews` helper (PR #1) is for PR #2's onboarding
 * worker, which will compose `fetch → select(positive-with-moderate-tail) → generate`
 * to cap output at 3 reviews. Prospect demos retain their 15-review breadth.
 *
 * Pure computation — does NOT write to the database. The worker handles all
 * persistence.
 */
export async function generateDemo(
  input: DemoGeneratorInput,
): Promise<DemoGeneratorResult> {
  const startTime = Date.now();

  const reviews = await fetchSerpApiReviews(input.placeId);

  if (reviews.length === 0) {
    throw new Error('No reviews found for this business');
  }

  const result = await generateResponsesForReviews(reviews, {
    name: input.businessName,
    category: input.category,
  });

  // Explicit destructure (NOT spread+rebind) so a future rename of
  // `generationDurationMs` on either side fails at compile time rather than
  // silently dropping our outer measurement.
  const {
    totalReviews,
    successfulResponses,
    failedResponses,
    totalCostUsd,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- discarded by design; outer measurement covers full pipeline (fetch + generate)
    generationDurationMs: _llmOnlyDurationMs,
  } = result.metadata;

  return {
    placeId: input.placeId,
    reviews: result.reviews,
    responses: result.responses,
    metadata: {
      totalReviews,
      successfulResponses,
      failedResponses,
      totalCostUsd,
      generationDurationMs: Date.now() - startTime, // end-to-end (fetch + generate)
    },
  };
}
