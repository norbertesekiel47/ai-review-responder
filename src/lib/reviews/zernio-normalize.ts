// src/lib/reviews/zernio-normalize.ts
//
// Normalizes Zernio review payloads into the project's MonitoredReview /
// NormalizedReview shape. Mirrors the per-review isolation pattern from
// serpapi-monitor.ts so a single malformed review can't abort a batch.
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

  const reviewerName = (z.reviewer?.displayName ?? '').trim() || 'Anonymous';
  const reviewText = (z.comment ?? '').trim() || null;

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
      identityStrategy: 'zernio_id',
    },
    contentHash: computeContentHash(review),
  };
}

/**
 * Extract the location id from Zernio's `review.name` field.
 * Format: `accounts/{accountId}/locations/{locationId}/reviews/{reviewId}`.
 * Returns null on any deviation — caller MUST treat null as fail-closed
 * per spec §6.3 (do NOT process a review whose location can't be parsed,
 * since fan-out across same-account-multi-location businesses would route
 * it to every business otherwise).
 */
export function extractLocationFromReviewName(name: string): string | null {
  if (typeof name !== 'string' || !name) return null;
  const m = name.match(/^accounts\/[^/]+\/locations\/([^/]+)\/reviews\/.+$/);
  return m && m[1] ? m[1] : null;
}
