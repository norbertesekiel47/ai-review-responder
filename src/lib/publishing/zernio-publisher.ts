import { v7 as uuidv7 } from 'uuid';
import { getCacheRedis } from '@/lib/db/redis-cache';
import { jsonb, sql } from '@/lib/db/server';
import { zernioClient } from '@/lib/zernio/client';
import { ZernioReviewNotFoundError } from '@/lib/zernio/errors';
import { fromZernioReview, matchesLocalRow } from '@/lib/reviews/zernio-field-match';
import type { SendOwnerEmailPayload } from '@/lib/shared/worker-types';

const CACHE_TTL_SECONDS = 86_400;

interface OurReviewRowExpanded {
  reviewer_name: string;
  review_date: Date;
  review_text: string | null;
  star_rating: number;
  provider: string;
  provider_review_id: string | null;
  provider_location_name: string | null;
}

/**
 * Resolve our internal review id to Zernio's canonical review id.
 *
 * Per spec §4.3, our `provider_review_id` for SerpAPI-sourced reviews is a
 * synthetic SHA-256 hash that doesn't match Zernio's view of the same review.
 * We resolve the mapping at post time via a Redis-cached lookup that does a
 * field-match (displayName + rating + comment + createTime ±24h) against
 * Zernio's recent reviews.
 *
 * Reviewer-edit semantics: SerpAPI mutates `reviews.review_text` when a
 * reviewer edits their review; Zernio reflects the same edit in `comment`.
 * On first publish (cache miss) both sides see CURRENT text — match succeeds.
 * On re-publish (cache hit) the cached Zernio review id is still valid because
 * Zernio's review.id is stable across edits. No cache invalidation required.
 */
