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
    await sql.begin(async (tx) => {
      // ── Watchdog: recover stale dispatched entries ─────────────────
      // If a BullMQ worker crashed after the OutboxPoller marked the entry
      // as 'dispatched' but before the worker marked it as 'completed',
      // the entry is stuck. Reset retryable ones to 'pending'; fail terminal ones.

      const [recovered] = await tx<{ count: string }[]>`
        WITH recovered AS (
          UPDATE job_outbox
          SET status = 'pending', available_at = NOW(), dispatched_at = NULL
          WHERE status = 'dispatched'
            AND dispatched_at < NOW() - INTERVAL '1 hour'
            AND attempts < max_attempts
          RETURNING id
        )
        SELECT COUNT(*)::text AS count FROM recovered
      `;

      const [terminated] = await tx<{ count: string }[]>`
        WITH terminated AS (
          UPDATE job_outbox
          SET status = 'failed',
              last_error = 'Stale dispatched entry exceeded max_attempts',
              completed_at = NOW()
          WHERE status = 'dispatched'
            AND dispatched_at < NOW() - INTERVAL '1 hour'
            AND attempts >= max_attempts
          RETURNING id
        )
        SELECT COUNT(*)::text AS count FROM terminated
      `;

      const recoveredCount = parseInt(recovered?.count ?? '0', 10);
      const terminatedCount = parseInt(terminated?.count ?? '0', 10);

      if (recoveredCount > 0 || terminatedCount > 0) {
        console.log(
          `[OutboxPoller] Watchdog: recovered=${recoveredCount}, failed=${terminatedCount}`,
        );
      }

      const entries = await tx<OutboxEntry[]>`
        SELECT id, topic, payload, attempts, max_attempts
        FROM job_outbox
        WHERE status = 'pending'
          AND available_at <= NOW()
        ORDER BY available_at
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `;

      if (entries.length === 0) return;

      console.log(`[OutboxPoller] Found ${entries.length} pending entries`);

      for (const entry of entries) {
        const queue = topicToQueue[entry.topic];

        if (!queue) {
          console.error(`[OutboxPoller] Unknown topic "${entry.topic}" for outbox entry ${entry.id}`);
          await tx`
            UPDATE job_outbox
            SET status = 'failed',
                last_error = ${'Unknown topic: ' + entry.topic},
                attempts = attempts + 1
            WHERE id = ${entry.id}
          `;
          continue;
        }

        try {
          // Postgres.js may return JSONB as a string depending on connection config.
          // Ensure it's a parsed object before passing to BullMQ.
          const payload = typeof entry.payload === 'string'
            ? JSON.parse(entry.payload) as Record<string, unknown>
            : entry.payload;

          // jobId includes attempt count so watchdog-recovered entries get a
          // fresh BullMQ job. Without this, BullMQ treats the re-add as a
          // duplicate of the old completed/failed job and silently drops it.
          // outbox_id is passed in payload so workers can complete the right
          // outbox entry regardless of the BullMQ jobId format.
          const jobId = `${entry.id}_${entry.attempts + 1}`;
          await queue.add(entry.topic, { ...payload, outbox_id: entry.id }, { jobId });

          await tx`
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

          const nextAttempts = entry.attempts + 1;
          if (nextAttempts >= entry.max_attempts) {
            console.error(
              `[OutboxPoller] Entry ${entry.id} exceeded max_attempts (${entry.max_attempts}), marking as failed`,
            );
            await tx`
              UPDATE job_outbox
              SET status = 'failed',
                  last_error = ${'Dispatch failed after ' + entry.max_attempts + ' attempts'},
                  attempts = ${nextAttempts}
              WHERE id = ${entry.id}
            `;
          } else {
            await tx`
              UPDATE job_outbox
              SET attempts = ${nextAttempts}
              WHERE id = ${entry.id}
            `;
          }
        }
      }
    });
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
