import { getWorkerConfig } from '../../../src/lib/config/worker';
import { sql } from '../../../src/lib/db/server';
import { createWorkerLogger, toError, type WorkerLogger } from '../../../src/lib/shared/logger';
import { createGuardedPoll } from '../guarded-poll';

const LOG_PREFIX = '[ArchivalPoller]';
const DEFAULT_INTERVAL_MS = 86_400_000; // 24 hours
// Hard per-cycle deadline (#414). 30min is far above a real cycle (6 batched
// DELETEs, LIMIT 5000 each → minutes) and well under the 24h interval, so a
// cycle hung on a stale connection frees the single-flight flag before the next
// tick instead of pinning it forever and silently disabling archival.
const ARCHIVAL_CYCLE_TIMEOUT_MS = 1_800_000; // 30 minutes

// Agent-run spine retention (migration 071: agent_runs, agent_run_steps,
// agent_outcomes). Uniform 180-day window. The binding constraint is the
// dashboard team-summary, which reads agent_outcomes up to 90 days back — the
// retention window MUST exceed that read window, so 180 > 90.
export const AGENT_SPINE_RETENTION_DAYS = 180;

function getIntervalMs(): number {
  const envVal = getWorkerConfig().ARCHIVAL_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

// Eight independent batched-DELETE arms + count/saturation reporting; the
// length is the retention vocabulary, one block per table. Pre-existing size —
// the perf pass only added the failed-outbox arm to the first block.
// fallow-ignore-next-line complexity
async function runArchival(logger: WorkerLogger): Promise<void> {
  try {
    // 1. Outbox entries: completed rows older than 7 days; failed rows older
    // than 90 days (kept longer for dead-letter forensics — mirrors the
    // analytics_events failed arm). Without the failed arm, dead-lettered rows
    // accumulate forever on the same table the OutboxPoller claim query scans
    // every few seconds. Failed rows from the dispatch-failure path never get
    // completed_at, so age falls back to created_at.
    const [outboxResult] = await sql<{ count: string }[]>`
      WITH candidates AS (
        SELECT id FROM job_outbox
        WHERE (status = 'completed' AND completed_at < NOW() - INTERVAL '7 days')
           OR (status = 'failed' AND COALESCE(completed_at, created_at) < NOW() - INTERVAL '90 days')
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

    // 6. analytics_events: completed rows older than 30 days (already shipped
    // to PostHog), failed rows older than 90 days (exhausted max_attempts;
    // kept longer for dispatch-outage forensics). Predicating age on
    // occurred_at lets the existing idx_analytics_events_status
    // (status, occurred_at DESC) serve both arms — no new index needed.
    //
    // FOR UPDATE SKIP LOCKED: same concurrent-cycle count-accuracy
    // rationale as notification_deliveries above.
    const [analyticsResult] = await sql<{ count: string }[]>`
      WITH candidates AS (
        SELECT id FROM analytics_events
        WHERE (status = 'completed' AND occurred_at < NOW() - INTERVAL '30 days')
           OR (status = 'failed' AND occurred_at < NOW() - INTERVAL '90 days')
        LIMIT 5000
        FOR UPDATE SKIP LOCKED
      ),
      deleted AS (
        DELETE FROM analytics_events WHERE id IN (SELECT id FROM candidates)
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `;

    // 7. agent_outcomes (migration 071 spine) older than 180 days. The window
    // must exceed the 90-day dashboard team-summary read window, so it is held
    // at AGENT_SPINE_RETENTION_DAYS (180). agent_outcomes references its parent
    // run via ON DELETE SET NULL — deleting a run does NOT cascade to it, so it
    // needs its own retention arm rather than riding the run cascade.
    //
    // FOR UPDATE SKIP LOCKED: same concurrent-cycle count-accuracy rationale as
    // notification_deliveries above.
    const [agentOutcomesResult] = await sql<{ count: string }[]>`
      WITH candidates AS (
        SELECT id FROM agent_outcomes
        WHERE occurred_at < NOW() - make_interval(days => ${AGENT_SPINE_RETENTION_DAYS})
        LIMIT 5000
        FOR UPDATE SKIP LOCKED
      ),
      deleted AS (
        DELETE FROM agent_outcomes WHERE id IN (SELECT id FROM candidates)
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `;

    // 8. agent_runs (migration 071 spine) older than 180 days. Terminal-only by
    // construction — the agent_runs_terminal_consistency CHECK makes
    // status='running' ⟺ ended_at IS NULL, and `ended_at < …` never matches
    // NULL, so running runs are never deleted; agent_run_steps prune via
    // ON DELETE CASCADE (no separate steps arm). Order: arm 7 (outcomes) runs
    // before arm 8 (runs) to avoid wasted SET NULL churn — efficiency only,
    // both arms filter by their own age.
    //
    // FOR UPDATE SKIP LOCKED: same concurrent-cycle count-accuracy rationale as
    // notification_deliveries above.
    const [agentRunsResult] = await sql<{ count: string }[]>`
      WITH candidates AS (
        SELECT id FROM agent_runs
        WHERE ended_at < NOW() - make_interval(days => ${AGENT_SPINE_RETENTION_DAYS})
        LIMIT 5000
        FOR UPDATE SKIP LOCKED
      ),
      deleted AS (
        DELETE FROM agent_runs WHERE id IN (SELECT id FROM candidates)
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `;

    const outboxCount = parseInt(outboxResult?.count ?? '0', 10);
    const eventsCount = parseInt(eventsResult?.count ?? '0', 10);
    const demosCount = parseInt(demosResult?.count ?? '0', 10);
    const costsCount = parseInt(costsResult?.count ?? '0', 10);
    const notificationsCount = parseInt(notificationsResult?.count ?? '0', 10);
    const analyticsCount = parseInt(analyticsResult?.count ?? '0', 10);
    const agentOutcomesCount = parseInt(agentOutcomesResult?.count ?? '0', 10);
    const agentRunsCount = parseInt(agentRunsResult?.count ?? '0', 10);

    const totalArchived =
      outboxCount +
      eventsCount +
      demosCount +
      costsCount +
      notificationsCount +
      analyticsCount +
      agentOutcomesCount +
      agentRunsCount;

    if (totalArchived > 0) {
      logger.log('Archived', {
        outbox: outboxCount,
        events: eventsCount,
        demos: demosCount,
        api_costs: costsCount,
        notifications: notificationsCount,
        analytics_events: analyticsCount,
        agent_outcomes: agentOutcomesCount,
        agent_runs: agentRunsCount,
      });

      const BATCH_LIMIT = 5000;
      const saturated: string[] = [];
      if (outboxCount >= BATCH_LIMIT) saturated.push('outbox');
      if (eventsCount >= BATCH_LIMIT) saturated.push('events');
      if (demosCount >= BATCH_LIMIT) saturated.push('demos');
      if (costsCount >= BATCH_LIMIT) saturated.push('api_costs');
      if (notificationsCount >= BATCH_LIMIT) saturated.push('notifications');
      if (analyticsCount >= BATCH_LIMIT) saturated.push('analytics_events');
      if (agentOutcomesCount >= BATCH_LIMIT) saturated.push('agent_outcomes');
      if (agentRunsCount >= BATCH_LIMIT) saturated.push('agent_runs');

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
    logger.error('Archival cycle failed', toError(error));
  }
}

const guard = createGuardedPoll(runArchival, {
  label: LOG_PREFIX,
  intervalMs: getIntervalMs,
  timeoutMs: ARCHIVAL_CYCLE_TIMEOUT_MS,
  onErrorMessage: 'Archival cycle failed',
});

export function startArchivalPoller(): void {
  guard.start(() =>
    createWorkerLogger(LOG_PREFIX).log('Starting', { interval_ms: getIntervalMs() }),
  );
}

export function stopArchivalPoller(): void {
  guard.stop();
}
