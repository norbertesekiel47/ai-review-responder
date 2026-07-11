import { v7 as uuidv7 } from 'uuid';
import type { Sql } from 'postgres';
import type { ChannelId } from '@/lib/notifications/channels/types';

/**
 * Records a notification delivery in the notification_deliveries table.
 * Used by NotificationWorker (approval emails) and other workers that
 * send owner or admin notifications.
 *
 * accountId is required — notification_deliveries.account_id is NOT NULL
 * after migration 034, so every INSERT must include it.
 */
export async function recordNotificationDelivery(sql: Sql, params: {
  accountId: string;
  businessId: string;
  responseId?: string | null;
  channel: ChannelId;
  recipient: string;
  template: string;
  externalMessageId: string;
}): Promise<void> {
  await sql`
    INSERT INTO notification_deliveries (id, account_id, business_id, response_id, channel, recipient, template, sent_at, external_message_id)
    VALUES (
      ${uuidv7()}, ${params.accountId}, ${params.businessId}, ${params.responseId ?? null}, ${params.channel},
      ${params.recipient}, ${params.template}, NOW(), ${params.externalMessageId}
    )
  `;
}

/**
 * Records a FAILED delivery. Used when a channel send threw before returning
 * an external message ID (Twilio rejected, Resend errored, cost-cap blocked),
 * or when a pre-send guard rejected the send. Mirrors recordNotificationDelivery
 * but sets failed_at + failure_reason and leaves external_message_id NULL.
 *
 * Defaults template to 'approval_request' since that's the primary use site
 * (the dispatcher's per-channel catch block). Owner-directed non-approval
 * templates (e.g., 'weekly_value_report') should pass the template explicitly.
 *
 * accountId is required — notification_deliveries.account_id is NOT NULL
 * after migration 034, so every INSERT must include it.
 */
export async function insertFailedDelivery(
  sql: Sql,
  accountId: string,
  businessId: string,
  responseId: string | null,
  channel: ChannelId,
  recipient: string,
  failureReason: string,
  template: string = 'approval_request',
): Promise<void> {
  await sql`
    INSERT INTO notification_deliveries
      (id, account_id, business_id, response_id, channel, recipient, template, failed_at, failure_reason)
    VALUES (
      ${uuidv7()}, ${accountId}, ${businessId}, ${responseId}, ${channel},
      ${recipient}, ${template}, NOW(), ${failureReason}
    )
  `;
}

// ── Claim-before-send (auto-approved post FYI, Workstream B) ─────────────────
//
// The FYI dispatcher claims a delivery row BEFORE sending so a crash-after-accept
// retry can't double-send (Codex R1 #3 / R2 #4). These four helpers own every
// notification_deliveries write the claim lifecycle needs, so the dispatcher
// reads as orchestration (claim → send → finalize|fail|release) and the table's
// write-shape lives in one place.

/**
 * Insert a pending claim keyed by (response_id, channel, recipient) for
 * template='auto_post_notice'. Returns the new delivery id, or null when a live
 * claim already exists — a prior SENT row (external_message_id set) or
 * TERMINAL-failed row (failed_at set) conflicts; a released (deleted) retryable
 * claim does not, so it re-sends.
 *
 * The ON CONFLICT predicate matches the partial index
 * `notification_deliveries_auto_post_notice_claim` (migration 067) BYTE-FOR-BYTE
 * — the 'auto_post_notice' literal must stay a literal, never a bound param, or
 * Postgres won't recognise the constraint.
 */
export async function claimAutoPostNoticeDelivery(sql: Sql, params: {
  accountId: string;
  businessId: string;
  responseId: string;
  channel: ChannelId;
  recipient: string;
}): Promise<string | null> {
  const id = uuidv7();
  const claimed = await sql<{ id: string }[]>`
    INSERT INTO notification_deliveries
      (id, account_id, business_id, response_id, channel, recipient, template)
    VALUES
      (${id}, ${params.accountId}, ${params.businessId}, ${params.responseId},
       ${params.channel}, ${params.recipient}, 'auto_post_notice')
    ON CONFLICT (response_id, channel, recipient)
      WHERE response_id IS NOT NULL AND template = 'auto_post_notice'
      DO NOTHING
    RETURNING id
  `;
  return claimed.length === 1 ? id : null;
}

/**
 * Insert a pending claim keyed by (escalation_id, channel, recipient) for
 * template='escalation_notice'. Returns the new delivery id, or null when a
 * live claim already exists. ON CONFLICT predicate matches the partial index
 * `notification_deliveries_escalation_notice_claim` (migration 073)
 * BYTE-FOR-BYTE — the 'escalation_notice' literal must stay a literal.
 */
export async function claimEscalationNoticeDelivery(sql: Sql, params: {
  accountId: string;
  businessId: string;
  escalationId: string;
  channel: ChannelId;
  recipient: string;
}): Promise<string | null> {
  const id = uuidv7();
  const claimed = await sql<{ id: string }[]>`
    INSERT INTO notification_deliveries
      (id, account_id, business_id, escalation_id, channel, recipient, template)
    VALUES
      (${id}, ${params.accountId}, ${params.businessId}, ${params.escalationId},
       ${params.channel}, ${params.recipient}, 'escalation_notice')
    ON CONFLICT (escalation_id, channel, recipient)
      WHERE escalation_id IS NOT NULL AND template = 'escalation_notice'
      DO NOTHING
    RETURNING id
  `;
  return claimed.length === 1 ? id : null;
}

