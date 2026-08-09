import { v7 as uuidv7 } from 'uuid';
import type { Sql } from 'postgres';
import { sql, jsonb } from '../../../src/lib/db/server';
import { QUEUE_NAMES } from '../../../src/lib/shared/queue-names';
import { isMockMode } from '../../../src/lib/shared/mock-mode';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { createGuardedPoll } from '../guarded-poll';
import type { OnboardingDripPayload } from '../../../src/lib/shared/worker-types';

const LOG_PREFIX = '[OnboardingDripScheduler]';
const logger = createWorkerLogger(LOG_PREFIX);
const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour

// Drip staleness cap (#719): a drip whose due date passed by more than this
// grace window is never queued and never sent. Without it, any outage that
// pauses drips clears into a burst of "Welcome to day 1!" emails to owners who
// joined long ago. Send AT the boundary, skip past it.
const STALENESS_GRACE_DAYS = 3;

// Churn cap (#719): stop re-minting an Outbox job for a (location, drip_type)
// that already failed this many times in the rolling window below. The
// in-flight NOT EXISTS excludes 'failed', so before this a permanently-broken
// drip re-queued every cycle forever — 93 rows across 3 locations on staging.
// Rolling rather than lifetime so a transient provider outage self-heals the
// next day; the Job-failure sink (T5) is what makes a persistent failure
// visible within the hour instead of silently trickling.
const MAX_FAILURES_PER_DAY = 3;
const CHURN_WINDOW_HOURS = 24;
// Hard per-cycle deadline (#414). 10min is far above a real cycle (due-drip scan
// + outbox insert loop → seconds) and well under the 1h interval, so a cycle hung
// on a stale connection frees the single-flight flag before the next tick instead
// of pinning it forever and silently disabling onboarding drips.
const ONBOARDING_DRIP_CYCLE_TIMEOUT_MS = 600_000; // 10 minutes

