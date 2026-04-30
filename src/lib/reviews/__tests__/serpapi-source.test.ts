import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeContentHash } from '../types';
import type { NormalizedReview } from '../types';
import { detectLanguage, detectResponseLanguage } from '../detect-language';
import { extractPlaceId } from '../url-parser';

// ── Mock SerpAPI ─────────────────────────────────────────────────────

vi.mock('serpapi', () => ({
  getJson: vi.fn(),
}));

async function getJsonMock() {
  const { getJson } = await import('serpapi');
  return getJson as ReturnType<typeof vi.fn>;
}

// ── NormalizedReview shape contract ──────────────────────────────────

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'reviewerName',
  'starRating',
  'reviewText',
  'reviewDate',
  'detectedLanguage',
]);

function assertNormalizedShape(review: NormalizedReview): void {
  const keys = Object.keys(review);
  for (const key of keys) {
    expect(ALLOWED_KEYS.has(key), `unexpected field "${key}"`).toBe(true);
  }
  for (const key of ALLOWED_KEYS) {
    expect(keys.includes(key), `missing field "${key}"`).toBe(true);
  }
}

describe('NormalizedReview contract', () => {
  const review: NormalizedReview = {
    reviewerName: 'Jane Doe',
    starRating: 5,
    reviewText: 'Excellent food and great service.',
    reviewDate: '2025-01-15T12:00:00Z',
    detectedLanguage: 'en',
  };

  it('has exactly the contract fields — no extras', () => {
    assertNormalizedShape(review);
  });

  it('allows null reviewText for rating-only reviews', () => {
    const ratingOnly: NormalizedReview = { ...review, reviewText: null };
    assertNormalizedShape(ratingOnly);
    expect(ratingOnly.reviewText).toBeNull();
  });

  it('starRating is a number', () => {
    expect(typeof review.starRating).toBe('number');
  });

  it('reviewDate is a valid ISO 8601 string', () => {
    const parsed = new Date(review.reviewDate);
    expect(parsed.getTime()).not.toBeNaN();
  });
});

// ── Content hash determinism ─────────────────────────────────────────

describe('computeContentHash', () => {
  const baseReview: NormalizedReview = {
    reviewerName: 'Alice',
    starRating: 4,
    reviewText: 'Good place, will come back.',
    reviewDate: '2025-03-01T10:00:00Z',
    detectedLanguage: 'en',
  };

  it('returns the same hash for the same input', () => {
    const hash1 = computeContentHash(baseReview);
    const hash2 = computeContentHash({ ...baseReview });
    expect(hash1).toBe(hash2);
  });

  it('returns a 64-char hex string (SHA-256)', () => {
    const hash = computeContentHash(baseReview);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when starRating changes', () => {
    const altered = { ...baseReview, starRating: 2 };
    expect(computeContentHash(altered)).not.toBe(computeContentHash(baseReview));
  });

  it('changes when reviewText changes', () => {
    const altered = { ...baseReview, reviewText: 'Updated review text.' };
    expect(computeContentHash(altered)).not.toBe(computeContentHash(baseReview));
  });

  it('is stable for null reviewText', () => {
    const nullText = { ...baseReview, reviewText: null };
    const hash1 = computeContentHash(nullText);
    const hash2 = computeContentHash(nullText);
    expect(hash1).toBe(hash2);
  });

  it('ignores non-content fields (reviewer name, date, language)', () => {
    const sameContent: NormalizedReview = {
      ...baseReview,
      reviewerName: 'Bob',
      reviewDate: '2025-06-01T00:00:00Z',
      detectedLanguage: 'fr',
    };
    expect(computeContentHash(sameContent)).toBe(computeContentHash(baseReview));
  });
});

// ── Language detection ───────────────────────────────────────────────

