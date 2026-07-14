import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import {
  activeOffboardingStateFromProjection,
  isPublishingBlocked,
} from '../../../src/lib/account-offboarding/gate';
import { checkSubscription } from '../../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../../src/lib/shared/outbox';
import type { PublishResponsePayload } from '../../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { asLocationId } from '../../../src/lib/shared/ids';
import type { LocationId } from '../../../src/lib/shared/ids';
import { autoApprovalRuntimeEnabled } from '../../../src/lib/auto-approval/flags';
import { replyEditingFlagEnabled } from '../../../src/lib/past-replies/flags';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';
import { loadPublishResponseContext } from './load-context';
import { postReplyAndHandleTerminalOutcomes } from './post-reply';
import { resolvePublishTarget } from './review-lookup';
import { runEditPublishIfApplicable } from './edit-publish';
import { isOrphanMarker } from '../../../src/lib/publishing/orphan-markers';
import { maybeCaptureActivationCompleted } from './activation';
import { downgradeAutoApprovedResponseForManualReview } from './auto-policy-downgrade';
import { enforceElapsedVetoWindow } from './veto-window-gate';
import { applyJudgeGate } from './judge-gate';
import { markPostedAndMaybeEnqueueAutoPostNotice } from './mark-posted';
import { isHeldForModerationReview } from './held-flag-gate';

