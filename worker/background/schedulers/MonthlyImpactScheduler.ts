import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../../src/lib/db/server';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import type { SendMonthlyImpactPayload } from '../../../src/lib/shared/worker-types';

const LOG_PREFIX = '[MonthlyImpactScheduler]';
const logger = createWorkerLogger(LOG_PREFIX);
const DEFAULT_INTERVAL_MS = 3_600_000;
const MONTHLY_IMPACT_TIMEZONE = 'UTC';

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

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
  if (isPolling) return;
  isPolling = true;
  try {
    const now = new Date();
    const utcDate = now.getUTCDate();
    const utcHour = now.getUTCHours();
    if (utcDate !== 1 || utcHour < 9 || utcHour >= 10) return;

    const monthStartDate = getPreviousMonthStart(now);

    const businesses = await sql<{ id: string }[]>`
      SELECT b.id FROM businesses b
      JOIN accounts a ON a.id = b.account_id
      WHERE a.subscription_status IN ('active', 'past_due')
        AND b.archived_at IS NULL
        AND (b.monthly_impact_enabled IS NULL OR b.monthly_impact_enabled = TRUE)
        AND NOT EXISTS (
          SELECT 1 FROM monthly_impact_emails mie
          WHERE mie.business_id = b.id
            AND mie.month_start_date = ${monthStartDate}::date
            AND mie.sent_at IS NOT NULL
        )
    `;

    let queued = 0;
    for (const biz of businesses) {
      const payload: SendMonthlyImpactPayload = {
        business_id: biz.id,
        month_start_date: monthStartDate,
        correlation_id: uuidv7(),
      };
      try {
        const inserted = await sql`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          SELECT ${uuidv7()}, 'send_monthly_impact', 'business', ${biz.id}, ${jsonb(payload)}, 'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox jo
            WHERE jo.topic = 'send_monthly_impact'
              AND jo.aggregate_id = ${biz.id}
              AND jo.status IN ('pending', 'dispatching', 'dispatched')
              AND jo.payload->>'month_start_date' = ${monthStartDate}
          )
        `;
        if (inserted.count > 0) queued++;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === '23505') continue;
        logger.error(`Failed to queue monthly impact for business ${biz.id}`, err);
      }
    }

    if (queued > 0) {
      logger.log(`Queued ${queued} send_monthly_impact outbox entries for month ${monthStartDate}`);
    }
  } catch (error) {
    logger.error('Scheduler cycle failed', error);
  } finally {
    isPolling = false;
  }
}

export function startMonthlyImpactScheduler(): void {
  const intervalMs = getIntervalMs();
  logger.log(`Starting (interval=${intervalMs}ms, timezone=${MONTHLY_IMPACT_TIMEZONE})`);
  checkAndSchedule().catch((err) => logger.error('Initial run failed', err));
  pollerInterval = setInterval(() => {
    checkAndSchedule().catch((err) => logger.error('Scheduled run failed', err));
  }, intervalMs);
}

export function stopMonthlyImpactScheduler(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    logger.log('Stopped');
  }
}
