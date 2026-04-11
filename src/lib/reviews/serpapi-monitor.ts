import { createHash } from 'node:crypto';
import { getJson } from 'serpapi';
import type {
  ReviewIdentity,
  MonitoredReview,
  IdentityCollision,
  MonitorResult,
} from './types';
import { computeContentHash } from './types';
import { normalizeSerpApiReview } from './serpapi-normalize';

const DEFAULT_COUNT = 10;
const MAX_COUNT = 20;

// Reviewer names that are collision-prone when used in fallback hashing
const AMBIGUOUS_NAMES = new Set(['', 'a google user', 'anonymous']);

/**
 * Production-mode review fetcher for SerpAPI polling.
 *
 * Same SerpAPI call as SerpApiSource, but enriches each review with:
 * - identity fields (provider_review_id, resource names)
 * - content hash (for edit detection)
 * - intra-batch collision detection
 *
 * The actual DB dedup + exception writes happen in ReviewSyncWorker.
 * This module only computes the metadata.
 */
export class SerpApiMonitor {
  constructor(private readonly apiKey: string) {}

  async fetchReviews(
    placeId: string,
    maxResults: number = DEFAULT_COUNT,
  ): Promise<MonitorResult> {
    const count = Math.min(Math.max(maxResults, 1), MAX_COUNT);

    // SerpAPI's initial page always returns 8 results and rejects the `num`
    // parameter unless `next_page_token` is also set. Only pass `num` if we
    // need fewer than 8 (to save quota); otherwise omit it.
    const params: Record<string, unknown> = {
      engine: 'google_maps_reviews',
      place_id: placeId,
      sort_by: 'newestFirst',
      api_key: this.apiKey,
    };

    const response = await getJson(params);

    if (response.error) {
      const errorMsg = typeof response.error === 'string'
        ? response.error
        : JSON.stringify(response.error);
      throw new Error(`SerpAPI error: ${errorMsg}`);
    }

    const rawReviews: Record<string, unknown>[] = response.reviews ?? [];
    return this.processReviews(rawReviews.slice(0, count), placeId);
  }

  private processReviews(
    rawReviews: Record<string, unknown>[],
    placeId: string,
  ): MonitorResult {
    const reviews: MonitoredReview[] = [];
    const collisions: IdentityCollision[] = [];
    const seenIdentities = new Map<string, string>(); // providerReviewId → contentHash

    for (const raw of rawReviews) {
      const review = normalizeSerpApiReview(raw);
      const identity = buildIdentity(raw, placeId);
      const contentHash = computeContentHash(review);

      const existingHash = seenIdentities.get(identity.providerReviewId);

      if (existingHash !== undefined) {
        if (existingHash !== contentHash) {
          collisions.push({
            review,
            identity,
            contentHash,
            collidesWithContentHash: existingHash,
          });
        }
        // Same identity + same content = true duplicate within batch, skip
        continue;
      }

      seenIdentities.set(identity.providerReviewId, contentHash);
      reviews.push({ review, identity, contentHash });
    }

    return { reviews, collisions };
  }
}

// ── Identity computation ─────────────────────────────────────────────

function buildIdentity(
  raw: Record<string, unknown>,
  placeId: string,
): ReviewIdentity {
  const user = (raw.user ?? {}) as Record<string, unknown>;
  const reviewerName = (user.name as string) ?? '';
  const reviewerProfileUrl = (user.link as string) ?? '';
  const reviewDate = (raw.iso_date as string) ?? '';

  let providerReviewId: string;
  let identityStrategy: ReviewIdentity['identityStrategy'];

  // PREFERRED: SerpAPI provides a review_id
  if (typeof raw.review_id === 'string' && raw.review_id.length > 0) {
    providerReviewId = raw.review_id;
    identityStrategy = 'source_id';
  }
  // FALLBACK: hash name + date + profile URL for disambiguation
  else if (reviewerProfileUrl.length > 0) {
    const input = `${reviewerName}|${reviewDate}|${reviewerProfileUrl}`;
    providerReviewId = sha256(input);
    identityStrategy = 'profile_hash';
    warnIfAmbiguousName(reviewerName, reviewDate);
  }
  // LAST RESORT: hash name + date only — collision-prone
  else {
    const input = `${reviewerName}|${reviewDate}`;
    providerReviewId = sha256(input);
    identityStrategy = 'name_date_hash';
    warnIfAmbiguousName(reviewerName, reviewDate);
  }

  return {
    provider: 'serpapi_poll',
    providerReviewId,
    providerReviewName: `serpapi://${placeId}/reviews/${providerReviewId}`,
    providerLocationName: `serpapi://${placeId}`,
    identityStrategy,
  };
}

function warnIfAmbiguousName(name: string, date: string): void {
  if (AMBIGUOUS_NAMES.has(name.toLowerCase().trim())) {
    console.warn(
      `[serpapi-monitor] Collision-prone identity: reviewer name is "${name || '(empty)'}" on ${date}. ` +
        'No stable review_id or profile URL available.',
    );
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
