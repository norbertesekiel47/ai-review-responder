// Deterministic review sentiment (v1). Star-rating driven so the SQL backfill
// in migration 052 and this ingest-path classifier produce identical results.
// `source` is recorded on reviews.sentiment_source; a later text/LLM classifier
// can supersede this with a new source tag and no schema change.

export type SentimentLabel = 'positive' | 'neutral' | 'negative';

export interface SentimentClassification {
  /** -1 (most negative) .. 1 (most positive). */
  score: number;
  label: SentimentLabel;
  source: string;
}

export const SENTIMENT_SOURCE = 'deterministic_star_v1';

/**
 * Classify a review from its star rating. A null rating (rating-less review)
 * is treated as neutral. Ratings outside 1..5 are clamped.
 */
export function classifySentiment(
  starRating: number | null,
): SentimentClassification {
  if (starRating == null) {
    return { score: 0, label: 'neutral', source: SENTIMENT_SOURCE };
  }

  const clamped = Math.min(Math.max(starRating, 1), 5);
  const score = (clamped - 3) / 2;
  const label: SentimentLabel =
    clamped >= 4 ? 'positive' : clamped <= 2 ? 'negative' : 'neutral';

  return { score, label, source: SENTIMENT_SOURCE };
}
