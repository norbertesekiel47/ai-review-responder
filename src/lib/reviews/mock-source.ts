import type { NormalizedReview, ReviewSource } from './types';

// ── Canned review data ────────────────────────────────────────────────

const MOCK_REVIEWS: NormalizedReview[] = [
  {
    reviewerName: 'Alice Thompson',
    starRating: 5,
    reviewText:
      'Absolutely fantastic experience! The staff were incredibly helpful and the quality exceeded my expectations. Will definitely be coming back.',
    reviewDate: '2026-03-15T10:00:00Z',
    detectedLanguage: 'en',
  },
  {
    reviewerName: 'Bob Martinez',
    starRating: 1,
    reviewText:
      'Terrible service. Waited over an hour and nobody acknowledged me. My order was completely wrong and the manager was rude when I complained.',
    reviewDate: '2026-03-10T14:30:00Z',
    detectedLanguage: 'en',
  },
  {
    reviewerName: 'Carlos Ruiz',
    starRating: 4,
    reviewText:
      'Muy buen servicio, el personal fue muy amable y atento. Los productos son de buena calidad aunque el precio es un poco elevado.',
    reviewDate: '2026-03-08T09:15:00Z',
    detectedLanguage: 'es',
  },
  {
    reviewerName: 'Diana Chen',
    starRating: 3,
    reviewText: null,
    reviewDate: '2026-03-05T16:45:00Z',
    detectedLanguage: 'en',
  },
  {
    reviewerName: 'Élise Dupont',
    starRating: 5,
    reviewText:
      'Service impeccable et produits de qualité exceptionnelle. Je recommande vivement cet établissement à tous mes amis. Une expérience mémorable!',
    reviewDate: '2026-03-01T11:20:00Z',
    detectedLanguage: 'fr',
  },
  {
    reviewerName: 'Frank Wilson',
    starRating: 2,
    reviewText:
      'I had high hopes based on the reviews I read online, but my experience was quite disappointing. The product quality was mediocre at best, and when I reached out to customer service to express my concerns, I was met with indifference. The response time was unacceptably slow and the resolution offered was inadequate. For the price point, I expected much better.',
    reviewDate: '2026-02-25T13:00:00Z',
    detectedLanguage: 'en',
  },
  {
    reviewerName: 'Grace Kim',
    starRating: 5,
    reviewText: 'Love it! Perfect every time.',
    reviewDate: '2026-02-20T08:30:00Z',
    detectedLanguage: 'en',
  },
  {
    reviewerName: 'Hans Müller',
    starRating: 4,
    reviewText:
      'Sehr gute Qualität und freundlicher Service. Die Wartezeit war etwas lang, aber das Ergebnis hat sich gelohnt. Gerne wieder!',
    reviewDate: '2026-02-15T15:00:00Z',
    detectedLanguage: 'de',
  },
];

// ── Mock implementation ───────────────────────────────────────────────

export class MockReviewSource implements ReviewSource {
  async fetchReviews(
    _placeId: string,
    maxResults?: number,
  ): Promise<NormalizedReview[]> {
    await new Promise((resolve) => setTimeout(resolve, 200));

    const reviews = maxResults != null
      ? MOCK_REVIEWS.slice(0, maxResults)
      : MOCK_REVIEWS;

    return reviews;
  }
}
