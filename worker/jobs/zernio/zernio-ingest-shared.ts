// worker/jobs/zernio/zernio-ingest-shared.ts
//
// Shared helpers used by ZernioReviewIngestWorker and ZernioBackfillWorker.
//   1. handleZernioIngestError — error-class dispatcher per spec §6.3 table.
//   2. reconcileExternallyAnsweredReview — supersedes local active responses
//      when the customer already replied via Google directly (spec §6.3b).
//      Under EXTERNAL_REPLY_IMPORT_ENABLED, also imports unseen external
//      replies as 'posted' responses so Past Replies can render them
//      (spec §4.3, §6.3b).

import type postgres from 'postgres';
import * as Sentry from '@sentry/node';
import { v7 as uuidv7 } from 'uuid';
import { QUEUE_NAMES } from '../../../src/lib/shared/queue-names';
import { externalReplyImportEnabled } from '../../../src/lib/publishing/flags';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioTransientError,
  ZernioValidationError,
} from '../../../src/lib/zernio/errors';
import { applyIngestionAuthErrorFallback } from '../../../src/lib/zernio/auth-error-fallback';
import { canonicalizeReplyText } from '../../../src/lib/zernio/canonicalize-reply';
import type { ZernioReview } from '../../../src/lib/zernio/types';
import { markOutboxFailed } from '../../../src/lib/shared/outbox';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import { fromZernioReview } from '../../../src/lib/reviews/zernio-field-match';
import { buildZernioMonitoredReview } from '../../../src/lib/reviews/zernio-normalize';
import { classifySentiment } from '../../../src/lib/reviews/sentiment';
import { detectLikelyPhi, redactPhiForLog } from '../../../src/lib/security/phi-scanner';
import type { PhiDetection } from '../../../src/lib/security/phi-scanner';

type TxClient = postgres.TransactionSql;
type SqlExecutor = postgres.Sql | TxClient;

const FLAG_ON = (): boolean =>
  externalReplyImportEnabled();

// ── Live-ingest cutoff (CONTEXT.md glossary) ─────────────────────────────
// connected_at − grace: the instant from which the live lane (webhook +
// recent poller) owns review handling. The recent poller processes only
// createTime >= cutoff (isRecentForConnection); the consented Review import
// selects only createTime < cutoff. Disjoint by construction — this is what
// makes the #674 lost-draft hazard structurally impossible. Null connected_at
// → null; each caller interprets null per its own fail direction (poller:
// owns nothing; import: no upper bound).
const DEFAULT_CONNECT_GRACE_MS = 5 * 60_000;

export function liveIngestCutoff(connectedAt: Date | null): Date | null {
  if (!connectedAt) return null;
  const connectedMs = connectedAt.getTime();
  if (!Number.isFinite(connectedMs)) return null;
  const parsed = parseInt(getWorkerConfig().ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS ?? '', 10);
  const graceMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONNECT_GRACE_MS;
  return new Date(connectedMs - graceMs);
}

export interface IngestErrorContext {
  business_id: string;
  zernio_account_id: string;
  zernio_location_id: string;
}

