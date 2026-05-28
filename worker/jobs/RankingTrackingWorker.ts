import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { getJson } from 'serpapi';
import { sql } from '../../src/lib/db/server';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import { checkRateLimit } from '../../src/lib/shared/rate-limit';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import type { TrackRankingPayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { asLocationId } from '../../src/lib/shared/ids';
import type { LocationId } from '../../src/lib/shared/ids';
import { getLocationContext } from '../../src/lib/db/account-guard';

type RankingLogger = ReturnType<typeof createWorkerLogger>;

interface RankingBusiness {
  google_place_id: string | null;
  google_place_lat: number | null;
  google_place_lng: number | null;
  ranking_search_location: string | null;
}

// Parse the JSONB tracked_keywords column into a clean string[]. Malformed
// JSON (or a non-array shape) collapses to an empty list rather than throwing,
// matching the worker's "treat as no keywords" behavior.
function parseTrackedKeywords(
  raw: unknown,
  businessId: LocationId,
  logger: RankingLogger,
): string[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed)
      ? parsed.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      : [];
  } catch {
    logger.warn(`Business ${businessId}: malformed tracked_keywords, treating as empty`);
    return [];
  }
}

// Resolve a single keyword's local-pack rank. Mock mode returns a random rank;
// otherwise it queries SerpAPI and matches on google_place_id, preferring
// SerpAPI's own position over the array index.
async function resolveRankPosition(
  keyword: string,
  business: RankingBusiness,
  hasCoords: boolean,
  logger: RankingLogger,
): Promise<number | null> {
  if (isMockMode()) {
    const rankPosition = Math.floor(Math.random() * 10) + 1;
    logger.log(`[mock] keyword="${keyword}" rank=${rankPosition}`);
    return rankPosition;
  }

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

  let rankPosition: number | null;
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
  return rankPosition;
}

export async function handleTrackRanking(job: Job<TrackRankingPayload>): Promise<void> {
  const logger = createWorkerLogger('[RankingTrackingWorker]', job.data.correlation_id);
  // Cast job data IDs to branded types at entry point
  const businessId: LocationId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // ── Step 1: Load business + account context via account-guard ──────
  const ctx = await getLocationContext(businessId);

  if (!ctx) {
    logger.warn(`Business ${businessId} not found or has no account`);
    await markOutboxFailed(outboxId, 'business_not_found', outboxAttempt);
    return;
  }

  const [business] = await sql<{
    id: string;
    tracked_keywords: unknown;
    google_place_id: string | null;
    google_place_lat: number | null;
    google_place_lng: number | null;
    ranking_search_location: string | null;
  }[]>`
    SELECT id, tracked_keywords,
           google_place_id, google_place_lat, google_place_lng, ranking_search_location
    FROM businesses WHERE id = ${businessId}
  `;

  if (!business) {
    logger.warn(`Business ${businessId} not found`);
    await markOutboxFailed(outboxId, 'business_not_found', outboxAttempt);
    return;
  }

  // ── Step 2: Strict active-only guard (ranking costs real SerpAPI spend) ──
  // Unlike notification/summary workers that use checkSubscription (allows past_due grace),
  // ranking requires strictly active — no paid API calls for non-paying businesses.
  if (ctx.account.subscriptionStatus !== 'active') {
    logger.log(`Business ${businessId} skipped: subscription_status=${ctx.account.subscriptionStatus}`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // Re-check google_place_id — may have been cleared or changed since scheduling
  if (!business.google_place_id) {
    logger.log(`Business ${businessId} skipped: no google_place_id`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── Step 3: Parse tracked_keywords (JSONB guard + shape validation) ─
  const rawKeywords = parseTrackedKeywords(business.tracked_keywords, businessId, logger);

  if (rawKeywords.length === 0) {
    logger.log(`Business ${businessId} has no tracked keywords`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // Sprint 5B initial rollout: limit to 1 keyword per business
  const keywords = rawKeywords.slice(0, 1);

  // ── Step 4: Location check ────────────────────────────────────────
  const hasCoords = business.google_place_lat != null && business.google_place_lng != null;
  const hasSearchLocation = !!business.ranking_search_location;

  if (!hasCoords && !hasSearchLocation) {
    logger.log(`Business ${businessId} has no location data for ranking search`);
    await markOutboxCompleted(outboxId, outboxAttempt);
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
      await markOutboxCompleted(outboxId, outboxAttempt);
      return;
    }

    if (!budgetCheck.allowed) {
      logger.log(`Monthly SerpAPI ranking budget exhausted at keyword "${keyword}"`);
      break; // Stop processing keywords but still mark outbox completed for keywords already done
    }

    // ── Step 6: Resolve rank (mock random, or SerpAPI google_maps match) ──
    const rankPosition = await resolveRankPosition(keyword, business, hasCoords, logger);

    // ── Step 7: Upsert ranking snapshot ─────────────────────────────
    await sql`
      INSERT INTO ranking_snapshots (id, business_id, keyword, rank_position, search_location, snapshot_date, source)
      VALUES (${uuidv7()}, ${businessId}, ${keyword}, ${rankPosition}, ${searchLocationValue}, ${today}, 'serpapi')
      ON CONFLICT (business_id, keyword, snapshot_date)
      DO UPDATE SET rank_position = EXCLUDED.rank_position, search_location = EXCLUDED.search_location, source = 'serpapi'
    `;
  }

  await markOutboxCompleted(outboxId, outboxAttempt);
  logger.log(`Ranking tracking complete for business ${businessId}`);
}
