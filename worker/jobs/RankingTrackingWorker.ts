import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { getJson } from 'serpapi';
import { sql } from '../../src/lib/db/server';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import { getWorkerConfig } from '../../src/lib/config/worker';
import { checkRateLimit } from '../../src/lib/shared/rate-limit';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import type { TrackRankingPayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { asLocationId } from '../../src/lib/shared/ids';
import type { LocationId } from '../../src/lib/shared/ids';
import { SubscriptionStatus } from '../../src/lib/shared/subscription-status';
import { getLocationContext } from '../../src/lib/db/account-guard';
import { primaryTrackedKeywordSql } from '../../src/lib/shared/primary-tracked-keyword-sql';

type RankingLogger = ReturnType<typeof createWorkerLogger>;

// SerpAPI's getJson defaults to a ~60s socket timeout — longer than the worker's
// shutdown grace and the queue slot. Bound it like the other SerpAPI call sites
// (serpapi-source.ts, place-id-resolver.ts). (Beta-launch gate, plan C1.)
const SERPAPI_TIMEOUT_MS = 12_000;

interface RankingBusiness {
  google_place_id: string | null;
  google_place_lat: number | null;
  google_place_lng: number | null;
  ranking_search_location: string | null;
}

interface CompetitorPackEntry {
  position: number;
  placeId: string | null;
  dataCid: string | null;
  title: string;
  rating: number | null;
  reviewCount: number | null;
  isSelf: boolean;
}

interface LocalPackResult {
  rankPosition: number | null;
  pack: CompetitorPackEntry[];
}

// Synthesize a Competitor pack for mock mode: 10 entries with the is_self row
// at a random rank, shaped exactly like the real lane so the replace-pack tx
// and downstream Competitor Delta work are exercisable without SerpAPI keys.
function synthesizeMockPack(business: RankingBusiness): LocalPackResult {
  const rankPosition = Math.floor(Math.random() * 10) + 1;
  const pack: CompetitorPackEntry[] = Array.from({ length: 10 }, (_, idx) => {
    const position = idx + 1;
    if (position === rankPosition) {
      return {
        position,
        placeId: business.google_place_id,
        dataCid: null,
        title: 'Mock Self',
        rating: 4.5,
        reviewCount: 120,
        isSelf: true,
      };
    }
    return {
      position,
      placeId: `mock-place-${position}`,
      dataCid: null,
      title: `Mock Rival ${position}`,
      rating: Math.round((3.5 + Math.random() * 1.5) * 10) / 10,
      reviewCount: 20 + Math.floor(Math.random() * 380),
      isSelf: false,
    };
  });
  return { rankPosition, pack };
}

// Resolve a keyword's full local pack: our own rank plus every competitor row
// (the Competitor pack, #532/#538). Mock mode synthesizes a pack; otherwise one
// SerpAPI google_maps query — the SAME call that always resolved the rank, so
// persisting competitors adds zero marginal quota.
async function resolveLocalPack(
  keyword: string,
  business: RankingBusiness,
  hasCoords: boolean,
  logger: RankingLogger,
): Promise<LocalPackResult> {
  if (isMockMode()) {
    const result = synthesizeMockPack(business);
    logger.log(`[mock] keyword="${keyword}" rank=${result.rankPosition} pack=${result.pack.length}`);
    return result;
  }

  const params: Record<string, unknown> = {
    engine: 'google_maps',
    q: keyword,
    api_key: getWorkerConfig().SERPAPI_API_KEY,
    timeout: SERPAPI_TIMEOUT_MS,
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

  const localResults: Array<{
    place_id?: string;
    data_cid?: string;
    title?: string;
    position?: number;
    rating?: number;
    reviews?: number;
  }> = response.local_results ?? [];

  // Full-pack rule (#532): every entry is persisted; missing fields become
  // NULLs (title '' — an unnamed entry is still a rank fact), never dropped.
  const pack: CompetitorPackEntry[] = localResults.map((r, idx) => ({
    // Prefer SerpAPI's position field (handles non-contiguous results, ads,
    // mixed groups); fall back to array index + 1 — same rule the own-rank
    // match has always used.
    position: Number.isInteger(r.position) ? r.position! : idx + 1,
    placeId: typeof r.place_id === 'string' ? r.place_id : null,
    dataCid: typeof r.data_cid === 'string' ? r.data_cid : null,
    title: typeof r.title === 'string' ? r.title : '',
    rating: typeof r.rating === 'number' && Number.isFinite(r.rating) ? r.rating : null,
    reviewCount: Number.isInteger(r.reviews) ? r.reviews! : null,
    isSelf: typeof r.place_id === 'string' && r.place_id === business.google_place_id,
  }));

  const selfEntry = pack.find((entry) => entry.isSelf);
  const rankPosition = selfEntry ? selfEntry.position : null;

  logger.log(
    `keyword="${keyword}" place_id=${business.google_place_id} ` +
    `rank=${rankPosition ?? 'not found'} (${pack.length} results)`,
  );
  return { rankPosition, pack };
}

// Pre-existing ranking job handler (14 cyclomatic on main); the #538 Competitor
// pack change added only the sql.begin persistence block (upsert + pack
// replace) — guard/branch structure is unchanged, complexity is inherited.
// fallow-ignore-next-line complexity
export async function handleTrackRanking(job: Job<TrackRankingPayload>): Promise<void> {
  const logger = createWorkerLogger('[RankingTrackingWorker]', job.data.correlation_id);
  // Cast job data IDs to branded types at entry point
  const businessId: LocationId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // ── Step 1: Load business + account context via account-guard ──────
  const ctx = await getLocationContext(sql, businessId);

  if (!ctx) {
    logger.warn(`Business ${businessId} not found or has no account`);
    await markOutboxFailed(sql, outboxId, 'business_not_found', outboxAttempt);
    return;
  }

  const [business] = await sql<{
    id: string;
    primary_keyword: string | null;
    google_place_id: string | null;
    google_place_lat: number | null;
    google_place_lng: number | null;
    ranking_search_location: string | null;
  }[]>`
    SELECT b.id, ${primaryTrackedKeywordSql(sql)} AS primary_keyword,
           b.google_place_id, b.google_place_lat, b.google_place_lng, b.ranking_search_location
    FROM businesses b WHERE b.id = ${businessId}
  `;

  if (!business) {
    logger.warn(`Business ${businessId} not found`);
    await markOutboxFailed(sql, outboxId, 'business_not_found', outboxAttempt);
    return;
  }

  // ── Step 2: Strict active-only guard (ranking costs real SerpAPI spend) ──
  // Unlike notification/summary workers that use checkSubscription (allows past_due grace),
  // ranking requires strictly active — no paid API calls for non-paying businesses.
  if (ctx.account.subscriptionStatus !== SubscriptionStatus.ACTIVE) {
    logger.log(`Business ${businessId} skipped: subscription_status=${ctx.account.subscriptionStatus}`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  // Re-check google_place_id — may have been cleared or changed since scheduling
  if (!business.google_place_id) {
    logger.log(`Business ${businessId} skipped: no google_place_id`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  // ── Step 3: Primary tracked keyword ───────────────────────────────
  // Resolved in SQL by primaryTrackedKeywordSql — the single owner shared with
  // the Competitor Delta digest and the rival picker (#572). A NULL means no
  // usable keyword: NULL, non-array, empty, or all-blank tracked_keywords.
  if (business.primary_keyword === null) {
    logger.log(`Business ${businessId} has no tracked keywords`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  // Sprint 5B initial rollout: limit to 1 keyword per business
  const keywords = [business.primary_keyword];

  // ── Step 4: Location check ────────────────────────────────────────
  const hasCoords = business.google_place_lat != null && business.google_place_lng != null;
  const hasSearchLocation = !!business.ranking_search_location;

  if (!hasCoords && !hasSearchLocation) {
    logger.log(`Business ${businessId} has no location data for ranking search`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
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
      await markOutboxCompleted(sql, outboxId, outboxAttempt);
      return;
    }

    if (!budgetCheck.allowed) {
      logger.log(`Monthly SerpAPI ranking budget exhausted at keyword "${keyword}"`);
      break; // Stop processing keywords but still mark outbox completed for keywords already done
    }

    // ── Step 6: Resolve the local pack (mock synthesis, or SerpAPI google_maps) ──
    const { rankPosition, pack } = await resolveLocalPack(keyword, business, hasCoords, logger);

    // ── Step 7: Persist own rank + Competitor pack in ONE transaction ──
    // Replace-pack idempotency: delete + reinsert the pack for this
    // (business, keyword, date). A pack failure rolls back the rank row and
    // fails the job — BullMQ retry converges (upsert + replace are idempotent).
    // ORDER IS LOAD-BEARING: the rank upsert's unique-index row lock
    // (business_id, keyword, snapshot_date) serializes concurrent same-key
    // jobs, so the pack DELETE+INSERT below it can never interleave into a
    // duplicated pack. Keep the upsert first.
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO ranking_snapshots (id, business_id, keyword, rank_position, search_location, snapshot_date, source)
        VALUES (${uuidv7()}, ${businessId}, ${keyword}, ${rankPosition}, ${searchLocationValue}, ${today}, 'serpapi')
        ON CONFLICT (business_id, keyword, snapshot_date)
        DO UPDATE SET rank_position = EXCLUDED.rank_position, search_location = EXCLUDED.search_location, source = 'serpapi'
      `;
      await tx`
        DELETE FROM competitor_snapshots
        WHERE business_id = ${businessId} AND keyword = ${keyword} AND snapshot_date = ${today}
      `;
      for (const entry of pack) {
        await tx`
          INSERT INTO competitor_snapshots
            (id, business_id, keyword, search_location, snapshot_date,
             rank_position, place_id, data_cid, title, rating, review_count, is_self)
          VALUES
            (${uuidv7()}, ${businessId}, ${keyword}, ${searchLocationValue}, ${today},
             ${entry.position}, ${entry.placeId}, ${entry.dataCid}, ${entry.title},
             ${entry.rating}, ${entry.reviewCount}, ${entry.isSelf})
        `;
      }
    });
  }

  await markOutboxCompleted(sql, outboxId, outboxAttempt);
  logger.log(`Ranking tracking complete for business ${businessId}`);
}
