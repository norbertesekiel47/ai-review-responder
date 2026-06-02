// worker/jobs/notification/dispatch.ts
//
// Per-channel send loop with isolated error handling. One failed channel
// does not abort the rest — that's the failover poller's job. Behavior
// is preserved verbatim from the original NotificationWorker dispatcher.

import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../../src/lib/db/server';
import {
  recordNotificationDelivery,
  insertFailedDelivery,
} from '../../../src/lib/notifications/delivery';
import { getChannel } from '../../../src/lib/notifications/channels';
import { createApprovalLink } from '../../../src/lib/approval/create-link';
import type { ChannelId } from '../../../src/lib/notifications/channels/types';
import { safeInvalidateChannelCache, type ResolvedChannel } from '../../../src/lib/notifications/resolve-channels';
import type { AccountId } from '../../../src/lib/shared/ids';
import { asAccountId } from '../../../src/lib/shared/ids';
import { classifyChannelError } from './errors';
import {
  reserveSmsCost,
  refundSmsCost,
  DailySmsLimitExceededError,
} from './sms-budget';
import { getDisplayLabel } from '../../../src/lib/locations/display-label';
import type { DispatchOutcome } from './outcomes';
import { orderNotificationDispatchEnrollments } from './plan';

export interface DispatchLogger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface DispatchContext {
  responseId: string;
  businessId: string;
  accountId: string;
  isFailover: boolean;
  appUrl: string;
  business: {
    name: string;
    displayLabel: string | null;
    owner_email_bounced: boolean;
  };
  review: {
    reviewerName: string;
    starRating: number;
    reviewText: string | null;
    reviewDate: string;
    responsePreview: string;
  };
}

type StatusFlipKind =
  | 'telegram_blocked'
  | 'telegram_chat_not_found'
  | 'whatsapp_blocked'
  | 'whatsapp_invalid_recipient';

/**
 * Flip a single channel_enrollments row to unsubscribed/disabled after a
 * permanent send failure.
 *
 * Scoping contract (see CLAUDE.md "Owner channel enrollment org-default is
 * account-scoped" and docs/known-issues.md "Dispatcher failure-handling
 * enrollment writes still key by business_id"): the row is keyed by
 * `account_id` + the enrollment's location, NOT by `business_id`. On a
 * multi-location account the org-default row (`location_id IS NULL`) carries a
 * legacy `business_id` from its original INSERT, so a `business_id`-keyed UPDATE
 * could miss it. `handle` is kept in the predicate (mirroring the SMS 21610
 * pattern) so a stale failure cannot stomp a freshly re-enrolled handle.
 *
 * Channel names and the unsubscribed_reason are written as SQL literals (not
 * bound params) to keep the unit-test SQL-text assertions stable. Each branch
 * is idempotent: COALESCE preserves the first-set timestamps/reason on re-run.
 */
