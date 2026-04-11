import type { NormalizedReview } from './types';
import { detectLanguage } from './detect-language';

/**
 * Normalizes a raw SerpAPI review object into the NormalizedReview DTO.
 * Shared by both SerpApiSource (demo) and SerpApiMonitor (production).
 *
 * Validates required fields and strips ALL SerpAPI-specific fields.
 * Throws if the raw object is missing rating or iso_date.
 */
export function normalizeSerpApiReview(
  raw: Record<string, unknown>,
): NormalizedReview {
  const rating = raw.rating;
  if (typeof rating !== 'number' || rating < 1 || rating > 5) {
    throw new Error(
      `SerpAPI review has invalid or missing rating: ${JSON.stringify(rating)}`,
    );
  }

  const isoDate = raw.iso_date;
  if (typeof isoDate !== 'string' || isoDate.length === 0) {
    throw new Error(
      `SerpAPI review has invalid or missing iso_date: ${JSON.stringify(isoDate)}`,
    );
  }

  const user = (raw.user ?? {}) as Record<string, unknown>;
  const extractedSnippet = raw.extracted_snippet as
    | Record<string, unknown>
    | undefined;

  // Prefer original text over the (possibly machine-translated) snippet
  const reviewText =
    (extractedSnippet?.original as string | undefined) ??
    (raw.snippet as string | undefined) ??
    null;

  return {
    reviewerName: (user.name as string) ?? 'Anonymous',
    starRating: rating,
    reviewText,
    reviewDate: isoDate,
    detectedLanguage: detectLanguage(reviewText),
  };
}
