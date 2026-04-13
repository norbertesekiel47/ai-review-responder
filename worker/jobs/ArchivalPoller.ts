import { sql } from '../../src/lib/db/server';

const LOG_PREFIX = '[ArchivalPoller]';
const DEFAULT_INTERVAL_MS = 86_400_000; // 24 hours

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

function getIntervalMs(): number {
  const envVal = process.env.ARCHIVAL_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

async function runArchival(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    // 1. Completed outbox entries older than 7 days (batched to avoid long locks)
    const [outboxResult] = await sql<{ count: string }[]>`
      WITH candidates AS (
        SELECT id FROM job_outbox
        WHERE status = 'completed'
          AND completed_at < NOW() - INTERVAL '7 days'
        LIMIT 5000
      ),
      deleted AS (
        DELETE FROM job_outbox WHERE id IN (SELECT id FROM candidates)
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `;

    // 2. Processed inbound events older than 30 days
    const [eventsResult] = await sql<{ count: string }[]>`
      WITH candidates AS (
        SELECT id FROM inbound_events
        WHERE status = 'processed'
          AND processed_at < NOW() - INTERVAL '30 days'
        LIMIT 5000
      ),
      deleted AS (
        DELETE FROM inbound_events WHERE id IN (SELECT id FROM candidates)
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `;

    // 3. Expired prospect demos older than 30 days past expiry
    const [demosResult] = await sql<{ count: string }[]>`
      WITH candidates AS (
        SELECT id FROM prospect_demos
        WHERE expires_at < NOW() - INTERVAL '30 days'
          AND generation_status = 'completed'
        LIMIT 5000
      ),
      deleted AS (
        DELETE FROM prospect_demos WHERE id IN (SELECT id FROM candidates)
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `;

    const outboxCount = parseInt(outboxResult?.count ?? '0', 10);
    const eventsCount = parseInt(eventsResult?.count ?? '0', 10);
    const demosCount = parseInt(demosResult?.count ?? '0', 10);

    if (outboxCount + eventsCount + demosCount > 0) {
      console.log(
        `${LOG_PREFIX} Archived: ${outboxCount} outbox entries, ${eventsCount} inbound events, ${demosCount} expired demos`,
      );
      if (outboxCount >= 5000 || eventsCount >= 5000 || demosCount >= 5000) {
        console.warn(`${LOG_PREFIX} Batch limit (5000) reached — more rows may remain. Next cycle will continue cleanup.`);
      }
    } else {
      console.log(`${LOG_PREFIX} Nothing to archive`);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Archival cycle failed:`, error);
  } finally {
    isPolling = false;
  }
}

export function startArchivalPoller(): void {
  const intervalMs = getIntervalMs();
  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms)`);
  runArchival().catch(console.error);
  pollerInterval = setInterval(() => {
    runArchival().catch(console.error);
  }, intervalMs);
}

export function stopArchivalPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
}
