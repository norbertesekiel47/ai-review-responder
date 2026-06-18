// Single owner of the sentiment→star-equivalent mapping used by the reputation
// trend chart. sentimentTrend carries AVG(sentiment_score) on a −1..1 scale
// (from lib/reviews/sentiment.ts), NOT a star series — so we map it for display
// and label the axis "star-equivalent", never presenting the raw score as a
// rating.
//
// The mapping is the exact inverse of classifySentiment, whose score is
// (clampedStar − 3) / 2; solving for star gives star = 3 + 2·score. Rating-less
// reviews already score 0 (neutral) inside the AVG, i.e. a 3.0 star-equivalent.
export function sentimentToStarEquivalent(averageScore: number): number {
  const raw = 3 + 2 * averageScore;
  return Math.min(5, Math.max(1, raw));
}
