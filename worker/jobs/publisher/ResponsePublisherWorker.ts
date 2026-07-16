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
import { replyEditingFlagEnabled } from '../../../src/lib/past-replies/flags';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';
import { loadPublishResponseContext } from './load-context';
import { postReplyAndHandleTerminalOutcomes } from './post-reply';
import { resolvePublishTarget } from './review-lookup';
import { runEditPublishIfApplicable } from './edit-publish';
import { isOrphanMarker } from '../../../src/lib/publishing/orphan-markers';
import { maybeCaptureActivationCompleted } from './activation';
import { markPostedAndMaybeEnqueueAutoPostNotice } from './mark-posted';
import { isHeldForModerationReview } from './held-flag-gate';
import {
  hasAutoPolicyProviderAttemptMarker,
  publishAutoPolicyResponse,
} from './auto-policy-publish';

export async function handlePublishResponse(
  sql: Sql,
  job: Job<PublishResponsePayload>,
): Promise<void> {
  const logger = createWorkerLogger('[ResponsePublisherWorker]', job.data.correlation_id);
  const { response_id } = job.data;
  // Cast job data IDs to branded types at entry point
  const businessId: LocationId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // The pre-routing reads are independent (each keyed only by immutable
  // job.data ids) and run on the pool, so they parallelize safely — the
  // auto-policy lane re-reads everything FOR UPDATE anyway (2026-07-16 review
  // finding #10; these are routing hints only).
  const [context, hasProviderAttempt] = await Promise.all([
    loadPublishResponseContext(sql, {
      responseId: response_id,
      businessId,
      outboxId,
      outboxAttempt,
      logger,
    }),
    // A durable provider-attempt marker outranks stale local response state.
    // In particular, an owner veto may have cleared approval_method after a
    // 2xx whose verification was ambiguous; the locked auto lane must
    // reconcile provider truth before ordinary publishable/offboarding gates
    // can close it.
    hasAutoPolicyProviderAttemptMarker(sql, {
      outboxId,
      outboxAttempt,
    }),
  ]);
  if (context === 'terminal') return;

  const { response, business } = context;
  if (hasProviderAttempt) {
    await publishAutoPolicyResponse(sql, {
      responseId: response_id,
      reviewId: response.review_id,
      businessId,
      accountId: business.account_id,
      approvedText: response.approved_text ?? '',
      outboxId,
      outboxAttempt,
      correlationId: job.data.correlation_id,
      logger,
    });
    return;
  }

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

  // Auto-policy owns one fresh, locked safety lane. Runtime, notice/veto,
  // archive, subscription+tier, moderation, and Judge state are re-read under
  // review -> business -> response -> entitlement immediately before provider
  // work; cheap load-context fields are routing hints only.
  if (response.approval_method === APPROVAL_METHOD.AUTO_POLICY) {
    await publishAutoPolicyResponse(sql, {
      responseId: response_id,
      reviewId: response.review_id,
      businessId,
      accountId: business.account_id,
      approvedText: response.approved_text ?? '',
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
