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

    // 4. api_costs older than 90 days — aggregate into rollups, then delete detail rows.
    // Single atomic CTE: candidates → aggregate → upsert → delete.
    // ON CONFLICT DO UPDATE is additive so batched runs across multiple cycles
    // accumulate correctly without double-counting.
    const [costsResult] = await sql<{ count: string }[]>`
      WITH candidates AS (
        SELECT id, business_id, provider, created_at::date AS cost_date,
               cost_usd,
               COALESCE(input_tokens, 0) AS input_tokens,
               COALESCE(output_tokens, 0) AS output_tokens
        FROM api_costs
        WHERE created_at < NOW() - INTERVAL '90 days'
        LIMIT 5000
      ),
      aggregated AS (
        SELECT business_id, provider, cost_date,
               SUM(cost_usd) AS total_cost_usd,
               SUM(input_tokens)::int AS total_input_tokens,
               SUM(output_tokens)::int AS total_output_tokens,
               COUNT(*)::int AS call_count
        FROM candidates
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
      ),
      deleted AS (
        DELETE FROM api_costs WHERE id IN (SELECT id FROM candidates)
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `;

    // 5. notification_deliveries older than 90 days — straight delete.
    // Cooldown/dedup checks in EngagementMonitor/NotificationFailover use much
    // shorter windows (24h, 3-7d), so permanent delivery records older than 90d
    // have no operational value.
    const [notificationsResult] = await sql<{ count: string }[]>`
      WITH candidates AS (
        SELECT id FROM notification_deliveries
        WHERE created_at < NOW() - INTERVAL '90 days'
        LIMIT 5000
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
