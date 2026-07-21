// worker/jobs/pending-post-notice/PendingPostNoticeWorker.ts
//
// Orchestrator for the veto-window "your reply will post automatically"
// notice (WS4 spec §2.7). Re-checks AUTO_APPROVAL_ENABLED at SEND time (spec
// §2.12, WS3 §2.4 kill-switch semantics: flipping the flag off stops outbound
// noise without touching the response record — the publisher's downgrade
// backstop owns the record). Loads the still-scheduled auto_policy response +
// business context, reuses the approval worker's eligibility primitive
// (subscription guard + resolveChannels + flag filter — invariant #11 comes
// free), then hands off to the notice-specific dispatcher. NEVER mutates the
// response: a send failure retries on this job alone; the delayed publish
// outbox row is independent and fires at the deadline regardless.
//
// Distinct asserted terminal signals via structured logs:
//   flag-off skip · fail/skip reasons (context) · no-eligible-channels
//   · sent / skipped / dedup / retryable-failed / terminal-failed (dispatch)
//   · systemic-failure.

import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import {
  markOutboxCompleted,
  markOutboxFailed,
  extractOutboxHandle,
} from '../../../src/lib/shared/outbox';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import type { PendingPostNoticePayload } from '../../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { asLocationId } from '../../../src/lib/shared/ids';
import type { LocationId } from '../../../src/lib/shared/ids';
import { autoApprovalRuntimeEnabled } from '../../../src/lib/auto-approval/flags';
import { resolveEligibleChannels } from '../notification/eligibility';
import { loadPendingPostNoticeContext } from './context';
import { dispatchPendingPostNotice } from './dispatch';

// entry-point orchestration (invariant #12): a flat guard-and-return sequence
// (kill switch, context fail/skip, eligibility ok/empty, missing app-url,
// systemic-failure, retryable-throw); cyclomatic count is the distinct-outcome
// vocabulary, not tangled logic.
// fallow-ignore-next-line complexity
export async function handlePendingPostNotice(sql: Sql, job: Job<PendingPostNoticePayload>): Promise<void> {
  const logger = createWorkerLogger('[PendingPostNoticeWorker]', job.data.correlation_id);
  const { response_id } = job.data;
  const businessId: LocationId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // Kill switch FIRST (spec §2.12, WS3 §2.4 semantics): flag off ⇒ complete
  // the outbox entry without loading anything — no notice, no retry churn.
  // The record itself is the publisher-downgrade backstop's job, not ours.
  if (!autoApprovalRuntimeEnabled()) {
    logger.log(`pending_post_notice flag-off skip response=${response_id}`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  const ctx = await loadPendingPostNoticeContext(sql, { responseId: response_id, businessId }, logger);
  if (ctx.kind === 'fail') {
    await markOutboxFailed(sql, outboxId, ctx.reason, outboxAttempt);
    return;
  }
  if (ctx.kind === 'skip') {
    logger.log(`pending_post_notice skip response=${response_id} reason=${ctx.reason}`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  // Reuse the approval worker's subscription guard + resolveChannels + flag
  // filter (invariant #11). If the account cancelled between the auto-approval
  // and this send, this skips.
  const eligibility = await resolveEligibleChannels(sql, ctx.business, businessId, logger);
  if (!eligibility.ok) {
    logger.log(`pending_post_notice no-eligible-channels response=${response_id} reason=${eligibility.reason}`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }
  if (eligibility.enrollments.length === 0) {
    logger.log(`pending_post_notice no-eligible-channels response=${response_id} reason=all_channels_flag_disabled`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  const appUrl = getWorkerConfig().NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    logger.error('NEXT_PUBLIC_APP_URL not set — cannot construct the approve-page CTA URL');
    await markOutboxFailed(sql, outboxId, 'NEXT_PUBLIC_APP_URL not configured', outboxAttempt);
    return;
  }

  const dispatch = await dispatchPendingPostNotice(
    sql,
    {
      responseId: response_id,
      businessId,
      accountId: ctx.business.account_id,
      appUrl: appUrl.replace(/\/$/, ''),
      business: {
        name: ctx.business.name,
        displayLabel: ctx.business.display_label,
        ownerEmailBounced: ctx.business.owner_email_bounced,
      },
      review: {
        reviewerName: ctx.response.reviewer_name,
        starRating: ctx.response.star_rating,
        reviewText: ctx.response.review_text,
      },
      draft: {
        responsePreview: ctx.response.approved_text,
        scheduledPostAt: ctx.response.auto_post_scheduled_at,
      },
    },
    eligibility.enrollments,
    logger,
  );

  logger.log(
    `pending_post_notice done response=${response_id} sent=${dispatch.sent} skipped=${dispatch.skipped} ` +
    `terminal_failed=${dispatch.terminalFailed} retryable_failed=${dispatch.retryableFailed}`,
  );

  // Systemic-failure signal: if NOTHING was sent but at least one channel was
  // attempted (skips count — an all-skipped run also leaves the owner
  // unnotified), surface the distinct alertable signal. Warn-level: the
  // publisher's notice-delivery gate owns enforcement (it downgrades an
  // unnotified auto-post to owner review); this line is observability, and
  // the outbox entry still completes below.
  const totalFailed = dispatch.terminalFailed + dispatch.retryableFailed;
  const totalAttempted = dispatch.skipped + totalFailed;
  if (dispatch.sent === 0 && totalAttempted > 0) {
    logger.warn(
      `pending_post_notice systemic-failure response=${response_id} — 0 of ${totalAttempted} channel attempt(s) sent (${dispatch.skipped} skipped, ${totalFailed} failed), no notice delivered`,
    );
  }

  // Retry ONLY when a transient failure left work to do (the released claims
  // let those channels re-send); terminal failures are recorded and done.
  if (dispatch.retryableFailed > 0) {
    throw new Error(
      `pending_post_notice: ${dispatch.retryableFailed} retryable channel failure(s) for response ${response_id} — BullMQ will retry.`,
    );
  }

  // NO spine step here, deliberately — where the escalation-notice precedent
  // records `escalation_sent`, WS4 adds no new step keys (spec §2.6/§2.8):
  // notification_deliveries is the authoritative per-channel record, and the
  // veto outcome (if any) is recorded by the veto transition, not this worker.
  await markOutboxCompleted(sql, outboxId, outboxAttempt);
}
