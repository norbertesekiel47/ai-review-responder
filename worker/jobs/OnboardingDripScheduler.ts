import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import type { OnboardingDripPayload } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[OnboardingDripScheduler]';
const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour

const DRIP_OFFSETS: { type: OnboardingDripPayload['drip_type']; days: number }[] = [
  { type: 'day_1', days: 1 },
  { type: 'day_7', days: 7 },
  { type: 'day_30', days: 30 },
];

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

    const businesses = await sql<{ id: string; subscription_activated_at: string }[]>`
      SELECT id, subscription_activated_at FROM businesses
      WHERE subscription_status = 'active'
        AND subscription_activated_at IS NOT NULL
    `;

    if (businesses.length === 0) return;

    const now = Date.now();
    let queued = 0;

    for (const biz of businesses) {
      const activatedAt = new Date(biz.subscription_activated_at).getTime();

      for (const drip of DRIP_OFFSETS) {
        const dueAt = activatedAt + drip.days * 24 * 60 * 60 * 1000;
        if (now < dueAt) continue;

        // Check drip log — skip if already sent
        const logRows = await sql<{ id: string }[]>`
          SELECT id FROM onboarding_drip_log
          WHERE business_id = ${biz.id} AND drip_type = ${drip.type}
          LIMIT 1
        `;
        if (logRows.length > 0) continue;

        // Check outbox — skip if already queued
        const outboxRows = await sql<{ id: string }[]>`
          SELECT id FROM job_outbox
          WHERE topic = 'onboarding_drip'
            AND aggregate_id = ${biz.id}
            AND status IN ('pending', 'dispatched')
            AND payload->>'drip_type' = ${drip.type}
          LIMIT 1
        `;
        if (outboxRows.length > 0) continue;

        const payload: OnboardingDripPayload = {
          business_id: biz.id,
          drip_type: drip.type,
        };

        try {
          const inserted = await sql`
            INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
            VALUES (
              ${uuidv7()},
              'onboarding_drip',
              'business',
              ${biz.id},
              ${JSON.stringify(payload)}::jsonb,
              'pending'
            )
          `;
          if (inserted.count > 0) queued++;
        } catch (err: unknown) {
          const code = (err as { code?: string }).code;
          if (code === '23505') continue;
          console.error(`${LOG_PREFIX} Failed to queue ${drip.type} for business ${biz.id}:`, err);
        }
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
