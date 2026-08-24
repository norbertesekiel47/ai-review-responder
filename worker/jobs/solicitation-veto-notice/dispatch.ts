// worker/jobs/solicitation-veto-notice/dispatch.ts
//
// Per-channel delivery loop for the Auto-approval lane's Veto notice (#631
// Task 5). The notice is about a BATCH, not a response or a review:
// notification_deliveries rows use entity_id = batch id, response_id NULL,
// template 'solicitation_veto_notice' (migration 113's claim-before-send
// index). The CTA is tokenless — `${appUrl}/dashboard/requests` (decision
// 10) — so unlike pending-post-notice this dispatcher creates no approval
// link.
//
// Claim-before-send idempotency backed by
// notification_deliveries_solicitation_veto_notice_claim (migration 113):
// claim (entity_id, channel, recipient) BEFORE the provider send, finalize
// with the provider id after ack. A 'settled' claim result means a live send
// already delivered this channel — dedup, no re-send. A 'pending' result
// means an earlier claim is unresolved (still sending, or its finalize
// failed) — re-throw so the outbox row stays incomplete rather than risk a
// silent double-send (autonomy-suspended-notice precedent).
//
// Systemic-failure logging (decision 12) lives HERE, not deferred to the
// Worker: when every attempted channel skips or fails and NONE sends, that is
// exactly as unnotified as the Worker's zero-enrolled early return, and the
// two are the only two "zero" paths this family has.

import type { Sql } from 'postgres';
import { getChannel } from '../../../src/lib/notifications/channels';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import type { ResolvedChannel } from '../../../src/lib/notifications/resolve-channels';
import type { SendSolicitationVetoNoticeParams } from '../../../src/lib/notifications/channels/types';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import {
  claimSolicitationVetoNoticeDelivery,
  finalizeDeliverySent,
  failDelivery,
  releaseDeliveryClaim,
} from '../../../src/lib/notifications/delivery';
import { classifySolicitationVetoNoticeSendError } from './errors';

export interface SolicitationVetoNoticeDispatchInput {
  batchId: string;
  businessId: string;
  accountId: string;
  /** Live rendered Outreach count on the batch, read at send time. */
  requestCount: number;
  /** `${appUrl}/dashboard/requests` — tokenless CTA (decision 10). */
  requestsUrl: string;
  business: { name: string; displayLabel: string | null; ownerEmailBounced: boolean };
}

export interface SolicitationVetoNoticeDispatchResult {
  sent: number;
  skipped: number;
  terminalFailed: number;
  /** > 0 ⇒ the worker re-throws so BullMQ retries (released claims re-send). */
  retryableFailed: number;
}

