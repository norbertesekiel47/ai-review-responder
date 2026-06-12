import { sql } from '../../../src/lib/db/server';
import {
  captureAnalyticsEvent,
  flushAnalytics,
  isAnalyticsConfigured,
} from '../../../src/lib/analytics/posthog';
import { createWorkerLogger, logUnhandledPollError } from '../../../src/lib/shared/logger';

const LOG_PREFIX = '[AnalyticsDispatchPoller]';

interface AnalyticsEventRow {
  id: string;
  event_key: string;
  event_name: string;
  distinct_id: string;
  properties: Record<string, unknown> | string;
  attempts: number;
  max_attempts: number;
}

// Written to last_error when the stale-row reclaim hands a crashed-mid-dispatch row
// back to 'pending'. Lets a recovered crash be distinguished from a real PostHog error.
const RECLAIMED_STALE_DISPATCH_ERROR = 'reclaimed_stale_dispatch';

function parseInteger(value: string | undefined, defaultValue: number): number {
  if (!value || !/^\d+$/.test(value.trim())) {
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
let activeRun: Promise<void> | null = null;

async function markDispatchCompleted(row: AnalyticsEventRow): Promise<void> {
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
}

// Real per-event errors retry with exponential backoff + jitter, then terminate
// at max_attempts. Burning the retry budget is correct here: the event itself is
// the problem (poison row).
async function markDispatchFailed(row: AnalyticsEventRow, message: string): Promise<void> {
  await sql`
    UPDATE analytics_events
    SET status = ${row.attempts >= row.max_attempts ? 'failed' : 'pending'},
        locked_at = NULL,
        last_error = ${message},
        available_at = NOW()
          + (INTERVAL '1 minute' * LEAST(POWER(2, ${row.attempts})::int, 60))
          + (random() * INTERVAL '30 seconds')
    WHERE id = ${row.id}::uuid
      AND status = 'dispatching'
      AND attempts = ${row.attempts}
  `;
}

// Config/infra conditions (PostHog unconfigured, flush failure) are NOT the
// event's fault, so defer without consuming the retry budget — revert the claim
// increment so these events can never walk to a permanent 'failed' state.
async function markDispatchDeferred(row: AnalyticsEventRow, message: string): Promise<void> {
  await sql`
    UPDATE analytics_events
    SET status = 'pending',
        locked_at = NULL,
        last_error = ${message},
        attempts = attempts - 1,
        available_at = NOW() + INTERVAL '1 minute'
    WHERE id = ${row.id}::uuid
      AND status = 'dispatching'
      AND attempts = ${row.attempts}
  `;
}

async function dispatchOnce(): Promise<void> {
  // No key configured → leave every pending row untouched so the queue is fully
  // recoverable once PostHog is wired up. Never claim (which would burn attempts).
  if (!isAnalyticsConfigured()) {
    return;
  }

  // A worker that crashed between claim and mark leaves a row stranded in
  // 'dispatching' with the claim's attempt increment already applied. Reclaiming it
  // is an infra fault, not the event's fault, so hand the attempt back the same way
  // markDispatchDeferred does. GREATEST floors at 0 because this bulk UPDATE acts on
  // rows it did not claim and has no per-row `AND attempts = $n` guard.
  await sql`
    UPDATE analytics_events
    SET status = 'pending',
        locked_at = NULL,
        attempts = GREATEST(attempts - 1, 0),
        last_error = ${RECLAIMED_STALE_DISPATCH_ERROR},
        available_at = NOW()
    WHERE status = 'dispatching'
      AND locked_at IS NOT NULL
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

  const captured: AnalyticsEventRow[] = [];
  for (const row of rows) {
    try {
      const properties = typeof row.properties === 'string'
        ? JSON.parse(row.properties) as Record<string, unknown>
        : row.properties;
      const ok = captureAnalyticsEvent({
        event: row.event_name,
        distinctId: row.distinct_id,
        properties: { ...properties, $insert_id: row.event_key },
      });
      if (!ok) {
        await markDispatchDeferred(row, 'posthog_not_configured');
        continue;
      }
      captured.push(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markDispatchFailed(row, message);
    }
  }

  if (captured.length === 0) {
    return;
  }

  // captureAnalyticsEvent only buffers in memory; confirm delivery with a flush
  // BEFORE marking rows completed so 'completed' means sent, not just queued.
  try {
    await flushAnalytics();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const row of captured) {
      await markDispatchDeferred(row, `flush_failed: ${message}`);
    }
    return;
  }

  for (const row of captured) {
    await markDispatchCompleted(row);
  }
}

export function runAnalyticsDispatchOnce(): Promise<void> {
  if (activeRun) {
    return activeRun;
  }
  activeRun = dispatchOnce().finally(() => {
    activeRun = null;
  });
  return activeRun;
}

export function startAnalyticsDispatchPoller(): void {
  const pollInterval = pollIntervalMs();
  const logger = createWorkerLogger(LOG_PREFIX);
  logger.log('Starting', { interval_ms: pollInterval, batch: batchSize() });
  runAnalyticsDispatchOnce().catch(logUnhandledPollError(LOG_PREFIX));
  interval = setInterval(() => {
    runAnalyticsDispatchOnce().catch(logUnhandledPollError(LOG_PREFIX));
  }, pollInterval);
}

export async function stopAnalyticsDispatchPoller(): Promise<void> {
  if (interval) {
    clearInterval(interval);
    interval = null;
    createWorkerLogger(LOG_PREFIX).log('Stopped');
  }
  // Drain the in-flight batch so we never mark rows completed (or call PostHog)
  // after the client has been shut down and the DB pool closed.
  if (activeRun) {
    try {
      await activeRun;
    } catch {
      // Errors are already surfaced via the poller's own catch/log.
    }
  }
}
