import type { Sql } from 'postgres';
import { fetchSerpApiReviews } from '../../../src/lib/demos/fetch-reviews';
import { getFallbackDemo } from '../../../src/lib/demos/fallback-content';
import { generateResponsesForReviews } from '../../../src/lib/demos/generate-responses';
import { selectQualifyingReviews } from '../../../src/lib/demos/select-qualifying';
import type { GenerationResult } from '../../../src/lib/responses/types';
import type { NormalizedReview } from '../../../src/lib/reviews/types';

export interface OnboardingDemoSourceResult {
  result: {
    reviews: NormalizedReview[];
    responses: (GenerationResult | null)[];
    metadata: { totalCostUsd: number };
  };
  source: 'serpapi' | 'curated_fallback';
}

export async function buildOnboardingDemoSource(sql: Sql, input: {
  demoId: string;
  googlePlaceId: string;
  businessName: string;
  category?: string;
  logger: { warn(message: string): void };
}): Promise<OnboardingDemoSourceResult> {
  // SerpAPI fetch + review-selection failures should NOT fail the demo —
  // the spec calls for graceful degradation to curated fallback so the user
  // still sees something compelling and the paywall stays in front of them.
  // Hard failure is reserved for downstream stages: invalid place resolution
  // and total LLM provider failure (caught by the worker's outer catch).
  let selected: NormalizedReview[] = [];
  let serpapiOk = true;
  try {
    const reviews = await fetchSerpApiReviews(input.googlePlaceId);
    selected = selectQualifyingReviews(reviews, { rule: 'positive-with-moderate-tail' });
  } catch (serpErr) {
    serpapiOk = false;
    input.logger.warn(
      `SerpAPI fetch failed for demo ${input.demoId}; falling back to curated content: ${serpErr instanceof Error ? serpErr.message : serpErr}`,
    );
  }

  const hasAnchor = selected.some((r) => r.starRating >= 4);
  if (serpapiOk && hasAnchor) {
    const result = await generateResponsesForReviews(sql, selected, {
      name: input.businessName,
      category: input.category ?? null,
    });
    return { result, source: 'serpapi' };
  }

  const fallback = getFallbackDemo(input.category ?? null);
  return {
    result: {
      reviews: fallback.reviews,
      responses: fallback.responses,
      metadata: { totalCostUsd: 0 },
    },
    source: 'curated_fallback',
  };
}