// per-channel delivery loop whose branches are the distinct claim→send outcomes
// (bounced-email/whatsapp pre-filters, dedup, pending-claim throw, channel-skip,
// sent, retryable-release, terminal-fail); inherent to the one-pass fan-out over
// the delivery.ts claim helpers it orchestrates.
// fallow-ignore-next-line complexity
export async function dispatchSolicitationVetoNotice(
  sql: Sql,
  input: SolicitationVetoNoticeDispatchInput,
  enrollments: ResolvedChannel[],
  logger: WorkerLogger,
): Promise<SolicitationVetoNoticeDispatchResult> {
  const result: SolicitationVetoNoticeDispatchResult = {
    sent: 0,
    skipped: 0,
    terminalFailed: 0,
    retryableFailed: 0,
  };
  const locationLabel = input.business.displayLabel ?? input.business.name;
  const whatsappTemplateSid = getWorkerConfig().WHATSAPP_SOLICITATION_VETO_TEMPLATE_SID;

  for (const enrollment of enrollments) {
    const channelId = enrollment.channel;
    const recipient = enrollment.handle;

    // Pre-filter: a known-bounced owner email skips cleanly BEFORE any claim —
    // same rule as every other notice dispatcher. The admin clears
    // owner_email_bounced from /admin/businesses/[id].
    if (channelId === 'email' && input.business.ownerEmailBounced) {
      result.skipped += 1;
      logger.log(
        `solicitation_veto_notice skipped channel=email reason=owner_email_bounced batch=${input.batchId}`,
      );
      continue;
    }

    // Pre-filter: WhatsApp without its Veto notice template SID skips cleanly,
    // without constructing the client or recording a delivery row (WhatsApp is
    // business-initiated ⇒ approved template required, fails closed-and-logged).
    if (channelId === 'whatsapp' && !whatsappTemplateSid) {
      result.skipped += 1;
      logger.log(
        `solicitation_veto_notice skipped channel=whatsapp reason=template_unset batch=${input.batchId}`,
      );
      continue;
    }

    // Delivery lifecycle DB work is deliberately OUTSIDE the provider-send
    // catch (autonomy-suspended-notice precedent). A claim/finalize/release/fail
    // error is infrastructure failure and must rethrow unchanged — classifying
    // it as a provider error could falsely settle a notice whose provider side
    // effect already succeeded.
    const claim = await claimSolicitationVetoNoticeDelivery(sql, {
      accountId: input.accountId,
      businessId: input.businessId,
      batchId: input.batchId,
      channel: channelId,
      recipient,
    });
    if (claim.kind === 'settled') {
      result.skipped += 1;
      logger.log(`solicitation_veto_notice dedup channel=${channelId} batch=${input.batchId}`);
      continue;
    }
    if (claim.kind === 'pending') {
      // Do not complete the outbox while a live claim is unresolved — same
      // contract as autonomy-suspended-notice.
      throw new Error(
        `solicitation_veto_notice pending delivery claim channel=${channelId} batch=${input.batchId}`,
      );
    }
    const deliveryId = claim.deliveryId;

    const params: SendSolicitationVetoNoticeParams = {
      handle: recipient,
      locationLabel,
      businessName: input.business.name,
      requestCount: input.requestCount,
      requestsUrl: input.requestsUrl,
      batchId: input.batchId,
    };

    try {
      const sendResult = await getChannel(channelId).sendSolicitationVetoNotice(params);
      if (sendResult.status === 'skipped') {
        // Channel declined after claim — release so a later config fix re-sends.
        await releaseDeliveryClaim(sql, deliveryId);
        result.skipped += 1;
        logger.log(
          `solicitation_veto_notice skipped channel=${channelId} reason=${sendResult.reason} batch=${input.batchId}`,
        );
        continue;
      }
      await finalizeDeliverySent(sql, deliveryId, sendResult.externalMessageId, logger);
      result.sent += 1;
      logger.log(`solicitation_veto_notice sent channel=${channelId} batch=${input.batchId}`);
    } catch (err) {
      const classification = classifySolicitationVetoNoticeSendError(err);
      if (classification.retryable) {
        // RELEASE the claim so a BullMQ retry re-acquires + re-sends.
        await releaseDeliveryClaim(sql, deliveryId);
        result.retryableFailed += 1;
        logger.warn(
          `solicitation_veto_notice retryable-failed channel=${channelId} batch=${input.batchId}: ${classification.reason}`,
        );
      } else {
        // TERMINAL: keep the claim as a recorded failed delivery (NOT deleted —
        // its presence suppresses a pointless retry, and it is the
        // observability row).
        await failDelivery(sql, deliveryId, classification.reason, logger);
        result.terminalFailed += 1;
        logger.warn(
          `solicitation_veto_notice terminal-failed channel=${channelId} batch=${input.batchId}: ${classification.reason}`,
        );
      }
    }
  }

  // Systemic-failure signal (decision 12, "dispatch zero-sent" half): if
  // NOTHING was sent but at least one channel was attempted (skips count — an
  // all-skipped run also leaves the owner unnotified), surface the distinct
  // alertable signal here rather than deferring it to the Worker.
  const totalFailed = result.terminalFailed + result.retryableFailed;
  const totalAttempted = result.skipped + totalFailed;
  if (result.sent === 0 && totalAttempted > 0) {
    logger.warn(
      `solicitation_veto_notice systemic-failure batch=${input.batchId} — 0 of ${totalAttempted} channel attempt(s) sent (${result.skipped} skipped, ${totalFailed} failed), no notice delivered`,
    );
  }

  return result;
}
