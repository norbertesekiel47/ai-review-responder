import { sql } from '../../../src/lib/db/server';
import { captureAnalyticsEvent } from '../../../src/lib/analytics/posthog';

interface AnalyticsEventRow {
  id: string;
  event_key: string;
  event_name: string;
  distinct_id: string;
  properties: Record<string, unknown> | string;
  attempts: number;
  max_attempts: number;
}

function parseInteger(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function pollIntervalMs(): number {
  const parsed = parseInteger(process.env.ANALYTICS_DISPATCH_POLL_INTERVAL_MS, 30_000);
  return parsed > 0 ? parsed : 30_000;
}

function batchSize(): number {
  return Math.max(1, Math.min(parseInteger(process.env.ANALYTICS_DISPATCH_BATCH_SIZE, 50), 250));
}

let interval: ReturnType<typeof setInterval> | null = null;
let running = false;

async function markDispatchFailed(row: AnalyticsEventRow, message: string): Promise<void> {
  await sql`
    UPDATE analytics_events
    SET status = ${row.attempts >= row.max_attempts ? 'failed' : 'pending'},
        locked_at = NULL,
        last_error = ${message},
        available_at = NOW() + INTERVAL '5 minutes'
    WHERE id = ${row.id}::uuid
      AND status = 'dispatching'
      AND attempts = ${row.attempts}
  `;
}

export async function runAnalyticsDispatchOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await sql`
      UPDATE analytics_events
      SET status = 'pending',
          locked_at = NULL,
          available_at = NOW()
      WHERE status = 'dispatching'
        AND locked_at < NOW() - INTERVAL '10 minutes'
    `;

    const rows = await sql<AnalyticsEventRow[]>`
      UPDATE analytics_events
      SET status = 'dispatching',
          locked_at = NOW(),
          attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM analytics_events
        WHERE status = 'pending'
          AND available_at <= NOW()
        ORDER BY available_at, created_at
        LIMIT ${batchSize()}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, event_key, event_name, distinct_id, properties, attempts, max_attempts
    `;

    for (const row of rows) {
      try {
        const properties = typeof row.properties === 'string'
          ? JSON.parse(row.properties) as Record<string, unknown>
          : row.properties;
        const captured = captureAnalyticsEvent({
          event: row.event_name,
          distinctId: row.distinct_id,
          properties: { ...properties, $insert_id: row.event_key },
        });
        if (!captured) {
          await markDispatchFailed(row, 'posthog_not_configured');
          continue;
        }
        await sql`
          UPDATE analytics_events
          SET status = 'completed',
              dispatched_at = NOW(),
              locked_at = NULL,
              last_error = NULL
          WHERE id = ${row.id}::uuid
            AND status = 'dispatching'
            AND attempts = ${row.attempts}
        `;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await markDispatchFailed(row, message);
      }
    }
  } finally {
    running = false;
  }
}

export function startAnalyticsDispatchPoller(): void {
  const pollInterval = pollIntervalMs();
  console.log(`[AnalyticsDispatchPoller] Starting (interval=${pollInterval}ms, batch=${batchSize()})`);
  runAnalyticsDispatchOnce().catch(console.error);
  interval = setInterval(() => {
    runAnalyticsDispatchOnce().catch(console.error);
  }, pollInterval);
}

export function stopAnalyticsDispatchPoller(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    console.log('[AnalyticsDispatchPoller] Stopped');
  }
}
