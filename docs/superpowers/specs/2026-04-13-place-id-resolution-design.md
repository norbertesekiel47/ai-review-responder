# Robust Google Place ID Resolution

**Date:** 2026-04-13
**Status:** Draft
**Problem:** Users paste Google Maps URLs containing unreliable identifiers (hex CIDs). These get stored and sent to SerpAPI, wasting credits when SerpAPI doesn't recognize them. No validation happens before storage or polling.

---

## Solution Overview

Replace the "paste a URL and hope" flow with a two-path input system:

1. **Primary path (autocomplete):** Google Maps Place Autocomplete widget on onboarding and demo forms. Returns canonical Place IDs directly from Google. Zero ambiguity, zero wasted SerpAPI credits.
2. **Fallback path (URL paste):** For users who prefer pasting a URL. The URL is parsed for all available data (ID, name, coordinates), then resolved to a canonical Place ID via SerpAPI search in a worker.
3. **Validation gate:** No business enters the polling pipeline without a verified Place ID. A `place_id_verified` flag gates ReconciliationPoller.

---

## Layer 1: Google Maps Place Autocomplete (Primary Input)

### What it does

Replaces the plain text "Google Maps URL" field on both the onboarding form (`/admin/businesses/new`) and demo generation form (`/admin/demos`) with a Google Maps Place Autocomplete widget.

The admin types a business name, selects from autocomplete suggestions, and the widget returns the canonical Place ID plus display info.

### Implementation

**Client-side component:** `src/components/PlaceAutocomplete.tsx`

A reusable React component that wraps the Google Maps Place Autocomplete element. It:
- Loads the Google Maps JavaScript API via `@googlemaps/js-api-loader` (or a script tag with `loading=async`)
- Renders a `gmp-place-autocomplete` element for place search
- Listens for the `gmp-select` event (renamed from the deprecated `gmp-placeselect`)
- On selection, calls `event.placePrediction.toPlace()` to get the Place object, then `place.fetchFields({ fields: ['id', 'formattedAddress', 'location'] })`
- Fires an `onPlaceSelect` callback with `{ placeId: place.id, formattedAddress, lat, lng }`
- Shows a confirmation card below the input: "123 Main St, Cupertino, CA" with the Place ID

**Note on `gmp-select` event flow:** Per Google's migration docs, the event returns a `placePrediction` instance, not a `place` directly. You must call `placePrediction.toPlace()` before `fetchFields()`.

**fetchFields billing tiers (Google SKU docs):**
- `id` → **IDs Only** tier (cheapest / free tier eligible)
- `formattedAddress`, `location` → **Essentials** tier
- `displayName` → **Pro** tier (more expensive)

We request `['id', 'formattedAddress', 'location']` — staying in the Essentials tier. We do NOT request `displayName` to avoid Pro-tier billing. The business name is already typed by the admin in the form's "Business Name" field, so we don't need it from Google.

**Environment variable:** `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` — a Maps JavaScript API key with Places API (New) enabled. Restricted to the app's domain(s).

**Cost:** As of March 2025, Google uses tier-based pricing (Essentials/Pro/Enterprise) with Free Usage Caps replacing the old "$200 credit" model. The Essentials tier provides 10,000 free requests/month for most core services. At MVP scale (tens of businesses per month), this is well within the free tier. Requesting only Essentials-tier fields keeps us in the cheapest billing bracket.

### Form changes

**Onboarding form (`/admin/businesses/new`):**

Replace the `googleMapsUrl` text input with:
1. The `PlaceAutocomplete` component (primary)
2. A "Or paste a Google Maps URL" toggle that reveals the old text input (fallback)

The form schema changes:
- When autocomplete is used: submit `{ googlePlaceId, googlePlaceName, googlePlaceAddress }` — no URL parsing needed
- When URL fallback is used: submit `{ googleMapsUrl }` — existing URL parsing + worker validation

**Demo form (`/admin/demos`):**

Same pattern — autocomplete primary, URL fallback toggle.

### API route changes

Both the onboarding route (`POST /api/admin/businesses`) and demo route (`POST /api/admin/demos/generate`) accept either input mode:

```typescript
// Zod schema accepts either autocomplete result OR URL
const PlaceInputSchema = z.union([
  z.object({
    googlePlaceId: z.string().min(1),
    googlePlaceAddress: z.string().optional(),
  }),
  z.object({
    googleMapsUrl: z.string().min(1),
  }),
]);
```

**Server-side validation — do NOT trust client-submitted `googlePlaceId` blindly:**

When `googlePlaceId` is provided (autocomplete path), the API route MUST validate the format before setting `place_id_verified = true`:
- Check with `isPlaceId(googlePlaceId)` — must be base64url, 20+ chars, starts with a letter
- Reject hex CIDs (`0x...:0x...`) and raw URLs even if submitted on the autocomplete path
- If validation fails: return 400 with "Invalid Place ID format"
- If validation passes: store with `place_id_verified = true`, queue `sync_reviews` directly

