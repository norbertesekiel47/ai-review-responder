// worker/jobs/zernio-ingest-shared.ts
//
// Shared helpers used by ZernioReviewIngestWorker and ZernioBackfillWorker.
//   1. handleZernioIngestError — error-class dispatcher per spec §6.3 table.
//   2. reconcileExternallyAnsweredReview — supersedes local active responses
//      when the customer already replied via Google directly (spec §6.3b).
//      Under EDIT_EXISTING_REPLIES_ENABLED, also imports unseen external
//      replies as 'posted' responses so Past Replies can render them
//      (spec §4.3, §6.3b).

import { createHash } from 'node:crypto';
import type postgres from 'postgres';
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

type TxClient = postgres.TransactionSql;

const FLAG_ON = (): boolean =>
  process.env.EDIT_EXISTING_REPLIES_ENABLED === 'true';

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
      if (!FLAG_ON()) {
        logger.log(`External reply on previously-unseen review ${target.id} — not ingesting`);
        return;
      }
      // Defensive: callers only invoke us when reviewReply !== null, but
      // guard so the import branch never inserts an empty 'posted' response.
      if (!target.reviewReply) {
        logger.log(`External reply on previously-unseen review ${target.id} — reviewReply null, not ingesting`);
        return;
      }
      const newReviewId = await insertImportedReview(tx, businessId, accountId, locationId, target);
      const inserted = await insertImportedResponse(tx, businessId, newReviewId, null, target.reviewReply);
      if (inserted) {
        await bumpExternalReplyIngestedCount(tx, businessId);
        logger.log(`Imported external reply for previously-unseen review ${target.id}`);
      } else {
        logger.log(`External reply for review ${target.id} already imported (ON CONFLICT) — counter not bumped`);
      }
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
      if (!FLAG_ON()) {
        logger.log(`External reply detected but no active responses for review row(s) ${reviewIds.join(',')} — no-op`);
        return;
      }
      if (!target.reviewReply) {
        logger.log(`External reply branch reached but reviewReply null — no-op for review row(s) ${reviewIds.join(',')}`);
        return;
      }
      const targetReviewRowId = matchedRows[0]!.id;
      const inserted = await insertImportedResponse(tx, businessId, targetReviewRowId, null, target.reviewReply);
      if (inserted) {
        await bumpExternalReplyIngestedCount(tx, businessId);
        logger.log(`Imported external reply onto existing review row ${targetReviewRowId}`);
      } else {
        logger.log(`External reply for review row ${targetReviewRowId} already imported (ON CONFLICT) — counter not bumped`);
      }
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

// ---------------------------------------------------------------------------
// Private helpers — used by the EDIT_EXISTING_REPLIES_ENABLED branches above.
// Not exported: implementation detail of reconcileExternallyAnsweredReview.
// ---------------------------------------------------------------------------

/**
 * INSERT a `reviews` row for a Zernio review we have never seen locally.
 * Race-safe via `ON CONFLICT (provider, provider_review_name) DO UPDATE SET
 * id = reviews.id RETURNING id` — DO NOTHING + RETURNING leaves no row when
 * the conflicting INSERT loses the race because the snapshot can't see the
 * just-committed sibling. DO UPDATE always RETURNs whether the row was
 * inserted or pre-existing; the no-op `SET id = id` triggers no observable
 * change on the row content.
 */
async function insertImportedReview(
  tx: TxClient,
  businessId: string,
  accountId: string,
  locationId: string,
  target: ZernioReview,
): Promise<string> {
  const matchFields = fromZernioReview(target);
  const providerReviewName = `zernio://${accountId}/locations/${locationId}/reviews/${target.id}`;
  const providerLocationName = `zernio://${accountId}/locations/${locationId}`;
  const reviewContentHash = createHash('sha256')
    .update(`${matchFields.star_rating}|${matchFields.review_text_trimmed}`)
    .digest('hex');

  const rows = await tx<{ id: string }[]>`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text,
      review_date, detected_language, review_content_hash, detected_at,
      status, external_reply_ingested_at
    )
    VALUES (
      gen_random_uuid(), ${businessId}, 'zernio', ${target.id},
      ${providerReviewName}, ${providerLocationName},
      ${matchFields.reviewer_name}, ${matchFields.star_rating},
      ${matchFields.review_text_trimmed},
      to_timestamp(${matchFields.created_at_ms} / 1000.0),
      ${null as unknown as string}, ${reviewContentHash},
      NOW(), 'new', NOW()
    )
    ON CONFLICT (provider, provider_review_name) DO UPDATE
      SET id = reviews.id
    RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * INSERT a `responses` row representing the owner's externally-posted Google
 * reply. status='posted', all three text columns set to the canonicalized
 * reply, llm_* columns NULL (no LLM call produced this row).
 *
 * version is computed server-side as `COALESCE(MAX(version), 0) + 1` so prior
 * terminal rows ('failed', 'superseded') don't collide on the
 * (review_id, version) unique constraint.
 *
 * The partial unique index `responses_one_posted_per_review` (migration 031)
 * guards against duplicate 'posted' rows when the helper is invoked twice
 * for the same review; ON CONFLICT … DO NOTHING keeps the second call
 * idempotent.
 */
async function insertImportedResponse(
  tx: TxClient,
  businessId: string,
  reviewId: string,
  reviewLanguage: string | null,
  externalReply: { comment: string; updateTime: string },
): Promise<boolean> {
  const replyText = canonicalizeReplyText(externalReply.comment);
  const updateTime = externalReply.updateTime;

  // RETURNING 1 lets the caller distinguish "actually inserted" from
  // "ON CONFLICT DO NOTHING fired" — important for the
  // external_reply_ingested_count metric so retries don't inflate it.
  const result = await tx`
    INSERT INTO responses (
      id, review_id, business_id,
      response_text, approved_text, original_draft_text, edited_text,
      response_language, version, status,
      approved_at, posted_at,
      llm_provider, llm_model, prompt_tokens, completion_tokens
    )
    VALUES (
      gen_random_uuid(), ${reviewId}, ${businessId},
      ${replyText}, ${replyText}, ${replyText}, NULL,
      ${reviewLanguage},
      COALESCE((SELECT MAX(version) FROM responses WHERE review_id = ${reviewId}), 0) + 1,
      'posted',
      ${updateTime}::timestamptz, ${updateTime}::timestamptz,
      NULL, NULL, NULL, NULL
    )
    ON CONFLICT (review_id) WHERE status = 'posted' DO NOTHING
    RETURNING 1
  `;
  return result.count > 0;
}

/**
 * Bump the active backfill run's `external_reply_ingested_count`. No-op when
 * called from the per-webhook ingest worker (no active row → 0 rows updated).
 */
async function bumpExternalReplyIngestedCount(
  tx: TxClient,
  businessId: string,
): Promise<void> {
  await tx`
    UPDATE zernio_backfill_runs
    SET external_reply_ingested_count = external_reply_ingested_count + 1,
        updated_at = NOW()
    WHERE business_id = ${businessId} AND completed_at IS NULL
  `;
}
