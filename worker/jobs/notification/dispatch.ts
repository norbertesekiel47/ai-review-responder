// worker/jobs/notification/dispatch.ts
//
// Per-channel send loop with isolated error handling. One failed channel
// does not abort the rest — that's the failover poller's job. Behavior
// is preserved verbatim from the original NotificationWorker dispatcher.

import type { Sql } from 'postgres';
import {
  insertPendingApprovalDelivery,
  finalizeDeliverySent,
  failDelivery,
} from '../../../src/lib/notifications/delivery';
import { getChannel } from '../../../src/lib/notifications/channels';
import { createApprovalLink } from '../../../src/lib/approval/create-link';
import type { ChannelId } from '../../../src/lib/notifications/channels/types';
import { safeInvalidateChannelCache, type ResolvedChannel } from '../../../src/lib/notifications/resolve-channels';
import { asAccountId } from '../../../src/lib/shared/ids';
import { classifyChannelError } from './errors';
import { getDisplayLabel } from '../../../src/lib/locations/display-label';
import type { DispatchOutcome } from './outcomes';
import { orderNotificationDispatchEnrollments, NOTIFICATION_DISPATCH_CHANNEL_ORDER } from './plan';

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
const DISPATCHABLE_CHANNELS: ReadonlySet<string> = new Set(NOTIFICATION_DISPATCH_CHANNEL_ORDER);

type StatusFlipKind =
  | 'telegram_blocked'
  | 'telegram_chat_not_found'
  | 'whatsapp_blocked'
  | 'whatsapp_invalid_recipient';

/**
 * Static shape of each status-flip kind: which channel row it targets and which
 * SET-clause it writes. `unsubscribe` records the owner's opt-out (with a reason
 * literal equal to the kind); `disable` records a dead recipient. Adding a
 * channel or kind is a single descriptor entry — the UPDATE below is one
 * template, not one block per kind.
 */
interface FlipDescriptor {
  channel: 'telegram' | 'whatsapp';
  transition: 'unsubscribe' | 'disable';
}

const FLIP_DESCRIPTORS: Record<StatusFlipKind, FlipDescriptor> = {
  telegram_blocked: { channel: 'telegram', transition: 'unsubscribe' },
  telegram_chat_not_found: { channel: 'telegram', transition: 'disable' },
  whatsapp_blocked: { channel: 'whatsapp', transition: 'unsubscribe' },
  whatsapp_invalid_recipient: { channel: 'whatsapp', transition: 'disable' },
};

/**
 * Flip a single channel_enrollments row to unsubscribed/disabled after a
 * permanent send failure. One parameterized UPDATE covers all four kinds ×
 * both location scopes (was eight near-identical inline blocks).
 *
 * Scoping contract (see CLAUDE.md "Owner channel enrollment org-default is
 * account-scoped"): the row is keyed by `account_id` + the enrollment's
 * location, NOT by `business_id`. On a multi-location account the org-default
 * row (`location_id IS NULL`) carries a legacy `business_id` from its original
 * INSERT, so a `business_id`-keyed UPDATE could miss it. `handle` is kept in the
 * predicate so a stale failure cannot stomp a freshly re-enrolled handle.
 *
 * The channel name and the unsubscribed_reason are composed as raw `sql``
 * fragments (NOT bound params) so they stay SQL literals in the produced text
 * (`channel = 'telegram'`, `unsubscribed_reason = COALESCE(..., 'telegram_blocked')`);
 * the dispatcher's SQL-text unit assertions rely on that. Only `account_id`,
 * `handle`, and (per-location) `location_id` are bound. Idempotent: COALESCE
 * preserves the first-set timestamps/reason on re-run.
 */
async function flipEnrollmentStatus(
  sql: Sql,
  kind: StatusFlipKind,
  accountId: string,
  enrollment: ResolvedChannel,
): Promise<void> {
  const { channel, transition } = FLIP_DESCRIPTORS[kind];
  const { handle, location_id: locationId } = enrollment;

  await sql.begin(async (tx) => {
    // Channel literal — a raw fragment picked from the closed kind set so the
    // text reads `channel = 'telegram'`, not a bound `?`.
    const channelPredicate =
      channel === 'telegram' ? tx`channel = 'telegram'` : tx`channel = 'whatsapp'`;

    // unsubscribed_reason is written as a SQL LITERAL (raw fragment, not a bound
    // param) so `.text` reads `COALESCE(..., 'telegram_blocked')`. The map is
    // exhaustive over StatusFlipKind — adding a kind forces declaring its reason
    // here, matching FLIP_DESCRIPTORS. `disable` transitions carry no reason
    // (null, only read in the `unsubscribe` branch below, never for those kinds).
    const reasonLiteralByKind: Record<StatusFlipKind, ReturnType<typeof tx> | null> = {
      telegram_blocked: tx`'telegram_blocked'`,
      whatsapp_blocked: tx`'whatsapp_blocked'`,
      telegram_chat_not_found: null,
      whatsapp_invalid_recipient: null,
    };

    // SET column body (no `SET` keyword — that stays in the main template so the
    // tenant-scope scanner sees `UPDATE channel_enrollments SET ...` and does not
    // read the interpolation as a table alias). Opt-out shape with the reason
    // literal, or the disabled shape.
    const setBody =
      transition === 'unsubscribe'
        ? tx`status = 'unsubscribed',
                unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
                unsubscribed_reason = COALESCE(unsubscribed_reason, ${reasonLiteralByKind[kind]}),
                updated_at = NOW()`
        : tx`status = 'disabled',
                disabled_at = COALESCE(disabled_at, NOW()),
                updated_at = NOW()`;

    // Org-default rows scope on `location_id IS NULL`; per-location overrides
    // bind the id (cast to uuid).
    const locationPredicate =
      locationId === null ? tx`location_id IS NULL` : tx`location_id = ${locationId}::uuid`;

    await tx`
            UPDATE channel_enrollments
            SET ${setBody}
            WHERE account_id = ${accountId}
              AND ${channelPredicate}
              AND handle = ${handle}
              AND ${locationPredicate}
              AND archived_at IS NULL
          `;
  });
}

