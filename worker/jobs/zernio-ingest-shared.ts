// worker/jobs/zernio-ingest-shared.ts
//
// Shared helpers used by ZernioReviewIngestWorker and ZernioBackfillWorker.
//   1. handleZernioIngestError — error-class dispatcher per spec §6.3 table.
//   2. reconcileExternallyAnsweredReview — supersedes local active responses
//      when the customer already replied via Google directly (spec §6.3b).

import { sql } from '../../src/lib/db/server';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioTransientError,
  ZernioValidationError,
} from '../../src/lib/zernio/errors';
import { applyIngestionAuthErrorFallback } from '../../src/lib/zernio/auth-error-fallback';
import { canonicalizeReplyText } from '../../src/lib/zernio/canonicalize-reply';
import type { ZernioReview } from '../../src/lib/zernio/types';
import { markOutboxFailed } from '../../src/lib/shared/outbox';
import type { WorkerLogger } from '../../src/lib/shared/logger';
import { fromZernioReview } from '../../src/lib/reviews/zernio-field-match';

export interface IngestErrorContext {
  business_id: string;
  zernio_account_id: string;
  zernio_location_id: string;
}

/**
 * Dispatches Zernio HTTP errors to the right disposition per spec §6.3 table.
 * - ZernioAuthError → applyIngestionAuthErrorFallback + markOutboxFailed permanent.
 * - ZernioPermanentError / ZernioValidationError → markOutboxFailed permanent.
 * - ZernioTransientError → rethrow (BullMQ retries with exponential backoff).
 * - Unknown → rethrow (BullMQ retries; on exhaustion the worker's onFailed
 *   hook decides; spec §6.3 says treat unknown as a code bug to investigate).
 */
export async function handleZernioIngestError(
  err: unknown,
  outboxId: string,
  attempt: number,
  ctx: IngestErrorContext,
  logger: WorkerLogger,
): Promise<void> {
  if (err instanceof ZernioAuthError) {
    const reason = err.message;
    logger.warn(`ZernioAuthError on ingest — running connection fallback: ${reason}`);
    await applyIngestionAuthErrorFallback(
      ctx.business_id, ctx.zernio_account_id, ctx.zernio_location_id, reason,
    );
    await markOutboxFailed(outboxId, 'zernio_auth_error_on_ingest', attempt);
    return;
  }
  if (err instanceof ZernioPermanentError) {
    logger.error(`ZernioPermanentError on ingest: ${err.message}`);
    await markOutboxFailed(outboxId, `zernio_permanent_error: ${err.message}`, attempt);
    return;
  }
  if (err instanceof ZernioValidationError) {
    logger.error(`ZernioValidationError on ingest: ${err.message}`);
    await markOutboxFailed(outboxId, `zernio_validation_error: ${err.message}`, attempt);
    return;
  }
  if (err instanceof ZernioTransientError) {
    logger.warn(`ZernioTransientError on ingest — rethrowing for retry: ${err.message}`);
    throw err;
  }
  // Unknown error class — rethrow so BullMQ retries; on exhaustion the
  // worker-specific onFailed handler decides what to do.
  throw err;
}

/**
 * Called from both ingest worker and backfill worker when a fetched Zernio
 * review has reviewReply !== null. Matches local rows by EITHER:
 *   1. provider='zernio' rows with exact identity (the new path), OR
 *   2. legacy provider='serpapi_poll' rows by field-match (reviewer_name +
 *      star_rating + review_text + createTime ±24h, mirroring zernio-publisher's
 *      MATCH_WINDOW_MS).
 *
 * For matched rows: load active responses; protect those whose canonicalized
 * approved_text equals the canonicalized external reply (those are OUR reply
 * being reflected back via review.updated); supersede everything else with
 * posting_error='already_replied_external'. Mixed legacy/Zernio set is
 * supported — protect-set is computed per-response, not all-or-nothing.
 *
 * The IN clause MUST NOT include 'awaiting_manual_post' — that status is
 * decommissioned in migration 029 (spec §6.12b). Spec §13 grep acceptance
 * criterion enforces this.
 */
