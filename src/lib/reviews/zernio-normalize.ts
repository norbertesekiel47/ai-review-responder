// src/lib/reviews/zernio-normalize.ts
//
// Normalizes Zernio review payloads into the project's MonitoredReview /
// NormalizedReview shape. Isolates per-review normalization so a single
// malformed review can't abort a batch.
//
// Identity:
//   provider              = 'zernio'
//   provider_review_id    = ZernioReview.id (stable across reviewer edits)
//   provider_review_name  = 'zernio://{accountId}/locations/{locationId}/reviews/{reviewId}'
//   provider_location_name = 'zernio://{accountId}/locations/{locationId}'
//   identityStrategy      = 'zernio_id'
//
// See spec §6.2.

import { detectLanguage } from './detect-language';
import { computeContentHash } from './types';
import type { MonitoredReview, NormalizedReview } from './types';
import type { ZernioReview } from '@/lib/zernio/types';
import { sanitizeMultilineText, sanitizeReviewerName } from '@/lib/shared/sanitize';

const LOG_PREFIX = '[zernio-normalize]';

export class ZernioReviewNormalizationError extends Error {
  constructor(reason: string, readonly raw: unknown) {
    super(`${LOG_PREFIX} ${reason}`);
    this.name = 'ZernioReviewNormalizationError';
  }
}

export function zernioReviewToNormalized(z: ZernioReview): NormalizedReview {
  if (!z.id || typeof z.id !== 'string' || z.id.trim().length === 0) {
    throw new ZernioReviewNormalizationError('missing review.id', z);
  }
  if (typeof z.rating !== 'number' || z.rating < 1 || z.rating > 5) {
    throw new ZernioReviewNormalizationError(`invalid rating: ${z.rating}`, z);
  }
  if (!z.createTime || isNaN(new Date(z.createTime).getTime())) {
    throw new ZernioReviewNormalizationError(`unparseable createTime: ${z.createTime}`, z);
  }

  // Sanitize the name BEFORE the Anonymous fallback: a name of only stripped
  // chars (bidi/zero-width) is non-empty pre-sanitize but empty after, so the
  // fallback must run on the sanitized value to honor the empty-name contract.
  const cleanedName = sanitizeReviewerName(z.reviewer?.displayName ?? '');
  const reviewerName = cleanedName.length > 0 ? cleanedName : 'Anonymous';
  const cleanedComment = sanitizeMultilineText(z.comment ?? '');
  const reviewText = cleanedComment.length > 0 ? cleanedComment : null;

  const review: NormalizedReview = {
    reviewerName,
    starRating: z.rating,
    reviewText,
    reviewDate: z.createTime,
    detectedLanguage: detectLanguage(reviewText),
  };
  return review;
}

export function buildZernioMonitoredReview(
  z: ZernioReview,
  accountId: string,
  locationId: string,
): MonitoredReview {
  const review = zernioReviewToNormalized(z);
  return {
    review,
    identity: {
      provider: 'zernio',
      providerReviewId: z.id,
      providerReviewName: `zernio://${accountId}/locations/${locationId}/reviews/${z.id}`,
      providerLocationName: `zernio://${accountId}/locations/${locationId}`,
      googleReviewName: normalizeGoogleReviewName(z.name),
      identityStrategy: 'zernio_id',
    },
    contentHash: computeContentHash(review),
  };
}

// Google review resource name: `accounts/{accountId}/locations/{locationId}/reviews/{reviewId}`.
// Single authoritative pattern — both the location extractor and the
// google_review_name capture validate against it.
const GOOGLE_REVIEW_RESOURCE_RE = /^accounts\/[^/]+\/locations\/([^/]+)\/reviews\/.+$/;

/**
 * Extract the location id from Zernio's `review.name` field.
 * Returns null on any deviation — caller MUST treat null as fail-closed
 * per spec §6.3 (do NOT process a review whose location can't be parsed,
 * since fan-out across same-account-multi-location businesses would route
 * it to every business otherwise).
 */
export function extractLocationFromReviewName(name: string): string | null {
  if (typeof name !== 'string' || !name) return null;
  const m = name.match(GOOGLE_REVIEW_RESOURCE_RE);
  return m && m[1] ? m[1] : null;
}

/**
 * Validate + normalize a Google-native review resource name for persistence
 * (`reviews.google_review_name`, migration 070). Null on anything that isn't
 * the canonical `accounts/…/locations/…/reviews/…` shape — capture is
 * best-effort provenance for the future GBP posting adapter, never a reason
 * to fail ingest.
 */
export function normalizeGoogleReviewName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return GOOGLE_REVIEW_RESOURCE_RE.test(trimmed) ? trimmed : null;
}
