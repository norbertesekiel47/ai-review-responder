// worker/jobs/solicitation-veto-notice/SolicitationVetoNoticeWorker.ts
//
// Orchestrator for the Auto-approval lane's Veto notice (#631 Task 5): "N
// review requests were auto-approved for {business}; they will send once
// your veto window closes; stop them from the Requests page." Loads the
// still-live `auto_policy` batch + business context, resolves eligible
// channels (subscription guard + resolveChannels + flag filter, invariant
// #11), then hands off to the notice-specific dispatcher.
//
// Owner re-lock decision 11: the family gates on BATCH STATE ONLY — no flag
// reads anywhere in this file (contrast pending-post-notice, which re-checks
// AUTO_APPROVAL_ENABLED as a kill switch; that precedent does NOT apply here).
//
// Distinct asserted terminal signals via structured logs:
//   context fail/skip · no-eligible-channels (systemic, decision 12)
//   · sent / skipped / dedup / retryable-failed / terminal-failed (dispatch)
//   · systemic-failure (dispatch's zero-sent half, decision 12).

import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import {
  markOutboxCompleted,
  markOutboxFailed,
  extractOutboxHandle,
} from '../../../src/lib/shared/outbox';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import type { SolicitationVetoNoticePayload } from '../../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { asLocationId } from '../../../src/lib/shared/ids';
import type { LocationId } from '../../../src/lib/shared/ids';
import { resolveEligibleChannels } from '../notification/eligibility';
import { loadSolicitationVetoNoticeContext } from './context';
import { dispatchSolicitationVetoNotice } from './dispatch';

// entry-point orchestration (invariant #12): a flat guard-and-return sequence
// (context fail/skip, eligibility ok/empty, missing app-url, retryable-throw);
// cyclomatic count is the distinct-outcome vocabulary, not tangled logic.
// fallow-ignore-next-line complexity
export async function handleSolicitationVetoNotice(
  sql: Sql,
  job: Job<SolicitationVetoNoticePayload>,
): Promise<void> {
  const logger = createWorkerLogger('[SolicitationVetoNoticeWorker]', job.data.correlation_id);
  const { batch_id } = job.data;
  const businessId: LocationId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // NO flag reads (decision 11) — the family gates on BATCH STATE only.
  const ctx = await loadSolicitationVetoNoticeContext(sql, { batchId: batch_id, businessId }, logger);
  if (ctx.kind === 'fail') {
    await markOutboxFailed(sql, outboxId, ctx.reason, outboxAttempt);
    return;
  }
  if (ctx.kind === 'skip') {
    // Quiet skip (decision 11): the batch is no longer a live auto_policy
    // batch (downgraded, halted, or closed) — the notice would be stale
    // noise, and none of those transitions is itself unnotified.
    logger.log(`solicitation_veto_notice skip batch=${batch_id} reason=${ctx.reason}`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  const eligibility = await resolveEligibleChannels(sql, ctx.business, businessId, logger);
  if (!eligibility.ok) {
    logger.log(`solicitation_veto_notice no-eligible-channels batch=${batch_id} reason=${eligibility.reason}`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }
  if (eligibility.enrollments.length === 0) {
    // Systemic-failure signal (decision 12, "Worker zero-enrolled" half): the
    // pending-post-notice precedent quietly completes here, but a fully
    // unenrolled owner is exactly the systemic-failure case
    // dispatchSolicitationVetoNotice's zero-sent check can never observe
    // (dispatch is never even called) — so THIS early return logs it instead.
    logger.warn(
      `solicitation_veto_notice systemic-failure batch=${batch_id} — no eligible channels enrolled, no notice delivered`,
    );
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  const appUrl = getWorkerConfig().NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    logger.error('NEXT_PUBLIC_APP_URL not set — cannot construct the Requests-page CTA URL');
    await markOutboxFailed(sql, outboxId, 'NEXT_PUBLIC_APP_URL not configured', outboxAttempt);
    return;
  }

  const dispatch = await dispatchSolicitationVetoNotice(
    sql,
    {
      batchId: batch_id,
      businessId,
      accountId: ctx.business.account_id,
      requestCount: ctx.requestCount,
      requestsUrl: `${appUrl.replace(/\/$/, '')}/dashboard/requests`,
      business: {
        name: ctx.business.name,
        displayLabel: ctx.business.display_label,
        ownerEmailBounced: ctx.business.owner_email_bounced,
      },
    },
    eligibility.enrollments,
    logger,
  );

  logger.log(
    `solicitation_veto_notice done batch=${batch_id} sent=${dispatch.sent} skipped=${dispatch.skipped} ` +
    `terminal_failed=${dispatch.terminalFailed} retryable_failed=${dispatch.retryableFailed}`,
  );

  // Retry ONLY when a transient failure left work to do (the released claims
  // let those channels re-send); terminal failures are recorded and done.
  if (dispatch.retryableFailed > 0) {
    throw new Error(
      `solicitation_veto_notice: ${dispatch.retryableFailed} retryable channel failure(s) for batch ${batch_id} — BullMQ will retry.`,
    );
  }

  // NO spine step here, deliberately — the granted veto window already lives
  // on the `batch_approved` step (Task 4), and the Veto anchor (Task 6) reads
  // notification_deliveries.sent_at directly, not a step this worker would
  // record.
  await markOutboxCompleted(sql, outboxId, outboxAttempt);
}
