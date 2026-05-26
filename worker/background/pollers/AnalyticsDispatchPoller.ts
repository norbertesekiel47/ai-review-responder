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

const POLL_INTERVAL_MS = parseInt(process.env.ANALYTICS_DISPATCH_POLL_INTERVAL_MS || '30000', 10);
const BATCH_SIZE = Math.max(1, Math.min(parseInt(process.env.ANALYTICS_DISPATCH_BATCH_SIZE || '50', 10), 250));

let interval: ReturnType<typeof setInterval> | null = null;
let running = false;

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
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, event_key, event_name, distinct_id, properties, attempts, max_attempts
    `;

    for (const row of rows) {
      const properties = typeof row.properties === 'string'
        ? JSON.parse(row.properties) as Record<string, unknown>
        : row.properties;
      try {
        captureAnalyticsEvent({
          event: row.event_name,
          distinctId: row.distinct_id,
          properties: { ...properties, $insert_id: row.event_key },
        });
        await sql`
          UPDATE analytics_events
          SET status = 'completed',
              dispatched_at = NOW(),
              locked_at = NULL,
              last_error = NULL
          WHERE id = ${row.id}::uuid
        `;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await sql`
          UPDATE analytics_events
          SET status = ${row.attempts >= row.max_attempts ? 'failed' : 'pending'},
              locked_at = NULL,
              last_error = ${message},
              available_at = NOW() + INTERVAL '5 minutes'
          WHERE id = ${row.id}::uuid
        `;
      }
    }
  } finally {
    running = false;
  }
}

export function startAnalyticsDispatchPoller(): void {
  console.log(`[AnalyticsDispatchPoller] Starting (interval=${POLL_INTERVAL_MS}ms, batch=${BATCH_SIZE})`);
  runAnalyticsDispatchOnce().catch(console.error);
  interval = setInterval(() => {
    runAnalyticsDispatchOnce().catch(console.error);
  }, POLL_INTERVAL_MS);
}

export function stopAnalyticsDispatchPoller(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    console.log('[AnalyticsDispatchPoller] Stopped');
  }
}
