import type { Job } from 'bullmq';
import { sql } from '../../../src/lib/db/server';
import { checkSubscription } from '../../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../../src/lib/shared/outbox';
import type { PublishResponsePayload } from '../../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { asLocationId } from '../../../src/lib/shared/ids';
import type { LocationId } from '../../../src/lib/shared/ids';
import { autoApprovalRuntimeEnabled } from '../../../src/lib/auto-approval/flags';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';
import { loadPublishResponseContext } from './load-context';
import { parkResponseForOwnerReconnect } from './no-connection';
import { postReplyAndHandleTerminalOutcomes } from './post-reply';
import { resolvePublishableZernioReviewId } from './review-lookup';
import { runEditPublishIfApplicable } from './edit-publish';
import { isOrphanMarker } from './orphan-markers';
import { maybeCaptureActivationCompleted } from './activation';
import { downgradeAutoApprovedResponseForManualReview } from './auto-policy-downgrade';
import type { ZernioConnectionRow } from './types';

export async function handlePublishResponse(
  job: Job<PublishResponsePayload>,
): Promise<void> {
  const logger = createWorkerLogger('[ResponsePublisherWorker]', job.data.correlation_id);
  const { response_id } = job.data;
  // Cast job data IDs to branded types at entry point
  const businessId: LocationId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const context = await loadPublishResponseContext({
    responseId: response_id,
    businessId,
    outboxId,
    outboxAttempt,
    logger,
  });
  if (context === 'terminal') return;

  const { response, business } = context;

  // ── Publishable-state gate ──────────────────────────────────
  //
  // Only proceed for states that represent owner-approved responses ready
  // to publish via Zernio. Bailing here is critical: without it, a 'failed'
  // or 'superseded' response would still call zernioClient.postReply,
  // creating a real reply on Google that we then fail to record (the
  // status-guarded UPDATE no-ops). 'pending_approval' would post an
  // unapproved response, violating the no-auto-posting invariant.
  //
  // This list mirrors the UPDATE WHERE clauses below and matches
  // AWAITING_PUBLISH_STATUSES exactly.
  const ZERNIO_PUBLISHABLE_STATES = ['approved', 'edited', 'awaiting_owner_connect'] as const;
  if (!(ZERNIO_PUBLISHABLE_STATES as readonly string[]).includes(response.status)) {
    logger.log(
      `Response ${response_id} not in publishable state (status=${response.status}), skipping`,
    );
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── Auto-policy kill-switch downgrade (before any external call) ────
  if (
    response.approval_method === APPROVAL_METHOD.AUTO_POLICY &&
    !autoApprovalRuntimeEnabled()
  ) {
    await downgradeAutoApprovedResponseForManualReview({
      responseId: response_id,
      businessId,
      outboxId,
      outboxAttempt,
      correlationId: job.data.correlation_id,
      logger,
    });
    return;
  }

  // ── Archived-location terminal ──────────────────────────────────────
  if (business.archived_at !== null) {
    logger.warn(
      `Business ${businessId} is archived; skipping public publish for response ${response_id}`,
    );
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── Subscription guard ─────────────────────────────────────
  const subCheck = checkSubscription({
    status: business.subscription_status,
    pastDueAt: business.account_past_due_at,
    accountFlags: business.account_flags ?? {},
    workerType: 'publisher',
  });

  if (!subCheck.allowed) {
    logger.warn(
      `Business ${businessId} subscription blocked: ${subCheck.reason}`,
    );
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── Load active Zernio connection ──────────────────────────
  const [zernioConnection] = await sql<ZernioConnectionRow[]>`
    SELECT zernio_account_id, zernio_location_id
    FROM zernio_connections
    WHERE business_id = ${businessId} AND status = 'active'
    LIMIT 1
  `;

  // ── Branch on connection presence ──────────────────────────
  if (!zernioConnection) {
    await parkResponseForOwnerReconnect({
      responseId: response_id,
      businessId,
      outboxId,
      outboxAttempt,
      responseStatus: response.status,
      logger,
    });
    return;
  }

  // Branch B — active connection found. Resolve Zernio's review id, then
  // post the reply.
  const approvedText = response.approved_text ?? '';
  if (!response.approved_text) {
    logger.warn(
      `Response ${response_id} has null approved_text — Zernio reply body will be empty`,
    );
  }

  const zernioReviewId = await resolvePublishableZernioReviewId({
    responseId: response_id,
    businessId,
    reviewId: response.review_id,
    zernioConnection,
    outboxId,
    outboxAttempt,
    logger,
  });
  if (zernioReviewId === 'completed') return;

  // ── Edit-publish dispatch (DELETE-before-POST) ──────────────
  //
  // When an owner edits an already-`posted` Google reply, the replacement
  // must DELETE the old reply before POSTing the new one. We enter that path
  // only when EDIT_REPLIES_ENABLED is on AND this is genuinely an edit: either
  // a sibling `posted` row exists for the same review (business-scoped), or
  // the candidate carries an orphan marker (a prior attempt already emptied
  // Google's slot). When the flag is off, this block is fully inert — the
  // predicate is never evaluated and the sibling probe never runs, so behavior
  // is byte-for-byte today's POST-only path. The module owns all DB mutations
  // + the locked DELETE+POST tx; the worker translates its outcome into the
  // existing outbox lifecycle.
  if (process.env.EDIT_REPLIES_ENABLED === 'true') {
    const [postedSibling] = await sql<{ id: string }[]>`
      SELECT id FROM responses
      WHERE review_id = ${response.review_id}
        AND status = 'posted'
        AND id <> ${response_id}
        AND business_id = ${businessId}
      LIMIT 1
    `;
    const hasPostedSibling = postedSibling !== undefined;
    const isOrphanRetry = isOrphanMarker(response.posting_error);

    if (hasPostedSibling || isOrphanRetry) {
      const result = await runEditPublishIfApplicable({
        responseId: response_id,
        businessId,
        reviewId: response.review_id,
        approvedText,
        responsePostingError: response.posting_error,
        zernioAccountId: zernioConnection.zernio_account_id,
        zernioLocationId: zernioConnection.zernio_location_id,
        zernioReviewId,
        correlationId: job.data.correlation_id,
        logger,
      });

      switch (result.outcome) {
        case 'completed':
          if (result.postedResponse) {
            await maybeCaptureActivationCompleted(result.postedResponse);
          }
          await markOutboxCompleted(outboxId, outboxAttempt);
          return;
        case 'failed':
          await markOutboxFailed(outboxId, result.reason, outboxAttempt);
          return;
        case 'throw':
          throw result.error;
        case 'continue_to_fresh':
          break;
      }
    }
  }

  const postOutcome = await postReplyAndHandleTerminalOutcomes({
    responseId: response_id,
    businessId,
    reviewId: response.review_id,
    zernioReviewId,
    approvedText,
    outboxId,
    outboxAttempt,
    correlationId: job.data.correlation_id,
    zernioConnection,
    logger,
  });
  if (postOutcome === 'completed') return;

  // ── Success: mark posted ────────────────────────────────────────────────
  await sql`
    UPDATE responses
    SET status = 'posted', posted_at = NOW(), updated_at = NOW()
    WHERE id = ${response_id}
      AND business_id = ${businessId}
      AND status IN ('approved', 'edited', 'awaiting_owner_connect')
  `;

  logger.log(
    `Response ${response_id} posted via Zernio for business ${businessId}`,
  );

  await maybeCaptureActivationCompleted({
    responseId: response_id,
    businessId,
    reviewId: response.review_id,
    logger,
  });

  await markOutboxCompleted(outboxId, outboxAttempt);
}
