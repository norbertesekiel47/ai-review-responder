import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import type { EngagementAlertPayload, EngagementAlertType } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[EngagementMonitorPoller]';
const DEFAULT_INTERVAL_MS = 86_400_000; // 24 hours

const COOLDOWNS: Record<EngagementAlertType, number> = {
  owner_nudge: 3,
  partner_engagement_alert: 7,
  partner_escalation_alert: 14,
  partner_low_engagement: 7,
};

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

interface BusinessMetrics {
  business_id: string;
  days_since_approval: number | null;
  pending_count: number;
  oldest_pending_age_days: number | null;
  notified_count: number;
  approved_count: number;
}

interface EngagementRule {
  type: EngagementAlertType;
  shouldFire: (metrics: {
    activityAgeDays: number | null;
    pendingCount: number;
    approvalRate: number | null;
    notifiedCount: number;
  }) => boolean;
}

const RULES: EngagementRule[] = [
  {
    type: 'owner_nudge',
    shouldFire: (m) => m.activityAgeDays !== null && m.activityAgeDays >= 3 && m.pendingCount > 0,
  },
  {
    type: 'partner_engagement_alert',
    shouldFire: (m) => m.activityAgeDays !== null && m.activityAgeDays >= 7 && m.pendingCount > 0,
  },
  {
    type: 'partner_escalation_alert',
    shouldFire: (m) =>
      m.activityAgeDays !== null && m.activityAgeDays >= 14 && (m.pendingCount > 0 || m.notifiedCount > 0),
  },
  {
    type: 'partner_low_engagement',
    shouldFire: (m) => m.approvalRate !== null && m.approvalRate < 50 && m.notifiedCount >= 3,
  },
];

function getIntervalMs(): number {
  const envVal = process.env.ENGAGEMENT_MONITOR_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

export async function runEngagementCheck(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    const rows = await sql<BusinessMetrics[]>`
      SELECT
        b.id AS business_id,
        EXTRACT(DAY FROM CURRENT_TIMESTAMP - MAX(resp.approved_at)
          FILTER (WHERE resp.status IN ('approved','edited','posted','awaiting_manual_post'))
        )::int AS days_since_approval,
        COUNT(resp.id) FILTER (WHERE resp.status = 'pending_approval')::int AS pending_count,
        EXTRACT(DAY FROM CURRENT_TIMESTAMP - MIN(resp.created_at)
          FILTER (WHERE resp.status = 'pending_approval')
        )::int AS oldest_pending_age_days,
        (SELECT COUNT(DISTINCT nd.response_id)
         FROM notification_deliveries nd
         WHERE nd.business_id = b.id
           AND nd.template = 'approval_request'
           AND nd.sent_at IS NOT NULL
           AND nd.sent_at >= CURRENT_DATE - 30
        )::int AS notified_count,
        (SELECT COUNT(DISTINCT nd.response_id)
         FROM notification_deliveries nd
         JOIN responses r2 ON r2.id = nd.response_id
         WHERE nd.business_id = b.id
           AND nd.template = 'approval_request'
           AND nd.sent_at IS NOT NULL
           AND nd.sent_at >= CURRENT_DATE - 30
           AND r2.status IN ('approved','edited','posted','awaiting_manual_post')
        )::int AS approved_count
      FROM businesses b
      LEFT JOIN responses resp ON resp.business_id = b.id
      WHERE b.subscription_status = 'active'
      GROUP BY b.id
    `;

    let totalAlerts = 0;
    const businessesAlerted = new Set<string>();

    for (const row of rows) {
      const approvalRate =
        row.notified_count > 0 ? Math.round((row.approved_count / row.notified_count) * 100) : null;
      const activityAgeDays = row.days_since_approval ?? row.oldest_pending_age_days;

      const metrics = {
        activityAgeDays,
        pendingCount: row.pending_count,
        approvalRate,
        notifiedCount: row.notified_count,
      };

      for (const rule of RULES) {
        if (!rule.shouldFire(metrics)) continue;

        const cooldownDays = COOLDOWNS[rule.type];
        const [existing] = await sql<{ exists: number }[]>`
          SELECT 1 AS exists FROM notification_deliveries
          WHERE business_id = ${row.business_id}
            AND template = ${rule.type}
            AND sent_at > NOW() - ${cooldownDays} * INTERVAL '1 day'
          LIMIT 1
        `;

        if (existing) continue;

        const payload: EngagementAlertPayload = {
          business_id: row.business_id,
          alert_type: rule.type,
          metrics: {
            days_since_approval: row.days_since_approval,
            oldest_pending_age_days: row.oldest_pending_age_days,
            pending_count: row.pending_count,
            approval_rate: approvalRate,
            notified_count: row.notified_count,
          },
        };

        await sql`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          VALUES (${uuidv7()}, 'engagement_alert', 'business', ${row.business_id}, ${JSON.stringify(payload)}::jsonb, 'pending')
        `;

        totalAlerts++;
        businessesAlerted.add(row.business_id);
      }
    }

    if (totalAlerts > 0) {
      console.log(
        `${LOG_PREFIX} Queued ${totalAlerts} engagement alerts for ${businessesAlerted.size} businesses`,
      );
    } else {
      console.log(`${LOG_PREFIX} No engagement alerts needed`);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Engagement check failed:`, error);
  } finally {
    isPolling = false;
  }
}

export function startEngagementMonitorPoller(): void {
  const intervalMs = getIntervalMs();
  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms)`);
  runEngagementCheck().catch(console.error);
  pollerInterval = setInterval(() => {
    runEngagementCheck().catch(console.error);
  }, intervalMs);
}

export function stopEngagementMonitorPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
}