/**
 * Dispatch one approval-request notification per eligible enrollment.
 * Each iteration is fully isolated: a thrown error from one channel
 * (or a config error, or a cost-cap) does NOT abort the rest of the
 * loop. The function returns the attempted/succeeded counters so the
 * orchestrator can decide whether to throw for a BullMQ retry.
 */
// Pre-existing per-channel fan-out (16 cyclomatic on main); this PR only added
// the idempotencyKey property to the send call, no new branches. Deep claim/send
// logic lives in the delivery.ts helpers.
// fallow-ignore-next-line complexity
export async function dispatchAll(
  sql: Sql,
  ctx: DispatchContext,
  enrollments: ResolvedChannel[],
  logger: DispatchLogger,
): Promise<DispatchOutcome> {
  let attempted = 0;
  let succeeded = 0;

  // channel_enrollments.channel is a TEXT column — filter out any stale
  // values (e.g. 'sms' after its removal) and emit a warn log entry per
  // skipped enrollment. orderNotificationDispatchEnrollments now owns the
  // correctness guard (unknown channels are dropped there, not crashed on),
  // so this pre-filter is purely observability: it surfaces stale rows in
  // logs without requiring the caller to inspect the ordered output.
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
      // Normal mode: skip if any non-failed delivery exists for this channel —
      // a SENT row (sent_at set) OR an in-flight PENDING claim (sent_at NULL,
      // failed_at NULL) written by a prior attempt that crashed after the
      // provider accepted but before the record committed. Catching the pending
      // claim is what closes the crash-after-send double-send window; the
      // orphaned claim is re-sent by the failover poller's stale branch if it
      // was never actually delivered. (Was `sent_at IS NOT NULL AND failed_at
      // IS NULL`, which missed the pending claim and re-sent on retry.)
      [existing] = await sql<{ id: string }[]>`
        SELECT id FROM notification_deliveries
        WHERE response_id = ${ctx.responseId}
          AND channel = ${channelId}
          AND template = 'approval_request'
          AND failed_at IS NULL
        LIMIT 1
      `;
    }
    if (existing) {
      logger.log(`${channelId} channel already has a prior delivery for response ${ctx.responseId}, skipping`);
      continue;
    }

    // Claim a PENDING delivery row BEFORE sending (claim-before-send). A retry
    // after a crash-during-send dedups on this row above and skips, instead of
    // re-sending. On send failure the claim is flipped to failed; on success it
    // is finalized with the provider message id.
    const deliveryId = await insertPendingApprovalDelivery(sql, {
      accountId: ctx.accountId,
      businessId: ctx.businessId,
      responseId: ctx.responseId,
      channel: channelId,
      recipient: enrollment.handle,
    });
    attempted++;

    // Approval-link creation is per-channel — a failure here must NOT
    // abort the whole dispatch loop (other channels may still succeed).
    let rawToken: string;
    let approvalLinkId: string;
    try {
      const link = await createApprovalLink(sql, {
        responseId: ctx.responseId,
        businessId: ctx.businessId,
        channel: channelId,
      });
      rawToken = link.rawToken;
      approvalLinkId = link.approvalLinkId;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`createApprovalLink failed for ${channelId} response ${ctx.responseId}: ${reason}`);
      await failDelivery(sql, deliveryId, `approval_link_error:${reason}`, logger);
      continue;
    }
    const approvalUrl = `${ctx.appUrl}/approve/${rawToken}`;

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
        // Stable per (response, channel) so a timeout-retry or failover re-send of
        // the same approval dedupes at the provider instead of double-sending.
        idempotencyKey: `approval_request:${ctx.responseId}:${channelId}`,
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
        await flipEnrollmentStatus(sql, directive.kind, ctx.accountId, enrollment);
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

      await failDelivery(sql, deliveryId, directive.failureReason, logger);
      continue;
    }

    await finalizeDeliverySent(sql, deliveryId, externalMessageId, logger);
    succeeded++;
    logger.log(`${channelId} approval notification sent for response ${ctx.responseId} (business ${ctx.businessId})`);
  }

  return { attempted, succeeded };
}