function getIntervalMs(): number {
  const envVal = process.env.ONBOARDING_DRIP_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

/** Per-cycle disposition. Skips are COUNTS so tests assert a value, not a log line. */
export interface DripCycleResult {
  queued: number;
  tooLate: number;
  churnCapped: number;
}

/**
 * One drip cycle. THROWS on a query failure — the poll wrapper below is the only
 * place that swallows. The old `checkAndSchedule` caught its own query error and
 * returned, so a crashed query and a legitimate "nothing due" were the same
 * observable: zero rows queued, no alert, for three months.
 *
 * `asOf` is injected because every bound this function enforces is a time
 * boundary, and separate `NOW()` evaluations cannot pin an equality. `exec` is
 * explicit per invariant #15 — the scheduler is the composition root that hands
 * the singleton in.
 */
export async function runOnboardingDripCycle(
  exec: Sql,
  asOf: Date,
): Promise<DripCycleResult> {
  // Single query: find all (business, drip_type) pairs that are due, not yet
  // sent (no drip_log row), and not yet queued (no non-failed outbox row).
  // Uses VALUES to cross-join drip offsets, avoiding N+1 per-business loops.
  const dueDrips = await exec<{
    business_id: string;
    drip_type: string;
    too_late: boolean;
    churn_capped: boolean;
  }[]>`
    SELECT b.id AS business_id, d.drip_type,
           b.subscription_activated_at
             < ${asOf}::timestamptz - ((d.days + ${STALENESS_GRACE_DAYS}) || ' days')::interval
             AS too_late,
           (
             SELECT count(*) FROM job_outbox jo
             WHERE jo.topic = ${QUEUE_NAMES.ONBOARDING_DRIP}
               AND jo.aggregate_id = b.id
               AND jo.payload->>'drip_type' = d.drip_type
               AND jo.status = 'failed'
               -- Three-way COALESCE because the two paths that write 'failed'
               -- disagree: the watchdog stamps completed_at, the poller's
               -- dispatch-error path (OutboxPoller.ts:293-299) does not but has
               -- refreshed dispatched_at at claim time. created_at is the floor.
               AND COALESCE(jo.completed_at, jo.dispatched_at, jo.created_at)
                     > ${asOf}::timestamptz - make_interval(hours => ${CHURN_WINDOW_HOURS})
           ) >= ${MAX_FAILURES_PER_DAY} AS churn_capped
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    CROSS JOIN (VALUES ('day_1', 1), ('day_7', 7), ('day_30', 30)) AS d(drip_type, days)
    WHERE a.subscription_status IN ('active', 'trialing')  -- enum: SubscriptionStatus.ACTIVE / .TRIALING
      AND b.subscription_activated_at IS NOT NULL
      AND b.subscription_activated_at <= ${asOf}::timestamptz - (d.days || ' days')::interval
      -- Abandoned tail: a pair past the grace window is reported for exactly one
      -- day (so the skip is observable) and then never selected again.
      AND b.subscription_activated_at
            > ${asOf}::timestamptz - ((d.days + ${STALENESS_GRACE_DAYS} + 1) || ' days')::interval
      AND NOT EXISTS (
        SELECT 1 FROM onboarding_drip_log dl
        WHERE dl.business_id = b.id AND dl.drip_type = d.drip_type
          AND dl.sent_at IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM job_outbox jo
        WHERE jo.topic = ${QUEUE_NAMES.ONBOARDING_DRIP}
          AND jo.aggregate_id = b.id
          AND jo.status <> 'failed'
          AND jo.payload->>'drip_type' = d.drip_type
      )
  `;

  const tooLate = dueDrips.filter((r) => r.too_late);
  // Staleness wins when a pair is both: a too-late pair is leaving for good, and
  // reporting it as merely churn-capped would imply it returns tomorrow.
  const churnCapped = dueDrips.filter((r) => !r.too_late && r.churn_capped);
  const actionable = dueDrips.filter((r) => !r.too_late && !r.churn_capped);

  let queued = 0;
  for (const row of actionable) {
    const payload: OnboardingDripPayload = {
      business_id: row.business_id,
      drip_type: row.drip_type as OnboardingDripPayload['drip_type'],
      correlation_id: uuidv7(),
    };

    try {
      // ON CONFLICT uses uniq_outbox_onboarding_drip partial unique index
      const inserted = await exec`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${uuidv7()},
          ${QUEUE_NAMES.ONBOARDING_DRIP},
          'business',
          ${row.business_id},
          ${jsonb(payload)},
          'pending'
        )
        ON CONFLICT DO NOTHING
      `;
      if (inserted.count > 0) queued++;
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === '23505') continue;
      logger.error(`Failed to queue ${row.drip_type} for business ${row.business_id}`, err);
    }
  }

  if (tooLate.length > 0) {
    logger.warn('Skipped drips past the staleness grace window', {
      count: tooLate.length,
      grace_days: STALENESS_GRACE_DAYS,
    });
  }
  if (churnCapped.length > 0) {
    logger.warn('Skipped drips at the daily failure cap', {
      count: churnCapped.length,
      max_failures_per_day: MAX_FAILURES_PER_DAY,
    });
  }
  if (queued > 0) {
    logger.log(`Queued ${queued} onboarding_drip outbox entries`);
  }

  return { queued, tooLate: tooLate.length, churnCapped: churnCapped.length };
}

export async function checkAndSchedule(): Promise<void> {
  try {
    if (isMockMode()) {
      logger.log('Mock mode — skipping');
      return;
    }
    await runOnboardingDripCycle(sql, new Date());
  } catch (error) {
    logger.error('Scheduler cycle failed', error);
  }
}

const guard = createGuardedPoll(checkAndSchedule, {
  label: LOG_PREFIX,
  logger,
  intervalMs: getIntervalMs,
  timeoutMs: ONBOARDING_DRIP_CYCLE_TIMEOUT_MS,
  onErrorMessage: 'Scheduler cycle failed',
});

export function startOnboardingDripScheduler(): void {
  guard.start(() => logger.log(`Starting (interval=${getIntervalMs()}ms)`));
}

export function stopOnboardingDripScheduler(): void {
  guard.stop();
}
