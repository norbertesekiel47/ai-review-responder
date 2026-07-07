// worker/jobs/escalation-notice/dispatch.ts
//
// Per-channel delivery loop for the Guardian escalation notice (WS3).
// SEPARATE from the approval dispatcher: it reuses only low-level primitives
// (channel send + delivery-row recording + error classification) and creates
// NO approval_links. Claim-before-send idempotency backed by the
// partial-unique index notification_deliveries_escalation_notice_claim
// (migration 073): claim (escalation_id, channel, recipient) BEFORE the
// provider send, finalize with the provider id after ack.
//
// Log lines carry escalation ids ONLY — review text is legal in the message
// body (private owner channel) but must never reach logs.

import type { Sql } from 'postgres';
import { getChannel } from '../../../src/lib/notifications/channels';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import type { ResolvedChannel } from '../../../src/lib/notifications/resolve-channels';
import type { SendEscalationNoticeParams } from '../../../src/lib/notifications/channels/types';
import type { TriageIssue, TriageSeverity } from '../../../src/lib/reviews/triage-schema';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import {
  claimEscalationNoticeDelivery,
  finalizeDeliverySent,
  failDelivery,
  releaseDeliveryClaim,
} from '../../../src/lib/notifications/delivery';
import { classifyEscalationNoticeSendError } from './errors';

export interface EscalationNoticeDispatchInput {
  escalationId: string;
  businessId: string;
  accountId: string;
  /** `${APP_URL}/dashboard/reviews` — the acknowledge surface (spec §2.7). */
  dashboardUrl: string;
  business: { name: string; displayLabel: string | null };
  review: { reviewerName: string; starRating: number | null; reviewText: string | null };
  triage: {
    severity: TriageSeverity;
    issues: TriageIssue[];
    /** triage_source === 'fallback_high_v1' ⇒ "couldn't assess" copy. */
    isFallback: boolean;
  };
}

export interface EscalationNoticeDispatchResult {
  sent: number;
  skipped: number;
  terminalFailed: number;
  /** > 0 ⇒ the worker re-throws so BullMQ retries (released claims re-send). */
  retryableFailed: number;
}

/**
 * A provider error message may echo the message body (e.g. "invalid body:
 * <text>") — redact the known review text so the warn lines never carry it
 * (log-hygiene rule: never log raw review text). The UNREDACTED reason still
 * lands in notification_deliveries.failure_reason for terminal failures,
 * which is a DB column, not a log line.
 */
function redactReviewText(reason: string, reviewText: string | null): string {
  if (!reviewText) return reason;
  return reason.split(reviewText).join('[review_text]');
}

// per-channel delivery loop whose branches are the distinct claim→send outcomes
// (whatsapp pre-filter, dedup, channel-skip, sent, retryable-release, terminal-fail);
// inherent to the one-pass fan-out over the delivery.ts claim helpers it orchestrates.
// fallow-ignore-next-line complexity
export async function dispatchEscalationNotice(
  sql: Sql,
  input: EscalationNoticeDispatchInput,
  enrollments: ResolvedChannel[],
  logger: WorkerLogger,
): Promise<EscalationNoticeDispatchResult> {
  const result: EscalationNoticeDispatchResult = {
    sent: 0,
    skipped: 0,
    terminalFailed: 0,
    retryableFailed: 0,
  };
  const locationLabel = input.business.displayLabel ?? input.business.name;
  const whatsappTemplateSid = getWorkerConfig().WHATSAPP_ESCALATION_TEMPLATE_SID;

  for (const enrollment of enrollments) {
    const channelId = enrollment.channel;
    const recipient = enrollment.handle;

    // Pre-filter: WhatsApp without its escalation template SID skips cleanly,
    // without constructing the client or recording a delivery row.
    if (channelId === 'whatsapp' && !whatsappTemplateSid) {
      result.skipped += 1;
      logger.log(
        `escalation_notice skipped channel=whatsapp reason=template_unset escalation=${input.escalationId}`,
      );
      continue;
    }

    const params: SendEscalationNoticeParams = {
      handle: recipient,
      locationLabel,
      businessName: input.business.name,
      reviewerName: input.review.reviewerName,
      starRating: input.review.starRating,
      reviewText: input.review.reviewText,
      severity: input.triage.severity,
      issues: input.triage.issues,
      isFallback: input.triage.isFallback,
      dashboardUrl: input.dashboardUrl,
      escalationId: input.escalationId,
    };

    // The claim lives INSIDE the per-channel try so one channel's failure is
    // isolated. A claim/DB-infra failure (deliveryId still null) re-throws so
    // the WHOLE job retries rather than being mistaken for a per-channel send
    // failure — the notice must never be silently dropped.
    let deliveryId: string | null = null;
    try {
      // Claim BEFORE send. null ⇒ a live claim already exists.
      deliveryId = await claimEscalationNoticeDelivery(sql, {
        accountId: input.accountId,
        businessId: input.businessId,
        escalationId: input.escalationId,
        channel: channelId,
        recipient,
      });
      if (deliveryId === null) {
        result.skipped += 1;
        logger.log(
          `escalation_notice dedup channel=${channelId} escalation=${input.escalationId} — already claimed`,
        );
        continue;
      }

      const sendResult = await getChannel(channelId).sendEscalationNotice(params);
      if (sendResult.status === 'skipped') {
        // Channel declined after claim — release so a later config fix re-sends.
        await releaseDeliveryClaim(sql, deliveryId);
        result.skipped += 1;
        logger.log(
          `escalation_notice skipped channel=${channelId} reason=${sendResult.reason} escalation=${input.escalationId}`,
        );
        continue;
      }
      await finalizeDeliverySent(sql, deliveryId, sendResult.externalMessageId);
      result.sent += 1;
      logger.log(`escalation_notice sent channel=${channelId} escalation=${input.escalationId}`);
    } catch (err) {
      if (deliveryId === null) {
        // The claim itself failed (DB infra) — re-throw so the whole job retries;
        // there is no claim to release and the notice must not be dropped.
        throw err;
      }
      const classification = classifyEscalationNoticeSendError(err);
      const loggedReason = redactReviewText(classification.reason, input.review.reviewText);
      if (classification.retryable) {
        // RELEASE the claim so a BullMQ retry re-acquires + re-sends.
        await releaseDeliveryClaim(sql, deliveryId);
        result.retryableFailed += 1;
        logger.warn(
          `escalation_notice retryable-failed channel=${channelId} escalation=${input.escalationId}: ${loggedReason}`,
        );
      } else {
        // TERMINAL: keep the claim as a recorded failed delivery (NOT deleted —
        // its presence suppresses a pointless retry, and it is the
        // observability row).
        await failDelivery(sql, deliveryId, classification.reason);
        result.terminalFailed += 1;
        logger.warn(
          `escalation_notice terminal-failed channel=${channelId} escalation=${input.escalationId}: ${loggedReason}`,
        );
      }
    }
  }

  return result;
}
