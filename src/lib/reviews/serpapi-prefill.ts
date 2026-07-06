import { getJson } from 'serpapi';
import type { Sql } from 'postgres';
import { getServerConfig } from '@/lib/config/server';
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
 * - Records a platform-level api_costs row (business_id=NULL) for each live SerpAPI call, including failures. 
 * - Returns canned deterministic data in mock mode.
 *
 * Normalization rules:
 * - `website` is normalized to `https://` when given a bare URL.
 *   Preserves existing `http://` / `https://` prefixes. Returns null
 *   for malformed URLs.
 * - `hours` is a comma-separated list formatted from `operating_hours`.
 */
export async function fetchBusinessDetails(sql: Sql, placeId: string): Promise<BusinessPrefill> {
  // 1. Mock mode short-circuit
  if (isMockMode()) {
    console.log(`${LOG_PREFIX} [MOCK] Returning canned prefill for ${placeId}`);
    return MOCK_PREFILL;
  }

  // 2. Cache lookup (safe — returns null if Redis unavailable)
  const cached = await readCache(placeId);
  if (cached) return cached;

  // 3. API key guard
  const cfg = getServerConfig();
  const apiKey = cfg.SERPAPI_API_KEY;
  if (!apiKey) {
    console.warn(`${LOG_PREFIX} SERPAPI_API_KEY not set — returning empty prefill`);
    return emptyPrefill();
  }

  // The Vercel route is invoked synchronously from the onboarding form's
  // PlaceAutocomplete callback. A stalled SerpAPI call must not hang the UI —
  // default 2s. Override via SERPAPI_TIMEOUT_MS env var for staging timeout testing.
  const serpApiTimeoutMs = cfg.SERPAPI_TIMEOUT_MS
    ? Math.max(1, parseInt(cfg.SERPAPI_TIMEOUT_MS, 10))
    : 2_000;

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
          () => reject(new Error(`SerpAPI timeout after ${serpApiTimeoutMs}ms`)),
          serpApiTimeoutMs,
        ),
      ),
    ]);
  } catch (err) {
    callFailed = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} SerpAPI call failed for ${placeId}: ${callFailed}`);
  }
  //console.log('[serpapi-prefill] raw place_results:', JSON.stringify((rawResponse as { place_results?: unknown })?.place_results, null, 2));

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
    recordApiCost(sql, {
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
    category: extractCategory(p),
    phone: typeof p.phone === 'string' ? p.phone : null,
    website: normalizeWebsite(p.website),
    hours: formatHours(p.hours ?? p.operating_hours),
    fullAddress: typeof p.address === 'string' ? p.address : null,
  };
}

/**
 * SerpAPI's `engine=google_maps` response uses different field names depending
 * on the place type. Individual businesses typically get `type: "Coffee shop"`
 * (singular string), while chains or multi-category places may return
 * `types: ["Warehouse store", "Supermarket"]` or `categories: [...]`. Some
 * responses expose `category` (string) as well.
 *
 * Try each shape in order; first non-empty string wins. Fallback null.
 */
function extractCategory(p: Record<string, unknown>): string | null {
  if (typeof p.type === 'string' && p.type.trim()) return p.type.trim();
  if (typeof p.category === 'string' && p.category.trim()) return p.category.trim();
  const firstString = (val: unknown): string | null =>
    Array.isArray(val)
      ? (val.find((v) => typeof v === 'string' && v.trim()) as string | undefined)?.trim() ?? null
      : null;
  return firstString(p.types) ?? firstString(p.categories);
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
  if (!raw) return null;

  // Shape A: array of strings like ["Monday: 9 AM - 9 PM", ...]
  if (Array.isArray(raw)) {
    const lines = raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    if (lines.length === 0) return null;
    return lines.join(', ');
  }

  // Shape B: array of { day, hours } objects.
  // Shape C: object map like { monday: "9am-9pm", tuesday: ... }.
  if (typeof raw !== 'object') return null;

  if (Array.isArray((raw as { hours?: unknown[] }).hours)) {
    raw = (raw as { hours: unknown[] }).hours;
    // Recurse — we now have an array.
    return formatHours(raw);
  }

  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([day, time]): [string, string] | null => {
      if (typeof time === 'string') return [day, time];
      // Nested shape: { monday: { open: "9am", close: "9pm" } }
      if (time && typeof time === 'object') {
        const t = time as Record<string, unknown>;
        const open = typeof t.open === 'string' ? t.open : null;
        const close = typeof t.close === 'string' ? t.close : null;
        if (open && close) return [day, `${open}-${close}`];
      }
      return null;
    })
    .filter((e): e is [string, string] => e !== null);

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
  if (!getServerConfig().REDIS_CACHE_URL) return null;
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
      redis.del(key).catch(() => { });
      return null;
    }
    if (!isValidBusinessPrefill(parsed)) {
      console.warn(`${LOG_PREFIX} Cached payload for ${placeId} fails shape validation — deleting entry`);
      redis.del(key).catch(() => { });
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
  if (!getServerConfig().REDIS_CACHE_URL) return;
  const redis = getCacheRedis();
  await redis.setex(
    `${CACHE_KEY_PREFIX}${placeId}`,
    CACHE_TTL_SECONDS,
    JSON.stringify(prefill),
  );
}