interface PhiReviewExceptionInput {
  businessId: string;
  accountId: string;
  locationId: string;
  review: ZernioReview;
  reasons: string[];
  source: 'webhook' | 'backfill' | 'recent_poller' | 'external_reply_import';
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
  sql: postgres.Sql,
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
      sql, ctx.business_id, ctx.zernio_account_id, ctx.zernio_location_id, reason,
    );
    await markOutboxFailed(sql, outboxId, 'zernio_auth_error_on_ingest', attempt);
    return;
  }
  if (err instanceof ZernioPermanentError) {
    logger.error(`ZernioPermanentError on ingest: ${err.message}`);
    await markOutboxFailed(sql, outboxId, `zernio_permanent_error: ${err.message}`, attempt);
    return;
  }
  if (err instanceof ZernioValidationError) {
    logger.error(`ZernioValidationError on ingest: ${err.message}`);
    await markOutboxFailed(sql, outboxId, `zernio_validation_error: ${err.message}`, attempt);
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

export async function openPhiReviewException(
  db: SqlExecutor,
  input: PhiReviewExceptionInput,
  logger: WorkerLogger,
): Promise<void> {
  // Caller owns the transaction (see call sites): the exception row and its
  // admin-notification outbox row must commit together (transactional outbox
  // invariant), so `db` is always a transaction handle here. When the
  // ON CONFLICT no-ops (a still-open exception already exists), we skip both the
  // outbox enqueue and the Sentry alert so we do not re-notify on every repeated
  // ingest of the same review.
  const [exception] = await db<{ id: string }[]>`
    INSERT INTO review_exceptions (id, business_id, type, status, payload)
    VALUES (
      ${uuidv7()}, ${input.businessId}, 'zernio_likely_phi_review', 'open',
      ${db.json({
        provider: 'zernio',
        provider_review_id: input.review.id,
        zernio_account_id: input.accountId,
        zernio_location_id: input.locationId,
        phi_reasons: input.reasons,
        source: input.source,
        detected_at: new Date().toISOString(),
      } as never)}
    )
    ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
      WHERE status = 'open' AND review_id IS NULL
    DO NOTHING
    RETURNING id
  `;

  if (!exception) {
    logger.warn(`Likely PHI review ${input.review.id} already has an open operator exception`);
    return;
  }

  await db`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts)
    VALUES (
      ${uuidv7()}, ${QUEUE_NAMES.NOTIFY_ADMIN}, 'business',
      ${input.businessId},
      ${db.json({ review_exception_id: exception.id, business_id: input.businessId } as never)},
      0, 5
    )
  `;

  Sentry.captureMessage('zernio_likely_phi_review_blocked', {
    level: 'warning',
    tags: {
      kind: 'likely_phi',
      // `source` distinguishes webhook / backfill / recent_poller / external
      // reply import — kept dynamic so events aren't misclassified by origin.
      source: input.source,
    },
    extra: {
      business_id: input.businessId,
      zernio_account_id: input.accountId,
      zernio_location_id: input.locationId,
      zernio_review_id: input.review.id,
      phi_reasons: input.reasons,
    },
  });
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
 *
 * consentedImport: the consented Review import lane (D5) imports answered
 * rows unconditionally — EXTERNAL_REPLY_IMPORT_ENABLED governs only the live
 * lane's posture.
 */
export async function reconcileExternallyAnsweredReview(
  sql: postgres.Sql,
  target: ZernioReview,
  businessId: string,
  accountId: string,
  locationId: string,
  logger: WorkerLogger,
  opts?: { consentedImport?: boolean },
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
  const targetPhi = detectLikelyPhi(targetComment);

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
      const importAllowed = FLAG_ON() || opts?.consentedImport === true;
      if (!importAllowed) {
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
      if (!newReviewId) {
        await openPhiReviewException(tx, {
          businessId,
          accountId,
          locationId,
          review: target,
          reasons: targetPhi.reasons,
          source: 'external_reply_import',
        }, logger);
        logger.warn(
          `Likely PHI detected for previously-unseen review ${target.id}; review_text=${redactPhiForLog(targetComment)}; skipping import`,
        );
        return;
      }
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
      const importAllowed = FLAG_ON() || opts?.consentedImport === true;
      if (!importAllowed) {
        logger.log(`External reply detected but no active responses for review row(s) ${reviewIds.join(',')} — no-op`);
        return;
      }
      if (!target.reviewReply) {
        logger.log(`External reply branch reached but reviewReply null — no-op for review row(s) ${reviewIds.join(',')}`);
        return;
      }
      const targetReviewRowId = matchedRows[0]!.id;
      await phiGateAndImportExternalReply(tx, {
        businessId,
        accountId,
        locationId,
        target,
        targetPhi,
        targetComment,
        reviewRowId: targetReviewRowId,
        externalReply: target.reviewReply,
        messages: {
          inserted: `Imported external reply onto existing review row ${targetReviewRowId}`,
          notBumped: `External reply for review row ${targetReviewRowId} already imported (ON CONFLICT) — counter not bumped`,
        },
      }, logger);
      return;
    }

    // Protect responses whose approved_text matches the external reply
    // (those are OUR reply that Zernio is reflecting back via review.updated).
    const protectedIds = new Set(
      activeResponses.flatMap((r) =>
        r.approved_text !== null &&
        canonicalizeReplyText(r.approved_text) === externalReplyText &&
        r.status !== 'pending_approval'
          ? [r.id]
          : [],
      ),
    );

    const supersedeIds = activeResponses.flatMap((r) =>
      !protectedIds.has(r.id) ? [r.id] : [],
    );

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

    // Consented import runs ONCE per review — it cannot rely on the live
    // lane's eventual convergence, so store the external reply now (D5).
    // Mirrors branch 2: PHI gate, then insertImportedResponse + counter.
    // protectedIds.size > 0 means one of the active responses IS our own
    // reply (approved_text matches the external text) — the reply is already
    // represented locally; inserting an imported posted row would duplicate
    // it (r2 fix-defect on the mixed protected+stale case).
    if (opts?.consentedImport === true && target.reviewReply && protectedIds.size === 0) {
      const targetReviewRowId = matchedRows[0]!.id;
      await phiGateAndImportExternalReply(tx, {
        businessId,
        accountId,
        locationId,
        target,
        targetPhi,
        targetComment,
        reviewRowId: targetReviewRowId,
        externalReply: target.reviewReply,
        messages: {
          inserted: `Imported external reply onto review row ${targetReviewRowId} after superseding active draft(s)`,
          notBumped: `External reply for review row ${targetReviewRowId} already imported (ON CONFLICT) — counter not bumped after superseding active draft(s)`,
        },
      }, logger);
    }
  });
}