When `googleMapsUrl` is provided (fallback path):
- Parse the URL for available data
- Store with `place_id_verified = false`
- Queue `validate_place_id` (validation step before sync)

---

## Layer 2: URL Parser Upgrade (Fallback Path)

### What changes

Current `extractPlaceId()` returns `string | null`. Add a richer extraction function:

```typescript
interface GoogleMapsUrlData {
  placeId: string | null;       // ChIJ... format (high confidence)
  hexCid: string | null;        // 0x...:0x... format (unreliable with SerpAPI)
  businessName: string | null;  // decoded from /place/Name/ URL segment
  coordinates: { lat: number; lng: number } | null; // from /@lat,lng segment
}

function parseGoogleMapsUrl(input: string): GoogleMapsUrlData;
```

From `https://www.google.com/maps/place/Caf%C3%A9+LaTTea/@37.32,-122.01,...`, this extracts:
- `placeId`: null (no ChIJ in this URL)
- `hexCid`: `0x808fb59e48e954f1:0xd8ad2f3c266775b`
- `businessName`: `Cafe LaTTea`
- `coordinates`: `{ lat: 37.3231977, lng: -122.0123423 }`

The existing `extractPlaceId()` remains as a thin wrapper for backward compatibility — calls `parseGoogleMapsUrl` and returns `placeId ?? hexCid`.

### Extraction rules

Place IDs are NOT limited to the `ChIJ` prefix. Google docs list multiple prefixes (`ChIJ`, `GhIJ`, `Eic`, `Iho`, etc.) with no maximum length. The reliable distinction is: Place IDs are base64url strings after `!1s` that are NOT hex CIDs.

| URL segment | Regex | Extracts |
|---|---|---|
| `/place/Caf%C3%A9+LaTTea/` | `/place/([^/@]+)/` | Business name (URI-decoded, `+` → space) |
| `/@37.32,-122.01,17z` | `/@(-?[\d.]+),(-?[\d.]+)` | Latitude, longitude |
| `!1s<base64url>` (not hex) | `!1s([A-Za-z0-9_-]{20,})` after excluding hex CID match | Canonical Place ID (any prefix) |
| `!1s0x...:0x...` | `!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)` | Hex CID |
| `?q=place_id:...` | query param extraction | Canonical Place ID |
| `?placeid=...` | query param extraction | Canonical Place ID (write-review URLs) |

---

## Layer 3: Place ID Resolver (Worker-Side)

### New file: `src/lib/reviews/place-id-resolver.ts`

A utility that takes `GoogleMapsUrlData` and returns a verified canonical Place ID by searching SerpAPI:

```
Resolution strategy (in order):
1. Has canonical Place ID (base64url)? → Return directly (high confidence)
2. Has business name + coordinates? → SerpAPI search (engine=google_maps) with name as query,
   coordinates as ll parameter → match results → return place_id
3. Has business name but no coordinates? → SerpAPI search by name only → match results
4. Nothing useful (no name, no ID)? → Fail with descriptive error
```

**Note:** The hex CID is NOT used as a SerpAPI lookup parameter. SerpAPI's `data` parameter is deprecated and requires a constructed value (data_id + coordinates), not a raw hex string. The `ll` parameter is only a search origin — SerpAPI does not guarantee results are within that area. This is why the coordinate + name matching gate below is critical.

**SerpAPI search call:**
```typescript
const params: Record<string, unknown> = {
  engine: 'google_maps',
  q: businessName,            // "Cafe LaTTea"
  type: 'search',
  api_key: serpApiKey,
};
// ll is a search origin hint, NOT a geographic filter
if (coordinates) {
  params.ll = `@${coordinates.lat},${coordinates.lng},15z`;
}
```

**Result matching (required to compensate for `ll` not being a filter):**
- SerpAPI returns `local_results[]` with `place_id`, `title`, `gps_coordinates`, `address`
- Match by coordinate proximity (haversine distance < 200m) — if coordinates available
- If multiple results within 200m, pick the one whose `title` best matches `businessName` (case-insensitive, normalized whitespace, diacritics stripped via `String.normalize('NFD')`)
- If no coordinates available, match by exact name against the first 3 results only (high false-match risk otherwise)
- If no result passes thresholds, fail with "Could not verify business location — try using the search field instead"
- Return the matched `place_id`

**Cost:** 1 SerpAPI credit per resolution. One-time cost per business — the resolved Place ID is stored and reused for all future polling.

### When the resolver is called

