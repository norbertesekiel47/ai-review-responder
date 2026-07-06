import type { Sql } from 'postgres';
import { generateResponse } from '@/lib/responses/generator';
import { generateMockResponse } from '@/lib/responses/mock-generator';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

const useMocks = process.env.MOCK_EXTERNAL_APIS === 'true';

export interface GenerateResponsesResult {
  reviews: NormalizedReview[];
  responses: (GenerationResult | null)[];
  metadata: {
    totalReviews: number;
    successfulResponses: number;
    failedResponses: number;
    totalCostUsd: number;
    generationDurationMs: number;
  };
}

/**
 * Generates an AI response for each review in parallel.
 *
 * Uses `generateMockResponse` when MOCK_EXTERNAL_APIS=true (env captured at
 * module-load), otherwise uses the real `generateResponse` in demo mode (no
 * cost guard, no Redis cache).
 *
 * Uses `Promise.allSettled` so a single LLM failure does not cancel other
 * in-flight calls. Rejected promises become `null` in the responses array
 * and are logged to console.error with the review index + reviewer name.
 *
 * Extracted from `generator.ts` so the worker does not need to know about
 * LLM-vs-mock selection or partial-failure handling. Behavior must remain
 * identical to the inline version it replaces.
 */
export async function generateResponsesForReviews(
  sql: Sql,
  reviews: NormalizedReview[],
  businessContext: { name: string; category: string | null },
): Promise<GenerateResponsesResult> {
  const startTime = Date.now();

  const settled = await Promise.allSettled(
    reviews.map((review) =>
      useMocks
        ? generateMockResponse(review, businessContext, [], { mode: 'demo' })
        : generateResponse(sql, review, businessContext, [], { mode: 'demo' }),
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