async function flipEnrollmentStatus(
  kind: StatusFlipKind,
  accountId: string,
  enrollment: ResolvedChannel,
): Promise<void> {
  const locationId = enrollment.location_id;
  await sql.begin(async (tx) => {
    switch (kind) {
      case 'telegram_blocked':
        if (locationId === null) {
          await tx`
            UPDATE channel_enrollments
            SET status = 'unsubscribed',
                unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
                unsubscribed_reason = COALESCE(unsubscribed_reason, 'telegram_blocked'),
                updated_at = NOW()
            WHERE account_id = ${accountId}
              AND channel = 'telegram'
              AND handle = ${enrollment.handle}
              AND location_id IS NULL
              AND archived_at IS NULL
          `;
        } else {
          await tx`
            UPDATE channel_enrollments
            SET status = 'unsubscribed',
                unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
                unsubscribed_reason = COALESCE(unsubscribed_reason, 'telegram_blocked'),
                updated_at = NOW()
            WHERE account_id = ${accountId}
              AND channel = 'telegram'
              AND handle = ${enrollment.handle}
              AND location_id = ${locationId}::uuid
              AND archived_at IS NULL
          `;
        }
        return;
      case 'telegram_chat_not_found':
        if (locationId === null) {
          await tx`
            UPDATE channel_enrollments
            SET status = 'disabled',
                disabled_at = COALESCE(disabled_at, NOW()),
                updated_at = NOW()
            WHERE account_id = ${accountId}
              AND channel = 'telegram'
              AND handle = ${enrollment.handle}
              AND location_id IS NULL
              AND archived_at IS NULL
          `;
        } else {
          await tx`
            UPDATE channel_enrollments
            SET status = 'disabled',
                disabled_at = COALESCE(disabled_at, NOW()),
                updated_at = NOW()
            WHERE account_id = ${accountId}
              AND channel = 'telegram'
              AND handle = ${enrollment.handle}
              AND location_id = ${locationId}::uuid
              AND archived_at IS NULL
          `;
        }
        return;
      case 'whatsapp_blocked':
        if (locationId === null) {
          await tx`
            UPDATE channel_enrollments
            SET status = 'unsubscribed',
                unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
                unsubscribed_reason = COALESCE(unsubscribed_reason, 'whatsapp_blocked'),
                updated_at = NOW()
            WHERE account_id = ${accountId}
              AND channel = 'whatsapp'
              AND handle = ${enrollment.handle}
              AND location_id IS NULL
              AND archived_at IS NULL
          `;
        } else {
          await tx`
            UPDATE channel_enrollments
            SET status = 'unsubscribed',
                unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
                unsubscribed_reason = COALESCE(unsubscribed_reason, 'whatsapp_blocked'),
                updated_at = NOW()
            WHERE account_id = ${accountId}
              AND channel = 'whatsapp'
              AND handle = ${enrollment.handle}
              AND location_id = ${locationId}::uuid
              AND archived_at IS NULL
          `;
        }
        return;
      case 'whatsapp_invalid_recipient':
        if (locationId === null) {
          await tx`
            UPDATE channel_enrollments
            SET status = 'disabled',
                disabled_at = COALESCE(disabled_at, NOW()),
                updated_at = NOW()
            WHERE account_id = ${accountId}
              AND channel = 'whatsapp'
              AND handle = ${enrollment.handle}
              AND location_id IS NULL
              AND archived_at IS NULL
          `;
        } else {
          await tx`
            UPDATE channel_enrollments
            SET status = 'disabled',
                disabled_at = COALESCE(disabled_at, NOW()),
                updated_at = NOW()
            WHERE account_id = ${accountId}
              AND channel = 'whatsapp'
              AND handle = ${enrollment.handle}
              AND location_id = ${locationId}::uuid
              AND archived_at IS NULL
          `;
        }
        return;
    }
  });
}

/**
 * Dispatch one approval-request notification per eligible enrollment.
 * Each iteration is fully isolated: a thrown error from one channel
 * (or a config error, or a cost-cap) does NOT abort the rest of the
 * loop. The function returns the attempted/succeeded counters so the
 * orchestrator can decide whether to throw for a BullMQ retry.
 */
