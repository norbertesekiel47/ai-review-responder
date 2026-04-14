# Place ID Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unreliable URL-based Place ID extraction with Google Maps autocomplete as primary input and worker-side SerpAPI resolution as fallback, gated by a `place_id_verified` flag that prevents unverified IDs from entering the polling pipeline.

**Architecture:** Two input paths (autocomplete primary, URL fallback) converge on a single verified `google_place_id` column. The autocomplete path validates server-side and stores immediately. The URL fallback path queues a `validate_place_id` outbox job that resolves via SerpAPI search before allowing `sync_reviews`. ReconciliationPoller and ReviewSyncWorker both gate on `place_id_verified = TRUE`.

**Tech Stack:** Google Maps JavaScript API (Places Autocomplete), `@googlemaps/js-api-loader`, SerpAPI `engine=google_maps`, existing BullMQ/outbox infrastructure, Supabase migrations.

**Spec:** `docs/superpowers/specs/2026-04-13-place-id-resolution-design.md`

---

## File Map

### New files
| File | Responsibility |
|---|---|
| `src/components/PlaceAutocomplete.tsx` | Reusable Google Maps autocomplete widget |
| `src/lib/reviews/place-id-resolver.ts` | SerpAPI search-based Place ID resolution |
| `src/lib/reviews/__tests__/url-parser.test.ts` | Dedicated tests for `parseGoogleMapsUrl` + `isPlaceId` |
| `src/lib/reviews/__tests__/place-id-resolver.test.ts` | Tests for resolver logic |
| `worker/jobs/PlaceIdValidationWorker.ts` | BullMQ consumer for `validate_place_id` topic |
| `worker/__tests__/PlaceIdValidationWorker.test.ts` | Worker tests |
| `supabase/migrations/007_place_id_verification.sql` | Adds `place_id_verified`, `google_maps_url` columns |

### Modified files
| File | What changes |
|---|---|
| `src/lib/reviews/url-parser.ts` | Add `parseGoogleMapsUrl()` returning `GoogleMapsUrlData` |
| `src/lib/shared/worker-types.ts` | Add `ValidatePlaceIdPayload` |
| `src/lib/shared/schemas.ts` | Update `OnboardBusinessSchema` with `PlaceInputSchema` union |
| `src/lib/demos/types.ts` | Update `DemoJobPayload` to carry optional URL data |
| `worker/queues.ts` | Add `VALIDATE_PLACE_ID` queue + topic mapping |
| `worker/index.ts` | Register new worker + queue |
| `worker/jobs/ReconciliationPoller.ts:29-35` | Add `place_id_verified = TRUE` filter |
| `worker/jobs/ReviewSyncWorker.ts:23-45` | Add `place_id_verified` column to SELECT + guard |
| `worker/jobs/DemoGenerationWorker.ts:10,74` | Add resolver pre-step for non-canonical IDs |
| `src/lib/demos/generator.ts:29` | Accept resolved placeId |
| `src/app/admin/businesses/new/page.tsx` | Replace URL input with autocomplete + fallback toggle |
| `src/app/admin/demos/page.tsx` | Same autocomplete + fallback toggle |
| `src/app/api/admin/businesses/route.ts:145-234` | Handle both input modes, validate Place ID format |
| `src/app/api/admin/demos/generate/route.ts:58-64` | Handle both input modes |
| `src/app/api/admin/jobs/route.ts:9-17` | Add `'validate_place_id'` to local queue list |
| `src/lib/reviews/serpapi-source.ts:3,22-28` | Revert to always `place_id` param |
| `src/lib/reviews/serpapi-monitor.ts:10,42-48` | Revert to always `place_id` param |

---

## Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/007_place_id_verification.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Add place_id_verified flag (defaults false — forces explicit verification)
ALTER TABLE businesses ADD COLUMN place_id_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- Store original URL for re-resolution if needed
ALTER TABLE businesses ADD COLUMN google_maps_url TEXT;

-- Only verify existing businesses whose google_place_id is a canonical base64url
-- Place ID (starts with a letter, 20+ chars). Do NOT grandfather hex CIDs.
UPDATE businesses
SET place_id_verified = TRUE
WHERE google_place_id IS NOT NULL
  AND google_place_id ~ '^[A-Za-z][A-Za-z0-9_-]{19,}$';

-- Existing businesses with non-canonical IDs stay place_id_verified = FALSE.
-- Insert a review_exception so the admin sees them in the dashboard.
-- review_id is NULL (no review involved), columns match the actual schema.
INSERT INTO review_exceptions (id, business_id, review_id, type, status, payload, created_at)
SELECT
  gen_random_uuid(),
  id,
  NULL,
  'place_id_resolution_required',
  'open',
  jsonb_build_object(
    'reason', 'Existing google_place_id is not a canonical Place ID',
    'current_value', google_place_id
  ),
  NOW()
FROM businesses
WHERE google_place_id IS NOT NULL
  AND NOT (google_place_id ~ '^[A-Za-z][A-Za-z0-9_-]{19,}$');

-- Add google_maps_url to prospect_demos too
ALTER TABLE prospect_demos ADD COLUMN google_maps_url TEXT;

