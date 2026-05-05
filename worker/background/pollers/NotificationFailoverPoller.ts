import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../../src/lib/db/server';
import { sendInternalEmail } from '../../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../../src/lib/notifications/delivery';
import { escapeHtml } from '../../../src/lib/shared/html';
import type { SendNotificationPayload } from '../../../src/lib/shared/worker-types';

const LOG_PREFIX = '[NotificationFailover]';
const DEFAULT_INTERVAL_MS = 7_200_000; // 2 hours

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

function getIntervalMs(): number {
  const envVal = process.env.NOTIFICATION_FAILOVER_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

/**
 * Recover the correlation_id from the upstream review chain so a failover
 * send_notification job shows up under the SAME correlation key as the
 * original sync/generate/notify chain in `payload->>'correlation_id'`
 * queries. Without this, every failover breaks Sprint 6's single-query
 * traceability promise.
 *
 * Lookup order:
 *   1. Most recent send_notification row for this response_id — if a prior
 *      attempt already carried a correlation_id, reuse it.
 *   2. Most recent generate_response row for the response's review_id —
 *      this is the canonical anchor used by `recoverCorrelationId` in
 *      src/lib/approval/correlation.ts.
 *   3. Fresh uuidv7() — graceful fallback for pre-20a rows with no
 *      correlation payload.
 */
type AlertOutcome = 'sent' | 'deduped' | 'send_error';

/**
 * Race-safe admin-alert claim helper.
 *
 * Two failover-poller processes (multi-instance deployments) can both pass a
 * time-windowed dedup SELECT and send duplicate admin emails. This helper
 * serializes per (response_id, template, recipient) via a transaction-scoped
 * advisory lock: the dedup re-check, the email send, and the delivery-row
 * insert all run INSIDE one `sql.begin` holding the lock. A second process
 * arriving concurrently waits for the lock, then sees the delivery row on
 * re-check and skips.
 *
 * The email send happens inside the transaction — the connection is held
 * during the Resend/Twilio round-trip. Acceptable for the admin-alert
 * volume (low-throughput, seconds-level latency). Revisit if connection
 * pool exhaustion becomes observable.
 *
 * Returns:
 *   'sent'       — we acquired the claim and the provider accepted the message
 *   'deduped'    — a prior alert in the 24h window already exists (no-op)
 *   'send_error' — the provider rejected the send (transaction rolled back;
 *                  next poll will retry since no delivery row persisted)
 */
async function tryClaimAlert(
  responseId: string,
  template: string,
  recipient: string,
  sendFn: () => Promise<string>,
  ctx: { businessId: string; responseId: string },
): Promise<AlertOutcome> {
  let outcome: AlertOutcome = 'deduped';
  try {
    await sql.begin(async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(hashtext(${`${responseId}:${template}:${recipient}`}))
      `;
      const [recentAlert] = await tx<{ id: string }[]>`
        SELECT id FROM notification_deliveries
        WHERE response_id = ${responseId}
          AND template = ${template}
          AND recipient = ${recipient}
          AND created_at > NOW() - INTERVAL '24 hours'
        LIMIT 1
      `;
      if (recentAlert) {
        outcome = 'deduped';
        return;
      }
      const messageId = await sendFn();
      await tx`
        INSERT INTO notification_deliveries
          (id, business_id, response_id, channel, recipient, template, sent_at, external_message_id)
        VALUES (
          ${uuidv7()}, ${ctx.businessId}, ${ctx.responseId}, 'email',
          ${recipient}, ${template}, NOW(), ${messageId}
        )
      `;
      outcome = 'sent';
    });
  } catch {
    outcome = 'send_error';
  }
  return outcome;
}

async function recoverFailoverCorrelationId(responseId: string): Promise<string> {
  const [existingSend] = await sql<{ correlation_id: string | null }[]>`
    SELECT payload->>'correlation_id' AS correlation_id
    FROM job_outbox
    WHERE topic = 'send_notification' AND aggregate_id = ${responseId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (existingSend?.correlation_id) return existingSend.correlation_id;

  const [upstream] = await sql<{ correlation_id: string | null }[]>`
    SELECT jo.payload->>'correlation_id' AS correlation_id
    FROM responses r
    JOIN job_outbox jo
      ON jo.topic = 'generate_response'
     AND jo.aggregate_id = r.review_id
    WHERE r.id = ${responseId}
    ORDER BY jo.created_at DESC
    LIMIT 1
  `;
  if (upstream?.correlation_id) return upstream.correlation_id;

  return uuidv7();
}

export async function runFailoverPollerOnce(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    // ── 1. All-failed: every approval_request delivery has failed_at set ──
    // IMPORTANT: Process all-failed BEFORE stale. The stale query's "no delivered_at"
    // condition also matches all-failed responses. If stale ran first, its outbox INSERT
    // would cause the all-failed query's in-flight check to skip, and the admin alert
    // would never fire.
    const allFailedResponses = await sql<{
      response_id: string;
      business_id: string;
      business_name: string;
      reviewer_name: string;
      star_rating: number;
    }[]>`
      SELECT resp.id AS response_id, resp.business_id,
             b.name AS business_name, r.reviewer_name, r.star_rating
      FROM responses resp
      JOIN businesses b ON resp.business_id = b.id
      JOIN reviews r ON resp.review_id = r.id
      WHERE resp.status = 'pending_approval'
        AND resp.created_at < NOW() - INTERVAL '4 hours'
        AND EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.response_id = resp.id AND nd.template = 'approval_request'
        )
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.response_id = resp.id
            AND nd.template = 'approval_request'
            AND nd.failed_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = 'send_notification'
            AND jo.aggregate_id = resp.id
            AND jo.status IN ('pending', 'dispatching', 'dispatched')
        )
    `;

    for (const row of allFailedResponses) {
      const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
      if (adminEmail) {
        // Serialize concurrent failover pollers (multi-instance deployments)
        // on the (response_id, template, recipient) key so only ONE worker
        // fires the admin alert per 24h window. The advisory lock is held for
        // the duration of the dedup-check + send + record, so a second worker
        // arriving in the middle either waits or finds the row on re-check.
        const claimed = await tryClaimAlert(
          row.response_id,
          'admin_notification_failover',
          adminEmail,
          async () => {
            const { messageId } = await sendInternalEmail({
              to: adminEmail,
              subject: `Notification failure: ${row.business_name} — all delivery attempts failed`,
              bodyHtml: `<p>All approval email delivery attempts have failed for a response to <strong>${escapeHtml(row.reviewer_name)}</strong>'s ${row.star_rating}-star review of <strong>${escapeHtml(row.business_name)}</strong>.</p><p>The system will re-attempt delivery. Please check the Resend dashboard for bounce/complaint details.</p>`,
              category: 'internal',
            });
            return messageId;
          },
          {
            businessId: row.business_id,
            responseId: row.response_id,
          },
        );
        if (claimed === 'send_error') {
          console.error(`${LOG_PREFIX} Failed to send admin alert for response ${row.response_id}`);
        }
      }

      const payload: SendNotificationPayload = {
        response_id: row.response_id,
        business_id: row.business_id,
        failover: { reason: 'all_deliveries_failed' },
        correlation_id: await recoverFailoverCorrelationId(row.response_id),
      };
      try {
        await sql`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          SELECT
            ${uuidv7()},
            'send_notification',
            'response',
            ${row.response_id},
            ${jsonb(payload)},
            'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox jo
            WHERE jo.topic = 'send_notification'
              AND jo.aggregate_id = ${row.response_id}
              AND jo.status IN ('pending', 'dispatching', 'dispatched')
          )
        `;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === '23505') continue;
        console.error(`${LOG_PREFIX} Failed to queue all-failed failover for response ${row.response_id}:`, err);
      }
    }

    if (allFailedResponses.length > 0) {
      console.log(`${LOG_PREFIX} Processed ${allFailedResponses.length} all-failed responses`);
    }

    // ── 2. Stale: pending_approval >4h, at least one send attempted, no approval ──
    //
    // Query gates on sent_at (we tried to notify), NOT delivered_at. Telegram
    // Bot API has no "delivered to recipient" callback, and SMS/WhatsApp
    // delivery webhooks are unreliable in some regions — gating on
    // delivered_at would false-alert on every Telegram-enrolled owner.
    //
    // Multi-channel era: re-sending has already happened across every enrolled
    // channel on initial dispatch. If the owner hasn't approved after 4h on
    // ANY channel, resending is unlikely to help — escalate to admin instead.
    // See docs/adding-communication-channels.md §3.5.
    const staleResponses = await sql<{
      response_id: string;
      business_id: string;
      business_name: string;
      reviewer_name: string;
      star_rating: number;
    }[]>`
      SELECT resp.id AS response_id, resp.business_id,
             b.name AS business_name, r.reviewer_name, r.star_rating
      FROM responses resp
      JOIN businesses b ON resp.business_id = b.id
      JOIN reviews r ON resp.review_id = r.id
      WHERE resp.status = 'pending_approval'
        AND resp.created_at < NOW() - INTERVAL '4 hours'
        AND EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.response_id = resp.id
            AND nd.template = 'approval_request'
            AND nd.sent_at IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = 'send_notification'
            AND jo.aggregate_id = resp.id
            AND jo.status IN ('pending', 'dispatching', 'dispatched')
        )
    `;

    const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
    let alertedCount = 0;
    for (const row of staleResponses) {
      if (!adminEmail) {
        console.warn(`${LOG_PREFIX} Stuck response ${row.response_id} detected but ADMIN_NOTIFICATION_EMAIL not set — no alert sent`);
        continue;
      }

      const outcome = await tryClaimAlert(
        row.response_id,
        'approval_responsiveness_alert',
        adminEmail,
        async () => {
          const { messageId } = await sendInternalEmail({
            to: adminEmail,
            subject: `Approval stuck: ${row.business_name} — no response in 4+ hours`,
            bodyHtml: `<p>A draft response to <strong>${escapeHtml(row.reviewer_name)}</strong>'s ${row.star_rating}-star review of <strong>${escapeHtml(row.business_name)}</strong> has been waiting for owner approval for more than 4 hours.</p>
              <p>At least one enrolled channel was notified; the owner simply hasn't responded. Check the delivery log for partial failures. Consider a check-in call.</p>
              <p><em>Response ID: ${row.response_id}</em></p>`,
            category: 'internal',
          });
          return messageId;
        },
        {
          businessId: row.business_id,
          responseId: row.response_id,
        },
      );
      if (outcome === 'sent') alertedCount++;
      if (outcome === 'send_error') {
        console.error(`${LOG_PREFIX} Failed to send responsiveness alert for response ${row.response_id}`);
      }
    }

    if (alertedCount > 0) {
      console.log(`${LOG_PREFIX} Sent ${alertedCount} responsiveness alerts (${staleResponses.length} stuck candidates)`);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Poll cycle failed:`, error);
  } finally {
    isPolling = false;
  }
}

export function startNotificationFailoverPoller(): void {
  const intervalMs = getIntervalMs();
  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms)`);
  runFailoverPollerOnce().catch(console.error);
  pollerInterval = setInterval(() => {
    runFailoverPollerOnce().catch(console.error);
  }, intervalMs);
}

export function stopNotificationFailoverPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
}