/**
 * Insert a pending claim keyed by (response_id, channel, recipient) for
 * template='pending_post_notice' (WS4 veto window). Returns the new delivery
 * id, or null when a live claim already exists. ON CONFLICT predicate matches
 * the partial index `notification_deliveries_pending_post_notice_claim`
 * (migration 074) BYTE-FOR-BYTE — the 'pending_post_notice' literal must stay
 * a literal, never a bound param, or Postgres won't recognise the constraint.
 */
export async function claimPendingPostNoticeDelivery(sql: Sql, params: {
  accountId: string;
  businessId: string;
  responseId: string;
  channel: ChannelId;
  recipient: string;
}): Promise<string | null> {
  const id = uuidv7();
  // Self-reap stale unfinalized claims first: a dispatcher that crashed
  // between claim and finalize/release leaves a pending row that would
  // dedup-block every future send of this veto-critical notice. A claim that
  // is neither sent nor terminally failed after 15 minutes is such an orphan
  // (a live send finalizes within seconds). The sent_at/failed_at guards
  // ensure a finalized or terminally-failed row is never reaped. Narrows
  // known follow-up #3b for the pending_post_notice template.
  await sql`
    DELETE FROM notification_deliveries
    WHERE response_id = ${params.responseId}
      AND business_id = ${params.businessId}
      AND channel = ${params.channel}
      AND recipient = ${params.recipient}
      AND template = 'pending_post_notice'
      AND sent_at IS NULL
      AND failed_at IS NULL
      AND created_at < NOW() - INTERVAL '15 minutes'
  `;
  const claimed = await sql<{ id: string }[]>`
    INSERT INTO notification_deliveries
      (id, account_id, business_id, response_id, channel, recipient, template)
    VALUES
      (${id}, ${params.accountId}, ${params.businessId}, ${params.responseId},
       ${params.channel}, ${params.recipient}, 'pending_post_notice')
    ON CONFLICT (response_id, channel, recipient)
      WHERE response_id IS NOT NULL AND template = 'pending_post_notice'
      DO NOTHING
    RETURNING id
  `;
  return claimed.length === 1 ? id : null;
}

/**
 * Insert a PENDING approval-request delivery claim (sent_at NULL, failed_at
 * NULL) and return its id. The approval dispatcher claims this row BEFORE the
 * provider send so a crash between provider-accept and the delivery record
 * can't double-send on the BullMQ retry — the retry's dedup SELECT sees the
 * pending row and skips, and an orphaned claim that was never delivered is
 * re-sent by the failover poller's stale branch.
 *
 * Unlike claimAutoPostNoticeDelivery this is NOT backed by a partial-unique
 * index: approval_request has historical rows that legitimately duplicate
 * (response_id, channel, recipient) — every failover re-send inserts another
 * row by design — so a unique claim index cannot be built over existing data.
 * Atomicity is instead provided by dispatch being single-flight per response
 * (OutboxPoller FOR UPDATE SKIP LOCKED claim + BullMQ jobId dedup + the
 * failover poller's in-flight outbox guard), so the dispatcher's
 * select-then-insert claim is race-safe in practice.
 */
export async function insertPendingApprovalDelivery(sql: Sql, params: {
  accountId: string;
  businessId: string;
  responseId: string;
  channel: ChannelId;
  recipient: string;
}): Promise<string> {
  const id = uuidv7();
  await sql`
    INSERT INTO notification_deliveries
      (id, account_id, business_id, response_id, channel, recipient, template)
    VALUES
      (${id}, ${params.accountId}, ${params.businessId}, ${params.responseId},
       ${params.channel}, ${params.recipient}, 'approval_request')
  `;
  return id;
}

/** Finalize a claimed delivery as SENT with the provider message id. */
export async function finalizeDeliverySent(
  sql: Sql,
  deliveryId: string,
  externalMessageId: string,
): Promise<void> {
  await sql`
    UPDATE notification_deliveries
    SET external_message_id = ${externalMessageId}, sent_at = NOW()
    WHERE id = ${deliveryId}
  `;
}

/** Record a claimed delivery as TERMINALLY failed (kept as the observability row). */
export async function failDelivery(sql: Sql, deliveryId: string, failureReason: string): Promise<void> {
  await sql`
    UPDATE notification_deliveries
    SET failed_at = NOW(), failure_reason = ${failureReason}
    WHERE id = ${deliveryId}
  `;
}

/**
 * Release an un-finalized claim (no provider id, not yet failed) so a retry can
 * re-acquire. The external_message_id/failed_at guards ensure a concurrent
 * finalize is never clobbered.
 */
export async function releaseDeliveryClaim(sql: Sql, deliveryId: string): Promise<void> {
  await sql`
    DELETE FROM notification_deliveries
    WHERE id = ${deliveryId} AND external_message_id IS NULL AND failed_at IS NULL
  `;
}
