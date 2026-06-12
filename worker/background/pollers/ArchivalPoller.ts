import { sql } from '../../../src/lib/db/server';
import { createWorkerLogger } from '../../../src/lib/shared/logger';

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
  const logger = createWorkerLogger(LOG_PREFIX);

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

    // 4. api_costs older than 90 days — claim via DELETE-RETURNING, then aggregate into rollups.
    //
    // DELETE-first pattern prevents double-counting under concurrent workers:
    // - candidates CTE uses FOR UPDATE SKIP LOCKED to claim rows exclusively
    // - DELETE returns the claimed row data as authoritative (a row can only
    //   be deleted once, so it can only be aggregated once)
    // - aggregated reads from DELETE's RETURNING, not a separate SELECT
    // - additive ON CONFLICT DO UPDATE still lets multi-cycle batches accumulate
    //   correctly because each cycle claims a DIFFERENT set of rows
    //
    // Ordering by (created_at, id) makes claiming deterministic and index-friendly.
    const [costsResult] = await sql<{ count: string }[]>`
      WITH candidates AS (
        SELECT id FROM api_costs
        WHERE created_at < NOW() - INTERVAL '90 days'
        ORDER BY created_at, id
        LIMIT 5000
        FOR UPDATE SKIP LOCKED
      ),
      deleted AS (
        DELETE FROM api_costs WHERE id IN (SELECT id FROM candidates)
        RETURNING business_id, provider, created_at::date AS cost_date,
                  cost_usd,
                  COALESCE(input_tokens, 0)::bigint AS input_tokens,
                  COALESCE(output_tokens, 0)::bigint AS output_tokens
      ),
      aggregated AS (
        SELECT business_id, provider, cost_date,
               SUM(cost_usd) AS total_cost_usd,
               SUM(input_tokens)::bigint AS total_input_tokens,
               SUM(output_tokens)::bigint AS total_output_tokens,
               COUNT(*)::bigint AS call_count
        FROM deleted
        GROUP BY business_id, provider, cost_date
      ),
      upserted AS (
        INSERT INTO api_costs_daily_rollups
          (id, business_id, provider, rollup_date,
           total_cost_usd, total_input_tokens, total_output_tokens, call_count)
        SELECT gen_random_uuid(), business_id, provider, cost_date,
               total_cost_usd, total_input_tokens, total_output_tokens, call_count
        FROM aggregated
        ON CONFLICT ON CONSTRAINT uniq_cost_rollups_business_provider_date DO UPDATE SET
          total_cost_usd = api_costs_daily_rollups.total_cost_usd + EXCLUDED.total_cost_usd,
          total_input_tokens = api_costs_daily_rollups.total_input_tokens + EXCLUDED.total_input_tokens,
          total_output_tokens = api_costs_daily_rollups.total_output_tokens + EXCLUDED.total_output_tokens,
          call_count = api_costs_daily_rollups.call_count + EXCLUDED.call_count
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `;

    // 5. notification_deliveries older than 90 days — straight delete.
    // Cooldown/dedup checks in EngagementMonitor/NotificationFailover use much
    // shorter windows (24h, 3-7d), so permanent delivery records older than 90d
    // have no operational value.
    //
    // FOR UPDATE SKIP LOCKED protects against concurrent archival cycles
    // (e.g. brief overlap during Railway zero-downtime redeploy): two
    // processes wouldn't corrupt each other, but both would SELECT the
    // same candidate IDs and the duplicate DELETE no-op would make the
    // returned count misleading (saturation warnings could miss-fire).
    const [notificationsResult] = await sql<{ count: string }[]>`
      WITH candidates AS (
        SELECT id FROM notification_deliveries
        WHERE created_at < NOW() - INTERVAL '90 days'
        LIMIT 5000
        FOR UPDATE SKIP LOCKED
      ),
      deleted AS (
        DELETE FROM notification_deliveries WHERE id IN (SELECT id FROM candidates)
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `;

    const outboxCount = parseInt(outboxResult?.count ?? '0', 10);
    const eventsCount = parseInt(eventsResult?.count ?? '0', 10);
    const demosCount = parseInt(demosResult?.count ?? '0', 10);
    const costsCount = parseInt(costsResult?.count ?? '0', 10);
    const notificationsCount = parseInt(notificationsResult?.count ?? '0', 10);

    const totalArchived = outboxCount + eventsCount + demosCount + costsCount + notificationsCount;

    if (totalArchived > 0) {
      logger.log('Archived', {
        outbox: outboxCount,
        events: eventsCount,
        demos: demosCount,
        api_costs: costsCount,
        notifications: notificationsCount,
      });

      const BATCH_LIMIT = 5000;
      const saturated: string[] = [];
      if (outboxCount >= BATCH_LIMIT) saturated.push('outbox');
      if (eventsCount >= BATCH_LIMIT) saturated.push('events');
      if (demosCount >= BATCH_LIMIT) saturated.push('demos');
      if (costsCount >= BATCH_LIMIT) saturated.push('api_costs');
      if (notificationsCount >= BATCH_LIMIT) saturated.push('notifications');

      if (saturated.length > 0) {
        // The sanitizer drops array values, so join the target names into a string.
        logger.warn('Batch limit reached — more rows may remain; next cycle will continue cleanup', {
          batch_limit: BATCH_LIMIT,
          saturated_targets: saturated.join(', '),
        });
      }
    } else {
      logger.log('Nothing to archive');
    }
  } catch (error) {
    logger.error('Archival cycle failed', error instanceof Error ? error : new Error(String(error)));
  } finally {
    isPolling = false;
  }
}

export function startArchivalPoller(): void {
  const intervalMs = getIntervalMs();
  createWorkerLogger(LOG_PREFIX).log('Starting', { interval_ms: intervalMs });
  runArchival().catch((err) =>
    createWorkerLogger(LOG_PREFIX).error('Unhandled poll error', err instanceof Error ? err : new Error(String(err))),
  );
  pollerInterval = setInterval(() => {
    runArchival().catch((err) =>
      createWorkerLogger(LOG_PREFIX).error('Unhandled poll error', err instanceof Error ? err : new Error(String(err))),
    );
  }, intervalMs);
}

export function stopArchivalPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    createWorkerLogger(LOG_PREFIX).log('Stopped');
  }
}
