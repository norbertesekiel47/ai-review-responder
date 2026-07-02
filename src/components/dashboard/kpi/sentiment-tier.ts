// UI mapping from the domain sentiment rule to the dashboard's visual tier.
// The star thresholds live in EXACTLY ONE place — classifySentiment
// (src/lib/reviews/sentiment.ts). This module only names the visual tiers.
import { classifySentiment, type SentimentLabel } from '@/lib/reviews/sentiment';

export type SentimentTier = 'good' | 'mid' | 'low';

export const TIER_BY_SENTIMENT: Record<SentimentLabel, SentimentTier> = {
  positive: 'good',
  neutral: 'mid',
  negative: 'low',
};

export function tierForStars(stars: number): SentimentTier {
  return TIER_BY_SENTIMENT[classifySentiment(stars).label];
}
