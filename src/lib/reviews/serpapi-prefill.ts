import { getJson } from 'serpapi';
import { isMockMode } from '@/lib/shared/mock-mode';
import { recordApiCost } from '@/lib/costs/audit';
import { getCacheRedis } from '@/lib/db/redis-cache';

const LOG_PREFIX = '[serpapi-prefill]';
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const CACHE_KEY_PREFIX = 'serpapi:prefill:';
const SERPAPI_PREFILL_COST_USD = 0.005; // ~$0.005 per SerpAPI search at $50/5000 plan
// Vercel route is invoked synchronously from the onboarding form's PlaceAutocomplete
// callback. A stalled SerpAPI call must not hang the UI — time out at 2s.
const SERPAPI_TIMEOUT_MS = 2_000;

export interface BusinessPrefill {
  category: string | null;
  phone: string | null;
  website: string | null;
  hours: string | null;
  fullAddress: string | null;
}

const MOCK_PREFILL: BusinessPrefill = {
  category: 'Mexican restaurant',
  phone: '+1 408-555-0100',
  website: 'https://example-restaurant.com',
  hours: 'monday-friday: 11am-9pm, saturday-sunday: 10am-10pm',
  fullAddress: '123 Mock Street, San Jose, CA 95112',
};

/**
 * Fetch rich business details from SerpAPI for onboarding form pre-fill.
 *
 * Contract:
 * - NEVER throws — returns partial/empty data on any failure (API error,
 *   malformed response, timeout, missing key, cache failure).
 * - Caches by place_id for 7 days when Redis is available.
 * - Records a platform-level api_costs row (business_id=NULL) on success.
 * - Returns canned deterministic data in mock mode.
 *
 * Normalization rules:
 * - `website` is normalized to `https://` when given a bare URL.
 *   Preserves existing `http://` / `https://` prefixes. Returns null
 *   for malformed URLs.
 * - `hours` is a comma-separated list formatted from `operating_hours`.
 */