describe('detectLanguage', () => {
  it('returns "en" for null text', () => {
    expect(detectLanguage(null)).toBe('en');
  });

  it('returns "en" for empty string', () => {
    expect(detectLanguage('')).toBe('en');
  });

  it('returns "en" for short text (<20 words)', () => {
    expect(detectLanguage('Great food, friendly staff')).toBe('en');
  });

  it('always returns a 2-character ISO 639-1 code', () => {
    const longEnglish =
      'The food was absolutely wonderful and the service was top notch. ' +
      'We had a great time dining here with our family and friends. ' +
      'The atmosphere was cozy and inviting, and the staff were incredibly attentive.';
    const code = detectLanguage(longEnglish);
    expect(code).toMatch(/^[a-z]{2}$/);
  });

  it('detects Spanish from sufficiently long text', () => {
    const spanish =
      'La comida fue absolutamente maravillosa y el servicio fue de primera clase. ' +
      'Pasamos un gran rato cenando aquí con nuestra familia y amigos. ' +
      'El ambiente era acogedor y atractivo, y el personal fue increíblemente atento.';
    expect(detectLanguage(spanish)).toBe('es');
  });

  it('detects German from sufficiently long text', () => {
    const german =
      'Das Essen war absolut wunderbar und der Service war erstklassig. ' +
      'Wir hatten eine tolle Zeit beim Abendessen hier mit unserer Familie und Freunden. ' +
      'Die Atmosphäre war gemütlich und einladend, und das Personal war unglaublich aufmerksam.';
    expect(detectLanguage(german)).toBe('de');
  });
});

// ── Response language detection (no word count guard) ────────────────

describe('detectResponseLanguage', () => {
  it('detects Spanish from a short response', () => {
    expect(detectResponseLanguage('Muchas gracias por su amable reseña, Maria!')).toBe('es');
  });

  it('detects French from a short response', () => {
    expect(detectResponseLanguage('Merci beaucoup pour votre avis, nous apprécions!')).toBe('fr');
  });

  it('returns "en" for empty string', () => {
    expect(detectResponseLanguage('')).toBe('en');
  });

  it('does NOT default short non-English text to "en"', () => {
    // detectLanguage would return 'en' for this (<20 words),
    // but detectResponseLanguage should attempt detection
    const shortSpanish = 'Gracias por visitarnos, esperamos verle pronto de nuevo';
    const result = detectResponseLanguage(shortSpanish);
    expect(result).not.toBe('en');
  });
});

// ── URL parser ───────────────────────────────────────────────────────

describe('extractPlaceId', () => {
  it('extracts raw Place ID', () => {
    expect(extractPlaceId('ChIJN1t_tDeuEmsRUsoyG83frY4')).toBe(
      'ChIJN1t_tDeuEmsRUsoyG83frY4',
    );
  });

  it('extracts from ?q=place_id: param', () => {
    const url =
      'https://www.google.com/maps/place/?q=place_id:ChIJN1t_tDeuEmsRUsoyG83frY4';
    expect(extractPlaceId(url)).toBe('ChIJN1t_tDeuEmsRUsoyG83frY4');
  });

  it('extracts from ?placeid= param (write review URL)', () => {
    const url =
      'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4';
    expect(extractPlaceId(url)).toBe('ChIJN1t_tDeuEmsRUsoyG83frY4');
  });

  it('returns null for CID URLs (CID ≠ Place ID)', () => {
    const url = 'https://www.google.com/maps?cid=12345678901234567';
    expect(extractPlaceId(url)).toBeNull();
  });

  it('extracts from data parameter in full URL', () => {
    const url =
      'https://www.google.com/maps/place/Some+Place/@-33.8,151.2,17z/data=!3m1!4b1!4m5!3m4!1s0x0:0x0!8m2!1sChIJN1t_tDeuEmsRUsoyG83frY4';
    expect(extractPlaceId(url)).toBe('ChIJN1t_tDeuEmsRUsoyG83frY4');
  });

  it('returns null for empty input', () => {
    expect(extractPlaceId('')).toBeNull();
  });

  it('returns null for unrecognized URL', () => {
    expect(extractPlaceId('https://example.com/some-page')).toBeNull();
  });
});

// ── SerpApiSource adapter normalization ──────────────────────────────

