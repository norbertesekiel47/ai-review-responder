// SPRINT 5B DEFERRAL: Prompt 19d specifies "trend direction" in partner_low_engagement
// alerts. Deferred to Sprint 5B because computing trend requires comparing the current
// 30-day approval rate against a previous 30-day window, which needs either historical
// approval_rate snapshots or a dual-window query. Current implementation uses neutral
// wording ("approval rate is X%") instead of claiming a direction. When implementing:
// add a previous_approval_rate field to EngagementAlertPayload.metrics, compute it in
// the metrics CTE, and pass trend direction ('declining' | 'stable' | 'improving') to
// the low-engagement email template.

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
  partner_satisfaction_alert: 7, // Satisfaction pulse alerts are created by the pulse handler, not this poller
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
      WITH active_biz AS (
        SELECT id FROM businesses WHERE subscription_status = 'active'
      ),
      response_metrics AS (
        SELECT
          resp.business_id,
          MAX(resp.approved_at) FILTER (WHERE resp.status IN ('approved','edited','posted','awaiting_manual_post')) AS last_approval,
          COUNT(*) FILTER (WHERE resp.status = 'pending_approval')::int AS pending_count,
          MIN(resp.created_at) FILTER (WHERE resp.status = 'pending_approval') AS oldest_pending_at
        FROM responses resp
        WHERE resp.business_id IN (SELECT id FROM active_biz)
        GROUP BY resp.business_id
      ),
      notif_metrics AS (
        SELECT
          nd.business_id,
          COUNT(DISTINCT nd.response_id)::int AS notified_count,
          COUNT(DISTINCT nd.response_id) FILTER (
            WHERE r.status IN ('approved','edited','posted','awaiting_manual_post')
          )::int AS approved_count
        FROM notification_deliveries nd
        JOIN responses r ON r.id = nd.response_id
        WHERE nd.business_id IN (SELECT id FROM active_biz)
          AND nd.template = 'approval_request'
          AND nd.sent_at IS NOT NULL
          AND nd.sent_at >= CURRENT_DATE - 30
        GROUP BY nd.business_id
      )
      SELECT
        ab.id AS business_id,
        EXTRACT(DAY FROM CURRENT_TIMESTAMP - rm.last_approval)::int AS days_since_approval,
        COALESCE(rm.pending_count, 0) AS pending_count,
        EXTRACT(DAY FROM CURRENT_TIMESTAMP - rm.oldest_pending_at)::int AS oldest_pending_age_days,
        COALESCE(nm.notified_count, 0) AS notified_count,
        COALESCE(nm.approved_count, 0) AS approved_count
      FROM active_biz ab
      LEFT JOIN response_metrics rm ON rm.business_id = ab.id
      LEFT JOIN notif_metrics nm ON nm.business_id = ab.id
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

        let insertedCount = 0;
        try {
          const inserted = await sql`
            INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
            SELECT
              ${uuidv7()}, 'engagement_alert', 'business', ${row.business_id},
              ${JSON.stringify(payload)}::jsonb, 'pending'
            WHERE NOT EXISTS (
              SELECT 1 FROM notification_deliveries
              WHERE business_id = ${row.business_id}
                AND template = ${rule.type}
                AND sent_at > NOW() - ${cooldownDays} * INTERVAL '1 day'
            )
            AND NOT EXISTS (
              SELECT 1 FROM job_outbox
              WHERE topic = 'engagement_alert'
                AND aggregate_id = ${row.business_id}
                AND status IN ('pending', 'dispatching', 'dispatched')
                AND payload->>'alert_type' = ${rule.type}
            )
          `;
          insertedCount = inserted.count;
        } catch (insertErr: unknown) {
          const code = (insertErr as { code?: string }).code;
          if (code === '23505') continue; // lost the race — another process already queued this alert
          throw insertErr;
        }

        if (insertedCount > 0) {
          totalAlerts++;
          businessesAlerted.add(row.business_id);
        }
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