export async function dispatchAll(
  ctx: DispatchContext,
  enrollments: ResolvedChannel[],
  logger: DispatchLogger,
): Promise<DispatchOutcome> {
  let attempted = 0;
  let succeeded = 0;

  const orderedEnrollments = orderNotificationDispatchEnrollments(enrollments);

  for (const enrollment of orderedEnrollments) {
    const channelId: ChannelId = enrollment.channel;

    // Per-channel feature flag filtering happens in getEligibleChannels.
    // owner_email_bounced is checked here because it depends on business
    // row data that the dispatcher already has in hand.
    if (channelId === 'email' && ctx.business.owner_email_bounced) {
      logger.log(`Email channel skipped for business ${ctx.businessId}: owner_email_bounced`);
      continue;
    }

    let existing: { id: string } | undefined;
    if (ctx.isFailover) {
      // Failover mode: only skip if a delivery was actually confirmed (delivered_at set).
      // A sent_at without delivered_at means the email may have been lost.
      [existing] = await sql<{ id: string }[]>`
        SELECT id FROM notification_deliveries
        WHERE response_id = ${ctx.responseId}
          AND channel = ${channelId}
          AND template = 'approval_request'
          AND delivered_at IS NOT NULL
        LIMIT 1
      `;
    } else {
      // Normal mode: skip if any successful delivery record exists for this channel.
      [existing] = await sql<{ id: string }[]>`
        SELECT id FROM notification_deliveries
        WHERE response_id = ${ctx.responseId}
          AND channel = ${channelId}
          AND template = 'approval_request'
          AND sent_at IS NOT NULL AND failed_at IS NULL
        LIMIT 1
      `;
    }
    if (existing) {
      logger.log(`${channelId} channel already has a prior delivery for response ${ctx.responseId}, skipping`);
      continue;
    }

    // SMS cost reservation. The cap-rejection branch auto-refunds inside
    // reserveSmsCost, so we only need to refund on downstream failure paths.
    let smsReservationDate: string | null = null;
    if (channelId === 'sms') {
      try {
        smsReservationDate = await reserveSmsCost(ctx.businessId);
      } catch (err) {
        if (err instanceof DailySmsLimitExceededError) {
          logger.warn(`SMS cap reached for business ${ctx.businessId} (${err.scope})`);
          attempted++;
          await insertFailedDelivery(
            ctx.accountId,
            ctx.businessId,
            ctx.responseId,
            'sms',
            enrollment.handle,
            `daily_sms_limit_exceeded:${err.scope}`,
          );
          continue;
        }
        throw err;
      }
    }

    // sendAccepted flips to true ONLY after the provider returns a SID.
    // The finally block refunds iff we reserved and did NOT get that ack.
    // A crash AFTER the provider ack but before recordNotificationDelivery
    // intentionally commits the cost — the message was sent.
    let sendAccepted = false;
    try {
      // Approval-link creation is per-channel — a failure here must NOT
      // abort the whole dispatch loop (other channels may still succeed).
      // The outer finally still runs on `continue`, refunding SMS cost.
      let rawToken: string;
      let approvalLinkId: string;
      try {
        const link = await createApprovalLink({
          responseId: ctx.responseId,
          businessId: ctx.businessId,
          channel: channelId,
        });
        rawToken = link.rawToken;
        approvalLinkId = link.approvalLinkId;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error(`createApprovalLink failed for ${channelId} response ${ctx.responseId}: ${reason}`);
        attempted++;
        await insertFailedDelivery(
          ctx.accountId,
          ctx.businessId,
          ctx.responseId,
          channelId,
          enrollment.handle,
          `approval_link_error:${reason}`,
        );
        continue;
      }
      const approvalUrl = `${ctx.appUrl}/approve/${rawToken}`;
      attempted++;

      let externalMessageId: string;
      try {
        // VAL-NOTIF-014: locationLabel is resolved from display_label ?? name
        const locationLabel = getDisplayLabel({
          display_label: ctx.business.displayLabel,
          name: ctx.business.name,
        });
        const result = await getChannel(channelId).sendApprovalRequest({
          handle: enrollment.handle,
          locationLabel,
          businessName: ctx.business.name,
          reviewerName: ctx.review.reviewerName,
          starRating: ctx.review.starRating,
          reviewText: ctx.review.reviewText,
          reviewDate: ctx.review.reviewDate,
          responsePreview: ctx.review.responsePreview,
          approvalUrl,
          approvalLinkId,
        });
        externalMessageId = result.externalMessageId;
        sendAccepted = true;
      } catch (err) {
        const directive = classifyChannelError(channelId, err, {
          businessId: ctx.businessId,
          responseId: ctx.responseId,
        });
        let accountIdsToInvalidate: string[] | null = null;

        // Apply the enrollment mutation. The four status-flip branches delegate
        // to flipEnrollmentStatus, which scopes the UPDATE by account_id + the
        // enrollment's location (org-default vs per-location override) — never by
        // business_id (a legacy FK that can miss org-default rows on
        // multi-location accounts). Channel names stay SQL literals (not bound)
        // to keep the unit-test SQL-text assertions
        // (worker/jobs/notification/__tests__/NotificationWorker.whatsapp.test.ts)
        // green. The SMS branch below is deliberately handle-global for TCPA and
        // is NOT account-scoped.
        if (directive.kind === 'sms_unsubscribed') {
          // Belt-and-suspenders: worker startup-assert already enforces
          // TWILIO_MESSAGING_SERVICE_SID when CHANNELS_SMS_ENABLED=true, but
          // a missing value here would write the literal string "undefined"
          // into the TCPA audit trail (sms_sender_opt_outs.messaging_service_sid)
          // because Postgres.js would coerce. Hard-fail loudly instead.
          const msid = process.env.TWILIO_MESSAGING_SERVICE_SID;
          if (!msid) {
            throw new Error(
              'TWILIO_MESSAGING_SERVICE_SID missing — cannot record SMS opt-out for TCPA audit',
            );
          }
          const affectedAccounts = await sql.begin(async (tx) => {
            await tx`
              INSERT INTO sms_sender_opt_outs (messaging_service_sid, handle, opted_out_at, opted_in_at, last_event_at)
              VALUES (${msid}, ${enrollment.handle}, NOW(), NULL, NOW())
              ON CONFLICT (messaging_service_sid, handle) DO UPDATE
                SET opted_out_at = EXCLUDED.opted_out_at,
                    opted_in_at = NULL,
                    last_event_at = EXCLUDED.last_event_at
            `;
            await tx`
              INSERT INTO sms_sender_opt_out_events (id, messaging_service_sid, handle, event_type, source, inbound_event_id)
              VALUES (${uuidv7()}, ${msid}, ${enrollment.handle}, '21610_at_send', 'twilio_21610', NULL)
            `;
            const updated = await tx<{ account_id: string }[]>`
              UPDATE channel_enrollments
              SET status = 'unsubscribed',
                  unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
                  unsubscribed_reason = COALESCE(unsubscribed_reason, 'twilio_21610_at_send'),
                  updated_at = NOW()
              WHERE handle = ${enrollment.handle} AND channel = 'sms' AND archived_at IS NULL
              RETURNING account_id
            `;
            return updated;
          });
          accountIdsToInvalidate = [
            ...new Set(affectedAccounts.flatMap((row) => (row.account_id ? [row.account_id] : []))),
          ];
        } else if (
          directive.kind === 'telegram_blocked' ||
          directive.kind === 'telegram_chat_not_found' ||
          directive.kind === 'whatsapp_blocked' ||
          directive.kind === 'whatsapp_invalid_recipient'
        ) {
          await flipEnrollmentStatus(directive.kind, ctx.accountId, enrollment);
        }
        // CONFIG-ERROR (whatsapp_template_config / whatsapp_session_window),
        // TRANSIENT (whatsapp_rate_limit / whatsapp_timeout), and 'unknown'
        // intentionally leave channel_enrollments unchanged.

        // VAL-NOTIF-009: Invalidate cache on channel_enrollments writes.
        // SMS 21610 can update every account sharing a handle, so invalidate
        // each account returned by the update rather than only ctx.accountId.
        const cacheAccountIds =
          accountIdsToInvalidate && accountIdsToInvalidate.length > 0
            ? accountIdsToInvalidate
            : [ctx.accountId];
        try {
          await Promise.all(
            cacheAccountIds.map((accountId) =>
              safeInvalidateChannelCache(
                asAccountId(accountId),
                'worker.notification.dispatch.channel-write',
                logger,
              ),
            ),
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logger.warn(`channel cache invalidation wrapper failed: ${reason}`);
        }

        // Primary log line (preserved verbatim from the original branches).
        logger[directive.logLevel](directive.logMessage);
        if (directive.extraLog) {
          logger[directive.extraLog.level](directive.extraLog.message);
        }

        await insertFailedDelivery(
          ctx.accountId,
          ctx.businessId,
          ctx.responseId,
          channelId,
          enrollment.handle,
          directive.failureReason,
        );
        continue; // `finally` runs before continue, so any refund still triggers when sendAccepted=false.
      }

      await recordNotificationDelivery({
        accountId: ctx.accountId,
        businessId: ctx.businessId,
        responseId: ctx.responseId,
        channel: channelId,
        recipient: enrollment.handle,
        template: 'approval_request',
        externalMessageId,
      });
      succeeded++;
      logger.log(`${channelId} approval notification sent for response ${ctx.responseId} (business ${ctx.businessId})`);
    } finally {
      if (channelId === 'sms' && smsReservationDate && !sendAccepted) {
        await refundSmsCost(ctx.businessId, smsReservationDate);
      }
    }
  }

  return { attempted, succeeded };
}
