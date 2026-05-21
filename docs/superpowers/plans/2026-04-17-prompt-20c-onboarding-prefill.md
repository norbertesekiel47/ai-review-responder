# Prompt 20c: Onboarding Automation + SerpAPI Pre-fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce sales-partner onboarding time from 20 minutes to ~10 minutes by auto-filling business category, phone, website, and hours from SerpAPI after the sales partner selects a business in PlaceAutocomplete.

**Architecture:** New module `src/lib/reviews/serpapi-prefill.ts` wraps the SerpAPI Google Maps endpoint, normalizes the response into a fixed `BusinessPrefill` shape, caches by place_id for 7 days, and writes a platform-level `api_costs` row (business_id=NULL). A thin admin-only Vercel API route at `/api/admin/businesses/prefill` gates access with auth + rate limit. The onboarding form auto-triggers a fetch after PlaceAutocomplete fires, only filling fields that are still empty (no overwrite of user typing in flight).

**Tech Stack:** TypeScript, serpapi library (already installed), ioredis (already installed), react-hook-form (already installed). No new dependencies.

**Prerequisite:** Migration 017 creates `businesses.website` column — already on disk, not yet applied to Supabase. Apply before running Task 4.

**Spec:** `docs/Final_Implementation_Plan.md` Prompt 20c.

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/lib/reviews/serpapi-prefill.ts` | `fetchBusinessDetails(placeId)` — SerpAPI wrapper, normalization, Redis cache, cost audit, mock mode, graceful failure |
| `src/lib/reviews/__tests__/serpapi-prefill.test.ts` | Unit tests for prefill module |
| `src/app/api/admin/businesses/prefill/route.ts` | `GET` endpoint — auth + rate limit + strict mode + call prefill |
| `src/app/api/admin/businesses/prefill/__tests__/route.test.ts` | API route tests (auth, rate limit, 503 when Redis unavailable, invalid place_id) |

### Modified Files
| File | Change |
|------|--------|
| `src/lib/costs/audit.ts` | Widen `businessId` parameter to `string \| null` |
| `src/lib/shared/schemas.ts` | Add `website` to `OnboardBusinessSchema` + `UpdateBusinessSchema` |
| `src/app/api/admin/businesses/route.ts` | Accept `website` in POST — add to INSERT column list |
| `src/app/api/admin/businesses/[id]/route.ts` | Map `website` in `FIELD_TO_COLUMN` for PATCH updates |
| `src/app/admin/businesses/new/page.tsx` | Add website field + auto-trigger prefill after place select |
| `src/app/admin/businesses/[id]/page.tsx` | Display + edit `website` in ProfileEditor |

---

## Task 1: Widen `recordApiCost` to Accept Null business_id

The prefill module needs to record platform-level cost entries (no specific business). `api_costs.business_id` is already nullable in the schema, but the TypeScript helper requires `string`. This task widens the helper.

**Files:**
- Modify: `src/lib/costs/audit.ts`

- [ ] **Step 1: Update the type signature**

In `src/lib/costs/audit.ts`, find the `recordApiCost` function (around lines 37-45). Change `businessId: string` to `businessId: string | null`:

```typescript
export async function recordApiCost(params: {
  businessId: string | null;
  provider: string;
  endpoint: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  responseId: string | null;
}): Promise<string> {
```

The SQL interpolation `${params.businessId}` already handles null correctly — Postgres.js will pass SQL NULL when the value is JS null. No SQL change needed.

- [ ] **Step 2: Verify existing callers still type-check**

Run: `pnpm tsc --noEmit`
Expected: No errors. Existing callers that pass `string` still satisfy `string | null`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/costs/audit.ts
git commit -m "chore(20c): widen recordApiCost businessId to string|null for platform-level costs"
```

---

## Task 2: SerpAPI Prefill Module

**Files:**
- Create: `src/lib/reviews/serpapi-prefill.ts`
- Create: `src/lib/reviews/__tests__/serpapi-prefill.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/reviews/__tests__/serpapi-prefill.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────

const { mockGetJson, mockRecordApiCost, mockIsMockMode, mockGetCacheRedis } = vi.hoisted(() => ({
  mockGetJson: vi.fn(),
  mockRecordApiCost: vi.fn().mockResolvedValue('cost-id'),
  mockIsMockMode: vi.fn().mockReturnValue(false),
  mockGetCacheRedis: vi.fn(),
}));

vi.mock('serpapi', () => ({
  getJson: (...args: unknown[]) => mockGetJson(...args),
}));

vi.mock('@/lib/costs/audit', () => ({
  recordApiCost: (...args: unknown[]) => mockRecordApiCost(...args),
}));

vi.mock('@/lib/shared/mock-mode', () => ({
  isMockMode: () => mockIsMockMode(),
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => mockGetCacheRedis(),
}));

// Import AFTER mocks are wired.
import { fetchBusinessDetails } from '../serpapi-prefill';

// ── Fixtures ────────────────────────────────────────────────────────

const FULL_SERPAPI_RESPONSE = {
  place_results: {
    type: 'Mexican restaurant',
    phone: '+1 408-555-1234',
    website: 'https://example.com',
    operating_hours: {
      monday: '9am-9pm',
      tuesday: '9am-9pm',
    },
    address: '123 Main St, San Jose, CA 95112',
  },
};

const PARTIAL_SERPAPI_RESPONSE = {
  place_results: {
    type: 'Coffee shop',
    // phone, website, operating_hours, address all missing
  },
};

function makeRedisMock(cacheHit?: string) {
  return {
    get: vi.fn().mockResolvedValue(cacheHit ?? null),
    setex: vi.fn().mockResolvedValue('OK'),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('fetchBusinessDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMockMode.mockReturnValue(false);
    process.env.SERPAPI_API_KEY = 'test-key';
    process.env.REDIS_CACHE_URL = 'redis://localhost:6379';
    mockGetCacheRedis.mockReturnValue(makeRedisMock());
  });

  it('extracts category, phone, website, hours, and fullAddress from a complete response', async () => {
    mockGetJson.mockResolvedValue(FULL_SERPAPI_RESPONSE);
    const result = await fetchBusinessDetails('ChIJ_test123');
    expect(result).toEqual({
      category: 'Mexican restaurant',
      phone: '+1 408-555-1234',
      website: 'https://example.com',
      hours: 'monday: 9am-9pm, tuesday: 9am-9pm',
      fullAddress: '123 Main St, San Jose, CA 95112',
    });
  });

  it('returns partial data (nulls for missing fields) without throwing', async () => {
    mockGetJson.mockResolvedValue(PARTIAL_SERPAPI_RESPONSE);
    const result = await fetchBusinessDetails('ChIJ_test456');
    expect(result).toEqual({
      category: 'Coffee shop',
      phone: null,
      website: null,
      hours: null,
      fullAddress: null,
    });
  });

  it('returns all-null on SerpAPI failure (never throws)', async () => {
    mockGetJson.mockRejectedValue(new Error('API error'));
    const result = await fetchBusinessDetails('ChIJ_bad');
    expect(result).toEqual({
      category: null,
      phone: null,
      website: null,
      hours: null,
      fullAddress: null,
    });
  });

  it('returns all-null when SerpAPI returns malformed payload (no place_results)', async () => {
    mockGetJson.mockResolvedValue({ unexpected: 'shape' });
    const result = await fetchBusinessDetails('ChIJ_malformed');
    expect(result).toEqual({
      category: null,
      phone: null,
      website: null,
      hours: null,
      fullAddress: null,
    });
  });

  it('normalizes website to https:// when given a bare URL', async () => {
    mockGetJson.mockResolvedValue({
      place_results: { type: 'Shop', website: 'example.com' },
    });
    const result = await fetchBusinessDetails('ChIJ_bare');
    expect(result.website).toBe('https://example.com');
  });

  it('returns null website for malformed URL', async () => {
    mockGetJson.mockResolvedValue({
      place_results: { type: 'Shop', website: 'not a url at all' },
    });
    const result = await fetchBusinessDetails('ChIJ_bad_url');
    expect(result.website).toBeNull();
  });

  it('passes http:// websites through unchanged (not forced to https)', async () => {
    mockGetJson.mockResolvedValue({
      place_results: { type: 'Shop', website: 'http://example.com' },
    });
    const result = await fetchBusinessDetails('ChIJ_http');
    expect(result.website).toBe('http://example.com');
  });

  it('records an api_costs row with business_id=NULL after a successful call', async () => {
    mockGetJson.mockResolvedValue(FULL_SERPAPI_RESPONSE);
    await fetchBusinessDetails('ChIJ_cost');
    expect(mockRecordApiCost).toHaveBeenCalledWith({
      businessId: null,
      provider: 'serpapi',
      endpoint: 'google_maps_prefill',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0.005,
      responseId: null,
    });
  });

  it('returns canned data in mock mode without calling SerpAPI', async () => {
    mockIsMockMode.mockReturnValue(true);
    const result = await fetchBusinessDetails('ChIJ_mock');
    expect(result.category).toBeTruthy();
    expect(result.phone).toBeTruthy();
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('returns cached result when Redis has a hit, without calling SerpAPI', async () => {
    const cached = JSON.stringify({
      category: 'Cached category',
      phone: '+1 555',
      website: 'https://cached.example',
      hours: null,
      fullAddress: 'Cached address',
    });
    mockGetCacheRedis.mockReturnValue(makeRedisMock(cached));

    const result = await fetchBusinessDetails('ChIJ_cached');
    expect(result.category).toBe('Cached category');
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('still returns data when Redis cache write fails', async () => {
    mockGetJson.mockResolvedValue(FULL_SERPAPI_RESPONSE);
    const redisMock = makeRedisMock();
    redisMock.setex.mockRejectedValue(new Error('Redis down'));
    mockGetCacheRedis.mockReturnValue(redisMock);

    const result = await fetchBusinessDetails('ChIJ_cache_fail');
    expect(result.category).toBe('Mexican restaurant');
  });

  it('skips cache entirely when REDIS_CACHE_URL is not set', async () => {
    delete process.env.REDIS_CACHE_URL;
    mockGetJson.mockResolvedValue(FULL_SERPAPI_RESPONSE);

    const result = await fetchBusinessDetails('ChIJ_no_redis');
    expect(result.category).toBe('Mexican restaurant');
    expect(mockGetCacheRedis).not.toHaveBeenCalled();
  });

  it('returns all-null when SERPAPI_API_KEY is not set', async () => {
    delete process.env.SERPAPI_API_KEY;
    const result = await fetchBusinessDetails('ChIJ_no_key');
    expect(result.category).toBeNull();
    expect(mockGetJson).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/lib/reviews/__tests__/serpapi-prefill.test.ts`
Expected: FAIL — module `../serpapi-prefill` not found.

- [ ] **Step 3: Implement the prefill module**

```typescript
// src/lib/reviews/serpapi-prefill.ts
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

  // 2. Cache lookup
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/lib/reviews/__tests__/serpapi-prefill.test.ts`
Expected: 13 tests PASS.

- [ ] **Step 5: Run full suite**

Run: `pnpm test`
Expected: All tests pass (618 pre-existing + 13 new = 631).

- [ ] **Step 6: Commit**

```bash
git add src/lib/reviews/serpapi-prefill.ts src/lib/reviews/__tests__/serpapi-prefill.test.ts
git commit -m "feat(20c): add SerpAPI business prefill with Redis cache + cost audit"
```

---

## Task 3: Admin Prefill API Route

**Files:**
- Create: `src/app/api/admin/businesses/prefill/route.ts`
- Create: `src/app/api/admin/businesses/prefill/__tests__/route.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/app/api/admin/businesses/prefill/__tests__/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireRole,
  mockCheckRateLimit,
  mockFetchBusinessDetails,
  mockIsPlaceId,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockFetchBusinessDetails: vi.fn(),
  mockIsPlaceId: vi.fn(),
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    AuthError,
  };
});

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock('@/lib/reviews/serpapi-prefill', () => ({
  fetchBusinessDetails: (...args: unknown[]) => mockFetchBusinessDetails(...args),
}));

vi.mock('@/lib/reviews/url-parser', () => ({
  isPlaceId: (...args: unknown[]) => mockIsPlaceId(...args),
}));

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`);
}

