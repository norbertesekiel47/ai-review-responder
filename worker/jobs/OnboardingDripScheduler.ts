import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import type { OnboardingDripPayload } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[OnboardingDripScheduler]';
const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

function getIntervalMs(): number {
  const envVal = process.env.ONBOARDING_DRIP_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

export async function checkAndSchedule(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    if (isMockMode()) {
      console.log(`${LOG_PREFIX} Mock mode — skipping`);
      return;
    }

    // Single query: find all (business, drip_type) pairs that are due, not yet
    // sent (no drip_log row), and not yet queued (no non-failed outbox row).
    // Uses VALUES to cross-join drip offsets, avoiding N+1 per-business loops.
    const dueDrips = await sql<{ business_id: string; drip_type: string }[]>`
      SELECT b.id AS business_id, d.drip_type
      FROM businesses b
      CROSS JOIN (VALUES ('day_1', 1), ('day_7', 7), ('day_30', 30)) AS d(drip_type, days)
      WHERE b.subscription_status = 'active'
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
            ${JSON.stringify(payload)}::jsonb,
            'pending'
          )
          ON CONFLICT DO NOTHING
        `;
        if (inserted.count > 0) queued++;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === '23505') continue;
        console.error(`${LOG_PREFIX} Failed to queue ${row.drip_type} for business ${row.business_id}:`, err);
      }
    }

    if (queued > 0) {
      console.log(`${LOG_PREFIX} Queued ${queued} onboarding_drip outbox entries`);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Scheduler cycle failed:`, error);
  } finally {
    isPolling = false;
  }
}

export function startOnboardingDripScheduler(): void {
  if (pollerInterval) return;
  const intervalMs = getIntervalMs();
  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms)`);
  checkAndSchedule().catch(console.error);
  pollerInterval = setInterval(() => {
    checkAndSchedule().catch(console.error);
  }, intervalMs);
}

export function stopOnboardingDripScheduler(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
}
