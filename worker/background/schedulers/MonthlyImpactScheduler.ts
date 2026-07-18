import { sql } from '../../../src/lib/db/server';
import { QUEUE_NAMES } from '../../../src/lib/shared/queue-names';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { createGuardedPoll } from '../guarded-poll';

const LOG_PREFIX = '[MonthlyImpactScheduler]';
const logger = createWorkerLogger(LOG_PREFIX);
const DEFAULT_INTERVAL_MS = 3_600_000;
const MONTHLY_IMPACT_TIMEZONE = 'UTC';
// Hard per-cycle deadline (#414). 10min is far above a real cycle (business scan
// + outbox insert loop → seconds) and well under the 1h interval, so a cycle hung
// on a stale connection frees the single-flight flag before the next tick instead
// of pinning it forever and silently disabling monthly impact emails.
const MONTHLY_IMPACT_CYCLE_TIMEOUT_MS = 600_000; // 10 minutes

function getIntervalMs(): number {
  const envVal = process.env.MONTHLY_IMPACT_SCHEDULER_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

function getPreviousMonthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 10);
}

async function checkAndSchedule(): Promise<void> {
  try {
    const now = new Date();
    const utcDate = now.getUTCDate();
    const utcHour = now.getUTCHours();
    if (utcDate !== 1 || utcHour < 9 || utcHour >= 10) return;

    const monthStartDate = getPreviousMonthStart(now);

    // Set-based enqueue: merge the candidate scan with the outbox insert. The
    // candidate-level in-flight NOT EXISTS is a cheap pre-filter; the partial
    // unique index (migration 080) + ON CONFLICT DO NOTHING is the correctness
    // owner for dedup under concurrent schedulers / restarts. gen_random_uuid()
    // (not app UUIDv7) supplies id + correlation_id because a set-based
    // INSERT…SELECT cannot call the JS generator per row and job_outbox.id has
    // no ordering contract — see migration 080 lab note.
    const result = await sql`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      SELECT
        gen_random_uuid(),
        ${QUEUE_NAMES.SEND_MONTHLY_IMPACT},
        'business',
        b.id,
        jsonb_build_object(
          'business_id', b.id,
          'month_start_date', ${monthStartDate}::text,
          'correlation_id', gen_random_uuid()
        ),
        'pending'
      FROM businesses b
      JOIN accounts a ON a.id = b.account_id
      WHERE a.subscription_status IN ('active', 'past_due', 'trialing')  -- enum: SubscriptionStatus.ACTIVE / .PAST_DUE / .TRIALING
        AND b.archived_at IS NULL
        AND a.monthly_impact_enabled = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM monthly_impact_emails mie
          WHERE mie.business_id = b.id
            AND mie.month_start_date = ${monthStartDate}::date
            AND mie.sent_at IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = ${QUEUE_NAMES.SEND_MONTHLY_IMPACT}
            AND jo.aggregate_id = b.id
            AND jo.status IN ('pending', 'dispatching', 'dispatched')
            AND jo.payload->>'month_start_date' = ${monthStartDate}
        )
      ON CONFLICT DO NOTHING
    `;

    const queued = result.count;
    if (queued > 0) {
      logger.log(`Queued ${queued} send_monthly_impact outbox entries for month ${monthStartDate}`);
    }
  } catch (error) {
    logger.error('Scheduler cycle failed', error);
  }
}

const guard = createGuardedPoll(checkAndSchedule, {
  label: LOG_PREFIX,
  logger,
  intervalMs: getIntervalMs,
  timeoutMs: MONTHLY_IMPACT_CYCLE_TIMEOUT_MS,
  onErrorMessage: 'Scheduler cycle failed',
});

export function startMonthlyImpactScheduler(): void {
  guard.start(() =>
    logger.log(`Starting (interval=${getIntervalMs()}ms, timezone=${MONTHLY_IMPACT_TIMEZONE})`),
  );
}

export function stopMonthlyImpactScheduler(): void {
  guard.stop();
}
