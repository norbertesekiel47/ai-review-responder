import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import type { TrackRankingPayload } from '../../src/lib/shared/worker-types';

const LOG_PREFIX = '[RankingTrackingScheduler]';
const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

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
  if (isPolling) return;
  isPolling = true;

  try {
    // Feature flag — silent return when disabled (runs hourly, no log spam)
    if (process.env.RANKING_TRACKING_ENABLED !== 'true') return;

    if (isMockMode()) {
      console.log(`${LOG_PREFIX} Mock mode — skipping`);
      return;
    }

    // Time gate: only proceed on even-week Sundays at 22:xx UTC
    const now = new Date();
    const utcDay = now.getUTCDay();    // 0 = Sunday
    const utcHour = now.getUTCHours();
    const weekNum = getIsoWeekNumber(now);

    if (utcDay !== 0 || utcHour !== 22 || weekNum % 2 !== 0) return;

    const candidates = await sql<{ id: string; google_place_id: string }[]>`
      SELECT b.id, b.google_place_id
      FROM businesses b
      WHERE b.subscription_status = 'active'
        AND b.place_id_verified = TRUE
        AND b.google_place_id IS NOT NULL
        AND b.tracked_keywords <> '[]'::jsonb
        AND (
          (b.google_place_lat IS NOT NULL AND b.google_place_lng IS NOT NULL)
          OR b.ranking_search_location IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = 'track_ranking'
            AND jo.aggregate_id = b.id
            AND jo.status IN ('pending', 'dispatching', 'dispatched')
        )
    `;

    if (candidates.length === 0) return;

    const runDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    let queued = 0;
    for (const biz of candidates) {
      const payload: TrackRankingPayload = {
        business_id: biz.id,
        google_place_id: biz.google_place_id,
        run_date: runDate,
        correlation_id: uuidv7(),
      };

      try {
        // ON CONFLICT uses uniq_outbox_track_ranking_run partial unique index:
        // (aggregate_id, payload->>'run_date') WHERE topic='track_ranking' AND status NOT IN ('completed','failed')
        // This prevents duplicate SerpAPI spend even under concurrent schedulers or restarts.
        const inserted = await sql`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          VALUES (
            ${uuidv7()},
            'track_ranking',
            'business',
            ${biz.id},
            ${jsonb(payload)},
            'pending'
          )
          ON CONFLICT DO NOTHING
        `;

        if (inserted.count > 0) queued++;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === '23505') continue; // Extra safety for other unique constraints
        throw err;
      }
    }

    if (queued > 0) {
      console.log(
        `${LOG_PREFIX} Queued ${queued} track_ranking outbox entries (${candidates.length} candidates checked)`,
      );
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Ranking check failed:`, error);
  } finally {
    isPolling = false;
  }
}

export function startRankingTrackingScheduler(): void {
  if (pollerInterval) return; // Prevent duplicate intervals on double-start
  const intervalMs = getIntervalMs();
  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms)`);
  runRankingCheck().catch(console.error);
  pollerInterval = setInterval(() => {
    runRankingCheck().catch(console.error);
  }, intervalMs);
}

export function stopRankingTrackingScheduler(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
}