describe('SerpApiSource.fetchReviews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const FAKE_SERPAPI_RESPONSE = {
    reviews: [
      {
        review_id: 'abc123',
        user: {
          name: 'Maria Garcia',
          link: 'https://www.google.com/maps/contrib/12345',
          thumbnail: 'https://lh3.googleusercontent.com/photo.jpg',
          local_guide: true,
          reviews: 42,
          photos: 10,
        },
        rating: 5,
        date: '3 months ago',
        iso_date: '2025-01-10T14:30:00Z',
        snippet: 'Translated: Great food',
        extracted_snippet: { original: 'Excelente comida', translated: 'Great food' },
        likes: 3,
        link: 'https://www.google.com/maps/reviews/data=xxx',
        position: 1,
        source: 'Google',
      },
      {
        review_id: 'def456',
        user: { name: 'John Smith', link: 'https://www.google.com/maps/contrib/67890' },
        rating: 3,
        date: '1 week ago',
        iso_date: '2025-03-25T09:00:00Z',
        snippet: null,
        likes: 0,
        position: 2,
      },
    ],
    search_metadata: { id: 'search_xxx', status: 'Success' },
    search_parameters: { engine: 'google_maps_reviews' },
    place_info: { title: 'Test Restaurant', address: '123 Main St' },
  };

  it('normalizes to exactly NormalizedReview fields — no SerpAPI leakage', async () => {
    const mock = await getJsonMock();
    mock.mockResolvedValueOnce(FAKE_SERPAPI_RESPONSE);

    const { SerpApiSource } = await import('../serpapi-source');
    const source = new SerpApiSource('fake-key');
    const reviews = await source.fetchReviews('ChIJtest123456789012345');

    expect(reviews).toHaveLength(2);
    for (const review of reviews) {
      assertNormalizedShape(review);
    }
  });

  it('prefers extracted_snippet.original over snippet', async () => {
    const mock = await getJsonMock();
    mock.mockResolvedValueOnce(FAKE_SERPAPI_RESPONSE);

    const { SerpApiSource } = await import('../serpapi-source');
    const source = new SerpApiSource('fake-key');
    const reviews = await source.fetchReviews('ChIJtest123456789012345');

    expect(reviews[0]?.reviewText).toBe('Excelente comida');
  });

  it('returns null reviewText when snippet is missing', async () => {
    const mock = await getJsonMock();
    mock.mockResolvedValueOnce(FAKE_SERPAPI_RESPONSE);

    const { SerpApiSource } = await import('../serpapi-source');
    const source = new SerpApiSource('fake-key');
    const reviews = await source.fetchReviews('ChIJtest123456789012345');

    expect(reviews[1]?.reviewText).toBeNull();
  });

  it('maps rating to starRating and iso_date to reviewDate', async () => {
    const mock = await getJsonMock();
    mock.mockResolvedValueOnce(FAKE_SERPAPI_RESPONSE);

    const { SerpApiSource } = await import('../serpapi-source');
    const source = new SerpApiSource('fake-key');
    const reviews = await source.fetchReviews('ChIJtest123456789012345');

    expect(reviews[0]?.starRating).toBe(5);
    expect(reviews[0]?.reviewDate).toBe('2025-01-10T14:30:00Z');
    expect(reviews[1]?.starRating).toBe(3);
  });

  it('falls back to "Anonymous" when user.name is missing', async () => {
    const mock = await getJsonMock();
    mock.mockResolvedValueOnce({
      reviews: [
        { rating: 1, iso_date: '2025-04-01T00:00:00Z', snippet: 'Bad' },
      ],
    });

    const { SerpApiSource } = await import('../serpapi-source');
    const source = new SerpApiSource('fake-key');
    const reviews = await source.fetchReviews('ChIJtest123456789012345');

    expect(reviews[0]?.reviewerName).toBe('Anonymous');
  });

  it('throws on SerpAPI error payload instead of returning empty', async () => {
    const mock = await getJsonMock();
    mock.mockResolvedValueOnce({
      error: 'Your API key is invalid or has been suspended.',
    });

    const { SerpApiSource } = await import('../serpapi-source');
    const source = new SerpApiSource('fake-key');

    await expect(
      source.fetchReviews('ChIJtest123456789012345'),
    ).rejects.toThrow('SerpAPI error');
  });

  it('throws when SerpAPI review is missing rating', async () => {
    const mock = await getJsonMock();
    mock.mockResolvedValueOnce({
      reviews: [{ user: { name: 'Test' }, iso_date: '2025-01-01T00:00:00Z', snippet: 'OK' }],
    });

    const { SerpApiSource } = await import('../serpapi-source');
    const source = new SerpApiSource('fake-key');

    await expect(
      source.fetchReviews('ChIJtest123456789012345'),
    ).rejects.toThrow('invalid or missing rating');
  });

  it('throws when SerpAPI review is missing iso_date', async () => {
    const mock = await getJsonMock();
    mock.mockResolvedValueOnce({
      reviews: [{ user: { name: 'Test' }, rating: 5, snippet: 'Great' }],
    });

    const { SerpApiSource } = await import('../serpapi-source');
    const source = new SerpApiSource('fake-key');

    await expect(
      source.fetchReviews('ChIJtest123456789012345'),
    ).rejects.toThrow('invalid or missing iso_date');
  });
});

// SerpApiMonitor adapter tests removed — serpapi-monitor.ts deleted in Task 23.
// The monitor was only used by ReviewSyncWorker (also deleted). SerpApiSource
// is still used by DemoGenerationWorker and its tests remain above.
