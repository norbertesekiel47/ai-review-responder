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
 * Claim the account-level autonomy-suspension safety notice before send.
 * Migration 076 keys this template by the stable suspension event rather than
 * a response; response_id is deliberately NULL because the notice contains no
 * review- or response-level content.
 */
export type AutonomySuspendedNoticeClaimResult =
  | { kind: 'claimed'; deliveryId: string }
  | { kind: 'settled'; deliveryId: string }
  | { kind: 'pending'; deliveryId: string | null };

export async function claimAutonomySuspendedNoticeDelivery(sql: Sql, params: {
  accountId: string;
  businessId: string;
  entityId: string;
  channel: ChannelId;
  recipient: string;
}): Promise<AutonomySuspendedNoticeClaimResult> {
  const id = uuidv7();
  // Self-reap stale unfinalized claims after 15 minutes — same contract as the
  // pending_post_notice reap above. INVARIANT: every channel send timeout must
  // stay well under this window. A send still hanging past the reap can resume
  // AFTER a newer attempt has re-claimed and re-sent, which turns this notice
  // into an at-least-once duplicate (surfaced only as finalizeDeliverySent's
  // reaped-row WARN). Widen the window if a channel ever needs a longer
  // timeout; never the other way around.
  // Scope by account, not business: business_id is not part of migration
  // 076's unique key, and the account's primary delivery anchor can change
  // while an orphaned claim is waiting to be reaped.
  await sql`
    DELETE FROM notification_deliveries
    WHERE entity_id = ${params.entityId}
      AND account_id = ${params.accountId}
      AND channel = ${params.channel}
      AND recipient = ${params.recipient}
      AND template = 'autonomy_suspended_notice'
      AND sent_at IS NULL
      AND failed_at IS NULL
      AND created_at < NOW() - INTERVAL '15 minutes'
  `;
  const claimed = await sql<{ id: string }[]>`
    INSERT INTO notification_deliveries
      (id, account_id, business_id, response_id, entity_id, channel, recipient, template)
    VALUES
      (${id}, ${params.accountId}, ${params.businessId}, ${null}, ${params.entityId},
       ${params.channel}, ${params.recipient}, 'autonomy_suspended_notice')
    ON CONFLICT (entity_id, channel, recipient)
      WHERE entity_id IS NOT NULL AND template = 'autonomy_suspended_notice'
      DO NOTHING
    RETURNING id
  `;
  if (claimed.length === 1) return { kind: 'claimed', deliveryId: id };

  // A conflict is not automatically a harmless dedup. A sent or terminally
  // failed row is settled; an unfinalized live claim means an earlier attempt
  // may still be sending or may have failed lifecycle persistence. Surface it
  // as pending so the outbox remains incomplete until finalize/release/fail or
  // the 15-minute stale-claim reap makes a safe recovery attempt possible.
  const [existing] = await sql<{
    id: string;
    sent_at: Date | null;
    failed_at: Date | null;
  }[]>`
    SELECT id, sent_at, failed_at
    FROM notification_deliveries
    WHERE entity_id = ${params.entityId}
      AND account_id = ${params.accountId}
      AND channel = ${params.channel}
      AND recipient = ${params.recipient}
      AND template = 'autonomy_suspended_notice'
    LIMIT 1
  `;
  if (!existing) return { kind: 'pending', deliveryId: null };
  if (existing.sent_at !== null || existing.failed_at !== null) {
    return { kind: 'settled', deliveryId: existing.id };
  }
  return { kind: 'pending', deliveryId: existing.id };
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

/** Minimal warn surface the finalize/fail helpers need from a caller's logger. */
type DeliveryWarnLogger = { warn(message: string): void };

/**
 * Finalize a claimed delivery as SENT with the provider message id.
 *
 * A 0-row UPDATE is surfaced as an ids-only WARN, never a throw: it means the
 * claim row was reaped (a >15-minute hung send — see
 * claimPendingPostNoticeDelivery's self-reap) and possibly re-claimed by a
 * newer send. The provider send DID succeed, so throwing would make the
 * caller retry and double-send; the WARN is the signal that a delivery
 * happened with no surviving row (and a re-claimed duplicate may follow).
 */
export async function finalizeDeliverySent(
  sql: Sql,
  deliveryId: string,
  externalMessageId: string,
  logger?: DeliveryWarnLogger,
): Promise<void> {
  const res = await sql`
    UPDATE notification_deliveries
    SET external_message_id = ${externalMessageId}, sent_at = NOW()
    WHERE id = ${deliveryId}
  `;
  if (res.count === 0) {
    (logger ?? console).warn(
      `finalizeDeliverySent no-op for delivery ${deliveryId} (provider message ${externalMessageId}) — claim row reaped after a hung send; send succeeded, not retrying`,
    );
  }
}

/**
 * Record a claimed delivery as TERMINALLY failed (kept as the observability
 * row). Mirrors finalizeDeliverySent's reaped-row handling: a 0-row UPDATE
 * (claim reaped mid-send) is an ids-only WARN, not a throw — the terminal
 * failure just goes unrecorded on a row that no longer exists.
 */
export async function failDelivery(
  sql: Sql,
  deliveryId: string,
  failureReason: string,
  logger?: DeliveryWarnLogger,
): Promise<void> {
  const res = await sql`
    UPDATE notification_deliveries
    SET failed_at = NOW(), failure_reason = ${failureReason}
    WHERE id = ${deliveryId}
  `;
  if (res.count === 0) {
    (logger ?? console).warn(
      `failDelivery no-op for delivery ${deliveryId} — claim row reaped after a hung send; terminal failure not recorded`,
    );
  }
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