export async function lookupZernioReviewId(
  businessId: string,
  ourReviewId: string,
  accountId: string,
  locationId: string,
): Promise<string> {
  const redis = getCacheRedis();
  // Cache key is scoped by (accountId, locationId) — Zernio review IDs are
  // namespaced per account, AND a same-account location switch invalidates
  // any prior mapping (mapping points at the OLD location's review id;
  // postReply against the new location would 404). Reconnects to a
  // different account also wipe via the accountId scope.
  const cacheKey = `zernio_review_map:${accountId}:${locationId}:${businessId}:${ourReviewId}`;

  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  const [ourReview] = await sql<OurReviewRowExpanded[]>`
    SELECT reviewer_name, review_date, review_text, star_rating,
           provider, provider_review_id, provider_location_name
    FROM reviews
    WHERE id = ${ourReviewId} AND business_id = ${businessId}
    LIMIT 1
  `;

  if (!ourReview) {
    throw new ZernioReviewNotFoundError({
      ourReviewId,
      accountId,
      reason: 'review_not_found_or_wrong_business',
    });
  }

  // Early-return for Zernio-sourced rows: provider_review_id IS canonical.
  // REQUIRE EXACT location match — same-account different-location row is
  // NOT safe to short-circuit (would target the wrong GBP location). Round-2 M4.
  if (ourReview.provider === 'zernio') {
    const expectedLocationName = `zernio://${accountId}/locations/${locationId}`;
    if (
      ourReview.provider_location_name === expectedLocationName &&
      ourReview.provider_review_id !== null
    ) {
      await redis.setex(cacheKey, CACHE_TTL_SECONDS, ourReview.provider_review_id);
      return ourReview.provider_review_id;
    }
    // provider says zernio but location MISMATCH — fall through to field-match
    // below (which will throw ReviewNotFoundError if it can't reconcile).
  }

  // Walk pages manually (rather than listAllReviews) so we can record WHICH
  // page the match was found on. The page index is cached separately for the
  // 409 verifier (Critical 1) so it doesn't need to re-walk all 4 pages.
  const localRow = {
    reviewer_name: ourReview.reviewer_name,
    star_rating: ourReview.star_rating,
    review_text: ourReview.review_text,
    review_date: ourReview.review_date,
  };

  let pageToken: string | undefined;
  let foundPageIndex = -1;
  let match: import('@/lib/zernio/types').ZernioReview | undefined;
  let totalCandidates = 0;

  for (let i = 0; i < 4 && !match; i++) {
    const page = await zernioClient.listReviews(accountId, {
      locationId,
      pageSize: 50,
      pageToken,
    });
    totalCandidates += page.reviews.length;
    for (const z of page.reviews) {
      // matchesLocalRow uses the canonical field-match predicate from
      // src/lib/reviews/zernio-field-match.ts (same logic as SQL in
      // zernio-ingest-shared.ts reconcileExternallyAnsweredReview).
      if (matchesLocalRow(fromZernioReview(z), localRow)) {
        match = z;
        foundPageIndex = i;
        break;
      }
    }
    if (match || !page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }

  if (!match) {
    throw new ZernioReviewNotFoundError({
      ourReviewId,
      accountId,
      candidatesChecked: totalCandidates,
      reason: 'no_field_match',
    });
  }

  // Cache the review-id mapping.
  await redis.setex(cacheKey, CACHE_TTL_SECONDS, match.id);

  // Cache the page index so the 409 verifier can target a tighter maxPages
  // bound if this review is found on page 0 or 1 rather than always walking 4.
  const pageKey = `zernio_review_page:${accountId}:${locationId}:${match.id}`;
  await redis.setex(pageKey, CACHE_TTL_SECONDS, String(foundPageIndex));

  return match.id;
}

/**
 * Returns the 0-based page index where this Zernio review was found during
 * the last lookupZernioReviewId walk, or null if the cache has expired or the
 * review was found via the early-return path (Zernio-sourced provider rows
 * don't walk pages).
 *
 * Used by the 409 verifier to bound listAllReviews to a tighter maxPages value
 * when we know the review lives on page 0 or 1.
 */
export async function getCachedZernioReviewPage(
  accountId: string,
  locationId: string,
  zernioReviewId: string,
): Promise<number | null> {
  const redis = getCacheRedis();
  const pageKey = `zernio_review_page:${accountId}:${locationId}:${zernioReviewId}`;
  const cached = await redis.get(pageKey);
  if (cached === null) return null;
  const parsed = parseInt(cached, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * BullMQ retry-exhaustion fallback for the response publisher (spec §4.4).
 *
 * Mirrors the in-worker auth-error path (spec §4.2): mark the active Zernio
 * connection disconnected with reason `auth_error_on_post`, transition the
 * affected response to `awaiting_owner_connect`, and enqueue both notify
 * outbox rows (reconnect + connection-lost) — but only if the response was
 * still in a non-terminal status. The status guard is critical: a parallel
 * worker may have already posted/failed/superseded the row.
 *
 * Lives here (not in the worker) so the same single-tx mutation block is
 * reused by both the in-worker auth-error path and the BullMQ onFailed
 * graceful-degradation path. No duplication.
 */
export async function applyTransientExhaustionFallback(args: {
  response_id: string;
  business_id: string;
  /** REQUIRED — every code path now wraps transient throws in
   *  PublisherTransientWithContext, so the failed-hook always has the
   *  attempt's account/location available. The previous un-pinned legacy
   *  fallback was deleted: a missing account+location would silently
   *  disconnect EVERY active connection at the business, which is
   *  catastrophic when a business has multiple Zernio connections. */
  account_id: string;
  location_id: string;
  correlation_id?: string;
}): Promise<void> {
  const {
    response_id: responseId,
    business_id: businessId,
    account_id: accountId,
    location_id: locationId,
  } = args;

  await sql.begin(async (tx) => {
    // Order matters: response transition FIRST. If the response is already
    // terminal (posted/failed/superseded by a parallel worker), we don't
    // want to disconnect the connection — the connection might still be
    // healthy from the perspective of every other queued response. The
    // connection-disconnect is only justified when we still own a response
    // that needs to be parked.
    const updated = await tx`
      UPDATE responses
      SET status = 'awaiting_owner_connect', updated_at = NOW()
      WHERE id = ${responseId}
        AND business_id = ${businessId}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect') -- status-audit-ignore: state-transition UPDATE guard, intentionally inline per response-status.ts header
      RETURNING 1
    `;

    if (updated.count === 0) {
      // Response already terminal (posted/failed/superseded). Skip both the
      // connection-disconnect AND the notify enqueues — neither is justified
      // by the row we hold.
      return;
    }

    await tx`
      UPDATE zernio_connections
      SET status = 'disconnected',
          disconnected_at = NOW(),
          disconnect_reason = 'auth_error_on_post',
          last_error = 'BullMQ retries exhausted',
          last_error_at = NOW()
      WHERE business_id = ${businessId}
        AND zernio_account_id = ${accountId}
        AND zernio_location_id = ${locationId}
        AND status = 'active'
    `;

    const reconnectPayload = {
      kind: 'reconnect_required',
      response_id: responseId,
      business_id: businessId,
    } satisfies SendOwnerEmailPayload;
    const lostPayload = {
      kind: 'connection_lost',
      business_id: businessId,
    } satisfies SendOwnerEmailPayload;

    await tx`
      INSERT INTO job_outbox (
        id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
      ) VALUES
        (
          ${uuidv7()},
          'notify_owner_reconnect',
          'response',
          ${responseId},
          ${jsonb(reconnectPayload)},
          0,
          5
        ),
        (
          ${uuidv7()},
          'notify_owner_connection_lost',
          'business',
          ${businessId},
          ${jsonb(lostPayload)},
          0,
          5
        )
    `;
  });
}