-- Partial index for ReconciliationPoller filter
CREATE INDEX idx_businesses_verified_active
  ON businesses (subscription_status, place_id_verified)
  WHERE subscription_status = 'active' AND place_id_verified = TRUE;
```

- [ ] **Step 2: Run the migration**

Run: `psql "$DATABASE_POOL_URL" -f supabase/migrations/007_place_id_verification.sql`
Expected: All statements succeed. Existing test businesses with `ChIJ` Place IDs get `place_id_verified = TRUE`. Any with hex CIDs get a `review_exceptions` row.

- [ ] **Step 3: Verify**

Run:
```sql
SELECT id, google_place_id, place_id_verified FROM businesses;
SELECT id, business_id, type, payload FROM review_exceptions WHERE type = 'place_id_resolution_required';
```
Expected: Correct bifurcation of verified vs unverified.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/007_place_id_verification.sql
git commit -m "feat: add place_id_verified and google_maps_url columns"
```

---

## Task 2: URL Parser — `parseGoogleMapsUrl()`

**Files:**
- Modify: `src/lib/reviews/url-parser.ts`
- Create: `src/lib/reviews/__tests__/url-parser.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/reviews/__tests__/url-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseGoogleMapsUrl, extractPlaceId, isPlaceId, isHexCid } from '../url-parser';

describe('parseGoogleMapsUrl', () => {
  it('extracts all data from a full URL with hex CID', () => {
    const url =
      'https://www.google.com/maps/place/Caf%C3%A9+LaTTea/@37.3231977,-122.0123423,17z/data=!3m1!4b1!4m6!3m5!1s0x808fb59e48e954f1:0xd8ad2f3c266775b!8m2!3d37.3231977!4d-122.0123423';
    const result = parseGoogleMapsUrl(url);

    expect(result.placeId).toBeNull();
    expect(result.hexCid).toBe('0x808fb59e48e954f1:0xd8ad2f3c266775b');
    expect(result.businessName).toBe('Café LaTTea');
    expect(result.coordinates).toEqual({ lat: 37.3231977, lng: -122.0123423 });
  });

  it('extracts canonical Place ID and business name from data path', () => {
    const url =
      'https://www.google.com/maps/place/Test+Restaurant/@40.7,-74.0,17z/data=!3m1!4b1!4m5!3m4!1sChIJgUbEo8cfqokR5lP9_Wh_DaM!8m2!3d40.7!4d-74.0';
    const result = parseGoogleMapsUrl(url);

    expect(result.placeId).toBe('ChIJgUbEo8cfqokR5lP9_Wh_DaM');
    expect(result.hexCid).toBeNull();
    expect(result.businessName).toBe('Test Restaurant');
    expect(result.coordinates).toEqual({ lat: 40.7, lng: -74.0 });
  });

  it('extracts name with special characters (URI decoded)', () => {
    const url = 'https://www.google.com/maps/place/Bob%27s+Fish+%26+Chips/@51.5,-0.1,17z';
    const result = parseGoogleMapsUrl(url);

    expect(result.businessName).toBe("Bob's Fish & Chips");
  });

  it('returns all nulls for non-Google-Maps URL', () => {
    const result = parseGoogleMapsUrl('https://example.com/page');
    expect(result).toEqual({
      placeId: null,
      hexCid: null,
      businessName: null,
      coordinates: null,
    });
  });

  it('returns all nulls for empty input', () => {
    const result = parseGoogleMapsUrl('');
    expect(result).toEqual({
      placeId: null,
      hexCid: null,
      businessName: null,
      coordinates: null,
    });
  });

  it('extracts coordinates even without data path', () => {
    const url = 'https://www.google.com/maps/place/Some+Place/@-33.8688,151.2093,17z';
    const result = parseGoogleMapsUrl(url);

    expect(result.businessName).toBe('Some Place');
    expect(result.coordinates).toEqual({ lat: -33.8688, lng: 151.2093 });
    expect(result.placeId).toBeNull();
    expect(result.hexCid).toBeNull();
  });

  it('handles URL with Place ID in query param', () => {
    const url = 'https://www.google.com/maps/place/?q=place_id:GhIJQWDl0CIeQUARxks3icF8U8A';
    const result = parseGoogleMapsUrl(url);

    expect(result.placeId).toBe('GhIJQWDl0CIeQUARxks3icF8U8A');
  });
});

describe('isPlaceId', () => {
  it('returns true for ChIJ Place IDs', () => {
    expect(isPlaceId('ChIJgUbEo8cfqokR5lP9_Wh_DaM')).toBe(true);
  });

  it('returns true for GhIJ Place IDs', () => {
    expect(isPlaceId('GhIJQWDl0CIeQUARxks3icF8U8A')).toBe(true);
  });

  it('returns true for Eic Place IDs', () => {
    expect(isPlaceId('EicxMyBNYXJrZXQgU3QsIFdpbG1pbmd0b24sIE5DIDI4NDAxLCBVU0E')).toBe(true);
  });

  it('returns false for hex CIDs', () => {
    expect(isPlaceId('0x808fb59e48e954f1:0xd8ad2f3c266775b')).toBe(false);
  });

  it('returns false for short strings', () => {
    expect(isPlaceId('short')).toBe(false);
  });
});

describe('isHexCid', () => {
  it('returns true for hex CID format', () => {
    expect(isHexCid('0x808fb59e48e954f1:0xd8ad2f3c266775b')).toBe(true);
  });

  it('returns false for Place IDs', () => {
    expect(isHexCid('ChIJgUbEo8cfqokR5lP9_Wh_DaM')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/reviews/__tests__/url-parser.test.ts`
