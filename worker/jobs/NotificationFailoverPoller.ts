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
            AND jo.status IN ('pending', 'dispatched')
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
        correlation_id: uuidv7(),
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
              AND jo.status IN ('pending', 'dispatched')
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
            AND jo.status IN ('pending', 'dispatched')
        )
    `;

    let staleQueued = 0;
    for (const row of staleResponses) {
      const payload: SendNotificationPayload = {
        response_id: row.response_id,
        business_id: row.business_id,
        failover: { reason: 'stale_no_delivery' },
        correlation_id: uuidv7(),
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
              AND jo.status IN ('pending', 'dispatched')
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
