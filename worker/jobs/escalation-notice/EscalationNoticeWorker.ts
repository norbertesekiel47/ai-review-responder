// worker/jobs/escalation-notice/EscalationNoticeWorker.ts
//
// Orchestrator for the Guardian escalation notice (WS3). Loads the escalation
// + review + business context, reuses the approval worker's eligibility
// primitive (subscription guard + resolveChannels + flag filter), then hands
// off to the escalation-specific dispatcher. The kill switch is re-checked
// here at SEND time (spec §2.4): flipping ESCALATION_ENABLED off stops
// outbound notices without hiding already-raised escalations.
//
// After sends it records the `escalation_sent` step on the review's active
// run — review row FOR UPDATE FIRST (lock-ordering rule), then the spine
// write. Step recording is BEST-EFFORT after the send (log-and-swallow): the
// notices are already delivered, so a step-tx failure must not fail the job —
// a retry would dedup on the claims (sent=0) and could never recover the
// step. notification_deliveries is the authoritative per-channel record.
//
// Distinct asserted terminal signals via structured logs:
//   flag-off skip · fail/skip reasons (context) · no-eligible-channels
//   · sent / skipped / dedup / retryable-failed / terminal-failed (dispatch)
//   · systemic-failure · step-record-failed.

import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import {
  markOutboxCompleted,
  markOutboxFailed,
  extractOutboxHandle,
} from '../../../src/lib/shared/outbox';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import type { EscalationNoticePayload } from '../../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { asLocationId } from '../../../src/lib/shared/ids';
import type { LocationId } from '../../../src/lib/shared/ids';
import { escalationEnabled } from '../../../src/lib/escalations/flags';
import { TRIAGE_SOURCE } from '../../../src/lib/reviews/triage-schema';
import { findActiveReviewRun, recordStep } from '../../../src/lib/agents/run-spine';
import { getEligibleChannels } from '../notification/eligibility';
import { loadEscalationNoticeContext } from './context';
import { dispatchEscalationNotice } from './dispatch';

// entry-point orchestration (invariant #12): a flat guard-and-return sequence
// (kill switch, context fail/skip, eligibility ok/empty, missing app-url,
// systemic-failure, retryable-throw, step-on-success); cyclomatic count is the
// distinct-outcome vocabulary, not tangled logic.
// fallow-ignore-next-line complexity
export async function handleEscalationNotice(sql: Sql, job: Job<EscalationNoticePayload>): Promise<void> {
  const logger = createWorkerLogger('[EscalationNoticeWorker]', job.data.correlation_id);
  const { escalation_id } = job.data;
  const businessId: LocationId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // Kill switch FIRST (spec §2.4): flag off ⇒ complete the outbox entry
  // without loading anything — no notice, no retry churn.
  if (!escalationEnabled()) {
    logger.log(`escalation_notice flag-off skip escalation=${escalation_id}`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  const ctx = await loadEscalationNoticeContext(sql, { escalationId: escalation_id, businessId }, logger);
  if (ctx.kind === 'fail') {
    await markOutboxFailed(sql, outboxId, ctx.reason, outboxAttempt);
    return;
  }
  if (ctx.kind === 'skip') {
    logger.log(`escalation_notice skip escalation=${escalation_id} reason=${ctx.reason}`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  // Reuse the approval worker's subscription guard + resolveChannels + flag
  // filter. If the account cancelled between raise and send, this skips.
  const eligibility = await getEligibleChannels(
    sql,
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
    logger.log(`escalation_notice no-eligible-channels escalation=${escalation_id} reason=${eligibility.reason}`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }
  if (eligibility.enrollments.length === 0) {
    logger.log(`escalation_notice no-eligible-channels escalation=${escalation_id} reason=all_channels_flag_disabled`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  const appUrl = getWorkerConfig().NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    logger.error('NEXT_PUBLIC_APP_URL not set — cannot construct the dashboard CTA URL');
    await markOutboxFailed(sql, outboxId, 'NEXT_PUBLIC_APP_URL not configured', outboxAttempt);
    return;
  }
  const dashboardUrl = `${appUrl.replace(/\/$/, '')}/dashboard/reviews`;

  const dispatch = await dispatchEscalationNotice(
    sql,
    {
      escalationId: escalation_id,
      businessId,
      accountId: ctx.escalation.account_id,
      dashboardUrl,
      business: {
        name: ctx.business.name,
        displayLabel: ctx.business.display_label,
        ownerEmailBounced: ctx.business.owner_email_bounced,
      },
      review: {
        reviewerName: ctx.escalation.reviewer_name,
        starRating: ctx.escalation.star_rating,
        reviewText: ctx.escalation.review_text,
      },
      triage: {
        severity: ctx.escalation.triage_severity,
        issues: ctx.escalation.triage_issues ?? [],
        isFallback: ctx.escalation.triage_source === TRIAGE_SOURCE.FALLBACK,
      },
    },
    eligibility.enrollments,
    logger,
  );

  logger.log(
    `escalation_notice done escalation=${escalation_id} sent=${dispatch.sent} skipped=${dispatch.skipped} ` +
    `terminal_failed=${dispatch.terminalFailed} retryable_failed=${dispatch.retryableFailed}`,
  );

  // Systemic-failure signal: if EVERY eligible channel failed (nothing sent),
  // surface at error level so it alerts — the per-channel warn lines alone
  // would not. The escalation row itself is intact; only the notice failed.
  const totalFailed = dispatch.terminalFailed + dispatch.retryableFailed;
  if (dispatch.sent === 0 && totalFailed > 0) {
    logger.error(
      `escalation_notice systemic-failure escalation=${escalation_id} — all ${totalFailed} channel send(s) failed, no notice delivered`,
    );
  }

  // Retry ONLY when a transient failure left work to do (the released claims
  // let those channels re-send). Throw BEFORE the step write so a partial
  // send never records escalation_sent while sends are still outstanding.
  if (dispatch.retryableFailed > 0) {
    throw new Error(
      `escalation_notice: ${dispatch.retryableFailed} retryable channel failure(s) for escalation ${escalation_id} — BullMQ will retry.`,
    );
  }

  if (dispatch.sent > 0) {
    // BEST-EFFORT step recording (log-and-swallow): the notices are the
    // primary side effect and are already sent — a step-tx failure must not
    // flip this job to failed (a retry would dedup on the claims, report
    // sent=0, and could never re-attempt the step anyway).
    try {
      await sql.begin(async (tx) => {
        // Lock-ordering rule: review row FIRST, then any spine write.
        const locked = await tx<{ id: string }[]>`
          SELECT id FROM reviews WHERE id = ${ctx.escalation.review_id} FOR UPDATE
        `;
        if (locked.count === 0) return;
        const activeRun = await findActiveReviewRun(tx, ctx.escalation.review_id);
        if (!activeRun) return;
        await recordStep(tx, {
          runId: activeRun.id,
          stepKey: 'escalation_sent',
          // Counts are PER-ATTEMPT: after a partial retry the step may say
          // sent=1 even though two channels delivered overall. The
          // notification_deliveries rows are the authoritative record.
          detail: {
            escalation_id: ctx.escalation.id,
            sent: dispatch.sent,
            skipped: dispatch.skipped,
            terminal_failed: dispatch.terminalFailed,
          },
        });
      });
    } catch (err) {
      logger.error(
        `escalation_notice step-record-failed escalation=${escalation_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await markOutboxCompleted(sql, outboxId, outboxAttempt);
}
