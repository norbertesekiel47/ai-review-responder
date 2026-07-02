// SPRINT 5B DEFERRAL: Prompt 19d specifies "trend direction" in partner_low_engagement
// alerts. Deferred to Sprint 5B because computing trend requires comparing the current
// 30-day approval rate against a previous 30-day window, which needs either historical
// approval_rate snapshots or a dual-window query. Current implementation uses neutral
// wording ("approval rate is X%") instead of claiming a direction. When implementing:
// add a previous_approval_rate field to EngagementAlertPayload.metrics, compute it in
// the metrics CTE, and pass trend direction ('declining' | 'stable' | 'improving') to
// the low-engagement email template.

import { v7 as uuidv7 } from 'uuid';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import { sql, jsonb } from '../../../src/lib/db/server';
import { QUEUE_NAMES } from '../../../src/lib/shared/queue-names';
import { createWorkerLogger, toError, type WorkerLogger } from '../../../src/lib/shared/logger';
import { createGuardedPoll } from '../guarded-poll';
import type { EngagementAlertPayload, EngagementAlertType } from '../../../src/lib/shared/worker-types';
import { HANDLED_STATUSES } from '../../../src/lib/shared/response-status';

const LOG_PREFIX = '[EngagementMonitorPoller]';
const DEFAULT_INTERVAL_MS = 86_400_000; // 24 hours
// Hard per-cycle deadline (#414). 30min is far above a real cycle (one metrics
// CTE + per-business insert loop → minutes) and well under the 24h interval, so a
// cycle hung on a stale connection frees the single-flight flag before the next
// tick instead of pinning it forever and silently disabling engagement alerts.
const ENGAGEMENT_CYCLE_TIMEOUT_MS = 1_800_000; // 30 minutes

// Cooldowns in days per alert type. partner_satisfaction_alert is NOT listed here —
// its dedup is handled by the satisfaction pulse producer (Prompt 19g) + the worker's
// own idempotency check on notification_deliveries, not by this poller.
const COOLDOWNS: Partial<Record<EngagementAlertType, number>> = {
  owner_nudge: 3,
  partner_engagement_alert: 7,
  partner_escalation_alert: 14,
  partner_low_engagement: 7,
};

interface BusinessMetrics {
  business_id: string;
  owner_email_bounced: boolean;
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
  const envVal = getWorkerConfig().ENGAGEMENT_MONITOR_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

async function runEngagementCheck(logger: WorkerLogger): Promise<void> {
  try {
    const rows = await sql<BusinessMetrics[]>`
      WITH active_biz AS (
        SELECT b.id, b.owner_email_bounced
        FROM businesses b
        JOIN accounts a ON a.id = b.account_id
        WHERE a.subscription_status IN ('active', 'trialing')  -- enum: SubscriptionStatus.ACTIVE / .TRIALING
      ),
      response_metrics AS (
        SELECT
          resp.business_id,
          MAX(resp.approved_at) FILTER (WHERE resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])) AS last_approval,
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
            WHERE r.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])
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
        ab.owner_email_bounced,
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

        // owner_nudge emails go to the business owner — skip if their email has bounced.
        // Partner rules still fire: the admin needs to know about engagement issues even
        // when the owner's email is undeliverable.
        if (rule.type === 'owner_nudge' && row.owner_email_bounced) continue;

        const cooldownDays = COOLDOWNS[rule.type] ?? 7;

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
          correlation_id: uuidv7(),
        };

        let insertedCount = 0;
        try {
          const inserted = await sql`
            INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
            SELECT
              ${uuidv7()}, ${QUEUE_NAMES.ENGAGEMENT_ALERT}, 'business', ${row.business_id},
              ${jsonb(payload)}, 'pending'
            WHERE NOT EXISTS (
              SELECT 1 FROM notification_deliveries
              WHERE business_id = ${row.business_id}
                AND template = ${rule.type}
                AND sent_at > NOW() - ${cooldownDays} * INTERVAL '1 day'
            )
            AND NOT EXISTS (
              SELECT 1 FROM job_outbox
              WHERE topic = ${QUEUE_NAMES.ENGAGEMENT_ALERT}
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
      logger.log('Queued engagement alerts', {
        alert_count: totalAlerts,
        business_count: businessesAlerted.size,
      });
    } else {
      logger.log('No engagement alerts needed');
    }
  } catch (error) {
    logger.error('Engagement check failed', toError(error));
  }
}

const guard = createGuardedPoll(runEngagementCheck, {
  label: LOG_PREFIX,
  intervalMs: getIntervalMs,
  timeoutMs: ENGAGEMENT_CYCLE_TIMEOUT_MS,
  onErrorMessage: 'Engagement check failed',
});

export function startEngagementMonitorPoller(): void {
  guard.start(() =>
    createWorkerLogger(LOG_PREFIX).log('Starting', { interval_ms: getIntervalMs() }),
  );
}

export function stopEngagementMonitorPoller(): void {
  guard.stop();
}