export async function fetchBusinessDetails(placeId: string): Promise<BusinessPrefill> {
  // 1. Mock mode short-circuit
  if (isMockMode()) {
    console.log(`${LOG_PREFIX} [MOCK] Returning canned prefill for ${placeId}`);
    return MOCK_PREFILL;
  }

  // 2. Cache lookup (safe — returns null if Redis unavailable)
  const cached = await readCache(placeId);
  if (cached) return cached;

  // 3. API key guard
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) {
    console.warn(`${LOG_PREFIX} SERPAPI_API_KEY not set — returning empty prefill`);
    return emptyPrefill();
  }

  // 4. SerpAPI call with timeout. The serpapi package doesn't support
  //    AbortController, so use Promise.race as the timeout primitive. The
  //    loser of the race never resolves — GC cleans it up eventually, and
  //    SerpAPI may still consume quota for the losing request.
  //    Because the real request may have gone out regardless of which side
  //    of the race won, we ALWAYS record the cost once we attempted to call
  //    SerpAPI — including on timeout and API errors. Without this, admin
  //    cost dashboards would underreport quota burn exactly when something
  //    is going wrong.
  let rawResponse: unknown = null;
  let callFailed: string | null = null;
  try {
    rawResponse = await Promise.race([
      getJson({
        engine: 'google_maps',
        place_id: placeId,
        api_key: apiKey,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`SerpAPI timeout after ${SERPAPI_TIMEOUT_MS}ms`)),
          SERPAPI_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    callFailed = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} SerpAPI call failed for ${placeId}: ${callFailed}`);
  }

  // 5. Normalize response (empty on failure — normalizeResponse handles null).
  const prefill = callFailed ? emptyPrefill() : normalizeResponse(rawResponse);

  // 6. Record cost always; cache only on success.
  //    Cost recording happens even on timeout/API failure because the outbound
  //    SerpAPI request may already have been sent and may still consume quota.
  //    Cache write is skipped on failure so the empty response isn't held for
  //    7 days and the next selection gets a real retry.
  //    AWAIT both so the serverless function doesn't terminate before the
  //    writes complete. Vercel freezes/drops background work once the response
  //    is returned, so fire-and-forget silently corrupts cost accounting.
  //    Promise.allSettled never rejects; individual failures get logged.
  const tasks: Promise<unknown>[] = [
    recordApiCost({
      businessId: null,
      provider: 'serpapi',
      endpoint: callFailed
        ? 'google_maps_prefill:failed'
        : 'google_maps_prefill',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: SERPAPI_PREFILL_COST_USD,
      responseId: null,
    }),
  ];
  if (!callFailed) {
    tasks.push(writeCache(placeId, prefill));
  }
  const backgroundResults = await Promise.allSettled(tasks);
  const costResult = backgroundResults[0];
  if (costResult && costResult.status === 'rejected') {
    console.warn(
      `${LOG_PREFIX} Failed to record api_costs row:`,
      costResult.reason instanceof Error
        ? costResult.reason.message
        : costResult.reason,
    );
  }
  const cacheResult = backgroundResults[1];
  if (!callFailed && cacheResult && cacheResult.status === 'rejected') {
    console.warn(
      `${LOG_PREFIX} Cache write failed:`,
      cacheResult.reason instanceof Error
        ? cacheResult.reason.message
        : cacheResult.reason,
    );
  }

  return prefill;
}

// ── Internals ───────────────────────────────────────────────────────

function emptyPrefill(): BusinessPrefill {
  return {
    category: null,
    phone: null,
    website: null,
    hours: null,
    fullAddress: null,
  };
}

function normalizeResponse(raw: unknown): BusinessPrefill {
  if (!raw || typeof raw !== 'object') return emptyPrefill();
  const place = (raw as { place_results?: unknown }).place_results;
  if (!place || typeof place !== 'object') return emptyPrefill();

  const p = place as Record<string, unknown>;
  return {
    category: typeof p.type === 'string' ? p.type : null,
    phone: typeof p.phone === 'string' ? p.phone : null,
    website: normalizeWebsite(p.website),
    hours: formatHours(p.operating_hours),
    fullAddress: typeof p.address === 'string' ? p.address : null,
  };
}

function normalizeWebsite(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const trimmed = raw.trim();

  // Already has a scheme — ONLY http/https allowed. javascript:, data:, ftp:
  // etc. are rejected even if the URL constructor parses them successfully,
  // because they become XSS/phishing vectors when rendered as anchor hrefs.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url.toString().replace(/\/$/, '');
    } catch {
      return null;
    }
  }

  // No scheme — try prepending https://
  // Reject anything that's not at least a domain-like string.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+/i.test(trimmed)) {
    return null;
  }
  try {
    const url = new URL(`https://${trimmed}`);
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function formatHours(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  if (entries.length === 0) return null;
  return entries.map(([day, time]) => `${day}: ${time}`).join(', ');
}

/**
 * Runtime type guard for cached BusinessPrefill payloads. A stale or
 * tampered cache value can bypass normalizeResponse if we type-assert
 * without checking — this guard rejects any payload that doesn't match
 * the exact { category, phone, website, hours, fullAddress }: string|null shape.
 */
function isValidBusinessPrefill(data: unknown): data is BusinessPrefill {
  if (!data || typeof data !== 'object') return false;
  const p = data as Record<string, unknown>;
  const fields = ['category', 'phone', 'website', 'hours', 'fullAddress'] as const;
  for (const key of fields) {
    const val = p[key];
    if (val !== null && typeof val !== 'string') return false;
  }
  return true;
}

async function readCache(placeId: string): Promise<BusinessPrefill | null> {
  if (!process.env.REDIS_CACHE_URL) return null;
  try {
    const redis = getCacheRedis();
    const key = `${CACHE_KEY_PREFIX}${placeId}`;
    const raw = await redis.get(key);
    if (!raw) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`${LOG_PREFIX} Invalid JSON in cache for ${placeId} — deleting entry`);
      redis.del(key).catch(() => {});
      return null;
    }
    if (!isValidBusinessPrefill(parsed)) {
      console.warn(`${LOG_PREFIX} Cached payload for ${placeId} fails shape validation — deleting entry`);
      redis.del(key).catch(() => {});
      return null;
    }

    // Defense-in-depth: re-normalize the cached website URL in case the
    // cache predates a normalization bug fix or was written by a version
    // that permitted unsafe schemes. normalizeWebsite is idempotent for
    // already-normalized http(s) URLs.
    return {
      ...parsed,
      website: parsed.website !== null ? normalizeWebsite(parsed.website) : null,
    };
  } catch (err) {
    console.warn(`${LOG_PREFIX} Cache read failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function writeCache(placeId: string, prefill: BusinessPrefill): Promise<void> {
  if (!process.env.REDIS_CACHE_URL) return;
  const redis = getCacheRedis();
  await redis.setex(
    `${CACHE_KEY_PREFIX}${placeId}`,
    CACHE_TTL_SECONDS,
    JSON.stringify(prefill),
  );
}
