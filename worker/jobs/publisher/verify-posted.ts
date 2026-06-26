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

import { canonicalizeReplyText } from '../../../src/lib/zernio/canonicalize-reply';
import { getReviewPublisher } from '../../../src/lib/publishing/review-publisher';
import type {
  FindReplyResult,
  ResolvedPublishTarget,
} from '../../../src/lib/publishing/review-publisher';
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
  target: ResolvedPublishTarget;
  approvedText: string;
  logger: WorkerLogger;
}

/**
 * Confirm our reply is actually attached to the review on Zernio after a
 * postReply that returned 2xx. Resolves when confirmed; throws otherwise.
 *
 * The feed fetch + page-cache bounding live behind `publisher.findReply`; this
 * function owns the canonicalization comparison and the indeterminate/retry
 * disposition. Throw types are chosen so the publisher failed-hook already knows
 * how to land them: ZernioReplyVerificationIndeterminateError → failed +
 * exception + admin alert; PublisherTransientWithContext → BullMQ retry (→ next
 * attempt 409 → verify409AndDispose).
 */
export async function verifyOwnReplyAttached(args: VerifyOwnReplyArgs): Promise<void> {
  const { target, approvedText, logger } = args;
  const { responseId, businessId, reviewId } = target.ref;

  let result: FindReplyResult;
  try {
    result = await getReviewPublisher().findReply(target);
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
        account_id: target.accountId,
        location_id: target.locationId,
      });
    }
    throw err;
  }

  if (result.kind === 'review_absent') {
    logger.warn(
      `post-verify: review ${target.providerReviewId} not in feed after ${result.reviewsSeen} reviews ` +
      `(maxPages=${result.pagesWalked}) for response ${responseId} — reply NOT confirmed on Google`,
    );
    throw new ZernioReplyVerificationIndeterminateError({
      response_id: responseId,
      business_id: businessId,
      review_id: reviewId,
      account_id: target.accountId,
      location_id: target.locationId,
      zernio_review_id: target.providerReviewId,
      reason: 'review_not_found_after_pagination',
      pages_walked: result.pagesWalked,
      reviews_seen: result.reviewsSeen,
    });
  }

  if (result.reply == null) {
    throw new ZernioReplyVerificationIndeterminateError({
      response_id: responseId,
      business_id: businessId,
      review_id: reviewId,
      account_id: target.accountId,
      location_id: target.locationId,
      zernio_review_id: target.providerReviewId,
      reason: 'review_found_but_reply_null',
    });
  }

  const attached = canonicalizeReplyText(result.reply.comment);
  const ours = canonicalizeReplyText(approvedText);
  if (attached !== ours) {
    throw new ZernioReplyVerificationIndeterminateError({
      response_id: responseId,
      business_id: businessId,
      review_id: reviewId,
      account_id: target.accountId,
      location_id: target.locationId,
      zernio_review_id: target.providerReviewId,
      reason: 'reply_text_mismatch',
    });
  }
}
