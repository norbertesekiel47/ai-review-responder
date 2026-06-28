import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../../src/lib/db/server';
import { isMockMode } from '../../../src/lib/shared/mock-mode';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { createGuardedPoll } from '../guarded-poll';
import type { OnboardingDripPayload } from '../../../src/lib/shared/worker-types';

const LOG_PREFIX = '[OnboardingDripScheduler]';
const logger = createWorkerLogger(LOG_PREFIX);
const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour
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

export async function checkAndSchedule(): Promise<void> {
  try {
    if (isMockMode()) {
      logger.log('Mock mode — skipping');
      return;
    }

    // Single query: find all (business, drip_type) pairs that are due, not yet
    // sent (no drip_log row), and not yet queued (no non-failed outbox row).
    // Uses VALUES to cross-join drip offsets, avoiding N+1 per-business loops.
    const dueDrips = await sql<{ business_id: string; drip_type: string }[]>`
      SELECT b.id AS business_id, d.drip_type
      FROM businesses b
      JOIN accounts a ON a.id = b.account_id
      CROSS JOIN (VALUES ('day_1', 1), ('day_7', 7), ('day_30', 30)) AS d(drip_type, days)
      WHERE a.subscription_status IN ('active', 'trialing')  -- enum: SubscriptionStatus.ACTIVE / .TRIALING
        AND b.subscription_activated_at IS NOT NULL
        AND b.subscription_activated_at <= NOW() - (d.days || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM onboarding_drip_log dl
          WHERE dl.business_id = b.id AND dl.drip_type = d.drip_type
            AND dl.sent_at IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = 'onboarding_drip'
            AND jo.aggregate_id = b.id
            AND jo.status <> 'failed'
            AND jo.payload->>'drip_type' = d.drip_type
        )
    `;

    if (dueDrips.length === 0) return;

    let queued = 0;
    for (const row of dueDrips) {
      const payload: OnboardingDripPayload = {
        business_id: row.business_id,
        drip_type: row.drip_type as OnboardingDripPayload['drip_type'],
        correlation_id: uuidv7(),
      };

      try {
        // ON CONFLICT uses uniq_outbox_onboarding_drip partial unique index
        const inserted = await sql`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          VALUES (
            ${uuidv7()},
            'onboarding_drip',
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

    if (queued > 0) {
      logger.log(`Queued ${queued} onboarding_drip outbox entries`);
    }
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