export async function reconcileExternallyAnsweredReview(
  target: ZernioReview,
  businessId: string,
  accountId: string,
  locationId: string,
  logger: WorkerLogger,
): Promise<void> {
  const providerReviewName = `zernio://${accountId}/locations/${locationId}/reviews/${target.id}`;
  // Use the canonical field-match predicate from zernio-field-match.ts.
  // The SQL WHERE fragment below MUST stay in sync with matchesLocalRow in
  // src/lib/reviews/zernio-field-match.ts. The unit tests there verify both
  // implementations agree on the same corpus.
  const matchFields = fromZernioReview(target);
  const targetCreatedAtMs = matchFields.created_at_ms;
  const targetReviewerName = matchFields.reviewer_name;
  const targetComment = matchFields.review_text_trimmed;

  await sql.begin(async (tx) => {
    const matchedRows = await tx<{ id: string; provider: string }[]>`
      SELECT id, provider FROM reviews
      WHERE business_id = ${businessId}
        AND (
          (provider = 'zernio' AND provider_review_name = ${providerReviewName})
          OR (
            provider = 'serpapi_poll'
            AND reviewer_name = ${targetReviewerName}
            AND star_rating = ${matchFields.star_rating}
            AND COALESCE(NULLIF(trim(review_text), ''), '') = ${targetComment}
            AND ABS(EXTRACT(EPOCH FROM (review_date - to_timestamp(${targetCreatedAtMs} / 1000.0)))) < 86400
          )
        )
      FOR UPDATE
    `;

    if (matchedRows.length === 0) {
      logger.log(`External reply on previously-unseen review ${target.id} — not ingesting`);
      return;
    }

    const reviewIds = matchedRows.map((r) => r.id);
    const externalReplyText = canonicalizeReplyText(target.reviewReply?.comment);

    const activeResponses = await tx<{
      id: string;
      status: string;
      approved_text: string | null;
    }[]>`
      SELECT id, status, approved_text
      FROM responses
      WHERE review_id = ANY(${reviewIds}::uuid[])
        AND status IN ('pending_approval', 'approved', 'edited',
                       'awaiting_owner_connect')
    `;
    // NOTE: 'awaiting_manual_post' is deliberately omitted — decommissioned
    // in migration 029. Spec §13 grep acceptance criterion forbids
    // re-introduction.

    if (activeResponses.length === 0) {
      logger.log(`External reply detected but no active responses for review row(s) ${reviewIds.join(',')} — no-op`);
      return;
    }

    // Protect responses whose approved_text matches the external reply
    // (those are OUR reply that Zernio is reflecting back via review.updated).
    const protectedIds = new Set(
      activeResponses
        .filter((r) =>
          r.approved_text !== null &&
          canonicalizeReplyText(r.approved_text) === externalReplyText &&
          r.status !== 'pending_approval',
        )
        .map((r) => r.id),
    );

    const supersedeIds = activeResponses
      .filter((r) => !protectedIds.has(r.id))
      .map((r) => r.id);

    if (supersedeIds.length === 0) {
      logger.log(
        `External reply matches every active response's approved_text ` +
        `(${protectedIds.size}) — likely our publish; no supersession`,
      );
      return;
    }

    const supersededRows = await tx`
      UPDATE responses
      SET status = 'superseded',
          posting_error = 'already_replied_external',
          updated_at = NOW()
      WHERE id = ANY(${supersedeIds}::uuid[])
      RETURNING id
    `;

    if (supersededRows.count > 0) {
      const providers = matchedRows.map((r) => r.provider).join(',');
      logger.log(
        `Superseded ${supersededRows.count} active response(s) across ` +
        `${matchedRows.length} review row(s) [${providers}] because customer ` +
        `replied externally on Google. Protected ${protectedIds.size} ` +
        `matching response(s) (our reply).`,
      );
    }
  });
}
