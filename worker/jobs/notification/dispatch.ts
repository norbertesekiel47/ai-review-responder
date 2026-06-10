// worker/jobs/notification/dispatch.ts
//
// Per-channel send loop with isolated error handling. One failed channel
// does not abort the rest — that's the failover poller's job. Behavior
// is preserved verbatim from the original NotificationWorker dispatcher.

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

// channel_enrollments.channel is a TEXT column — a stale value (e.g. 'sms'
// after its removal) must not reach createApprovalLink() or getChannel().
// This is defense-in-depth; the primary filter is the SQL WHERE clause in
// resolve-channels.ts and the eligibility flag check in eligibility.ts.
const DISPATCHABLE_CHANNELS: ReadonlySet<string> = new Set(['email', 'telegram', 'whatsapp']);

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
 * could miss it. `handle` is kept in the predicate so a stale failure cannot
 * stomp a freshly re-enrolled handle.
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

  // channel_enrollments.channel is a TEXT column — filter out any stale
  // values (e.g. 'sms' after its removal) BEFORE ordering so that
  // orderNotificationDispatchEnrollments never receives an unknown key.
  // This guard is defense-in-depth; the primary filter is the SQL WHERE
  // clause in resolve-channels.ts and the eligibility flag in eligibility.ts.
  const supportedEnrollments = enrollments.filter((e) => {
    if (DISPATCHABLE_CHANNELS.has(e.channel)) return true;
    logger.warn(`Skipping unsupported channel "${e.channel}" for response ${ctx.responseId} (stale enrollment row)`);
    return false;
  });

  const orderedEnrollments = orderNotificationDispatchEnrollments(supportedEnrollments);

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

    // Approval-link creation is per-channel — a failure here must NOT
    // abort the whole dispatch loop (other channels may still succeed).
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
    } catch (err) {
      const directive = classifyChannelError(channelId, err, {
        businessId: ctx.businessId,
        responseId: ctx.responseId,
      });
      // Apply the enrollment mutation. The four status-flip branches delegate
      // to flipEnrollmentStatus, which scopes the UPDATE by account_id + the
      // enrollment's location (org-default vs per-location override) — never by
      // business_id (a legacy FK that can miss org-default rows on
      // multi-location accounts). Channel names stay SQL literals (not bound)
      // to keep the unit-test SQL-text assertions
      // (worker/jobs/notification/__tests__/NotificationWorker.whatsapp.test.ts)
      // green.
      if (
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
      try {
        await safeInvalidateChannelCache(
          asAccountId(ctx.accountId),
          'worker.notification.dispatch.channel-write',
          logger,
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
      continue;
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
  }

  return { attempted, succeeded };
}
