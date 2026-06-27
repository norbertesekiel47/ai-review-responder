// src/lib/publishing/zernio-review-publisher.ts
//
// First adapter behind the ReviewPublisher seam. It DELEGATES to the existing
// Zernio primitives (zernioClient transport + lookupZernioReviewId / the Redis
// page-cache) rather than reimplementing them — that delegation is deliberate: it
// keeps the publisher worker's existing test mocks of `zernioClient.*` /
// `lookupZernioReviewId` valid, which is the strongest guard that this seam is a
// pure refactor with zero behavior change.
//
// What this adapter OWNS (moved out of the worker): the active-connection lookup,
// the review-id resolution + Redis cache, and the page-cache bounding for the
// verify walk — all pure Zernio concerns the worker should not know about.

import { sql } from '@/lib/db/server';
import { zernioClient } from '@/lib/zernio/client';
import {
  ZernioReviewNotFoundError,
  ZernioTransientError,
  ZernioAuthError,
  ZernioPermanentError,
  ZernioValidationError,
} from '@/lib/zernio/errors';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import {
  getCachedZernioReviewPage,
  lookupZernioReviewId,
} from './zernio-publisher';
import type {
  FindReplyResult,
  ResolveTargetResult,
  ReviewLocator,
  ReviewPublisher,
  ReviewRef,
} from './review-publisher';

/** Conservative cap on the verify walk when the page cache misses (4 pages × 50). */
const MAX_VERIFY_PAGES = 4;

/**
 * Surface the raw Zernio failure of a reply post/delete to Sentry. Publish
 * failures were previously invisible: the worker's retry-exhaustion fallback
 * collapses every cause into a single `auth_error_on_post` disconnect with
 * `last_error="BullMQ retries exhausted"`, discarding the actual Zernio status +
 * body. Capturing the typed error's `status`/`body`/`kind`/`meta` here (the
 * chokepoint where the raw error is still intact) makes publish failures
 * diagnosable. Re-throws unchanged — pure observability, no behavior change.
 */
function captureZernioPublishFailure(
  op: 'publishReply' | 'deleteReply',
  err: unknown,
  locator: ReviewLocator,
): void {
  const detail: Record<string, unknown> = {
    op,
    error_name: err instanceof Error ? err.name : typeof err,
    account_id: locator.accountId,
    location_id: locator.locationId,
    provider_review_id: locator.providerReviewId,
  };
  if (err instanceof ZernioAuthError) {
    detail.status = err.status;
    detail.body = err.body;
  } else if (err instanceof ZernioPermanentError || err instanceof ZernioTransientError) {
    detail.kind = err.kind;
    detail.meta = err.meta;
  } else if (err instanceof ZernioValidationError) {
    detail.code = err.code;
    detail.body = err.body;
  }
  reportCaughtError('publishing/zernio-post-failure', err, detail);
}

interface ActiveConnectionRow {
  zernio_account_id: string;
  zernio_location_id: string;
}

export class ZernioReviewPublisher implements ReviewPublisher {
  async resolveTarget(ref: ReviewRef): Promise<ResolveTargetResult> {
    const [connection] = await sql<ActiveConnectionRow[]>`
      SELECT zernio_account_id, zernio_location_id
      FROM zernio_connections
      WHERE business_id = ${ref.businessId} AND status = 'active'
      LIMIT 1
    `;

    if (!connection) return { kind: 'no_connection' };

    const accountId = connection.zernio_account_id;
    const locationId = connection.zernio_location_id;

    try {
      const providerReviewId = await lookupZernioReviewId(
        ref.businessId,
        ref.reviewId,
        accountId,
        locationId,
      );
      return {
        kind: 'resolved',
        target: { ref, locator: { accountId, locationId, providerReviewId } },
      };
    } catch (err) {
      // Review couldn't be matched on the provider — neutral result; the worker
      // opens a review_exception (the DB write stays worker-owned).
      if (err instanceof ZernioReviewNotFoundError) {
        return { kind: 'review_not_found', meta: err.meta };
      }
      // Transient resolution failure — neutral result carrying the attempt
      // coordinates so the worker can pin the disconnect on retry exhaustion.
      if (err instanceof ZernioTransientError) {
        return { kind: 'transient', accountId, locationId, error: err };
      }
      // Auth / permanent / unknown: bubble exactly as today (worker doesn't
      // disposition these at resolution time — they fail the outbox via BullMQ).
      throw err;
    }
  }

  async publishReply(locator: ReviewLocator, replyText: string): Promise<void> {
    try {
      await zernioClient.postReply(locator.accountId, locator.providerReviewId, {
        comment: replyText,
      });
    } catch (err) {
      captureZernioPublishFailure('publishReply', err, locator);
      throw err;
    }
  }

  async deleteReply(locator: ReviewLocator): Promise<void> {
    try {
      await zernioClient.deleteReply(locator.accountId, locator.providerReviewId);
    } catch (err) {
      captureZernioPublishFailure('deleteReply', err, locator);
      throw err;
    }
  }

  async findReply(locator: ReviewLocator): Promise<FindReplyResult> {
    const maxPages = await this.resolveVerifierMaxPages(locator);

    const allReviews = await zernioClient.listAllReviews(locator.accountId, {
      locationId: locator.locationId,
      pageSize: 50,
      maxPages,
    });

    const found = allReviews.find((review) => review.id === locator.providerReviewId);
    if (!found) {
      return { kind: 'review_absent', pagesWalked: maxPages, reviewsSeen: allReviews.length };
    }

    return {
      kind: 'found',
      reply: found.reviewReply ? { comment: found.reviewReply.comment } : null,
    };
  }

  /**
   * Bound the verify walk using the page index cached by the review-id lookup: a
   * review found on page 0 or 1 avoids re-walking all pages. Cache miss / read
   * failure falls back to the conservative cap. Single owner so the post-verify
   * and 409 paths cannot drift apart.
   */
  private async resolveVerifierMaxPages(locator: ReviewLocator): Promise<number> {
    try {
      const cachedPage = await getCachedZernioReviewPage(
        locator.accountId,
        locator.locationId,
        locator.providerReviewId,
      );
      if (cachedPage !== null) return Math.min(cachedPage + 1, MAX_VERIFY_PAGES);
    } catch {
      // Non-fatal — fall back to the conservative full walk.
    }
    return MAX_VERIFY_PAGES;
  }
}
