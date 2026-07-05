// tests/llm-eval/live-runner.ts
//
// Optional live eval path. Imported dynamically by run.ts only when --live is
// passed, so the offline path never loads the generator's heavy deps and never
// needs provider keys.
import { sql } from '../../src/lib/db/server';
import { generateResponse } from '../../src/lib/responses/generator';
import type { NormalizedReview } from '../../src/lib/reviews/types';
import type { EvalRow } from './types';

/** Live eval needs a real provider; fail loudly rather than silently no-op. */
export function assertLiveKeysPresent(): void {
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'Live eval requires OPENAI_API_KEY or ANTHROPIC_API_KEY. ' +
        'Run `pnpm eval:llm` without --live for keyless offline scoring.',
    );
  }
}

/** Returns a generator that produces a candidate by calling the real LLM in demo mode. */
export function createLiveGenerator(): (row: EvalRow) => Promise<string> {
  assertLiveKeysPresent();

  return async (row: EvalRow): Promise<string> => {
    const review: NormalizedReview = {
      reviewerName: row.input.reviewerName,
      starRating: row.input.starRating,
      reviewText: row.input.reviewText,
      reviewDate: row.input.reviewDate,
      detectedLanguage: row.input.detectedLanguage,
    };
    const result = await generateResponse(
      sql,
      review,
      { name: row.input.businessName, category: row.input.businessCategory },
      [],
      { mode: 'demo' },
    );
    return result.responseText;
  };
}
