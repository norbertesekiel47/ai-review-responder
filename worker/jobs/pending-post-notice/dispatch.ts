// worker/jobs/pending-post-notice/dispatch.ts
//
// Per-channel delivery loop for the veto-window pending-post notice (WS4 spec
// §2.7). Clone of the escalation-notice dispatcher (bounced-owner email skip
// included from day one) with ONE structural difference: like the approval
// dispatcher — and unlike auto-post/escalation — it creates an approval link
// per delivery, because the notice's single CTA is the tokenized approve page
// (view / edit / cancel). Claim-before-send idempotency backed by the
// partial-unique index notification_deliveries_pending_post_notice_claim
// (migration 074): claim (response_id, channel, recipient) BEFORE the provider
// send, finalize with the provider id after ack.
//
// Log-hygiene contract: log lines carry ids ONLY. Review text and the draft
// preview are legal in the message body (private owner channel) but must
// never reach logs; the RAW TOKEN additionally must never reach Postgres
// (invariant #5), so it is redacted from failure_reason too.

import type { Sql } from 'postgres';
import { getChannel } from '../../../src/lib/notifications/channels';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import type { ResolvedChannel } from '../../../src/lib/notifications/resolve-channels';
import type { SendPendingPostNoticeParams } from '../../../src/lib/notifications/channels/types';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import { createApprovalLink } from '../../../src/lib/approval/create-link';
import {
  claimPendingPostNoticeDelivery,
  finalizeDeliverySent,
  failDelivery,
  releaseDeliveryClaim,
} from '../../../src/lib/notifications/delivery';
import { classifyPendingPostNoticeSendError } from './errors';

export interface PendingPostNoticeDispatchInput {
  responseId: string;
  businessId: string;
  accountId: string;
  /** APP_URL with trailing slash trimmed — per-delivery CTA is `${appUrl}/approve/<rawToken>`. */
  appUrl: string;
  business: { name: string; displayLabel: string | null; ownerEmailBounced: boolean };
  review: { reviewerName: string; starRating: number; reviewText: string | null };
  draft: {
    /** responses.approved_text — the auto-approved reply the notice previews. */
    responsePreview: string;
    /** responses.auto_post_scheduled_at — the veto deadline (channels own formatting). */
    scheduledPostAt: Date;
  };
}

export interface PendingPostNoticeDispatchResult {
  sent: number;
  skipped: number;
  terminalFailed: number;
  /** > 0 ⇒ the worker re-throws so BullMQ retries (released claims re-send). */
  retryableFailed: number;
}

/**
 * A provider error message may echo the message body (e.g. "invalid body:
 * <text>") — redact the known review text, draft preview, and raw token so
 * the warn lines never carry them (log-hygiene rule). The review/draft text
 * still lands unredacted in notification_deliveries.failure_reason (a DB
 * column, not a log line — escalation-notice precedent), but the RAW TOKEN is
 * redacted from that too: invariant #5 forbids raw tokens anywhere in
 * Postgres.
 */