Expected: FAIL — `parseGoogleMapsUrl` is not exported.

- [ ] **Step 3: Implement `parseGoogleMapsUrl`**

Add to `src/lib/reviews/url-parser.ts`:

```typescript
export interface GoogleMapsUrlData {
  placeId: string | null;
  hexCid: string | null;
  businessName: string | null;
  coordinates: { lat: number; lng: number } | null;
}

/** Extracts all available data from a Google Maps URL. */
export function parseGoogleMapsUrl(input: string): GoogleMapsUrlData {
  const result: GoogleMapsUrlData = {
    placeId: null,
    hexCid: null,
    businessName: null,
    coordinates: null,
  };

  const trimmed = input.trim();
  if (trimmed.length === 0) return result;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return result;
  }

  // Business name from /place/Name/ segment
  const nameMatch = url.pathname.match(/\/place\/([^/@]+)/);
  if (nameMatch) {
    result.businessName = decodeURIComponent(nameMatch[1]!.replace(/\+/g, ' '));
  }

  // Coordinates from /@lat,lng segment
  const coordMatch = trimmed.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]!);
    const lng = parseFloat(coordMatch[2]!);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      result.coordinates = { lat, lng };
    }
  }

  // Canonical Place ID from query params
  const qParam = url.searchParams.get('q');
  if (qParam?.startsWith('place_id:')) {
    result.placeId = qParam.slice('place_id:'.length);
    return result;
  }
  const placeIdParam = url.searchParams.get('placeid') ?? url.searchParams.get('place_id');
  if (placeIdParam) {
    result.placeId = placeIdParam;
    return result;
  }

  // Canonical Place ID from !1s data path (check before hex CID)
  const dataPlaceId = trimmed.match(/!1s([A-Za-z][A-Za-z0-9_-]{19,})/)?.[1];
  if (dataPlaceId) {
    result.placeId = dataPlaceId;
    return result;
  }

  // Hex CID from !1s data path
  const hexCid = trimmed.match(/!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/)?.[1];
  if (hexCid) {
    result.hexCid = hexCid;
  }

  return result;
}
```

Also update the existing `extractPlaceId` to delegate to the new function:

```typescript
export function extractPlaceId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // Raw Place ID (base64url, 20+ chars, starts with a letter)
  if (PLACE_ID_RE.test(trimmed)) {
    return trimmed;
  }

  const parsed = parseGoogleMapsUrl(trimmed);
  return parsed.placeId ?? parsed.hexCid ?? null;
}
```

Note: Keep the raw Place ID check at the top since `parseGoogleMapsUrl` requires a URL. The path segment regex in the old code is removed since `parseGoogleMapsUrl` handles all URL cases.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/reviews/__tests__/url-parser.test.ts`
Expected: All PASS.

- [ ] **Step 5: Run existing tests to check no regressions**

Run: `npx vitest run src/lib/reviews/__tests__/serpapi-source.test.ts`
Expected: All 39 existing tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reviews/url-parser.ts src/lib/reviews/__tests__/url-parser.test.ts
git commit -m "feat: add parseGoogleMapsUrl() for rich URL data extraction"
```

---

## Task 3: Place ID Resolver