export async function handlePublishResponse(
  sql: Sql,
  job: Job<PublishResponsePayload>,
): Promise<void> {
  const logger = createWorkerLogger('[ResponsePublisherWorker]', job.data.correlation_id);
  const { response_id } = job.data;
  // Cast job data IDs to branded types at entry point
  const businessId: LocationId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const context = await loadPublishResponseContext(sql, {
    responseId: response_id,
    businessId,
    outboxId,
    outboxAttempt,
    logger,
  });
  if (context === 'terminal') return;

  const { response, business } = context;

  const offboardingState = activeOffboardingStateFromProjection(business);
  if (isPublishingBlocked(offboardingState)) {
    logger.warn(
      `Business ${businessId} account is offboarding; skipping public publish for response ${response_id}`,
    );
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

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
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  // ── Auto-policy kill-switch downgrade (before any external call) ────
  if (
    response.approval_method === APPROVAL_METHOD.AUTO_POLICY &&
    !autoApprovalRuntimeEnabled()
  ) {
    await downgradeAutoApprovedResponseForManualReview(sql, {
      responseId: response_id,
      businessId,
      outboxId,
      outboxAttempt,
      correlationId: job.data.correlation_id,
      logger,
    });
    return;
  }

  // ── Auto-policy notice-delivery gate (spec §2.11) ────────────────────
  // An unnotified auto-post fails toward the owner — the veto window is only
  // real if the owner could see it, and only for its FULL duration: the gate
  // requires a complete veto window elapsed since the FIRST delivered
  // pending-post notice, pushing the deadline for late deliveries. Zero
  // DELIVERED notices at publish time ⇒ downgrade to owner review instead of
  // posting. Placement: this runs BEFORE any external call, so a racing
  // notice-send between the check and the post is benign (fail-toward-owner:
  // worst case the owner manually reviews a draft they were just told would
  // auto-post).
  if (response.approval_method === APPROVAL_METHOD.AUTO_POLICY) {
    const vetoGate = await enforceElapsedVetoWindow(sql, {
      responseId: response_id,
      businessId,
      outboxId,
      outboxAttempt,
      correlationId: job.data.correlation_id,
      logger,
    });
    if (vetoGate === 'downgrade') {
      await downgradeAutoApprovedResponseForManualReview(sql, {
        responseId: response_id,
        businessId,
        outboxId,
        outboxAttempt,
        correlationId: job.data.correlation_id,
        reason: 'notice_undelivered',
        logger,
      });
      return;
    }
    if (vetoGate === 'completed') return;
  }

  // ── Archived-location terminal ──────────────────────────────────────
  if (business.archived_at !== null) {
    logger.warn(
      `Business ${businessId} is archived; skipping public publish for response ${response_id}`,
    );
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
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
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  // ── Moderation hold gate (F-5 belt-and-suspenders) ─────────
  // Refuse to post when an open moderation flag holds the draft. Non-exploitable
  // today (flagged drafts stay `pending_approval` and never reach here), but this
  // makes the moderation veto binding on the publish path, not just the owner UI.
  if (await isHeldForModerationReview(sql, response_id, businessId)) {
    logger.warn(
      `Response ${response_id} has an open moderation flag; refusing to publish (F-5).`,
    );
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  // ── Judge availability gate (WS6) ────────────────────────────────────
  // Placement: AFTER the cheap quiet terminals (archived location,
  // subscription guard, moderation hold — all cheaper than the two fleet
  // health queries, and a row those gates would quietly terminate must not be
  // downgraded+notified instead), and BEFORE resolvePublishTarget so no
  // external call can happen without a live Judge. The WS4 kill-switch and
  // veto-window/notice gates above keep their relative order.
  if (response.approval_method === APPROVAL_METHOD.AUTO_POLICY) {
    const judgeGate = await applyJudgeGate(sql, {
      responseId: response_id,
      businessId,
      outboxId,
      outboxAttempt,
      correlationId: job.data.correlation_id,
      logger,
    });
    if (judgeGate === 'downgraded') return;
  }

  // ── Resolve the publishing target via the ReviewPublisher seam ──────
  // The seam owns the active-connection lookup + provider review-id resolution.
  // Every non-success outcome (no connection → park, review-not-found →
  // exception, transient → retry) is dispositioned inside resolvePublishTarget,
  // which returns 'completed' (terminal here) or throws for BullMQ retry.
  const approvedText = response.approved_text ?? '';
  if (!response.approved_text) {
    logger.warn(
      `Response ${response_id} has null approved_text — Zernio reply body will be empty`,
    );
  }

  const target = await resolvePublishTarget(sql, {
    responseId: response_id,
    businessId,
    reviewId: response.review_id,
    responseStatus: response.status,
    outboxId,
    outboxAttempt,
    logger,
  });
  if (target === 'completed') return;

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
  if (replyEditingFlagEnabled()) {
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
      // Invariant (Codex R2 #2): auto-approval is `live_ingest_new` v1 only, so
      // an `approval_method='auto_policy'` response can NEVER reach the
      // owner-edit / orphan publish writers (edit-publish.ts /
      // edit-publish-errors.ts). Their success paths DO now route through
      // markPostedAndMaybeEnqueueAutoPostNotice (step 7 since Task 11; the
      // edit-lane 409 recovery since the WS4 fix round), so the FYI would fire
      // correctly — this assert remains as defense-in-depth on the spec
      // invariant itself: an auto_policy row entering the edit lane means the
      // v1 eligibility gate broke somewhere upstream, which must surface
      // loudly, not post silently. Assert HERE, only when actually entering
      // the edit path, so a first-time auto-approved publish (no posted
      // sibling, no orphan marker) still falls through to the fresh POST path
      // below.
      if (response.approval_method === APPROVAL_METHOD.AUTO_POLICY) {
        throw new Error(
          `Invariant violation: auto_policy response ${response_id} reached the edit-publish path`,
        );
      }
      const result = await runEditPublishIfApplicable(sql, {
        responseId: response_id,
        businessId,
        reviewId: response.review_id,
        approvedText,
        responsePostingError: response.posting_error,
        zernioAccountId: target.locator.accountId,
        zernioLocationId: target.locator.locationId,
        zernioReviewId: target.locator.providerReviewId,
        correlationId: job.data.correlation_id,
        logger,
      });

      switch (result.outcome) {
        case 'completed':
          if (result.postedResponse) {
            await maybeCaptureActivationCompleted(sql, result.postedResponse);
          }
          await markOutboxCompleted(sql, outboxId, outboxAttempt);
          return;
        case 'failed':
          await markOutboxFailed(sql, outboxId, result.reason, outboxAttempt);
          return;
        case 'throw':
          throw result.error;
        case 'continue_to_fresh':
          break;
      }
    }
  }

  const postOutcome = await postReplyAndHandleTerminalOutcomes(sql, {
    target,
    approvedText,
    outboxId,
    outboxAttempt,
    correlationId: job.data.correlation_id,
    logger,
  });
  if (postOutcome === 'completed') return;

  // ── Success: mark posted (+ enqueue the auto-post FYI for auto_policy) ─────
  // Wrapped in one tx so the status flip + FYI enqueue are atomic (invariant
  // #2). Safe under retry: a retry-after-rollback re-posts → Zernio 409 →
  // verify409AndDispose recovers via the same shared helper, and the
  // status-guarded UPDATE no-ops once already posted (Codex R1 #1).
  await sql.begin(async (tx) => {
    await markPostedAndMaybeEnqueueAutoPostNotice({
      tx,
      responseId: response_id,
      reviewId: response.review_id,
      businessId,
      correlationId: job.data.correlation_id,
      logger,
    });
  });

  logger.log(
    `Response ${response_id} posted via Zernio for business ${businessId}`,
  );

  await maybeCaptureActivationCompleted(sql, {
    responseId: response_id,
    businessId,
    reviewId: response.review_id,
    logger,
  });

  await markOutboxCompleted(sql, outboxId, outboxAttempt);
}
