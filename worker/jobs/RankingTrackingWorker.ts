import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { getJson } from 'serpapi';
import { sql } from '../../src/lib/db/server';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { checkRateLimit } from '../../src/lib/shared/rate-limit';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import type { TrackRankingPayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../src/lib/shared/logger';

export async function handleTrackRanking(job: Job<TrackRankingPayload>): Promise<void> {
  const logger = createWorkerLogger('[RankingTrackingWorker]', job.data.correlation_id);
  const { business_id } = job.data;
  const outboxId = (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

  // ── Step 1: Load business ─────────────────────────────────────────
  const [business] = await sql<{
    id: string;
    subscription_status: string;
    updated_at: Date;
    tracked_keywords: unknown;
    google_place_id: string | null;
    google_place_lat: number | null;
    google_place_lng: number | null;
    ranking_search_location: string | null;
  }[]>`
    SELECT id, subscription_status, updated_at, tracked_keywords,
           google_place_id, google_place_lat, google_place_lng, ranking_search_location
    FROM businesses WHERE id = ${business_id}
  `;

  if (!business) {
    logger.warn(`Business ${business_id} not found`);
    await markOutboxFailed(outboxId, 'business_not_found');
    return;
  }

  // ── Step 2: Strict active-only guard (ranking costs real SerpAPI spend) ──
  // Unlike notification/summary workers that use checkSubscription (allows past_due grace),
  // ranking requires strictly active — no paid API calls for non-paying businesses.
  if (business.subscription_status !== 'active') {
    logger.log(`Business ${business_id} skipped: subscription_status=${business.subscription_status}`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // Re-check google_place_id — may have been cleared or changed since scheduling
  if (!business.google_place_id) {
    logger.log(`Business ${business_id} skipped: no google_place_id`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── Step 3: Parse tracked_keywords (JSONB guard + shape validation) ─
  let rawKeywords: string[];
  try {
    const parsed = typeof business.tracked_keywords === 'string'
      ? JSON.parse(business.tracked_keywords)
      : business.tracked_keywords;
    // Ensure it's an array of non-empty strings
    rawKeywords = Array.isArray(parsed)
      ? parsed.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      : [];
  } catch {
    logger.warn(`Business ${business_id}: malformed tracked_keywords, treating as empty`);
    rawKeywords = [];
  }

  if (rawKeywords.length === 0) {
    logger.log(`Business ${business_id} has no tracked keywords`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // Sprint 5B initial rollout: limit to 1 keyword per business
  const keywords = rawKeywords.slice(0, 1);

  // ── Step 4: Location check ────────────────────────────────────────
  const hasCoords = business.google_place_lat != null && business.google_place_lng != null;
  const hasSearchLocation = !!business.ranking_search_location;

  if (!hasCoords && !hasSearchLocation) {
    logger.log(`Business ${business_id} has no location data for ranking search`);
    await markOutboxCompleted(outboxId);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const searchLocationValue = hasCoords
    ? `${business.google_place_lat},${business.google_place_lng}`
    : business.ranking_search_location!;

  for (const keyword of keywords) {
    // Per-keyword budget check (fail-closed via strict mode).
    // Checked inside the loop so each keyword consumes one budget slot —
    // safe when MAX_KEYWORDS_PER_BUSINESS is raised above 1.
    let budgetCheck: { allowed: boolean; remaining: number };
    try {
      budgetCheck = await checkRateLimit('serpapi:ranking:monthly', 100, 30 * 24 * 3600, { strict: true });
    } catch (err) {
      logger.warn(`Cannot enforce SerpAPI budget (Redis unavailable or not configured), skipping:`, err instanceof Error ? err.message : err);
      await markOutboxCompleted(outboxId);
      return;
    }

    if (!budgetCheck.allowed) {
      logger.log(`Monthly SerpAPI ranking budget exhausted at keyword "${keyword}"`);
      break; // Stop processing keywords but still mark outbox completed for keywords already done
    }

    let rankPosition: number | null;

    if (isMockMode()) {
      // ── Mock mode: random rank 1-10, skip SerpAPI ───────────────
      rankPosition = Math.floor(Math.random() * 10) + 1;
      logger.log(`[mock] keyword="${keyword}" rank=${rankPosition}`);
    } else {
      // ── Step 6: SerpAPI call ────────────────────────────────────
      const params: Record<string, unknown> = {
        engine: 'google_maps',
        q: keyword,
        api_key: process.env.SERPAPI_API_KEY,
      };

      if (hasCoords) {
        params.ll = `@${business.google_place_lat},${business.google_place_lng},15z`;
      } else {
        params.location = business.ranking_search_location;
      }

      const response = await getJson(params);

      if (response.error) {
        const errorMsg = typeof response.error === 'string'
          ? response.error
          : JSON.stringify(response.error);
        throw new Error(`SerpAPI ranking search error: ${errorMsg}`);
      }

      const localResults: Array<{ place_id?: string; title?: string; position?: number }> =
        response.local_results ?? [];

      const match = localResults.find(
        (r) => r.place_id === business.google_place_id,
      );

      if (match) {
        // Prefer SerpAPI's position field (handles non-contiguous results, ads, mixed groups).
        // Fall back to array index + 1 only if position is missing or non-integer.
        const idx = localResults.indexOf(match);
        rankPosition = Number.isInteger(match.position) ? match.position! : idx + 1;
      } else {
        rankPosition = null;
      }

      logger.log(
        `keyword="${keyword}" place_id=${business.google_place_id} ` +
        `rank=${rankPosition ?? 'not found'} (${localResults.length} results)`,
      );
    }

    // ── Step 7: Upsert ranking snapshot ─────────────────────────────
    await sql`
      INSERT INTO ranking_snapshots (id, business_id, keyword, rank_position, search_location, snapshot_date, source)
      VALUES (${uuidv7()}, ${business_id}, ${keyword}, ${rankPosition}, ${searchLocationValue}, ${today}, 'serpapi')
      ON CONFLICT (business_id, keyword, snapshot_date)
      DO UPDATE SET rank_position = EXCLUDED.rank_position, search_location = EXCLUDED.search_location, source = 'serpapi'
    `;
  }

  await markOutboxCompleted(outboxId);
  logger.log(`Ranking tracking complete for business ${business_id}`);
}