**Files:**
- Create: `src/lib/reviews/place-id-resolver.ts`
- Create: `src/lib/reviews/__tests__/place-id-resolver.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/reviews/__tests__/place-id-resolver.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock serpapi before importing resolver
vi.mock('serpapi', () => ({
  getJson: vi.fn(),
}));

// Mock rate limiter
vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 50 }),
}));

import { resolvePlaceId } from '../place-id-resolver';
import type { GoogleMapsUrlData } from '../url-parser';

async function getJsonMock() {
  const { getJson } = await import('serpapi');
  return getJson as ReturnType<typeof vi.fn>;
}

async function getRateLimitMock() {
  const { checkRateLimit } = await import('@/lib/shared/rate-limit');
  return checkRateLimit as ReturnType<typeof vi.fn>;
}

describe('resolvePlaceId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns canonical Place ID directly without SerpAPI call', async () => {
    const data: GoogleMapsUrlData = {
      placeId: 'ChIJgUbEo8cfqokR5lP9_Wh_DaM',
      hexCid: null,
      businessName: 'Test',
      coordinates: { lat: 40.7, lng: -74.0 },
    };

    const result = await resolvePlaceId(data);
    expect(result).toBe('ChIJgUbEo8cfqokR5lP9_Wh_DaM');

    const mock = await getJsonMock();
    expect(mock).not.toHaveBeenCalled();
  });

  it('resolves via SerpAPI search when name + coords available', async () => {
    const mock = await getJsonMock();
    mock.mockResolvedValueOnce({
      local_results: [{
        place_id: 'ChIJResolved1234567890abc',
        title: 'Café LaTTea',
        gps_coordinates: { latitude: 37.3232, longitude: -122.0123 },
      }],
    });

    const data: GoogleMapsUrlData = {
      placeId: null,
      hexCid: '0x808fb59e48e954f1:0xd8ad2f3c266775b',
      businessName: 'Café LaTTea',
      coordinates: { lat: 37.3231977, lng: -122.0123423 },
    };

    const result = await resolvePlaceId(data);
    expect(result).toBe('ChIJResolved1234567890abc');

    expect(mock).toHaveBeenCalledWith(expect.objectContaining({
      engine: 'google_maps',
      q: 'Café LaTTea',
    }));
  });

  it('fails fast when only business name available (no coords)', async () => {
    const data: GoogleMapsUrlData = {
      placeId: null,
      hexCid: null,
      businessName: 'Some Restaurant',
      coordinates: null,
    };

    await expect(resolvePlaceId(data)).rejects.toThrow(
      'Cannot resolve Place ID without coordinates',
    );
  });

  it('fails fast when only hex CID available (no name or coords)', async () => {
    const data: GoogleMapsUrlData = {
      placeId: null,
      hexCid: '0x808fb59e48e954f1:0xd8ad2f3c266775b',
      businessName: null,
      coordinates: null,
    };

    await expect(resolvePlaceId(data)).rejects.toThrow(
      'Cannot resolve Place ID without business name and coordinates',
    );
  });

  it('fails when no SerpAPI results match within 200m', async () => {
    const mock = await getJsonMock();
    mock.mockResolvedValueOnce({
      local_results: [{
        place_id: 'ChIJFarAway1234567890abc',
        title: 'Totally Different Place',
        gps_coordinates: { latitude: 50.0, longitude: 10.0 },
      }],
    });

    const data: GoogleMapsUrlData = {
      placeId: null,
      hexCid: null,
      businessName: 'Café LaTTea',
      coordinates: { lat: 37.3232, lng: -122.0123 },
    };

    await expect(resolvePlaceId(data)).rejects.toThrow(
      'Could not verify business location',
    );
  });

  it('fails when SerpAPI returns no results', async () => {
    const mock = await getJsonMock();
    mock.mockResolvedValueOnce({ local_results: [] });

    const data: GoogleMapsUrlData = {
      placeId: null,
      hexCid: null,
      businessName: 'Nonexistent Place',
      coordinates: { lat: 37.0, lng: -122.0 },
    };

    await expect(resolvePlaceId(data)).rejects.toThrow(
      'Could not verify business location',
    );
  });

  it('respects daily rate limit', async () => {
    const rateLimitMock = await getRateLimitMock();
    rateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    const data: GoogleMapsUrlData = {
      placeId: null,
      hexCid: null,
      businessName: 'Café LaTTea',
      coordinates: { lat: 37.3232, lng: -122.0123 },
    };

    await expect(resolvePlaceId(data)).rejects.toThrow(
      'Daily Place ID resolution limit reached',
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/reviews/__tests__/place-id-resolver.test.ts`
Expected: FAIL — `resolvePlaceId` not found.

- [ ] **Step 3: Implement the resolver**

Create `src/lib/reviews/place-id-resolver.ts`:

```typescript
import { getJson } from 'serpapi';
import { isPlaceId } from './url-parser';
import type { GoogleMapsUrlData } from './url-parser';
import { checkRateLimit } from '@/lib/shared/rate-limit';

const MATCH_RADIUS_M = 200;
const DAILY_LIMIT = 75;
const DAILY_WINDOW_S = 86400;

interface SerpApiLocalResult {
  place_id?: string;
  title?: string;
  gps_coordinates?: { latitude: number; longitude: number };
  address?: string;
}

/**
 * Resolves a GoogleMapsUrlData to a canonical Place ID.
 *
 * Strategy:
 * 1. Canonical Place ID present → return directly
 * 2. Business name + coordinates → SerpAPI google_maps search → match by proximity
 * 3. Anything else → fail fast
 */
export async function resolvePlaceId(data: GoogleMapsUrlData): Promise<string> {
  // Strategy 1: already canonical
  if (data.placeId && isPlaceId(data.placeId)) {
    return data.placeId;
  }

  // Strategy 3 (checked before 2): fail fast if missing required data
  if (!data.businessName && !data.coordinates) {
    throw new Error(
      'Cannot resolve Place ID without business name and coordinates — use the search field instead',
    );
  }
  if (!data.coordinates) {
    throw new Error(
      'Cannot resolve Place ID without coordinates — use the search field instead',
    );
  }
  if (!data.businessName) {
    throw new Error(
      'Cannot resolve Place ID without business name and coordinates — use the search field instead',
    );
  }

  // Strategy 2: SerpAPI search
  const limit = await checkRateLimit('serpapi:resolve:daily', DAILY_LIMIT, DAILY_WINDOW_S);
  if (!limit.allowed) {
    throw new Error('Daily Place ID resolution limit reached — use the search field instead');
  }

  const params: Record<string, unknown> = {
    engine: 'google_maps',
    q: data.businessName,
    ll: `@${data.coordinates.lat},${data.coordinates.lng},15z`,
    type: 'search',
    api_key: process.env.SERPAPI_API_KEY,
  };

  const response = await getJson(params);

  if (response.error) {
    const msg = typeof response.error === 'string' ? response.error : JSON.stringify(response.error);
    throw new Error(`SerpAPI search error: ${msg}`);
  }

  const results: SerpApiLocalResult[] = response.local_results ?? [];
  if (results.length === 0) {
    throw new Error('Could not verify business location — try using the search field instead');
  }

  // Find best match within MATCH_RADIUS_M
  const targetLat = data.coordinates.lat;
  const targetLng = data.coordinates.lng;
  const targetName = normalizeName(data.businessName);

  let bestMatch: SerpApiLocalResult | null = null;
  let bestDistance = Infinity;

  for (const result of results) {
    if (!result.place_id || !result.gps_coordinates) continue;

    const distance = haversineMeters(
      targetLat, targetLng,
      result.gps_coordinates.latitude, result.gps_coordinates.longitude,
    );

    if (distance > MATCH_RADIUS_M) continue;

    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = result;
    } else if (distance === bestDistance && result.title) {
      // Tie-break by name similarity
      const currentNameSim = normalizeName(bestMatch?.title ?? '');
      const candidateNameSim = normalizeName(result.title);
      if (candidateNameSim === targetName && currentNameSim !== targetName) {
        bestMatch = result;
      }
    }
  }

  if (!bestMatch?.place_id) {
    throw new Error('Could not verify business location — try using the search field instead');
  }

  return bestMatch.place_id;
}

function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function haversineMeters(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const R = 6_371_000; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/reviews/__tests__/place-id-resolver.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reviews/place-id-resolver.ts src/lib/reviews/__tests__/place-id-resolver.test.ts
git commit -m "feat: add Place ID resolver with SerpAPI search + haversine matching"
```

---

## Task 4: Worker Infrastructure — Queue, Payload Type, Registration

**Files:**
- Modify: `src/lib/shared/worker-types.ts`
- Modify: `worker/queues.ts`
- Modify: `worker/index.ts`
- Modify: `src/app/api/admin/jobs/route.ts:9-17`

- [ ] **Step 1: Add `ValidatePlaceIdPayload` to worker types**

Add to `src/lib/shared/worker-types.ts`:

```typescript
export interface ValidatePlaceIdPayload {
  business_id: string;
  google_maps_url: string;
}
```

- [ ] **Step 2: Add queue to `worker/queues.ts`**

Add `VALIDATE_PLACE_ID: 'validate_place_id'` to `QUEUE_NAMES`, add queue instance to `queues`, and add topic mapping to `topicToQueue`.

- [ ] **Step 3: Register worker in `worker/index.ts`**

Import `handlePlaceIdValidation` from `./jobs/PlaceIdValidationWorker`. Create a new BullMQ Worker for `QUEUE_NAMES.VALIDATE_PLACE_ID`. Add it to the `workers` array.

- [ ] **Step 4: Add to admin jobs route local queue list**

Add `'validate_place_id'` to the `QUEUE_NAMES` array in `src/app/api/admin/jobs/route.ts:9-17`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/worker-types.ts worker/queues.ts worker/index.ts src/app/api/admin/jobs/route.ts
git commit -m "feat: register validate_place_id queue and worker infrastructure"
```

---

## Task 5: PlaceIdValidationWorker

**Files:**
- Create: `worker/jobs/PlaceIdValidationWorker.ts`
- Create: `worker/__tests__/PlaceIdValidationWorker.test.ts`

- [ ] **Step 1: Write failing tests**

Create `worker/__tests__/PlaceIdValidationWorker.test.ts`. Test cases:
- URL with canonical Place ID → sets `place_id_verified = true`, queues `sync_reviews`, no SerpAPI call
- URL with hex CID + name + coords → resolves via SerpAPI, updates `google_place_id`, sets verified, queues sync
- URL with hex CID only (no name/coords) → fails with `place_id_resolution_failed` exception
- Business not found → completes outbox cleanly
- SerpAPI error → throws to trigger BullMQ retry

Mock `sql`, `resolvePlaceId`, `parseGoogleMapsUrl`, `markOutboxCompleted`, `markOutboxFailed`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run worker/__tests__/PlaceIdValidationWorker.test.ts`

- [ ] **Step 3: Implement the worker**

Create `worker/jobs/PlaceIdValidationWorker.ts`:

```typescript
import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import type { ValidatePlaceIdPayload, SyncReviewsPayload } from '../../src/lib/shared/worker-types';
import { parseGoogleMapsUrl, isPlaceId } from '../../src/lib/reviews/url-parser';
import { resolvePlaceId } from '../../src/lib/reviews/place-id-resolver';

const LOG_PREFIX = '[PlaceIdValidationWorker]';

export async function handlePlaceIdValidation(
  job: Job<ValidatePlaceIdPayload>,
): Promise<void> {
  const { business_id, google_maps_url } = job.data;
  const outboxId = (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

  // Load business
  const [business] = await sql<{ id: string; google_place_id: string | null }[]>`
    SELECT id, google_place_id FROM businesses WHERE id = ${business_id}
  `;

  if (!business) {
    console.warn(`${LOG_PREFIX} Business ${business_id} not found`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // Parse URL for all available data
  const urlData = parseGoogleMapsUrl(google_maps_url);

  // If URL contained a canonical Place ID, verify format and store
  if (urlData.placeId && isPlaceId(urlData.placeId)) {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE businesses
        SET google_place_id = ${urlData.placeId},
            place_id_verified = TRUE
        WHERE id = ${business_id}
      `;

      const syncPayload: SyncReviewsPayload = {
        business_id,
        google_place_id: urlData.placeId!,
      };

      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (${uuidv7()}, 'sync_reviews', 'business', ${business_id},
                ${JSON.stringify(syncPayload)}::jsonb, 'pending')
      `;
    });

    await markOutboxCompleted(outboxId);
    console.log(`${LOG_PREFIX} Business ${business_id} verified (canonical ID in URL)`);
    return;
  }

  // Otherwise, resolve via SerpAPI search
  try {
    const resolvedPlaceId = await resolvePlaceId(urlData);

    await sql.begin(async (tx) => {
      await tx`
        UPDATE businesses
        SET google_place_id = ${resolvedPlaceId},
            place_id_verified = TRUE
        WHERE id = ${business_id}
      `;

      const syncPayload: SyncReviewsPayload = {
        business_id,
        google_place_id: resolvedPlaceId,
      };

      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (${uuidv7()}, 'sync_reviews', 'business', ${business_id},
                ${JSON.stringify(syncPayload)}::jsonb, 'pending')
      `;
    });

    await markOutboxCompleted(outboxId);
    console.log(`${LOG_PREFIX} Business ${business_id} resolved to ${resolvedPlaceId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Transient errors (SerpAPI down) → throw for BullMQ retry
    if (message.includes('SerpAPI search error')) {
      console.error(`${LOG_PREFIX} Transient error for ${business_id}: ${message}`);
      throw error;
    }

    // Permanent errors (no match, rate limit, bad data) → fail outbox + log exception
    console.error(`${LOG_PREFIX} Permanent resolution failure for ${business_id}: ${message}`);

    await sql`
      INSERT INTO review_exceptions (id, business_id, review_id, type, status, payload)
      VALUES (
        ${uuidv7()}, ${business_id}, NULL, 'place_id_resolution_failed', 'open',
        ${JSON.stringify({ reason: message, google_maps_url })}::jsonb
      )
      ON CONFLICT DO NOTHING
    `;

    await markOutboxFailed(outboxId, message);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run worker/__tests__/PlaceIdValidationWorker.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/PlaceIdValidationWorker.ts worker/__tests__/PlaceIdValidationWorker.test.ts
git commit -m "feat: add PlaceIdValidationWorker for outbox-driven Place ID resolution"
```

---

## Task 6: ReconciliationPoller + ReviewSyncWorker Guards

**Files:**
- Modify: `worker/jobs/ReconciliationPoller.ts:29-35`
- Modify: `worker/jobs/ReviewSyncWorker.ts:23-45`

- [ ] **Step 1: Add `place_id_verified` filter to ReconciliationPoller**

In `worker/jobs/ReconciliationPoller.ts`, add `AND b.place_id_verified = TRUE` to the candidate selection query at line ~32.

- [ ] **Step 2: Add defensive guard in ReviewSyncWorker**

In `worker/jobs/ReviewSyncWorker.ts`:
1. Add `place_id_verified: boolean` to the SELECT type at line ~23
2. Add `place_id_verified` to the SQL SELECT column list at line ~30
3. Add guard after the `google_place_id` null check (after line 45):

```typescript
if (!business.place_id_verified) {
  console.warn(`${LOG_PREFIX} Business ${business_id} place_id not verified, skipping`);
  await markOutboxCompleted(outboxId);
  return;
}
```

- [ ] **Step 3: Run existing tests**

Run: `npx vitest run`
Expected: All tests pass (no tests directly exercise these guards with the new column, but nothing should break).

- [ ] **Step 4: Commit**

```bash
git add worker/jobs/ReconciliationPoller.ts worker/jobs/ReviewSyncWorker.ts
git commit -m "feat: gate ReconciliationPoller and ReviewSyncWorker on place_id_verified"
```

---

## Task 7: SerpAPI Source/Monitor Cleanup

**Files:**
- Modify: `src/lib/reviews/serpapi-source.ts`
- Modify: `src/lib/reviews/serpapi-monitor.ts`

- [ ] **Step 1: Revert `serpapi-source.ts` to always use `place_id`**

Remove the `isHexCid` import and the conditional `data_id` logic. Revert to:

```typescript
const params: Record<string, unknown> = {
  engine: 'google_maps_reviews',
  place_id: placeId,
  sort_by: 'newestFirst',
  api_key: this.apiKey,
};
```

- [ ] **Step 2: Revert `serpapi-monitor.ts` to always use `place_id`**

Same revert — remove `isHexCid` import and conditional.

- [ ] **Step 3: Run existing SerpAPI tests**

Run: `npx vitest run src/lib/reviews/__tests__/serpapi-source.test.ts`
Expected: All 39 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/reviews/serpapi-source.ts src/lib/reviews/serpapi-monitor.ts
git commit -m "refactor: revert SerpAPI sources to always use place_id parameter"
```

---

## Task 8: API Route Changes — Onboarding + Demo Generation

**Files:**
- Modify: `src/lib/shared/schemas.ts`
- Modify: `src/app/api/admin/businesses/route.ts`
- Modify: `src/app/api/admin/demos/generate/route.ts`
- Modify: `src/lib/demos/types.ts`

- [ ] **Step 1: Update schemas**

In `src/lib/shared/schemas.ts`, update `OnboardBusinessSchema` to accept either input mode. Replace the `googleMapsUrl` field with a discriminated union approach — accept `googlePlaceId` + optional `googlePlaceAddress`, OR `googleMapsUrl`. Use `.refine()` to ensure at least one is provided.

- [ ] **Step 2: Update onboarding API route**

In `src/app/api/admin/businesses/route.ts`:
- When `googlePlaceId` is submitted: validate with `isPlaceId()`, store with `place_id_verified = true`, store optional `googlePlaceAddress`, queue `sync_reviews` directly
- When `googleMapsUrl` is submitted: store the URL in `google_maps_url` column, set `place_id_verified = false`, queue `validate_place_id` instead of `sync_reviews`
- Import `isPlaceId` from `url-parser`, import `ValidatePlaceIdPayload` from `worker-types`

- [ ] **Step 3: Update demo generation types**

In `src/lib/demos/types.ts`, update `DemoJobPayload` to optionally carry `googleMapsUrl`:

```typescript
export interface DemoJobPayload {
  demoId: string;
  googlePlaceId: string;
  businessName: string;
  category?: string;
  googleMapsUrl?: string;  // for URL fallback resolution
}
```

- [ ] **Step 4: Update demo generation API route**

In `src/app/api/admin/demos/generate/route.ts`:
- Accept either `googlePlaceId` or `googleMapsUrl`
- When `googlePlaceId` with valid `isPlaceId()`: use directly
- When `googleMapsUrl`: parse URL, extract whatever placeId is available (may be hex CID), store URL in `google_maps_url` column, pass URL in payload

- [ ] **Step 5: Update DemoGenerationWorker**

In `worker/jobs/DemoGenerationWorker.ts`:
- When `googlePlaceId` passes `isPlaceId()`: use directly (existing path)
- When `googleMapsUrl` is in payload: call `resolvePlaceId(parseGoogleMapsUrl(url))` before `generateDemo()`
- Import `parseGoogleMapsUrl`, `isPlaceId` from url-parser, `resolvePlaceId` from resolver

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/shared/schemas.ts src/app/api/admin/businesses/route.ts src/app/api/admin/demos/generate/route.ts src/lib/demos/types.ts worker/jobs/DemoGenerationWorker.ts
git commit -m "feat: API routes accept autocomplete Place ID or URL with conditional validation"
```

---

## Task 9: PlaceAutocomplete Component

**Files:**
- Create: `src/components/PlaceAutocomplete.tsx`

- [ ] **Step 1: Install Google Maps loader**

Run: `pnpm add @googlemaps/js-api-loader`

- [ ] **Step 2: Create the component**

Create `src/components/PlaceAutocomplete.tsx`:

```typescript
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Loader } from '@googlemaps/js-api-loader';

export interface PlaceSelection {
  placeId: string;
  formattedAddress: string;
  lat: number;
  lng: number;
}

interface PlaceAutocompleteProps {
  onPlaceSelect: (selection: PlaceSelection) => void;
  onClear?: () => void;
  placeholder?: string;
  className?: string;
}

const loader = new Loader({
  apiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '',
  version: 'weekly',
  libraries: ['places'],
});

export function PlaceAutocomplete({
  onPlaceSelect,
  onClear,
  placeholder = 'Search for a business...',
  className,
}: PlaceAutocompleteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<PlaceSelection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSelect = useCallback(
    async (event: Event) => {
      try {
        const customEvent = event as CustomEvent;
        const placePrediction = customEvent.detail?.placePrediction
          ?? (customEvent as any).placePrediction;

        if (!placePrediction) {
          setError('Failed to get place prediction');
          return;
        }

        const place = placePrediction.toPlace();
        await place.fetchFields({ fields: ['id', 'formattedAddress', 'location'] });

        if (!place.location || !place.id) {
          setError('Place has no location data');
          return;
        }

        const result: PlaceSelection = {
          placeId: place.id,
          formattedAddress: place.formattedAddress ?? '',
          lat: place.location.lat(),
          lng: place.location.lng(),
        };

        setSelection(result);
        setError(null);
        onPlaceSelect(result);
      } catch (err) {
        setError('Failed to load place details');
        console.error('[PlaceAutocomplete]', err);
      }
    },
    [onPlaceSelect],
  );

  useEffect(() => {
    let autocompleteElement: HTMLElement | null = null;

    loader
      .importLibrary('places')
      .then(() => {
        if (!containerRef.current) return;

        autocompleteElement = document.createElement('gmp-place-autocomplete');
        autocompleteElement.setAttribute('placeholder', placeholder);
        autocompleteElement.style.width = '100%';

        autocompleteElement.addEventListener('gmp-select', handleSelect);

        containerRef.current.innerHTML = '';
        containerRef.current.appendChild(autocompleteElement);
      })
      .catch((err) => {
        setError('Failed to load Google Maps');
        console.error('[PlaceAutocomplete] Load error:', err);
      });

    return () => {
      if (autocompleteElement) {
        autocompleteElement.removeEventListener('gmp-select', handleSelect);
      }
    };
  }, [placeholder, handleSelect]);

  const handleClear = () => {
    setSelection(null);
    setError(null);
    onClear?.();
  };

  return (
    <div>
      <div ref={containerRef} className={className} />

      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}

      {selection && (
        <div className="mt-2 flex items-start justify-between rounded-md border border-green-200 bg-green-50 px-3 py-2">
          <div>
            <p className="text-sm font-medium text-green-900">
              {selection.formattedAddress}
            </p>
            <p className="text-xs text-green-700 mt-0.5">
              Place ID: {selection.placeId.slice(0, 20)}...
            </p>
          </div>
          <button
            type="button"
            onClick={handleClear}
            className="ml-2 text-xs text-green-600 hover:text-green-800"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/PlaceAutocomplete.tsx
pnpm add @googlemaps/js-api-loader
git add package.json pnpm-lock.yaml
git commit -m "feat: add PlaceAutocomplete component with Google Maps JS API"
```

---

## Task 10: Update Onboarding + Demo Forms

**Files:**
- Modify: `src/app/admin/businesses/new/page.tsx`
- Modify: `src/app/admin/demos/page.tsx`

- [ ] **Step 1: Update onboarding form**

In `src/app/admin/businesses/new/page.tsx`:
- Add state: `const [inputMode, setInputMode] = useState<'autocomplete' | 'url'>('autocomplete')`
- Add state: `const [placeSelection, setPlaceSelection] = useState<PlaceSelection | null>(null)`
- Replace the `googleMapsUrl` Field with:
  - When `inputMode === 'autocomplete'`: render `PlaceAutocomplete` component
  - Toggle link: "Or paste a Google Maps URL" / "Use search instead"
  - When `inputMode === 'url'`: render the old text input
- Update `onSubmit` to send either `{ googlePlaceId, googlePlaceAddress }` or `{ googleMapsUrl }` based on input mode
- Update `FormSchema` to make `googleMapsUrl` optional, add `googlePlaceId` and `googlePlaceAddress` as optional, with a refine to require at least one path

- [ ] **Step 2: Update demo form**

In `src/app/admin/demos/page.tsx`:
- Same pattern: add `inputMode` state, toggle between autocomplete and URL input
- Update mutation to send either `{ googlePlaceId, businessName, category }` or `{ googleMapsUrl, businessName, category }`

- [ ] **Step 3: Test in browser**

Start `pnpm dev`. Visit `/admin/businesses/new`:
- Verify autocomplete loads (requires `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` in `.env.local`)
- Type a business name → see suggestions → select one → confirmation card appears
- Toggle to URL mode → old text input appears
- Submit with autocomplete → business created with `place_id_verified = true`
- Submit with URL → business created with `place_id_verified = false`

Visit `/admin/demos`:
- Same autocomplete/URL toggle works
- Demo generation succeeds with autocomplete-provided Place ID

- [ ] **Step 4: Commit**

```bash
git add src/app/admin/businesses/new/page.tsx src/app/admin/demos/page.tsx
git commit -m "feat: add Place Autocomplete to onboarding and demo forms with URL fallback"
```

---

## Task 11: Run Full Test Suite + Manual Verification

- [ ] **Step 1: Run all Vitest tests**

Run: `npx vitest run`
Expected: All tests pass (existing 212+ tests plus new url-parser and resolver tests).

- [ ] **Step 2: Verify worker starts cleanly**

Run: `pnpm worker`
Expected: Worker starts with no errors. New `validate_place_id` queue registered. Log shows all 8 workers initialized.

- [ ] **Step 3: Manual E2E test — autocomplete path**

1. Start `pnpm dev` + `pnpm worker`
2. Go to `/admin/businesses/new`
3. Use autocomplete to select a real business
4. Submit → verify `place_id_verified = true` in database
5. Check worker logs for `sync_reviews` being queued

- [ ] **Step 4: Manual E2E test — URL fallback path**

1. Go to `/admin/businesses/new`
2. Toggle to URL mode, paste a real Google Maps URL
3. Submit → verify `place_id_verified = false` in database
4. Check worker logs for `validate_place_id` being queued and processed
5. After resolution → verify `place_id_verified = true` and `sync_reviews` queued

- [ ] **Step 5: Manual E2E test — demo generation**

1. Go to `/admin/demos`
2. Use autocomplete to select a business
3. Generate demo → verify it works end-to-end

- [ ] **Step 6: Commit all remaining changes**

If any tweaks were needed during manual testing:
```bash
git add -A
git commit -m "fix: adjustments from manual E2E testing"
```
