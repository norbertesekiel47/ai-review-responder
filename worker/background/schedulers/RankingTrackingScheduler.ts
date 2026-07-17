import { sql } from '../../../src/lib/db/server';
import { QUEUE_NAMES } from '../../../src/lib/shared/queue-names';
import { rankingTrackingEnabled } from '../../../src/lib/ranking/flags';
import { createWorkerLogger, toError } from '../../../src/lib/shared/logger';
import { createGuardedPoll } from '../guarded-poll';
import { isMockMode } from '../../../src/lib/shared/mock-mode';

const LOG_PREFIX = '[RankingTrackingScheduler]';
const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour
// Hard per-cycle deadline (#414). 10min is far above a real cycle (candidate scan
// + outbox insert loop → seconds) and well under the 1h interval, so a cycle hung
// on a stale connection frees the single-flight flag before the next tick instead
// of pinning it forever and silently disabling ranking scheduling.
const RANKING_CYCLE_TIMEOUT_MS = 600_000; // 10 minutes

function getIntervalMs(): number {
  const envVal = process.env.RANKING_TRACKING_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

/**
 * ISO 8601 week number: Monday-based weeks, week 1 contains the year's first Thursday.
 */
export function getIsoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Set to nearest Thursday: current date + 4 - current day number (Monday=1, Sunday=7)
  const dayNum = d.getUTCDay() || 7; // Convert Sunday(0) to 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return weekNum;
}

export async function runRankingCheck(): Promise<void> {
  const logger = createWorkerLogger(LOG_PREFIX);
  try {
    // Feature flag — silent return when disabled (runs hourly, no log spam)
    if (!rankingTrackingEnabled()) return;

    if (isMockMode()) {
      logger.log('Mock mode — skipping');
      return;
    }

    // Time gate: only proceed on even-week Sundays at 22:xx UTC
    const now = new Date();
    const utcDay = now.getUTCDay();    // 0 = Sunday
    const utcHour = now.getUTCHours();
    const weekNum = getIsoWeekNumber(now);

    if (utcDay !== 0 || utcHour !== 22 || weekNum % 2 !== 0) return;

    const runDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Set-based enqueue: merge the candidate scan with the outbox insert. The
    // candidate-level in-flight NOT EXISTS is a cheap pre-filter; ON CONFLICT DO
    // NOTHING backed by uniq_outbox_track_ranking_run
    // (aggregate_id, payload->>'run_date') WHERE topic='track_ranking' AND
    // status <> 'failed' is the correctness owner for dedup, preventing
    // duplicate SerpAPI spend under concurrent schedulers or restarts.
    // gen_random_uuid() (not app UUIDv7) supplies id + correlation_id because a
    // set-based INSERT…SELECT cannot call the JS generator per row and
    // job_outbox.id has no ordering contract — see migration 079 lab note.
    const result = await sql`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      SELECT
        gen_random_uuid(),
        ${QUEUE_NAMES.TRACK_RANKING},
        'business',
        b.id,
        jsonb_build_object(
          'business_id', b.id,
          'google_place_id', b.google_place_id,
          'run_date', ${runDate}::text,
          'correlation_id', gen_random_uuid()
        ),
        'pending'
      FROM businesses b
      JOIN accounts a ON a.id = b.account_id
      WHERE a.subscription_status = 'active'  -- enum: SubscriptionStatus.ACTIVE
        AND b.place_id_verified = TRUE
        AND b.google_place_id IS NOT NULL
        AND b.tracked_keywords <> '[]'::jsonb
        AND (
          (b.google_place_lat IS NOT NULL AND b.google_place_lng IS NOT NULL)
          OR b.ranking_search_location IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = ${QUEUE_NAMES.TRACK_RANKING}
            AND jo.aggregate_id = b.id
            AND jo.status IN ('pending', 'dispatching', 'dispatched')
        )
      ON CONFLICT DO NOTHING
    `;

    const queued = result.count;
    if (queued > 0) {
      logger.log('Queued track_ranking outbox entries', { queued });
    }
  } catch (error) {
    logger.error(
      'Ranking check failed',
      toError(error),
    );
  }
}

const guard = createGuardedPoll(runRankingCheck, {
  label: LOG_PREFIX,
  intervalMs: getIntervalMs,
  timeoutMs: RANKING_CYCLE_TIMEOUT_MS,
  onErrorMessage: 'Ranking check failed',
});

export function startRankingTrackingScheduler(): void {
  guard.start(() =>
    createWorkerLogger(LOG_PREFIX).log('Starting', { interval_ms: getIntervalMs() }),
  );
}

export function stopRankingTrackingScheduler(): void {
  guard.stop();
}
