import { sql } from '../../src/lib/db/server';
import { topicToQueue } from '../queues';

interface OutboxEntry {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

const POLL_INTERVAL_MS = 10_000;
const BATCH_SIZE = 50;

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

async function pollOutbox(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    const entries = await sql<OutboxEntry[]>`
      SELECT id, topic, payload, attempts, max_attempts
      FROM job_outbox
      WHERE status = 'pending'
        AND available_at <= NOW()
      ORDER BY available_at
      LIMIT ${BATCH_SIZE}
    `;

    if (entries.length === 0) return;

    console.log(`[OutboxPoller] Found ${entries.length} pending entries`);

    for (const entry of entries) {
      const queue = topicToQueue[entry.topic];

      if (!queue) {
        console.error(`[OutboxPoller] Unknown topic "${entry.topic}" for outbox entry ${entry.id}`);
        await sql`
          UPDATE job_outbox
          SET status = 'failed',
              last_error = ${'Unknown topic: ' + entry.topic},
              attempts = attempts + 1
          WHERE id = ${entry.id}
        `;
        continue;
      }

      try {
        // jobId = outbox entry id → idempotent (BullMQ skips duplicates)
        await queue.add(entry.topic, entry.payload, { jobId: entry.id });

        await sql`
          UPDATE job_outbox
          SET status = 'dispatched',
              dispatched_at = NOW(),
              attempts = attempts + 1
          WHERE id = ${entry.id}
        `;
      } catch (dispatchError) {
        console.error(
          `[OutboxPoller] Failed to dispatch entry ${entry.id} (topic=${entry.topic}):`,
          dispatchError,
        );
        // Leave as 'pending' — next cycle will retry
      }
    }
  } catch (error) {
    console.error('[OutboxPoller] Poll cycle failed:', error);
  } finally {
    isPolling = false;
  }
}

export function startOutboxPoller(): void {
  console.log(`[OutboxPoller] Starting (interval=${POLL_INTERVAL_MS}ms, batch=${BATCH_SIZE})`);
  pollOutbox().catch(console.error);
  pollerInterval = setInterval(() => {
    pollOutbox().catch(console.error);
  }, POLL_INTERVAL_MS);
}

export function stopOutboxPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log('[OutboxPoller] Stopped');
  }
}
