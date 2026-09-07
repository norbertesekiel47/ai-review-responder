import type { ReputationSummary } from '@/lib/dashboard/types';

/**
 * The hero's interpretation line (Harbor redesign): the conclusion as ONE
 * deterministic sentence, stated before the numbers. Same discipline as
 * chart-headlines.ts — derived only from real windowed values, no adjectives
 * the data cannot back.
 */
export function computeHeroHeadline(summary: ReputationSummary): string {
  const { averageStar, responseRate, isRamping } = summary;

  if (isRamping) {
    return 'Your agents are on the job. The baseline is still building.';
  }

  if (averageStar.current == null) {
    return 'No new ratings in the last 30 days. Your agents are standing by.';
  }

  const rating = averageStar.current.toFixed(1);
  let ratingClause: string;
  if (averageStar.delta != null && averageStar.delta > 0) {
    ratingClause = `Your rating climbed to ${rating}`;
  } else if (averageStar.delta != null && averageStar.delta < 0) {
    ratingClause = `Your rating dipped to ${rating}`;
  } else {
    ratingClause = `Your rating held at ${rating}`;
  }

  if (responseRate.current == null) {
    return `${ratingClause} over the last 30 days.`;
  }
  return `${ratingClause} while ${responseRate.current}% of reviews got an answer.`;
}
