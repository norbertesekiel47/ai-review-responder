// worker/jobs/auto-post-notice/dispatch.ts
//
// Per-channel delivery loop for the auto-approved post FYI. SEPARATE from the
// approval dispatcher (Codex R1 #4): it reuses only low-level primitives
// (channel send + delivery-row recording + error classification) and creates
// NO approval_links. Claim-before-send idempotency (Codex R1 #3 / R2 #4) backed
// by the partial-unique index notification_deliveries_auto_post_notice_claim
// (migration 067): claim (response_id, channel, recipient) BEFORE the provider
// send, finalize with the provider id after ack.

import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../../src/lib/db/server';
import { getChannel } from '../../../src/lib/notifications/channels';
import type { ResolvedChannel } from '../../../src/lib/notifications/resolve-channels';
import type { SendAutoPostNoticeParams } from '../../../src/lib/notifications/channels/types';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import { classifyAutoPostNoticeSendError } from './errors';

const TEMPLATE = 'auto_post_notice';

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

export async function dispatchAutoPostNotice(
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

  for (const enrollment of enrollments) {
    const channelId = enrollment.channel;
    const recipient = enrollment.handle;

    // B7 pre-filter: WhatsApp without its FYI template SID skips cleanly,
    // without constructing the client or recording a delivery row.
    if (channelId === 'whatsapp' && !process.env.WHATSAPP_AUTOPOST_TEMPLATE_SID) {
      result.skipped += 1;
      logger.log(
        `auto_post_notice skipped channel=whatsapp reason=template_unset response=${input.responseId}`,
      );
      continue;
    }

    // ── Claim BEFORE send (Codex R1 #3) ──────────────────────────────────────
    // Predicate matches notification_deliveries_auto_post_notice_claim
    // byte-for-byte. A pre-existing SENT row (external_message_id set) or
    // TERMINAL-failed row (failed_at set) conflicts → dedup-skip; a released
    // (deleted) retryable claim does not → re-send.
    const deliveryId = uuidv7();
    const claimed = await sql<{ id: string }[]>`
      INSERT INTO notification_deliveries
        (id, account_id, business_id, response_id, channel, recipient, template)
      VALUES
        (${deliveryId}, ${input.accountId}, ${input.businessId}, ${input.responseId},
         ${channelId}, ${recipient}, ${TEMPLATE})
      ON CONFLICT (response_id, channel, recipient)
        WHERE response_id IS NOT NULL AND template = 'auto_post_notice'
        DO NOTHING
      RETURNING id
    `;
    if (claimed.length === 0) {
      result.skipped += 1;
      logger.log(
        `auto_post_notice dedup channel=${channelId} response=${input.responseId} — already claimed`,
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

    try {
      const sendResult = await getChannel(channelId).sendAutoPostNotice(params);
      if (sendResult.status === 'skipped') {
        // Channel declined after claim — release so a later config fix re-sends.
        await releaseClaim(deliveryId);
        result.skipped += 1;
        logger.log(
          `auto_post_notice skipped channel=${channelId} reason=${sendResult.reason} response=${input.responseId}`,
        );
        continue;
      }
      await sql`
        UPDATE notification_deliveries
        SET external_message_id = ${sendResult.externalMessageId}, sent_at = NOW()
        WHERE id = ${deliveryId}
      `;
      result.sent += 1;
      logger.log(`auto_post_notice sent channel=${channelId} response=${input.responseId}`);
    } catch (err) {
      const classification = classifyAutoPostNoticeSendError(err);
      if (classification.retryable) {
        // RELEASE the claim so a BullMQ retry re-acquires + re-sends.
        await releaseClaim(deliveryId);
        result.retryableFailed += 1;
        logger.warn(
          `auto_post_notice retryable-failed channel=${channelId} response=${input.responseId}: ${classification.reason}`,
        );
      } else {
        // TERMINAL: convert the claim into a recorded failed delivery (NOT
        // deleted — its presence suppresses a pointless retry of a permanent
        // failure, and it is the observability row).
        await sql`
          UPDATE notification_deliveries
          SET failed_at = NOW(), failure_reason = ${classification.reason}
          WHERE id = ${deliveryId}
        `;
        result.terminalFailed += 1;
        logger.warn(
          `auto_post_notice terminal-failed channel=${channelId} response=${input.responseId}: ${classification.reason}`,
        );
      }
    }
  }

  return result;
}

async function releaseClaim(deliveryId: string): Promise<void> {
  // Only delete an un-finalized claim (no provider id, not yet a failed row),
  // so a concurrent finalize can never be clobbered.
  await sql`
    DELETE FROM notification_deliveries
    WHERE id = ${deliveryId} AND external_message_id IS NULL AND failed_at IS NULL
  `;
}
