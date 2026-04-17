import { getJson } from 'serpapi';
import { isMockMode } from '@/lib/shared/mock-mode';
import { recordApiCost } from '@/lib/costs/audit';
import { getCacheRedis } from '@/lib/db/redis-cache';

const LOG_PREFIX = '[serpapi-prefill]';
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const CACHE_KEY_PREFIX = 'serpapi:prefill:';
const SERPAPI_PREFILL_COST_USD = 0.005; // ~$0.005 per SerpAPI search at $50/5000 plan

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

  // 4. SerpAPI call (wrapped in try/catch — never throws upward)
  let rawResponse: unknown;
  try {
    rawResponse = await getJson({
      engine: 'google_maps',
      place_id: placeId,
      api_key: apiKey,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} SerpAPI call failed for ${placeId}: ${message}`);
    return emptyPrefill();
  }

  // 5. Normalize response
  const prefill = normalizeResponse(rawResponse);

  // 6. Record cost (fire-and-forget; failure must not block return)
  recordApiCost({
    businessId: null,
    provider: 'serpapi',
    endpoint: 'google_maps_prefill',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: SERPAPI_PREFILL_COST_USD,
    responseId: null,
  }).catch((err) => {
    console.warn(`${LOG_PREFIX} Failed to record api_costs row: ${err instanceof Error ? err.message : err}`);
  });

  // 7. Write to cache (fire-and-forget)
  writeCache(placeId, prefill).catch((err) => {
    console.warn(`${LOG_PREFIX} Cache write failed: ${err instanceof Error ? err.message : err}`);
  });

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

  // Already has a scheme — validate by URL constructor and return as-is.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return url.toString().replace(/\/$/, ''); // strip trailing slash for cleanliness
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

async function readCache(placeId: string): Promise<BusinessPrefill | null> {
  if (!process.env.REDIS_CACHE_URL) return null;
  try {
    const redis = getCacheRedis();
    const raw = await redis.get(`${CACHE_KEY_PREFIX}${placeId}`);
    if (!raw) return null;
    return JSON.parse(raw) as BusinessPrefill;
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
