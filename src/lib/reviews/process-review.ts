import { v7 as uuidv7 } from 'uuid';
import type postgres from 'postgres';
import type { Sql } from 'postgres';
import type { MonitoredReview } from './types';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import type {
  GenerateResponseOriginLane,
  NotifyAdminExceptionPayload,
} from '@/lib/shared/worker-types';
import { GENERATE_RESPONSE_ORIGIN_LANE } from '@/lib/shared/worker-types';
import { enqueueGenerateResponse } from '@/lib/shared/job-outbox-helpers';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import { makeAnalyticsEventKey } from '@/lib/analytics/events';
import { classifySentiment } from '@/lib/reviews/sentiment';
import { replyEditingFlagEnabled } from '@/lib/past-replies/flags';
import { startOrGetActiveRun, recordStep, completeRun } from '@/lib/agents/run-spine';
import {
  STALE_AFTER_REVIEW_CHANGED,
  DELETE_FAILED_PREFIX,
  POST_AFTER_DELETE_FAILED_PREFIX,
} from '@/lib/publishing/orphan-markers';

// ── Types ────────────────────────────────────────────────────────────

export type ProcessResult = 'new' | 'updated' | 'unchanged';

type TxClient = postgres.TransactionSql;

// ── Per-review processing ────────────────────────────────────────────
// Pure domain logic: dedup by provider identity, content-hash comparison,
// state-machine branching. Zero coupling to BullMQ. Operates on a
// Postgres.js transaction.

export async function processReview(
  sql: Sql,
  monitored: MonitoredReview,
  businessId: string,
  correlationId?: string,
  options?: { suppressNotification?: boolean; originLane?: GenerateResponseOriginLane },
): Promise<ProcessResult> {
  const suppressNotification = options?.suppressNotification ?? false;
  const newReviewOriginLane = options?.originLane ?? GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW;
  const updateOriginLane = options?.originLane ?? GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_UPDATE;
  // `review` / `contentHash` are consumed by insertNewReviewRow and
  // processExistingReview, both of which take `monitored` whole.
  const { identity } = monitored;

  return await sql.begin(async (tx) => {
    // Try to lock existing review by provider identity (unique constraint)
    const [existing] = await tx<{
      id: string;
      review_content_hash: string | null;
      status: string | null;
    }[]>`
      SELECT id, review_content_hash, status
      FROM reviews
      WHERE provider = ${identity.provider}
        AND provider_review_name = ${identity.providerReviewName}
      FOR UPDATE
    `;

    if (!existing) {
      // ── NEW review — insert with ON CONFLICT guard for concurrent writers ──
      const reviewId = uuidv7();
      const insertedCount = await insertNewReviewRow(tx, reviewId, businessId, monitored);

      if (insertedCount > 0) {
        // We won the race — start the agent run, then enqueue response generation
        await startReviewRun(tx, {
          reviewId,
          businessId,
          correlationId,
          stepKey: 'review_ingested',
        });

        await enqueueGenerateResponse(tx, {
          reviewId,
          businessId,
          version: 1,
          originLane: newReviewOriginLane,
          correlationId,
          suppressNotification,
        });

        await maybeEnqueueFirstReviewIngested(tx, {
          businessId,
          reviewId,
        });

        return 'new' as const;
      }

      // We lost the race — another concurrent writer inserted this review first.
      // Re-read the winner row with FOR UPDATE and fall through to existing-row logic.
      const [winner] = await tx<{
        id: string;
        review_content_hash: string | null;
        status: string | null;
      }[]>`
        SELECT id, review_content_hash, status
        FROM reviews
        WHERE provider = ${identity.provider}
          AND provider_review_name = ${identity.providerReviewName}
        FOR UPDATE
      `;

      if (!winner) {
        throw new Error(
          `process-review: race-loss without winner row for ${identity.providerReviewName}`,
        );
      }

      return processExistingReview(
        tx,
        winner,
        monitored,
        businessId,
        correlationId,
        suppressNotification,
        updateOriginLane,
      );
    }

    return processExistingReview(
      tx,
      existing,
      monitored,
      businessId,
      correlationId,
      suppressNotification,
      updateOriginLane,
    );
  });
}

// ── Shared new-review INSERT (internal seam) ─────────────────────────
// Used by both entry points. Returns the number of rows inserted: 0 means
// the review already existed (or a concurrent writer won the race), since
// ON CONFLICT (provider, provider_review_name) DO NOTHING is the dedup.
// Sentiment is classified here so every insert site classifies identically.
// Private by design — not part of the module's interface.

