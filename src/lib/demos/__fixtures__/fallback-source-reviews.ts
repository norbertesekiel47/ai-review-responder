import type { NormalizedReview } from '@/lib/reviews/types';

export const fallbackReviews: NormalizedReview[] = [
  {
    reviewerName: 'Sarah M.',
    starRating: 5,
    reviewText:
      'Absolutely loved the experience here. The staff was incredibly attentive and the quality exceeded my expectations. I will definitely be coming back and recommending this place to all my friends and family.',
    reviewDate: '2026-03-15T00:00:00Z',
    detectedLanguage: 'en',
  },
  {
    reviewerName: 'James K.',
    starRating: 4,
    reviewText:
      'Great service and friendly atmosphere. Everything was well organized and the team clearly cares about their customers. Just a minor wait time, but worth it.',
    reviewDate: '2026-03-10T00:00:00Z',
    detectedLanguage: 'en',
  },
  {
    reviewerName: 'Patricia R.',
    starRating: 3,
    reviewText:
      'The service was decent but I expected a bit more given the reviews. Some aspects were good, others felt average. Might give it another try.',
    reviewDate: '2026-02-28T00:00:00Z',
    detectedLanguage: 'en',
  },
];