function redactAll(reason: string, secrets: Array<string | null>): string {
  let redacted = reason;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

// per-channel delivery loop whose branches are the distinct claim→send outcomes
// (bounced-email/whatsapp pre-filters, dedup, link-create-failure, channel-skip,
// sent, retryable-release, terminal-fail); inherent to the one-pass fan-out over
// the delivery.ts claim helpers it orchestrates.
// fallow-ignore-next-line complexity
export async function dispatchPendingPostNotice(
  sql: Sql,
  input: PendingPostNoticeDispatchInput,
  enrollments: ResolvedChannel[],
  logger: WorkerLogger,
): Promise<PendingPostNoticeDispatchResult> {
  const result: PendingPostNoticeDispatchResult = {
    sent: 0,
    skipped: 0,
    terminalFailed: 0,
    retryableFailed: 0,
  };
  const locationLabel = input.business.displayLabel ?? input.business.name;
  const whatsappTemplateSid = getWorkerConfig().WHATSAPP_PENDING_POST_TEMPLATE_SID;

  for (const enrollment of enrollments) {
    const channelId = enrollment.channel;
    const recipient = enrollment.handle;

    // Pre-filter: a known-bounced owner email skips cleanly BEFORE any claim —
    // same rule as the approval + escalation dispatchers; the admin clears
    // owner_email_bounced from /admin/businesses/[id].
    if (channelId === 'email' && input.business.ownerEmailBounced) {
      result.skipped += 1;
      logger.log(
        `pending_post_notice skipped channel=email reason=owner_email_bounced response=${input.responseId}`,
      );
      continue;
    }

    // Pre-filter: WhatsApp without its pending-post template SID skips cleanly,
    // without constructing the client or recording a delivery row (WhatsApp is
    // business-initiated ⇒ approved template required, fails closed-and-logged).
    if (channelId === 'whatsapp' && !whatsappTemplateSid) {
      result.skipped += 1;
      logger.log(
        `pending_post_notice skipped channel=whatsapp reason=template_unset response=${input.responseId}`,
      );
      continue;
    }

    // The claim lives INSIDE the per-channel try so one channel's failure is
    // isolated. A claim/DB-infra failure (deliveryId still null) re-throws so
    // the WHOLE job retries rather than being mistaken for a per-channel send
    // failure — the notice must never be silently dropped.
    let deliveryId: string | null = null;
    let rawToken: string | null = null;
    try {
      // Claim BEFORE send — and BEFORE the link create. Two layers keep a
      // retry from revoking a link already delivered on this channel:
      // (1) this claim's dedup skip (primary — the ordering rationale: a
      //     retried job hits the live claim and never reaches the link
      //     create), and
      // (2) createApprovalLink's orphaned_only revoke check, whose
      //     delivered-template list includes 'pending_post_notice' alongside
      //     'approval_request' — do NOT re-narrow that list back to
      //     approval_request only, or layer (2) vanishes for this notice.
      // Do not "narrow the crash window" by moving the link create above the
      // claim. null ⇒ a live claim already exists.
      deliveryId = await claimPendingPostNoticeDelivery(sql, {
        accountId: input.accountId,
        businessId: input.businessId,
        responseId: input.responseId,
        channel: channelId,
        recipient,
      });
      if (deliveryId === null) {
        result.skipped += 1;
        logger.log(
          `pending_post_notice dedup channel=${channelId} response=${input.responseId} — already claimed`,
        );
        continue;
      }

      // ONE approval link per delivery — same helper + usage as the approval
      // dispatcher (48h TTL, per-channel revoke scoping). The raw token goes
      // ONLY into the message URL below; hash-at-rest in approval_links.
      // A createApprovalLink failure is DB work (its own tx) — transient by
      // nature — so release the claim and count it retryable; a terminal
      // failDelivery here would let one DB blip permanently suppress the
      // channel via the claim dedup.
      let approveUrl: string;
      try {
        const link = await createApprovalLink(sql, {
          responseId: input.responseId,
          businessId: input.businessId,
          channel: channelId,
        });
        rawToken = link.rawToken;
        approveUrl = `${input.appUrl}/approve/${link.rawToken}`;
      } catch (linkErr) {
        await releaseDeliveryClaim(sql, deliveryId);
        result.retryableFailed += 1;
        const reason = linkErr instanceof Error ? linkErr.message : String(linkErr);
        logger.warn(
          `pending_post_notice link-create-failed channel=${channelId} response=${input.responseId}: ${reason}`,
        );
        continue;
      }

      const params: SendPendingPostNoticeParams = {
        handle: recipient,
        locationLabel,
        businessName: input.business.name,
        reviewerName: input.review.reviewerName,
        starRating: input.review.starRating,
        reviewText: input.review.reviewText,
        responsePreview: input.draft.responsePreview,
        scheduledPostAt: input.draft.scheduledPostAt,
        approveUrl,
        responseId: input.responseId,
      };

      const sendResult = await getChannel(channelId).sendPendingPostNotice(params);
      if (sendResult.status === 'skipped') {
        // Channel declined after claim — release so a later config fix re-sends.
        await releaseDeliveryClaim(sql, deliveryId);
        result.skipped += 1;
        logger.log(
          `pending_post_notice skipped channel=${channelId} reason=${sendResult.reason} response=${input.responseId}`,
        );
        continue;
      }
      await finalizeDeliverySent(sql, deliveryId, sendResult.externalMessageId, logger);
      result.sent += 1;
      logger.log(`pending_post_notice sent channel=${channelId} response=${input.responseId}`);
    } catch (err) {
      if (deliveryId === null) {
        // The claim itself failed (DB infra) — re-throw so the whole job retries;
        // there is no claim to release and the notice must not be dropped.
        throw err;
      }
      const classification = classifyPendingPostNoticeSendError(err);
      const loggedReason = redactAll(classification.reason, [
        input.review.reviewText,
        input.draft.responsePreview,
        rawToken,
      ]);
      if (classification.retryable) {
        // RELEASE the claim so a BullMQ retry re-acquires + re-sends.
        await releaseDeliveryClaim(sql, deliveryId);
        result.retryableFailed += 1;
        logger.warn(
          `pending_post_notice retryable-failed channel=${channelId} response=${input.responseId}: ${loggedReason}`,
        );
      } else {
        // TERMINAL: keep the claim as a recorded failed delivery (NOT deleted —
        // its presence suppresses a pointless retry, and it is the
        // observability row). Raw token redacted (invariant #5 — never in
        // Postgres); review/draft text may remain (DB column, not a log).
        await failDelivery(sql, deliveryId, redactAll(classification.reason, [rawToken]), logger);
        result.terminalFailed += 1;
        logger.warn(
          `pending_post_notice terminal-failed channel=${channelId} response=${input.responseId}: ${loggedReason}`,
        );
      }
    }
  }

  return result;
}
