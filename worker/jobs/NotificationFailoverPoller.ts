import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { sendInternalEmail } from '../../src/lib/notifications/email';
import { recordNotificationDelivery } from '../../src/lib/notifications/delivery';
import { escapeHtml } from '../../src/lib/shared/html';
import type { SendNotificationPayload } from '../../src/lib/shared/worker-types';

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

async function checkFailedNotifications(): Promise<void> {
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
        const [recentAlert] = await sql<{ id: string }[]>`
          SELECT id FROM notification_deliveries
          WHERE response_id = ${row.response_id}
            AND template = 'admin_notification_failover'
            AND recipient = ${adminEmail}
            AND created_at > NOW() - INTERVAL '24 hours'
        `;

        if (!recentAlert) {
          try {
            const { messageId } = await sendInternalEmail({
              to: adminEmail,
              subject: `Notification failure: ${row.business_name} — all delivery attempts failed`,
              bodyHtml: `<p>All approval email delivery attempts have failed for a response to <strong>${escapeHtml(row.reviewer_name)}</strong>'s ${row.star_rating}-star review of <strong>${escapeHtml(row.business_name)}</strong>.</p><p>The system will re-attempt delivery. Please check the Resend dashboard for bounce/complaint details.</p>`,
              category: 'internal',
            });
            await recordNotificationDelivery({
              businessId: row.business_id,
              responseId: row.response_id,
              channel: 'email',
              recipient: adminEmail,
              template: 'admin_notification_failover',
              externalMessageId: messageId,
            });
          } catch (emailErr) {
            console.error(`${LOG_PREFIX} Failed to send admin alert for response ${row.response_id}:`, emailErr);
          }
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
            ${JSON.stringify(payload)}::jsonb,
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

    // ── 2. Stale: pending_approval >4h, no confirmed delivery, no in-flight outbox ──
    // Runs AFTER all-failed so those responses already have outbox entries and are
    // excluded by the in-flight check here.
    const staleResponses = await sql<{ response_id: string; business_id: string }[]>`
      SELECT resp.id AS response_id, resp.business_id
      FROM responses resp
      WHERE resp.status = 'pending_approval'
        AND resp.created_at < NOW() - INTERVAL '4 hours'
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.response_id = resp.id
            AND nd.template = 'approval_request'
            AND nd.delivered_at IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = 'send_notification'
            AND jo.aggregate_id = resp.id
            AND jo.status IN ('pending', 'dispatching', 'dispatched')
        )
    `;

    let staleQueued = 0;
    for (const row of staleResponses) {
      const payload: SendNotificationPayload = {
        response_id: row.response_id,
        business_id: row.business_id,
        failover: { reason: 'stale_no_delivery' },
        correlation_id: await recoverFailoverCorrelationId(row.response_id),
      };
      try {
        const inserted = await sql`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          SELECT
            ${uuidv7()},
            'send_notification',
            'response',
            ${row.response_id},
            ${JSON.stringify(payload)}::jsonb,
            'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox jo
            WHERE jo.topic = 'send_notification'
              AND jo.aggregate_id = ${row.response_id}
              AND jo.status IN ('pending', 'dispatching', 'dispatched')
          )
        `;
        if (inserted.count > 0) staleQueued++;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === '23505') continue;
        console.error(`${LOG_PREFIX} Failed to queue failover for response ${row.response_id}:`, err);
      }
    }

    if (staleQueued > 0) {
      console.log(`${LOG_PREFIX} Queued ${staleQueued} stale failover entries (${staleResponses.length} candidates)`);
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
  checkFailedNotifications().catch(console.error);
  pollerInterval = setInterval(() => {
    checkFailedNotifications().catch(console.error);
  }, intervalMs);
}

export function stopNotificationFailoverPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
}
