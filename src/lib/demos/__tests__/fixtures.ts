import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

/**
 * Typed fixture factories for demo-related tests.
 *
 * Replacing the previous `as never` casts in test files. If `NormalizedReview`
 * or `GenerationResult` gains a new required field, these factories fail at
 * compile time — catching fixture drift before it surfaces at runtime SQL
 * inserts. Per code review L2.
 */

export function makeReview(
  overrides: Partial<NormalizedReview> = {},
): NormalizedReview {
  return {
    reviewerName: 'Test Reviewer',
    starRating: 5,
    reviewText: 'Test review text',
    reviewDate: '2026-01-01T00:00:00Z',
    detectedLanguage: 'en',
    ...overrides,
  };
}

export function makeGenerationResult(
  overrides: Partial<GenerationResult> = {},
): GenerationResult {
  return {
    responseText: 'Thanks for your feedback!',
    language: 'en',
    provider: 'openai',
    model: 'gpt-4o-mini',
    usage: {
      promptTokens: 100,
      completionTokens: 50,
    },
    costUsd: 0.01,
    apiCostId: null,
    ...overrides,
  };
}
