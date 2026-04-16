import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import type { WeeklySummaryPayload } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[WeeklySummaryScheduler]';
const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour
const WEEKLY_SUMMARY_TIMEZONE = 'UTC';

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

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
  if (isPolling) return;
  isPolling = true;

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
      WHERE b.subscription_status IN ('active', 'past_due')
        AND (b.weekly_summary_enabled IS NULL OR b.weekly_summary_enabled = TRUE)
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
      };

      try {
        const inserted = await sql`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          SELECT
            ${uuidv7()},
            'weekly_summary',
            'business',
            ${biz.id},
            ${JSON.stringify(payload)}::jsonb,
            'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox jo
            WHERE jo.topic = 'weekly_summary'
              AND jo.aggregate_id = ${biz.id}
              AND jo.status IN ('pending', 'dispatched')
              AND jo.payload->>'week_start_date' = ${weekStartDate}
          )
        `;
        if (inserted.count > 0) queued++;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === '23505') continue;
        console.error(`${LOG_PREFIX} Failed to queue summary for business ${biz.id}:`, err);
      }
    }

    if (queued > 0) {
      console.log(`${LOG_PREFIX} Queued ${queued} weekly_summary outbox entries for week ${weekStartDate}`);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Scheduler cycle failed:`, error);
  } finally {
    isPolling = false;
  }
}

export function startWeeklySummaryScheduler(): void {
  const intervalMs = getIntervalMs();
  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms, timezone=${WEEKLY_SUMMARY_TIMEZONE})`);
  checkAndSchedule().catch(console.error);
  pollerInterval = setInterval(() => {
    checkAndSchedule().catch(console.error);
  }, intervalMs);
}

export function stopWeeklySummaryScheduler(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
}