// ---------------------------------------------------------------------------
// Private helpers — used by the EXTERNAL_REPLY_IMPORT_ENABLED branches above.
// Not exported: implementation detail of reconcileExternallyAnsweredReview.
// ---------------------------------------------------------------------------

/**
 * INSERT a `reviews` row for a Zernio review we have never seen locally.
 *
 * Every persisted value comes from `buildZernioMonitoredReview` — the SAME
 * builder the live ingest lane uses (`process-review.ts`) — so an imported row
 * and a live-ingested row of identical content are byte-identical in
 * `review_content_hash`, `review_text`, `reviewer_name` and `detected_language`
 * (#762). Do NOT re-derive any of those here. The hash in particular has
 * exactly one owner, `computeContentHash` (`src/lib/reviews/types.ts`); the
 * hand-rolled `star|trimmed` form this function used to carry disagreed with it
 * on every empty-text review (`'5|'` vs `'5|null'`) and on any text sanitizing
 * would alter, so a later `review.updated` webhook for such a row took the
 * content-changed lane — supersede + regenerate — with no content change.
 *
 * What stays import-specific, and must not be folded into the live lane's
 * `insertNewReviewRow`:
 *   - `external_reply_ingested_at` — set only here; the live lane has no such
 *     column write.
 *   - `ON CONFLICT … DO UPDATE SET id = reviews.id RETURNING id` — DO NOTHING +
 *     RETURNING (what the live lane uses, because it only needs the insert
 *     count) leaves no row when the conflicting INSERT loses the race, since
 *     the snapshot can't see the just-committed sibling. DO UPDATE always
 *     RETURNs whether the row was inserted or pre-existing; besides
 *     opportunistically backfilling a NULL `google_review_name`, the no-op
 *     `SET id = id` triggers no observable change on the row content.
 *
 * The PHI screen deliberately keeps reading `fromZernioReview`'s UNSANITIZED
 * trimmed text: the caller screens the same value to build the exception row's
 * `reasons`, and the two must not disagree about whether a review is PHI.
 */