async function insertNewReviewRow(
  tx: TxClient,
  reviewId: string,
  businessId: string,
  monitored: MonitoredReview,
): Promise<number> {
  const { review, identity, contentHash } = monitored;
  const sentiment = classifySentiment(review.starRating);

  const inserted = await tx<{ id: string }[]>`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id,
      provider_review_name, provider_location_name, google_review_name,
      reviewer_name, star_rating, review_text, review_date,
      detected_language, review_content_hash, status, detected_at,
      sentiment_score, sentiment_label, sentiment_classified_at, sentiment_source
    ) VALUES (
      ${reviewId}, ${businessId}, ${identity.provider}, ${identity.providerReviewId},
      ${identity.providerReviewName}, ${identity.providerLocationName}, ${identity.googleReviewName},
      ${review.reviewerName}, ${review.starRating}, ${review.reviewText}, ${review.reviewDate},
      ${review.detectedLanguage}, ${contentHash}, ${REVIEW_STATUS.NEW}, NOW(),
      ${sentiment.score}, ${sentiment.label}, NOW(), ${sentiment.source}
    )
    ON CONFLICT (provider, provider_review_name) DO NOTHING
    RETURNING id
  `;

  return inserted.count;
}

// ── Agent run spine (WS1) ────────────────────────────────────────────
// Starts (or joins) the review_handler run for a review and records the
// ingest/update step, inside the SAME transaction as the review write —
// outbox discipline: a spine failure fails the job and BullMQ retries.
// Unchanged/status-only paths deliberately get no spine writes (mirrors
// the sentiment discipline).

async function startReviewRun(
  tx: TxClient,
  input: {
    reviewId: string;
    businessId: string;
    correlationId?: string;
    stepKey: 'review_ingested' | 'review_updated';
  },
): Promise<string | null> {
  const [biz] = await tx<{ account_id: string }[]>`
    SELECT account_id FROM businesses WHERE id = ${input.businessId}
  `;
  // Defensive: unreachable today — reviews.business_id FK guarantees the row
  // exists (KEY SHARE from the INSERT / cascade blocks behind our review lock).
  // Skip rather than fail ingest if that ever changes.
  if (!biz) return null;

  const { runId } = await startOrGetActiveRun(tx, {
    kind: 'review_handler',
    subjectType: 'review',
    subjectId: input.reviewId,
    accountId: biz.account_id,
    businessId: input.businessId,
    correlationId: input.correlationId,
  });
  await recordStep(tx, { runId, stepKey: input.stepKey });
  return runId;
}

async function maybeEnqueueFirstReviewIngested(
  tx: TxClient,
  input: {
    businessId: string;
    reviewId: string;
  },
): Promise<void> {
  const [row] = await tx<{ account_id: string; earlier_exists: boolean }[]>`
    SELECT
      b.account_id,
      EXISTS (
        SELECT 1
        FROM reviews r2
        JOIN businesses b2 ON b2.id = r2.business_id
        WHERE b2.account_id = b.account_id
          AND r2.id <> ${input.reviewId}::uuid
          AND r2.detected_at IS NOT NULL
        LIMIT 1
      ) AS earlier_exists
    FROM businesses b
    WHERE b.id = ${input.businessId}::uuid
    LIMIT 1
  `;

  if (!row || row.earlier_exists) return;

  await enqueueAnalyticsEvent(tx, {
    eventName: 'first_review_ingested',
    eventKey: makeAnalyticsEventKey('first_review_ingested', [row.account_id]),
    distinctId: row.account_id,
    accountId: row.account_id,
    businessId: input.businessId,
    properties: {
      account_id: row.account_id,
      business_id: input.businessId,
      review_id: input.reviewId,
    },
  });
}

// ── Existing-row state machine ────────────────────────────────────────
// Called both from the normal path (existing row found on first SELECT)
// and from the race-loss path (winner row found after INSERT DO NOTHING).

