import { sql } from '../../../src/lib/db/server';
import { QUEUE_NAMES } from '../../../src/lib/shared/queue-names';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { createGuardedPoll } from '../guarded-poll';

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

    // Set-based enqueue: merge the candidate scan with the outbox insert. The
    // candidate-level in-flight NOT EXISTS is a cheap pre-filter; the partial
    // unique index (migration 079) + ON CONFLICT DO NOTHING is the correctness
    // owner for dedup under concurrent schedulers / restarts. gen_random_uuid()
    // (not app UUIDv7) supplies id + correlation_id because a set-based
    // INSERT…SELECT cannot call the JS generator per row and job_outbox.id has
    // no ordering contract — see migration 079 lab note.
    const result = await sql`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      SELECT
        gen_random_uuid(),
        ${QUEUE_NAMES.WEEKLY_SUMMARY},
        'business',
        b.id,
        jsonb_build_object(
          'business_id', b.id,
          'week_start_date', ${weekStartDate}::text,
          'correlation_id', gen_random_uuid()
        ),
        'pending'
      FROM businesses b
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
        AND NOT EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = ${QUEUE_NAMES.WEEKLY_SUMMARY}
            AND jo.aggregate_id = b.id
            AND jo.status IN ('pending', 'dispatching', 'dispatched')
            AND jo.payload->>'week_start_date' = ${weekStartDate}
        )
      ON CONFLICT DO NOTHING
    `;

    const queued = result.count;
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
