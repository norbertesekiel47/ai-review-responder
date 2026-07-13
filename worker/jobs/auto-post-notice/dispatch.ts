// worker/jobs/auto-post-notice/dispatch.ts
//
// Per-channel delivery loop for the auto-approved post FYI. SEPARATE from the
// approval dispatcher (Codex R1 #4): it reuses only low-level primitives
// (channel send + delivery-row recording + error classification) and creates
// NO approval_links. Claim-before-send idempotency (Codex R1 #3 / R2 #4) backed
// by the partial-unique index notification_deliveries_auto_post_notice_claim
// (migration 067): claim (response_id, channel, recipient) BEFORE the provider
// send, finalize with the provider id after ack.

import type { Sql } from 'postgres';
import { getChannel } from '../../../src/lib/notifications/channels';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import type { ResolvedChannel } from '../../../src/lib/notifications/resolve-channels';
import type { SendAutoPostNoticeParams } from '../../../src/lib/notifications/channels/types';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import {
  claimAutoPostNoticeDelivery,
  finalizeDeliverySent,
  failDelivery,
  releaseDeliveryClaim,
} from '../../../src/lib/notifications/delivery';
import { classifyAutoPostNoticeSendError } from './errors';

export interface AutoPostNoticeDispatchInput {
  responseId: string;
  businessId: string;
  accountId: string;
  /** `${APP_URL}/r/google/${responseId}` — the hardened redirect CTA target. */
  viewUrl: string;
  business: { name: string; displayLabel: string | null; googleMapsUrl: string | null };
  review: { reviewerName: string; starRating: number };
}

export interface AutoPostNoticeDispatchResult {
  sent: number;
  skipped: number;
  terminalFailed: number;
  /** > 0 ⇒ the worker re-throws so BullMQ retries (released claims re-send). */
  retryableFailed: number;
}

// per-channel delivery loop whose branches are the distinct claim→send outcomes
// (whatsapp pre-filter, dedup, channel-skip, sent, retryable-release, terminal-fail);
// inherent to the one-pass fan-out over the delivery.ts claim helpers it orchestrates.
// fallow-ignore-next-line complexity
export async function dispatchAutoPostNotice(
  sql: Sql,
  input: AutoPostNoticeDispatchInput,
  enrollments: ResolvedChannel[],
  logger: WorkerLogger,
): Promise<AutoPostNoticeDispatchResult> {
  const result: AutoPostNoticeDispatchResult = {
    sent: 0,
    skipped: 0,
    terminalFailed: 0,
    retryableFailed: 0,
  };
  const locationLabel = input.business.displayLabel ?? input.business.name;
  const whatsappTemplateSid = getWorkerConfig().WHATSAPP_AUTOPOST_TEMPLATE_SID;

  for (const enrollment of enrollments) {
    const channelId = enrollment.channel;
    const recipient = enrollment.handle;

    // B7 pre-filter: WhatsApp without its FYI template SID skips cleanly,
    // without constructing the client or recording a delivery row.
    if (channelId === 'whatsapp' && !whatsappTemplateSid) {
      result.skipped += 1;
      logger.log(
        `auto_post_notice skipped channel=whatsapp reason=template_unset response=${input.responseId}`,
      );
      continue;
    }

    const params: SendAutoPostNoticeParams = {
      handle: recipient,
      locationLabel,
      businessName: input.business.name,
      reviewerName: input.review.reviewerName,
      starRating: input.review.starRating,
      googleMapsUrl: input.business.googleMapsUrl,
      viewUrl: input.viewUrl,
      responseId: input.responseId,
    };

    // The claim lives INSIDE the per-channel try (Codex review #5) so one
    // channel's failure is isolated. A claim/DB-infra failure (deliveryId still
    // null) re-throws so the WHOLE job retries rather than being mistaken for a
    // per-channel send failure — the FYI must never be silently dropped.
    let deliveryId: string | null = null;
    try {
      // Claim BEFORE send (Codex R1 #3). null ⇒ a live claim already exists.
      deliveryId = await claimAutoPostNoticeDelivery(sql, {
        accountId: input.accountId,
        businessId: input.businessId,
        responseId: input.responseId,
        channel: channelId,
        recipient,
      });
      if (deliveryId === null) {
        result.skipped += 1;
        logger.log(
          `auto_post_notice dedup channel=${channelId} response=${input.responseId} — already claimed`,
        );
        continue;
      }

      const sendResult = await getChannel(channelId).sendAutoPostNotice(params);
      if (sendResult.status === 'skipped') {
        // Channel declined after claim — release so a later config fix re-sends.
        await releaseDeliveryClaim(sql, deliveryId);
        result.skipped += 1;
        logger.log(
          `auto_post_notice skipped channel=${channelId} reason=${sendResult.reason} response=${input.responseId}`,
        );
        continue;
      }
      await finalizeDeliverySent(sql, deliveryId, sendResult.externalMessageId, logger);
      result.sent += 1;
      logger.log(`auto_post_notice sent channel=${channelId} response=${input.responseId}`);
    } catch (err) {
      if (deliveryId === null) {
        // The claim itself failed (DB infra) — re-throw so the whole job retries;
        // there is no claim to release and the FYI must not be dropped.
        throw err;
      }
      const classification = classifyAutoPostNoticeSendError(err);
      if (classification.retryable) {
        // RELEASE the claim so a BullMQ retry re-acquires + re-sends.
        await releaseDeliveryClaim(sql, deliveryId);
        result.retryableFailed += 1;
        logger.warn(
          `auto_post_notice retryable-failed channel=${channelId} response=${input.responseId}: ${classification.reason}`,
        );
      } else {
        // TERMINAL: keep the claim as a recorded failed delivery (NOT deleted —
        // its presence suppresses a pointless retry, and it is the
        // observability row).
        await failDelivery(sql, deliveryId, classification.reason, logger);
        result.terminalFailed += 1;
        logger.warn(
          `auto_post_notice terminal-failed channel=${channelId} response=${input.responseId}: ${classification.reason}`,
        );
      }
    }
  }

  return result;
}
