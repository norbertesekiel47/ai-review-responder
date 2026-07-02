import { createHash } from 'node:crypto';

// ── Core DTOs ────────────────────────────────────────────────────────

export interface NormalizedReview {
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  /** ISO 8601 date string */
  reviewDate: string;
  /** ISO 639-1 language code */
  detectedLanguage: string;
}

// ── ReviewSource contract ────────────────────────────────────────────
// All review sources (SerpAPI, manual paste, future GBP API) implement this.

export interface ReviewSource {
  fetchReviews(
    placeId: string,
    maxResults?: number,
  ): Promise<NormalizedReview[]>;
}

// ── Content hashing (edit detection) ─────────────────────────────────

export type ContentHashable = NormalizedReview;

/**
 * Deterministic hash for detecting review edits.
 * Used for mutable-content comparison, NOT for identity.
 */
export function computeContentHash(review: ContentHashable): string {
  const input = `${review.starRating}|${review.reviewText}`;
  return createHash('sha256').update(input).digest('hex');
}

// ── Monitor types (production polling) ───────────────────────────────

export interface ReviewIdentity {
  provider: 'serpapi_poll' | 'zernio';
  providerReviewId: string;
  providerReviewName: string;
  providerLocationName: string;
  /**
   * Google-native review resource name (`accounts/{a}/locations/{l}/reviews/{r}`)
   * when the source payload carries one; null otherwise. NOT part of dedup
   * identity — persisted so a future direct-GBP posting adapter can address
   * the review without a Zernio round-trip.
   */
  googleReviewName: string | null;
  identityStrategy: 'source_id' | 'profile_hash' | 'name_date_hash' | 'zernio_id';
}

export interface MonitoredReview {
  review: NormalizedReview;
  identity: ReviewIdentity;
  contentHash: string;
}