describe('GET /api/admin/businesses/prefill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
      businessId: null,
    });
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 10 });
    mockIsPlaceId.mockReturnValue(true);
    mockFetchBusinessDetails.mockResolvedValue({
      category: 'Restaurant',
      phone: '+1 555',
      website: 'https://example.com',
      hours: null,
      fullAddress: null,
    });
  });

  it('returns 200 with prefill JSON on happy path', async () => {
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/businesses/prefill?place_id=ChIJ_abc'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.category).toBe('Restaurant');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns 400 when place_id query param is missing', async () => {
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/businesses/prefill'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/place_id/);
  });

  it('returns 400 when place_id is malformed (fails isPlaceId)', async () => {
    mockIsPlaceId.mockReturnValue(false);
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/businesses/prefill?place_id=not-a-place-id'));
    expect(res.status).toBe(400);
  });

  it('returns 401 when auth fails', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthenticated', 401));
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/businesses/prefill?place_id=ChIJ_abc'));
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has wrong role', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Forbidden', 403));
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/businesses/prefill?place_id=ChIJ_abc'));
    expect(res.status).toBe(403);
  });

  it('returns 429 when rate limit is exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/businesses/prefill?place_id=ChIJ_abc'));
    expect(res.status).toBe(429);
  });

  it('returns 503 when rate limiter throws (Redis unavailable in strict mode)', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('[rate-limit] REDIS_CACHE_URL not configured — cannot enforce budget in strict mode'));
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/businesses/prefill?place_id=ChIJ_abc'));
    expect(res.status).toBe(503);
  });

  it('uses rate limit key scoped per user', async () => {
    const { GET } = await import('../route');
    await GET(makeRequest('/api/admin/businesses/prefill?place_id=ChIJ_abc'));
    const callArgs = mockCheckRateLimit.mock.calls[0];
    expect(callArgs?.[0]).toBe('prefill:minute:admin-1');
    expect(callArgs?.[1]).toBe(10);
    expect(callArgs?.[2]).toBe(60);
    // strict mode enabled so Redis failure triggers 503 instead of uncapped SerpAPI spend
    expect(callArgs?.[3]).toEqual({ strict: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/app/api/admin/businesses/prefill/__tests__/route.test.ts`
Expected: FAIL — module `../route` not found.

- [ ] **Step 3: Implement the route**

```typescript
// src/app/api/admin/businesses/prefill/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { isPlaceId } from '@/lib/reviews/url-parser';
import { fetchBusinessDetails } from '@/lib/reviews/serpapi-prefill';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  // 1. Auth
  let user: { id: string };
  try {
    user = await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode, headers: NO_STORE },
      );
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  // 2. Validate query param
  const placeId = request.nextUrl.searchParams.get('place_id');
  if (!placeId) {
    return NextResponse.json(
      { error: 'place_id query param is required' },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!isPlaceId(placeId)) {
    return NextResponse.json(
      { error: 'place_id is not a valid Google Place ID' },
      { status: 400, headers: NO_STORE },
    );
  }

  // 3. Rate limit — strict mode so Redis unavailability returns 503 instead of
  //    silently allowing uncapped SerpAPI calls.
  try {
    const { allowed } = await checkRateLimit(
      `prefill:minute:${user.id}`,
      10,
      60,
      { strict: true },
    );
    if (!allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded — try again in a minute' },
        { status: 429, headers: NO_STORE },
      );
    }
  } catch {
    // Redis unavailable or other rate-limiter failure: refuse rather than
    // allowing unbounded SerpAPI spend. 503 is the correct signal to the UI
    // to degrade gracefully (show manual entry, no prefill).
    return NextResponse.json(
      { error: 'Prefill temporarily unavailable' },
      { status: 503, headers: NO_STORE },
    );
  }

  // 4. Fetch prefill — never throws; worst case returns all-null
  const prefill = await fetchBusinessDetails(placeId);

  return NextResponse.json(prefill, { status: 200, headers: NO_STORE });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/app/api/admin/businesses/prefill/__tests__/route.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Full suite**

Run: `pnpm test`
Expected: 639+ tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/admin/businesses/prefill
git commit -m "feat(20c): admin prefill API — auth, strict rate-limit, Place ID validation"
```

---

## Task 4: Add website to Zod Schemas + Onboarding POST + PATCH

**Prerequisite:** Apply migration 017 to Supabase before this task (adds `businesses.website` column). Paste `supabase/migrations/017_sprint6_scale.sql` into the Supabase SQL editor.

**Files:**
- Modify: `src/lib/shared/schemas.ts`
- Modify: `src/app/api/admin/businesses/route.ts`
- Modify: `src/app/api/admin/businesses/[id]/route.ts`

- [ ] **Step 1: Add `website` to both Zod schemas**

In `src/lib/shared/schemas.ts`:

After the existing `OnboardBusinessSchema` field list (before `.refine(...)` on line ~34), add:
```typescript
    website: z.string().url().max(500).optional().nullable(),
```

In `UpdateBusinessSchema` (after `avoidFacts` line), add:
```typescript
    website: z.string().url().max(500).nullable().optional(),
```

Final `OnboardBusinessSchema` body section should look like this (for reference):
```typescript
export const OnboardBusinessSchema = z
  .object({
    name: businessNameSchema,
    category: categorySchema.optional(),
    googlePlaceId: z.string().min(1).optional(),
    googlePlaceAddress: z.string().optional(),
    googleMapsUrl: z.string().min(1).optional(),
    ownerName: ownerNameSchema,
    ownerEmail: ownerEmailSchema,
    ownerPhone: ownerPhoneSchema.optional(),
    notificationPreference: z.enum(['email', 'sms', 'both']).default('email'),
    tone: toneSchema.default('professional and friendly'),
    productsServices: z.string().max(5000).optional(),
    staffNames: z.string().max(2000).optional(),
    highlightFacts: z.string().max(2000).optional(),
    avoidFacts: z.string().max(2000).optional(),
    sampleResponses: z.string().max(5000).optional(),
    subscriptionTier: z.enum(['founding', 'standard']).default('standard'),
    website: z.string().url().max(500).optional().nullable(),
  })
  .refine(
    (data) => Boolean(data.googlePlaceId) || Boolean(data.googleMapsUrl),
    { message: 'Either a Place ID or Google Maps URL is required', path: ['googlePlaceId'] },
  );
```

- [ ] **Step 2: Add website to POST INSERT**

In `src/app/api/admin/businesses/route.ts`, find the INSERT INTO businesses statement (around lines 179-219). Add `website` to the column list and `${data.website ?? null}` to the values list.

After `subscription_status` column on line ~198, add one line before the closing `)`:
```typescript
          subscription_tier,
          subscription_status,
          website
        ) VALUES (
```

And after the `${data.subscriptionTier}` value on line ~216:
```typescript
          ${data.subscriptionTier},
          'pending_payment',
          ${data.website ?? null}
        )
```

- [ ] **Step 3: Add website to PATCH FIELD_TO_COLUMN**

In `src/app/api/admin/businesses/[id]/route.ts`, find the `FIELD_TO_COLUMN` constant. Add `website` mapping:

```typescript
const FIELD_TO_COLUMN: Record<string, string> = {
  name: 'name',
  category: 'category',
  tone: 'tone',
  productsServices: 'products_services',
  staffNames: 'staff_names',
  highlightFacts: 'highlight_facts',
  avoidFacts: 'avoid_facts',
  website: 'website',
};
```

- [ ] **Step 4: Verify build + tests**

Run: `pnpm tsc --noEmit && pnpm test`
Expected: No type errors, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/schemas.ts src/app/api/admin/businesses/route.ts src/app/api/admin/businesses/\[id\]/route.ts
git commit -m "feat(20c): accept website field in onboarding + admin PATCH"
```

---

## Task 5: Onboarding Form — Website Field + Auto-Prefill

**Files:**
- Modify: `src/app/admin/businesses/new/page.tsx`

- [ ] **Step 1: Add website to FormSchema**

Find the `FormSchema` object (around lines 12-29). Add `website` after `googleMapsUrl`:

```typescript
const FormSchema = z.object({
  name: z.string().min(1, 'Business name is required').max(255),
  category: z.string().max(100).optional(),
  googlePlaceId: z.string().optional(),
  googlePlaceAddress: z.string().optional(),
  googleMapsUrl: z.string().optional(),
  website: z.string().url('Invalid URL').max(500).optional().or(z.literal('')),
  ownerName: z.string().min(1, 'Owner name is required').max(255),
  ownerEmail: z.string().email('Valid email is required').max(255),
  ownerPhone: z.string().max(20).optional(),
  notificationPreference: z.enum(['email', 'sms', 'both']),
  tone: z.string().max(100),
  productsServices: z.string().max(5000).optional(),
  staffNames: z.string().max(2000).optional(),
  highlightFacts: z.string().max(2000).optional(),
  avoidFacts: z.string().max(2000).optional(),
  sampleResponses: z.string().max(5000).optional(),
  subscriptionTier: z.enum(['founding', 'standard']),
});
```

The `.or(z.literal(''))` allows the field to be empty string (user didn't fill it) OR a valid URL.

- [ ] **Step 2: Add prefill state + trigger function**

Inside the `NewBusinessPage` component, after the `useForm` block (around line 106), add:

```typescript
  const [prefilling, setPrefilling] = useState(false);

  // Use getValues to check which fields are still empty at the moment the
  // prefill response returns — prevents overwriting what the user typed
  // while the SerpAPI call was in flight.
  const { getValues } = useForm<FormData>(); // NOTE: discard; we'll use the existing useForm — see correction below
```

Actually, destructure `getValues` from the existing `useForm` call. Update line 93-99 to include `getValues`:

```typescript
  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    clearErrors,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      notificationPreference: 'email',
      tone: 'professional and friendly',
      subscriptionTier: 'founding',
    },
  });

  const [prefilling, setPrefilling] = useState(false);
```

Then add the prefill trigger function below the `useForm` setup:

```typescript
  async function triggerPrefill(placeId: string) {
    setPrefilling(true);
    try {
      const res = await fetch(
        `/api/admin/businesses/prefill?place_id=${encodeURIComponent(placeId)}`,
      );
      if (!res.ok) return; // Silent failure — fields remain empty for manual entry
      const prefill = (await res.json()) as {
        category: string | null;
        phone: string | null;
        website: string | null;
        hours: string | null;
        fullAddress: string | null;
      };
      // Only fill fields that are STILL empty at this moment. This prevents
      // overwriting text the user typed while the request was in flight.
      // setValue { shouldDirty: false } keeps the form state "clean" since
      // the value came from an API, not the user.
      const current = getValues();
      if (prefill.category && !current.category) {
        setValue('category', prefill.category, { shouldDirty: false });
      }
      if (prefill.phone && !current.ownerPhone) {
        setValue('ownerPhone', prefill.phone, { shouldDirty: false });
      }
      if (prefill.website && !current.website) {
        setValue('website', prefill.website, { shouldDirty: false });
      }
    } catch {
      // Network error — silently degrade to manual entry
    } finally {
      setPrefilling(false);
    }
  }
```

- [ ] **Step 3: Wire prefill to PlaceAutocomplete**

Find the `<PlaceAutocomplete>` component (around lines 192-203). Update the `onPlaceSelect` callback:

```typescript
              {inputMode === 'autocomplete' ? (
                <PlaceAutocomplete
                  onPlaceSelect={(sel) => {
                    setValue('googlePlaceId', sel.placeId);
                    setValue('googlePlaceAddress', sel.formattedAddress);
                    clearErrors('googlePlaceId');
                    // Auto-trigger prefill. This runs async and fills empty
                    // category/ownerPhone/website fields when the response arrives.
                    triggerPrefill(sel.placeId);
                  }}
                  onClear={() => {
                    setValue('googlePlaceId', '');
                    setValue('googlePlaceAddress', '');
                  }}
                />
              ) : (
```

- [ ] **Step 4: Add website input field**

In the "Business Info" SectionCard (around lines 164-233), add a Website field after the Category field (after line 181):

```tsx
            <Field
              label="Website"
              error={errors.website?.message}
              hint={prefilling ? 'Fetching suggestions from Google Maps…' : undefined}
            >
              <input
                {...register('website')}
                type="url"
                className={inputClass}
                placeholder="https://example.com"
              />
            </Field>
```

Also update the Category field to show the prefill hint when prefilling:
```tsx
            <Field
              label="Category"
              error={errors.category?.message}
              hint={prefilling ? 'Fetching suggestions from Google Maps…' : undefined}
            >
              <input
                {...register('category')}
                type="text"
                className={inputClass}
                placeholder="Restaurant, Salon, Dentist..."
              />
            </Field>
```

And update the Phone field in the Owner Info section to show the prefill hint:
```tsx
            <Field
              label="Phone"
              error={errors.ownerPhone?.message}
              hint={prefilling ? 'Fetching suggestions from Google Maps…' : undefined}
            >
              <input
                {...register('ownerPhone')}
                type="tel"
                className={inputClass}
                placeholder="+1 555 000 0000"
              />
            </Field>
```

- [ ] **Step 5: Update onSubmit to include website in payload**

The existing onSubmit (lines 108-153) already spreads `...rest`. Since `website` is now part of `FormData`, it automatically flows into `rest` and the payload. But we should explicitly handle empty string → null. Inside `onSubmit`, after the destructure:

```typescript
    try {
      // Build payload from inputMode, not hidden field presence
      const { googlePlaceId, googlePlaceAddress, googleMapsUrl, website, ...rest } = data;
      // Normalize empty website string to null (Zod allowed empty or URL).
      const normalizedWebsite = website && website.trim().length > 0 ? website.trim() : null;
      const payload = inputMode === 'autocomplete'
        ? { ...rest, googlePlaceId, googlePlaceAddress, website: normalizedWebsite }
        : { ...rest, googleMapsUrl, website: normalizedWebsite };

      const res = await fetch('/api/admin/businesses', {
```

- [ ] **Step 6: Run build + test**

Run: `pnpm tsc --noEmit && pnpm build`
Expected: No errors, build succeeds.

Run: `pnpm test`
Expected: All tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/app/admin/businesses/new/page.tsx
git commit -m "feat(20c): onboarding form — website field + auto-prefill from SerpAPI"
```

---

## Task 6: Business Detail Page — Display + Edit Website

**Files:**
- Modify: `src/app/admin/businesses/[id]/page.tsx`

- [ ] **Step 1: Add website to BusinessDetail interface**

Find the `BusinessDetail` interface (around line 11). Add `website: string | null` after `category`:

```typescript
interface BusinessDetail {
  id: string;
  name: string;
  category: string | null;
  website: string | null;
  googlePlaceId: string | null;
  // ... rest unchanged
}
```

- [ ] **Step 2: Add website state to ProfileEditor**

Find the `ProfileEditor` component (around line 113). After the existing `useState` declarations:

```typescript
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(business.name);
  const [category, setCategory] = useState(business.category ?? '');
  const [website, setWebsite] = useState(business.website ?? '');
  const [tone, setTone] = useState(business.tone);
  // ... rest unchanged
```

- [ ] **Step 3: Add website to the PATCH payload**

Find the `mutation.mutationFn` (around line 124). Add `website` to the body:

```typescript
      const body = {
        name: name.trim(),
        category: category.trim() || null,
        website: website.trim() || null,
        tone: tone.trim(),
        productsServices: productsServices.trim() || null,
        staffNames: staffNames
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
        highlightFacts: highlightFacts
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        avoidFacts: avoidFacts
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      };
```

- [ ] **Step 4: Add website to handleCancel reset**

Find `handleCancel` (around line 164). Add the website reset:

```typescript
  const handleCancel = () => {
    setName(business.name);
    setCategory(business.category ?? '');
    setWebsite(business.website ?? '');
    setTone(business.tone);
    // ... rest unchanged
```

- [ ] **Step 5: Add website display row**

In the read-only view (around lines 188-227), add a display row for website after the Category row:

```tsx
          <div>
            <dt className="font-medium text-gray-500">Category</dt>
            <dd className="text-gray-900">{business.category ?? '—'}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">Website</dt>
            <dd className="text-gray-900">
              {business.website ? (
                <a href={business.website} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline">
                  {business.website}
                </a>
              ) : '—'}
            </dd>
          </div>
```

- [ ] **Step 6: Add website input to edit form**

In the edit form (around lines 232-280), add a website input after the Category input:

```tsx
        <div>
          <label className="block text-sm font-medium text-gray-700">Category</label>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Website</label>
          <input
            type="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://example.com"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
```

- [ ] **Step 7: Update GET /api/admin/businesses/[id] route to return website**

Check `src/app/api/admin/businesses/[id]/route.ts` GET handler. Find the SELECT statement and add `website` to the columns returned. Also add it to the response object mapping.

In the SELECT (search for `SELECT` in the GET handler), add `b.website` alongside other fields. In the response mapping, add `website: row.website`.

- [ ] **Step 8: Verify + commit**

Run: `pnpm tsc --noEmit && pnpm build && pnpm test`
Expected: No errors, build succeeds, all tests pass.

```bash
git add src/app/admin/businesses/\[id\]/page.tsx src/app/api/admin/businesses/\[id\]/route.ts
git commit -m "feat(20c): business detail page displays + edits website"
```

---

## Task 7: Final Verification + Tracking Docs

- [ ] **Step 1: Full test + build verification**

```bash
pnpm test          # Expected: 639+ tests pass (618 pre-existing + ~21 new)
pnpm tsc --noEmit  # Expected: no errors
pnpm build         # Expected: build succeeds
```

- [ ] **Step 2: Audit that migration 017 was applied**

In Supabase SQL editor:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'businesses' AND column_name = 'website';
```
Expected: 1 row. If empty, apply migration 017 before running the manual smoke test in Step 3.

- [ ] **Step 3: Manual smoke test (optional, requires SerpAPI key)**

With `MOCK_EXTERNAL_APIS=false`, `SERPAPI_API_KEY` set, and migration 017 applied:
1. Open `/admin/businesses/new`
2. Select a real business in PlaceAutocomplete
3. Verify category, ownerPhone, and website fields fill in within 2-3 seconds
4. Type in the phone field while prefill is in flight — verify the typed value is NOT overwritten when prefill arrives
5. Submit the form and verify `website` is saved to the database
6. Open the business detail page, click Edit on the profile, change website, save — verify it persists

- [ ] **Step 4: Update tracking docs**

In `.claude/CLAUDE.md` "Current status" section, append to the Sprint 6 entry:

```markdown
  - Prompt 20c (Onboarding Automation + SerpAPI Pre-fill): COMPLETE (2026-04-17) — new `fetchBusinessDetails(placeId)` module wraps SerpAPI `engine=google_maps`, normalizes category/phone/website/hours/address into a fixed `BusinessPrefill` shape, caches by place_id for 7 days, records platform-level api_costs row (business_id=NULL), never throws. New admin-only route `/api/admin/businesses/prefill` with auth + 10/min per-user rate limit (strict mode: 503 when Redis unavailable). Onboarding form auto-triggers prefill after PlaceAutocomplete, only fills empty fields (doesn't overwrite user typing in flight). `businesses.website` column added + editable in onboarding + admin detail. Widened `recordApiCost` to accept null businessId.
```

In `docs/progresstracking.md`, add a section under Sprint 6:

```markdown
### Prompt 20c — Onboarding Automation + SerpAPI Pre-fill (2026-04-17)

**Status:** COMPLETE

**New modules:**
- `src/lib/reviews/serpapi-prefill.ts` — SerpAPI wrapper returning a fixed `BusinessPrefill` shape. Never throws; returns all-null on any failure. 7-day Redis cache by place_id. Records platform-level `api_costs` row (business_id=NULL). Mock mode returns canned data.
- `src/app/api/admin/businesses/prefill/route.ts` — GET endpoint. Requires admin/sales_partner. Validates place_id via `isPlaceId()`. Rate-limited `prefill:minute:{user.id}` at 10/min in strict mode (503 on Redis failure to avoid uncapped SerpAPI spend).

**Schema changes:**
- Widened `recordApiCost.businessId` to `string | null`.
- Added `website` to `OnboardBusinessSchema` and `UpdateBusinessSchema` (Zod URL, max 500, nullable).
- Added `website` to businesses INSERT columns (POST) and `FIELD_TO_COLUMN` mapping (PATCH).

**UI changes:**
- Onboarding form: added `website` input + auto-trigger prefill after PlaceAutocomplete selection.
  Prefill only fills empty fields — does NOT overwrite user typing during in-flight request.
  `prefilling` state drives "Fetching suggestions from Google Maps…" hint on category/phone/website.
- Business detail page: display website (as link) in read-only view; add editable input in ProfileEditor; wire PATCH payload.

**Tests:** 13 new prefill module tests (full response, partial response, API error, malformed payload, website normalization, http/https preservation, cost recording, mock mode, cache hit, cache write failure, Redis disabled, missing API key). 8 new route tests (200 happy, 400 missing/invalid place_id, 401 unauth, 403 wrong role, 429 rate limit, 503 Redis unavailable, rate-limit key format). Total ~639 tests.

**Migration:** Requires migration 017 applied to Supabase (adds `businesses.website` column).
```

- [ ] **Step 5: Final commit**

```bash
git add .claude/CLAUDE.md && git add -f docs/progresstracking.md
git commit -m "docs: track Prompt 20c completion"
```