- **PlaceIdValidationWorker**: For businesses onboarded via URL fallback
- **DemoGenerationWorker**: As a pre-step before fetching reviews (inline, no separate outbox topic for demos since they're one-shot)

---

## Layer 4: Validation Gate

### New outbox topic: `validate_place_id`

**New payload type:**
```typescript
interface ValidatePlaceIdPayload {
  business_id: string;
  google_maps_url: string;  // original URL for re-resolution
}
```

**New worker: `PlaceIdValidationWorker`**

1. Read business record
2. Parse URL via `parseGoogleMapsUrl()`
3. If URL contains a ChIJ Place ID directly:
   - Store it, set `place_id_verified = true`
   - Queue `sync_reviews` in the same transaction
   - Done
4. Otherwise, call resolver:
   - On success: update `google_place_id` with canonical ChIJ, set `place_id_verified = true`, queue `sync_reviews`
   - On failure (permanent — no match found): set `place_id_verified = false`, insert `review_exceptions` entry with type `place_id_resolution_failed`, mark outbox failed
   - On failure (transient — SerpAPI down): throw to trigger BullMQ retry

### Database changes

**Migration: `add_place_id_verification.sql`**

```sql
-- Add verification flag (defaults false — forces explicit verification)
ALTER TABLE businesses ADD COLUMN place_id_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- Store original URL for re-resolution if needed
ALTER TABLE businesses ADD COLUMN google_maps_url TEXT;

-- Only verify existing businesses whose google_place_id is a canonical base64url
-- Place ID (starts with a letter, 20+ chars). Do NOT blindly grandfather hex CIDs
-- (0x...:0x...) or other formats — those need resolution via validate_place_id.
UPDATE businesses
SET place_id_verified = TRUE
WHERE google_place_id IS NOT NULL
  AND google_place_id ~ '^[A-Za-z][A-Za-z0-9_-]{19,}$';

-- Queue validate_place_id for existing businesses with hex CIDs or unknown formats.
-- These rows keep place_id_verified = FALSE and will be resolved by the worker.
INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
SELECT
  gen_random_uuid(),
  'validate_place_id',
  'business',
  id,
  jsonb_build_object('business_id', id, 'google_maps_url', ''),
  'pending'
FROM businesses
WHERE google_place_id IS NOT NULL
  AND NOT (google_place_id ~ '^[A-Za-z][A-Za-z0-9_-]{19,}$');

-- Index for ReconciliationPoller filter
CREATE INDEX idx_businesses_verified_active
  ON businesses (subscription_status, place_id_verified)
  WHERE subscription_status = 'active' AND place_id_verified = TRUE;
```

**prospect_demos table:** Add `google_maps_url TEXT` column for the same reason (store original URL).

### ReconciliationPoller change

Add `AND b.place_id_verified = TRUE` to the candidate selection query:

```sql
SELECT b.id, b.google_place_id
FROM businesses b
WHERE b.subscription_status = 'active'
  AND b.google_place_id IS NOT NULL
  AND b.place_id_verified = TRUE
  AND (b.last_sync_at IS NULL OR b.last_sync_at < NOW() - INTERVAL '60 minutes')
```

---

## Layer 5: SerpAPI Source/Monitor Cleanup

Once all identifiers flowing into the system are canonical ChIJ Place IDs:

- **Revert `serpapi-source.ts`**: Remove the `isHexCid` conditional. Always use `place_id` parameter.
- **Revert `serpapi-monitor.ts`**: Same — always `place_id`.
- **Remove `isHexCid()`** from `url-parser.ts` — no longer needed at the SerpAPI call site.

This simplifies the SerpAPI integration back to a single code path.

---

## Flow Diagrams

### Onboarding — Autocomplete Path (happy path)
```
Admin types business name in autocomplete
  → Google returns canonical Place ID
  → Form submits { googlePlaceId, ... }
  → API route validates format (isPlaceId() — rejects hex CIDs and URLs)
  → Stores business with place_id_verified=true
  → Queues sync_reviews directly
  → ReviewSyncWorker checks place_id_verified (defense-in-depth) → fetches reviews
```

### Onboarding — URL Fallback Path
```
Admin pastes Google Maps URL
  → Form submits { googleMapsUrl, ... }
  → API route stores business with place_id_verified=false, stores URL
  → Queues validate_place_id
  → PlaceIdValidationWorker resolves canonical Place ID via SerpAPI search
  → Updates google_place_id + place_id_verified=true
  → Queues sync_reviews
  → ReviewSyncWorker fetches reviews with verified Place ID
```

### Demo Generation
```
Admin uses autocomplete or pastes URL
  → API route stores demo with placeId or URL data
  → Queues generate_demo
  → DemoGenerationWorker:
    - If placeId is ChIJ → use directly
    - If hex CID or URL → resolve via SerpAPI search first
    - Fetch reviews with verified Place ID
    - Generate responses
```

### ReconciliationPoller (production sync)
```
Every 60 minutes:
  → SELECT businesses WHERE active AND place_id_verified=true AND stale
  → Queue sync_reviews for each
  → ReviewSyncWorker uses stored canonical Place ID
  → Zero wasted SerpAPI credits
```

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Autocomplete used | Server validates format with `isPlaceId()`. Rejects hex CIDs/URLs. `place_id_verified = true` only after validation. |
| URL contains ChIJ | Validation worker sets `place_id_verified = true` immediately. |
| URL contains hex CID | Resolver searches by name + coords. 1 SerpAPI credit. |
| URL contains no ID | Resolver searches by name + coords. 1 SerpAPI credit. |
| SerpAPI search finds no match | `place_id_verified = false`, exception logged, admin can retry or use autocomplete. |
| SerpAPI down during validation | BullMQ retries with backoff (transient error). |
| Ambiguous search results | Match by coordinate proximity (< 200m) + name similarity. Fail if no confident match. |
| Shortened URL (maps.app.goo.gl) | No ID, no coords, no name extractable. Fail with clear error suggesting autocomplete or full URL. |

---

## GBP API Migration Path

When Google Business Profile API access is approved:

1. **Place Autocomplete stays** — same widget, same canonical Place IDs
2. **Resolver swaps implementation** — `SerpAPI search` → `Google Places API (Find Place)` for URL fallback resolution. Same interface, same flow.
3. **Validation worker stays** — same outbox topic, same verified flag
4. **SerpAPI sources swap** — `engine=google_maps_reviews` → GBP API reviews endpoint. The `place_id` parameter is the same canonical format Google uses everywhere.

The `place_id_verified` flag and `google_maps_url` column remain useful throughout.

---

## What Changes, What Doesn't

| Component | Change |
|---|---|
| `PlaceAutocomplete.tsx` | **New** — reusable Google Maps autocomplete component |
| `url-parser.ts` | Add `parseGoogleMapsUrl()` returning `GoogleMapsUrlData` |
| `place-id-resolver.ts` | **New** — SerpAPI search-based resolution |
| `PlaceIdValidationWorker` | **New** — outbox consumer for `validate_place_id` |
| `worker-types.ts` | Add `ValidatePlaceIdPayload` |
| `queues.ts` | Add `VALIDATE_PLACE_ID` queue + topic mapping |
| `worker/index.ts` | Register new worker + queue |
| `src/app/api/admin/jobs/route.ts` | Add `'validate_place_id'` to local `QUEUE_NAMES` list (line 9) |
| `schemas.ts` | Update `OnboardBusinessSchema` to accept either autocomplete or URL input |
| Onboarding form | Replace URL input with autocomplete + URL fallback toggle |
| Onboarding API route | Handle both input modes, conditionally queue validation |
| Demo form | Same — autocomplete + URL fallback |
| Demo API route | Handle both input modes, pass URL data in payload |
| `DemoGenerationWorker` | Add resolver pre-step for non-ChIJ IDs |
| `ReconciliationPoller` | Add `place_id_verified = TRUE` filter |
| `serpapi-source.ts` | Revert to always `place_id` (no more `isHexCid` conditional) |
| `serpapi-monitor.ts` | Same revert |
| `ReviewSyncWorker` | Add `place_id_verified` defensive guard (see below) |
| DB migration | Add `place_id_verified`, `google_maps_url` columns; smart grandfathering |

### Defensive guard in ReviewSyncWorker

Add a check early in `handleReviewSync()` after loading the business record:

```typescript
if (!business.place_id_verified) {
  console.warn(`${LOG_PREFIX} Business ${business_id} place_id not verified, skipping`);
  await markOutboxCompleted(outboxId);
  return;
}
```

This prevents stale `sync_reviews` jobs (queued before the migration or by a race condition) from polling SerpAPI with an unverified identifier. The ReconciliationPoller filter is the primary gate, but this is defense-in-depth at the worker level.

### What doesn't change
- OutboxPoller, BullMQ infrastructure, approval flow, notification flow, response generation, weekly summaries, archival — all untouched.
- The `reviews`, `responses`, `approval_links` tables — untouched.
- Mock mode — `MockReviewSource` and `MockMonitor` bypass all of this.

---

## Environment Requirements

| Variable | Purpose | Required |
|---|---|---|
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Maps JavaScript API key for Place Autocomplete | Yes (for autocomplete path) |
| `SERPAPI_API_KEY` | Already exists — used by resolver for URL fallback | Yes (already configured) |

The Google Maps API key needs:
- **Maps JavaScript API** enabled
- **Places API (New)** enabled
- **Application restriction**: HTTP referrer restricted to the app's domain(s)
- **API restriction**: Maps JavaScript API + Places API only
