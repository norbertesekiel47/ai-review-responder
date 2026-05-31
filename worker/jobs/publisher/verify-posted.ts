// worker/jobs/publisher/verify-posted.ts
//
// Post-publish verification (the missing safety check behind the staging
// 2026-05-31 false-positive: postReply returned 2xx for a review id that was
// NOT in the live GBP feed — a stale/phantom id — so the reply never reached
// Google, yet we marked the response `posted`).
//
// After postReply resolves, we re-fetch the review and confirm OUR reply text
// is actually attached before the caller marks the response `posted`. Anything
// short of "found + our reply attached" is surfaced loudly rather than trusted:
//
//   - review absent from feed   → throw indeterminate(review_not_found_after_pagination)
//   - review found, reply null   → throw indeterminate(review_found_but_reply_null)  (Zernio lag)
//   - review found, reply ≠ ours → throw indeterminate(reply_text_mismatch)
//   - the verification LIST call itself errors → throw PublisherTransientWithContext
//     so BullMQ retries; the next attempt's postReply returns 409 and routes to
//     the existing verify409AndDispose path.
//
// The indeterminate throws are handled at retry-exhaustion by the publisher
// failed-hook (handleVerificationIndeterminate): status=failed +
// review_exception + notify_admin_review_exception. No silent success.

import { zernioClient } from '../../../src/lib/zernio/client';
import { canonicalizeReplyText } from '../../../src/lib/zernio/canonicalize-reply';
import { getCachedZernioReviewPage } from '../../../src/lib/publishing/zernio-publisher';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioTransientError,
  ZernioValidationError,
} from '../../../src/lib/zernio/errors';
import {
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
} from './publisher-error-handlers';
import type { WorkerLogger } from '../../../src/lib/shared/logger';

interface VerifyOwnReplyArgs {
  responseId: string;
  businessId: string;
  reviewId: string;
  zernioReviewId: string;
  approvedText: string;
  accountId: string;
  locationId: string;
  logger: WorkerLogger;
}

/**
 * Confirm our reply is actually attached to the review on Zernio after a
 * postReply that returned 2xx. Resolves when confirmed; throws otherwise.
 *
 * Throw types are chosen so the publisher failed-hook already knows how to land
 * them: ZernioReplyVerificationIndeterminateError → failed + exception + admin
 * alert; PublisherTransientWithContext → BullMQ retry (→ next attempt 409 →
 * verify409AndDispose).
 */
export async function verifyOwnReplyAttached(args: VerifyOwnReplyArgs): Promise<void> {
  const {
    responseId, businessId, reviewId,
    zernioReviewId, approvedText, accountId, locationId, logger,
  } = args;

  // Bound the walk with the page-cache populated by lookupZernioReviewId, same
  // as verify409AndDispose. Cache miss / read failure → conservative 4 pages.
  let maxPages = 4;
  try {
    const cachedPage = await getCachedZernioReviewPage(accountId, locationId, zernioReviewId);
    if (cachedPage !== null) {
      maxPages = Math.min(cachedPage + 1, 4);
    }
  } catch {
    // Non-fatal — fall back to the 4-page walk.
  }

  let allReviews: Awaited<ReturnType<typeof zernioClient.listAllReviews>>;
  try {
    allReviews = await zernioClient.listAllReviews(accountId, {
      locationId,
      pageSize: 50,
      maxPages,
    });
  } catch (err) {
    // The reply may already be on Google (postReply returned 2xx) — we just
    // can't confirm it right now. Retry rather than mark failed: the next
    // attempt's postReply will 409 and route to verify409AndDispose. Auth /
    // permanent verification errors are also treated as retryable here because
    // the post itself already succeeded; a terminal classification would risk
    // marking a genuinely-posted reply as failed.
    if (
      err instanceof ZernioTransientError ||
      err instanceof ZernioAuthError ||
      err instanceof ZernioPermanentError ||
      err instanceof ZernioValidationError
    ) {
      const transient =
        err instanceof ZernioTransientError
          ? err
          : new ZernioTransientError('post_verify_list_failed', {
              underlying: err.name,
            });
      logger.warn(
        `post-verify list failed for response ${responseId} (${err.name}) — retrying to re-confirm`,
      );
      throw new PublisherTransientWithContext(transient, {
        response_id: responseId,
        business_id: businessId,
        account_id: accountId,
        location_id: locationId,
      });
    }
    throw err;
  }

  const found = allReviews.find((r) => r.id === zernioReviewId);

  if (!found) {
    logger.warn(
      `post-verify: review ${zernioReviewId} not in feed after ${allReviews.length} reviews ` +
      `(maxPages=${maxPages}) for response ${responseId} — reply NOT confirmed on Google`,
    );
    throw new ZernioReplyVerificationIndeterminateError({
      response_id: responseId,
      business_id: businessId,
      review_id: reviewId,
      account_id: accountId,
      location_id: locationId,
      zernio_review_id: zernioReviewId,
      reason: 'review_not_found_after_pagination',
      pages_walked: maxPages,
      reviews_seen: allReviews.length,
    });
  }

  if (found.reviewReply == null) {
    throw new ZernioReplyVerificationIndeterminateError({
      response_id: responseId,
      business_id: businessId,
      review_id: reviewId,
      account_id: accountId,
      location_id: locationId,
      zernio_review_id: zernioReviewId,
      reason: 'review_found_but_reply_null',
    });
  }

  const attached = canonicalizeReplyText(found.reviewReply.comment);
  const ours = canonicalizeReplyText(approvedText);
  if (attached !== ours) {
    throw new ZernioReplyVerificationIndeterminateError({
      response_id: responseId,
      business_id: businessId,
      review_id: reviewId,
      account_id: accountId,
      location_id: locationId,
      zernio_review_id: zernioReviewId,
      reason: 'reply_text_mismatch',
    });
  }
}
