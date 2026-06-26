// worker/jobs/auto-post-notice/AutoPostNoticeWorker.ts
//
// Orchestrator for the auto-approved post FYI (Workstream B). Loads the
// posted-auto_policy response + business context, reuses the approval worker's
// eligibility primitive (subscription guard + resolveChannels + flag filter),
// then hands off to the FYI-specific dispatcher. NEVER mutates the
// already-posted response (B9 failure isolation): a send failure retries on
// this job alone.
//
// Distinct asserted terminal signals (Codex R1 #11) via structured logs:
//   enqueued (publisher) · skip (context) · no-eligible-channels · no-google-url
//   · sent / skipped / terminal_failed / retryable_failed (dispatch).

import type { Job } from 'bullmq';
import {
  markOutboxCompleted,
  markOutboxFailed,
  extractOutboxHandle,
} from '../../../src/lib/shared/outbox';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import type { AutoPostNoticePayload } from '../../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { asLocationId } from '../../../src/lib/shared/ids';
import type { LocationId } from '../../../src/lib/shared/ids';
import { getEligibleChannels } from '../notification/eligibility';
import { loadAutoPostNoticeContext } from './context';
import { dispatchAutoPostNotice } from './dispatch';

// fallow-ignore-next-line complexity — entry-point orchestration (invariant #12): a flat guard-and-return sequence (context fail/skip, eligibility ok/empty, missing app-url, null google-url, systemic-failure, retryable-throw); cyclomatic count is the distinct-outcome vocabulary, not tangled logic.
export async function handleAutoPostNotice(job: Job<AutoPostNoticePayload>): Promise<void> {
  const logger = createWorkerLogger('[AutoPostNoticeWorker]', job.data.correlation_id);
  const { response_id } = job.data;
  const businessId: LocationId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const ctx = await loadAutoPostNoticeContext({ responseId: response_id, businessId }, logger);
  if (ctx.kind === 'fail') {
    await markOutboxFailed(outboxId, ctx.reason, outboxAttempt);
    return;
  }
  if (ctx.kind === 'skip') {
    logger.log(`auto_post_notice skip response=${response_id} reason=${ctx.reason}`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // Reuse the approval worker's subscription guard + resolveChannels + flag
  // filter. B9: if the account cancelled between post and send, this skips.
  const eligibility = await getEligibleChannels(
    {
      accountId: ctx.business.account_id,
      locationId: businessId,
      subscriptionStatus: ctx.business.subscription_status,
      pastDueAt: ctx.business.account_past_due_at,
      accountFlags: ctx.business.account_flags ?? {},
    },
    logger,
  );
  if (!eligibility.ok) {
    logger.log(`auto_post_notice no-eligible-channels response=${response_id} reason=${eligibility.reason}`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }
  if (eligibility.enrollments.length === 0) {
    logger.log(`auto_post_notice no-eligible-channels response=${response_id} reason=all_channels_flag_disabled`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const appUrl = getWorkerConfig().NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    logger.error('NEXT_PUBLIC_APP_URL not set — cannot construct the FYI view URL');
    await markOutboxFailed(outboxId, 'NEXT_PUBLIC_APP_URL not configured', outboxAttempt);
    return;
  }
  const viewUrl = `${appUrl.replace(/\/$/, '')}/r/google/${response_id}`;

  if (ctx.business.google_maps_url === null) {
    logger.log(`auto_post_notice no-google-url response=${response_id} — free-form channels omit the CTA`);
  }

  const dispatch = await dispatchAutoPostNotice(
    {
      responseId: response_id,
      businessId,
      accountId: ctx.business.account_id,
      viewUrl,
      business: {
        name: ctx.business.name,
        displayLabel: ctx.business.display_label,
        googleMapsUrl: ctx.business.google_maps_url,
      },
      review: {
        reviewerName: ctx.response.reviewer_name,
        starRating: ctx.response.star_rating,
      },
    },
    eligibility.enrollments,
    logger,
  );

  logger.log(
    `auto_post_notice done response=${response_id} sent=${dispatch.sent} skipped=${dispatch.skipped} ` +
    `terminal_failed=${dispatch.terminalFailed} retryable_failed=${dispatch.retryableFailed}`,
  );

  // Systemic-failure signal (Codex review #4): if EVERY eligible channel failed
  // (nothing sent), surface at error level so it alerts — the per-channel warn
  // lines alone would not. The Google post still succeeded; only the FYI failed.
  const totalFailed = dispatch.terminalFailed + dispatch.retryableFailed;
  if (dispatch.sent === 0 && totalFailed > 0) {
    logger.error(
      `auto_post_notice systemic-failure response=${response_id} — all ${totalFailed} channel send(s) failed, no FYI delivered`,
    );
  }

  // B9: never mutate the already-posted response. Retry ONLY when a transient
  // failure left work to do (the released claims let those channels re-send);
  // terminal failures are recorded and done.
  if (dispatch.retryableFailed > 0) {
    throw new Error(
      `auto_post_notice: ${dispatch.retryableFailed} retryable channel failure(s) for response ${response_id} — BullMQ will retry.`,
    );
  }

  await markOutboxCompleted(outboxId, outboxAttempt);
}