async function processExistingReview(
  tx: TxClient,
  existing: { id: string; review_content_hash: string | null; status?: string | null },
  monitored: MonitoredReview,
  businessId: string,
  correlationId: string | undefined,
  suppressNotification: boolean,
  originLane: GenerateResponseOriginLane,
): Promise<ProcessResult> {
  const { review, identity, contentHash } = monitored;
  const existingHash = existing.review_content_hash;

  if (existingHash === contentHash) {
    if (existing.status === REVIEW_STATUS.DELETED) {
      await tx`
        UPDATE reviews
        SET status = ${REVIEW_STATUS.NEW},
            detected_at = NOW()
        WHERE id = ${existing.id}
      `;
      return 'updated' as const;
    }
    return 'unchanged' as const;
  }

  // ── STALE-MARK recoverable failed rows (spec §4.5) ─────────────────
  // Runs unconditionally at the TOP of the content-change block, before any
  // branch. If a customer edits their review AFTER an edit-publisher failure
  // left a recoverable 'failed' row (posting_error starting with delete_failed_*
  // or post_after_delete_failed_*), recovering that row would re-post a reply
  // against old review text. Mark it stale so /retry refuses to recover it.
  //
  // The 'reviews FOR UPDATE' lock acquired above serializes us against /retry
  // — the retry route acquires the same lock order and waits for our COMMIT
  // before reading the failed row's posting_error. Zero-row UPDATE is fine
  // (no recoverable orphan exists — no-op).
  //
  // Gated behind EDIT_REPLIES_ENABLED so Phase A is fully inert when the flag
  // is off — no new behavior until the flag is on. The worker keys on the raw
  // edit flag alone (the view flag is a UI concern); see past-replies/flags.ts.
  if (replyEditingFlagEnabled()) {
    await tx`
      UPDATE responses
      SET posting_error = ${STALE_AFTER_REVIEW_CHANGED}, updated_at = NOW()
      WHERE review_id = ${existing.id}
        AND status = 'failed'
        AND (posting_error LIKE ${`${DELETE_FAILED_PREFIX}%`}
             OR posting_error LIKE ${`${POST_AFTER_DELETE_FAILED_PREFIX}%`})
    `;
  }

  // ── CONTENT CHANGED — update the review row ───────────────────
  const sentiment = classifySentiment(review.starRating);
  await tx`
    UPDATE reviews
    SET reviewer_name = ${review.reviewerName},
        star_rating = ${review.starRating},
        review_text = ${review.reviewText},
        review_date = ${review.reviewDate},
        detected_language = ${review.detectedLanguage},
        review_content_hash = ${contentHash},
        google_review_name = COALESCE(${identity.googleReviewName}, google_review_name),
        sentiment_score = ${sentiment.score},
        sentiment_label = ${sentiment.label},
        sentiment_classified_at = NOW(),
        sentiment_source = ${sentiment.source},
        status = CASE WHEN status = ${REVIEW_STATUS.DELETED} THEN ${REVIEW_STATUS.NEW} ELSE status END,
        detected_at = CASE WHEN status = ${REVIEW_STATUS.DELETED} THEN NOW() ELSE detected_at END
    WHERE id = ${existing.id}
  `;

  await startReviewRun(tx, {
    reviewId: existing.id,
    businessId,
    correlationId,
    stepKey: 'review_updated',
  });

  // Find the current non-terminal response for this review. FOR UPDATE
  // serializes against a concurrent approval transaction (which also
  // SELECTs the row FOR UPDATE in src/lib/approval/service.ts) so we
  // can't re-read a stale status and then stomp a fresh approval with
  // status='failed' below.
  const [activeResponse] = await tx<{
    id: string;
    status: string;
    version: number;
  }[]>`
    SELECT id, status, version
    FROM responses
    WHERE review_id = ${existing.id}
      AND status NOT IN ('superseded', 'failed') -- status-audit-ignore: state-transition SELECT FOR UPDATE guard subset, intentionally inline per response-status.ts header
    ORDER BY version DESC
    LIMIT 1
    FOR UPDATE
  `;

  if (!activeResponse) {
    // No active response — queue a fresh generation. Use MAX(version)+1
    // so a prior terminal v1 (e.g. failed by cost-limit) doesn't collide
    // with the new draft. ResponseGeneratorWorker's idempotency check
    // (UNIQUE (review_id, version)) would otherwise short-circuit on the
    // existing terminal row and silently skip generation.
    const [versionRow] = await tx<{ next_version: number }[]>`
      SELECT COALESCE(MAX(version), 0) + 1 AS next_version
      FROM responses
      WHERE review_id = ${existing.id}
    `;
    const nextVersion = versionRow?.next_version ?? 1;

    await enqueueGenerateResponse(tx, {
      reviewId: existing.id,
      businessId,
      version: nextVersion,
      originLane,
      correlationId,
      suppressNotification,
    });

    return 'updated' as const;
  }

  if (activeResponse.status === 'pending_approval') {
    // Pending approval — fail the old response, generate a new one
    await tx`
      UPDATE responses
      SET status = 'failed', posting_error = 'review_content_changed', updated_at = NOW()
      WHERE id = ${activeResponse.id}
    `;

    const nextVersion = activeResponse.version + 1;
    await enqueueGenerateResponse(tx, {
      reviewId: existing.id,
      businessId,
      version: nextVersion,
      originLane,
      correlationId,
      suppressNotification,
    });

    return 'updated' as const;
  }

  if (
    activeResponse.status === 'posted' ||
    activeResponse.status === 'awaiting_owner_connect'
  ) {
    // Already posted/pending post — create review_exception + notify admin.
    // `awaiting_owner_connect` is included so an owner-approved response
    // queued for Zernio publish isn't silently discarded if the customer
    // edits their review while the owner is still reconnecting.
    const exceptionId = uuidv7();

    const inserted = await tx`
      INSERT INTO review_exceptions (id, business_id, review_id, response_id, type, status, payload)
      VALUES (
        ${exceptionId}, ${businessId}, ${existing.id}, ${activeResponse.id},
        'review_edited_after_post', 'open',
        ${tx.json({
          old_content_hash: existingHash,
          new_content_hash: contentHash,
          response_status: activeResponse.status,
        } as never)}
      )
      ON CONFLICT (review_id, type) WHERE status = 'open'
      DO NOTHING
    `;

    if (inserted.count > 0) {
      const notifyPayload: NotifyAdminExceptionPayload = {
        review_exception_id: exceptionId,
        business_id: businessId,
        correlation_id: correlationId,
      };

      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${uuidv7()}, ${QUEUE_NAMES.NOTIFY_ADMIN}, 'review', ${existing.id},
          ${tx.json(notifyPayload as never)}, 'pending'
        )
      `;
    }

    // Supersede the parked response so DrainOwnerConnectWorker doesn't
    // re-queue a stale response when the owner reconnects. 'posted' responses
    // are NOT superseded — that's truly terminal (the reply already exists on
    // Google; no further action is possible from our side).
    if (activeResponse.status === 'awaiting_owner_connect') {
      await tx`
        UPDATE responses
        SET status = 'superseded',
            posting_error = 'review_content_changed_during_park',
            updated_at = NOW()
        WHERE id = ${activeResponse.id}
      `;
    }

    return 'updated' as const;
  }

  // Other statuses (approved, edited) — supersede and regenerate
  await tx`
    UPDATE responses
    SET status = 'superseded', updated_at = NOW()
    WHERE id = ${activeResponse.id}
  `;

  const nextVersion = activeResponse.version + 1;
  await enqueueGenerateResponse(tx, {
    reviewId: existing.id,
    businessId,
    version: nextVersion,
    originLane,
    correlationId,
    suppressNotification,
  });

  return 'updated' as const;
}

// ── Review import (#674, spec §6.2) ──────────────────────────────────

/**
 * Store a review as inventory — insert and stop.
 *
 * The consented **Review import** stores reviews without writing replies for
 * them (spec D2). Sentiment is classified at the write site and the run spine
 * records `review_ingested`, but **no `generate_response` is enqueued** — so
 * this path writes no `job_outbox` row at all, and nothing it stores can reach
 * Google (invariant #3).
 *
 * Insert-only by construction. An existing review row is left completely
 * untouched — no content update, no supersede, no `review_exceptions`, no
 * admin notify — so a bulk import can never mutate a row the live-ingest lane
 * already owns. A genuinely edited review is picked up by the live lane's next
 * poll instead.
 *
 * There is deliberately no `SELECT … FOR UPDATE` probe: because an existing row
 * means zero writes, the INSERT's `ON CONFLICT` is the whole decision, and
 * taking no review lock keeps a 100-review import from contending with
 * concurrent live-ingest work. `'unchanged'` therefore covers both "the row
 * already existed" and "a concurrent writer won the race" — the two collapse to
 * the same skip, and neither falls through to `processExistingReview`.
 *
 * The run is **completed in this same transaction**. An imported review has no
 * draft and no publish, so no downstream worker would ever complete its run and
 * it would surface as `stalled` after 48h (`deriveRunDisplayState`,
 * `src/lib/agents/read.ts`). The import's work genuinely is finished when the
 * row lands; #678's on-demand Generate opens a fresh run per owner action.
 *
 * KNOWN HAZARD (deviations D4, owned by #675): if this call wins the identity
 * race against a concurrent live-ingest `processReview`, the loser re-reads
 * this row, finds the hash matches, and returns `'unchanged'` without
 * enqueueing — so that review is stored and never drafted.
 *
 * Callers screen reviews (PHI, normalization) before calling; precedent is the
 * `processUnansweredReview` closure inside `handleZernioBackfill`.
 */
export async function importReview(
  sql: Sql,
  monitored: MonitoredReview,
  businessId: string,
  correlationId?: string,
): Promise<'new' | 'unchanged'> {
  return await sql.begin(async (tx) => {
    const reviewId = uuidv7();
    const insertedCount = await insertNewReviewRow(tx, reviewId, businessId, monitored);

    if (insertedCount === 0) {
      return 'unchanged' as const;
    }

    const runId = await startReviewRun(tx, {
      reviewId,
      businessId,
      correlationId,
      stepKey: 'review_ingested',
    });

    if (runId) {
      await completeRun(tx, runId, 'completed');
    }

    await maybeEnqueueFirstReviewIngested(tx, { businessId, reviewId });

    return 'new' as const;
  });
}
