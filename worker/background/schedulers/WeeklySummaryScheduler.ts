import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../../src/lib/db/server';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { createGuardedPoll } from '../guarded-poll';
import type { WeeklySummaryPayload } from '../../../src/lib/shared/worker-types';

const LOG_PREFIX = '[WeeklySummaryScheduler]';
const logger = createWorkerLogger(LOG_PREFIX);
const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour
const WEEKLY_SUMMARY_TIMEZONE = 'UTC';
// Hard per-cycle deadline (#414). 10min is far above a real cycle (business scan
// + outbox insert loop → seconds) and well under the 1h interval, so a cycle hung
// on a stale connection frees the single-flight flag before the next tick instead
// of pinning it forever and silently disabling weekly summaries.
const WEEKLY_SUMMARY_CYCLE_TIMEOUT_MS = 600_000; // 10 minutes

function getIntervalMs(): number {
  const envVal = process.env.WEEKLY_SUMMARY_SCHEDULER_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

/**
 * Returns the Monday 00:00 UTC of the week that just ended.
 * Works for any day of the week — not just Monday.
 */
function getPreviousMonday(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  const dayOfWeek = d.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday - 7);
  return d.toISOString().slice(0, 10);
}

// Complexity is inherited — PR 262 added a single `archived_at IS NULL` SQL
// predicate; the surrounding function shape predates it. Decomposition tracked
// in the multi-location fast-follow spec.
// fallow-ignore-next-line complexity
async function checkAndSchedule(): Promise<void> {
  try {
    const now = new Date();
    const utcDay = now.getUTCDay(); // 0=Sun, 1=Mon
    const utcHour = now.getUTCHours();

    // Only schedule on Monday between 8-9 AM UTC
    if (utcDay !== 1 || utcHour < 8 || utcHour >= 9) {
      return;
    }

    const weekStartDate = getPreviousMonday(now);

    // Find businesses that need a summary
    const businesses = await sql<{ id: string }[]>`
      SELECT b.id FROM businesses b
      JOIN accounts a ON a.id = b.account_id
      WHERE a.subscription_status IN ('active', 'past_due', 'trialing')  -- enum: SubscriptionStatus.ACTIVE / .PAST_DUE / .TRIALING
        AND b.archived_at IS NULL
        AND a.weekly_summary_enabled = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM weekly_summaries ws
          WHERE ws.business_id = b.id
            AND ws.week_start_date = ${weekStartDate}::date
            AND ws.sent_at IS NOT NULL
        )
    `;

    let queued = 0;
    for (const biz of businesses) {
      const payload: WeeklySummaryPayload = {
        business_id: biz.id,
        week_start_date: weekStartDate,
        correlation_id: uuidv7(),
      };

      try {
        const inserted = await sql`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          SELECT
            ${uuidv7()},
            'weekly_summary',
            'business',
            ${biz.id},
            ${jsonb(payload)},
            'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox jo
            WHERE jo.topic = 'weekly_summary'
              AND jo.aggregate_id = ${biz.id}
              AND jo.status IN ('pending', 'dispatching', 'dispatched')
              AND jo.payload->>'week_start_date' = ${weekStartDate}
          )
        `;
        if (inserted.count > 0) queued++;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === '23505') continue;
        logger.error(`Failed to queue summary for business ${biz.id}`, err);
      }
    }

    if (queued > 0) {
      logger.log(`Queued ${queued} weekly_summary outbox entries for week ${weekStartDate}`);
    }
  } catch (error) {
    logger.error('Scheduler cycle failed', error);
  }
}

const guard = createGuardedPoll(checkAndSchedule, {
  label: LOG_PREFIX,
  logger,
  intervalMs: getIntervalMs,
  timeoutMs: WEEKLY_SUMMARY_CYCLE_TIMEOUT_MS,
  onErrorMessage: 'Scheduler cycle failed',
});

export function startWeeklySummaryScheduler(): void {
  guard.start(() =>
    logger.log(`Starting (interval=${getIntervalMs()}ms, timezone=${WEEKLY_SUMMARY_TIMEZONE})`),
  );
}

export function stopWeeklySummaryScheduler(): void {
  guard.stop();
}