async function insertImportedReview(
  tx: TxClient,
  businessId: string,
  accountId: string,
  locationId: string,
  target: ZernioReview,
): Promise<string | null> {
  const matchFields = fromZernioReview(target);
  const phi = detectLikelyPhi(matchFields.review_text_trimmed);
  if (phi.matched) {
    return null;
  }

  const { review, identity, contentHash } = buildZernioMonitoredReview(target, accountId, locationId);
  const sentiment = classifySentiment(review.starRating);

  const rows = await tx<{ id: string }[]>`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, google_review_name, reviewer_name, star_rating, review_text,
      review_date, detected_language, review_content_hash, detected_at,
      status, external_reply_ingested_at,
      sentiment_score, sentiment_label, sentiment_classified_at, sentiment_source
    )
    VALUES (
      gen_random_uuid(), ${businessId}, ${identity.provider}, ${identity.providerReviewId},
      ${identity.providerReviewName}, ${identity.providerLocationName},
      ${identity.googleReviewName},
      ${review.reviewerName}, ${review.starRating},
      ${review.reviewText},
      ${review.reviewDate},
      ${review.detectedLanguage}, ${contentHash},
      NOW(), 'new', NOW(),
      ${sentiment.score}, ${sentiment.label}, NOW(), ${sentiment.source}
    )
    ON CONFLICT (provider, provider_review_name) DO UPDATE
      SET id = reviews.id,
          google_review_name = COALESCE(reviews.google_review_name, EXCLUDED.google_review_name)
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

/**
 * PHI-gate then import for a matched review row — shared by branch 2 (no
 * active responses) and the branch-3 consented tail (active responses
 * superseded, none protected). A PHI match opens the exception row, warns,
 * and skips the import; otherwise the reply lands via
 * importExternalReplyOntoRow with the caller's own wording.
 */
async function phiGateAndImportExternalReply(
  tx: TxClient,
  args: {
    businessId: string;
    accountId: string;
    locationId: string;
    target: ZernioReview;
    targetPhi: PhiDetection;
    targetComment: string;
    reviewRowId: string;
    externalReply: { comment: string; updateTime: string };
    messages: { inserted: string; notBumped: string };
  },
  logger: WorkerLogger,
): Promise<void> {
  if (args.targetPhi.matched) {
    await openPhiReviewException(tx, {
      businessId: args.businessId,
      accountId: args.accountId,
      locationId: args.locationId,
      review: args.target,
      reasons: args.targetPhi.reasons,
      source: 'external_reply_import',
    }, logger);
    logger.warn(
      `Likely PHI detected for matched review ${args.target.id}; review_text=${redactPhiForLog(args.targetComment)}; skipping external reply import`,
    );
    return;
  }
  await importExternalReplyOntoRow(tx, args.businessId, args.reviewRowId, null, args.externalReply, logger, args.messages);
}

/**
 * Shared tail for the "matched review, active-response set resolved" branches
 * (branch 2: no active responses; branch-3 tail: active responses superseded,
 * none protected): insert the imported 'posted' response, bump the counter
 * ONLY on an actual insert (an ON CONFLICT no-op must not inflate the metric),
 * and log the outcome using the caller's own wording so each branch keeps its
 * exact current log messages.
 */
async function importExternalReplyOntoRow(
  tx: TxClient,
  businessId: string,
  reviewRowId: string,
  reviewLanguage: string | null,
  externalReply: { comment: string; updateTime: string },
  logger: WorkerLogger,
  messages: { inserted: string; notBumped: string },
): Promise<void> {
  const inserted = await insertImportedResponse(tx, businessId, reviewRowId, reviewLanguage, externalReply);
  if (inserted) {
    await bumpExternalReplyIngestedCount(tx, businessId);
    logger.log(messages.inserted);
  } else {
    logger.log(messages.notBumped);
  }
}
