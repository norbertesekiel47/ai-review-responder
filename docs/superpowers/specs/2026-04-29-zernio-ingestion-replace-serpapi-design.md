# Zernio Review Ingestion — Replace SerpAPI Polling

**Date:** 2026-04-29
**Author:** Norbert (with Claude Code)
**Status:** Draft v19 (round-final-4 — last manual-post test fixture cleanup)
**Related migrations:** 028 (zernio_backfill_runs table) and 029 (drop_awaiting_manual_post — terminate orphan rows + rebuild non-terminal uniqueness index without dead status + drop migration-024's stale `notification_deliveries_response_template_uniq` index). **Apply order: 028 BEFORE 029** — 029's index rebuild references the migration-026 `responses_one_non_terminal_per_review` index, and the surrounding workflow assumes 028 has already shipped the backfill table.
**Related specs:** `2026-04-27-zernio-integration-design.md` (Phase 0 — publishing, shipped in PR #9)

---

## 1. Motivation

The SerpAPI `ReconciliationPoller` runs every 60 minutes per active business. With current pricing (~$50 per 5,000 SerpAPI searches), each business consumes ~720 calls/month for review polling alone. At 7 active customers we already brush the next pricing tier; cost scales linearly with the customer base.

PR #9 shipped Phase 0 of the Zernio integration: connect flow, publishing, and webhook ingress with `account.disconnected` handling. That PR also wired the webhook handler to receive `review.new` and `review.updated` — but the handler currently just `INCRBY`s a counter (`worker/ingress/zernio.ts:185-193`). Zernio is already pushing real-time review events to our worker; we just throw them away.

Switching ingestion to Zernio webhooks removes the need to poll Google externally. It also lets `lookupZernioReviewId` in `zernio-publisher.ts` short-circuit the field-match dance for new rows — once `provider='zernio'` and `provider_review_id` IS the canonical Zernio review id, we can post replies directly without an extra `listReviews` round-trip.

This spec hard-replaces SerpAPI for production review ingestion. SerpAPI remains in the codebase for two narrow uses: (a) prospect demo generation in `DemoGenerationWorker`, and (b) onboarding form prefill (`serpapi-prefill.ts`) which provides rich business metadata that Zernio doesn't expose. `place-id-resolver.ts` also continues to use SerpAPI for URL→placeId fallback at onboarding time.

## 2. Non-goals

- `DemoGenerationWorker` keeps `SerpApiSource`. Prospect demos don't have a Zernio connection by definition.
- `serpapi-prefill.ts` is unchanged — onboarding form rich data continues to use SerpAPI.
- `RankingTrackingWorker` is unchanged — search-ranking tracking is unrelated to review ingestion.
- No Zernio reconciliation backstop poller in v1. Spec §4.5 documents the deferred-by-design choice and the escape hatch if missed-event rate becomes a real problem.
- No notification batching / digest engineering. The first-connect notification problem is solved by suppression, not batching (§4.6).

## 3. Goals

1. Eliminate the hourly SerpAPI poll per active business.
2. Ingest reviews via Zernio webhook events (`review.new`, `review.updated`) using a fetch-on-event pattern that does not depend on the webhook payload shape and is robust against eventual-consistency at Zernio.
3. On first Zernio connect, run a tier-aware backfill so paying customers don't see an empty dashboard. Backfilled responses are surfaced in-dashboard but suppress approval emails (§4.6) — the owner is on the dashboard the moment they click Connect Google.
4. Wire up the existing `'premium'` tier (already in cost limits + type unions but never end-to-end). Add `STRIPE_PAYMENT_LINK_PREMIUM` + `STRIPE_PRICE_PREMIUM` env vars and thread `'premium'` through the eight locations identified in §6.10.
5. Use the existing `businesses.subscription_activated_at` column (added in migration 014, already written write-once at `worker/ingress/stripe.ts:105`) as the "purchase moment" anchor for backfill bucket cutoff. No new column needed.
6. Keep all changes behind the existing `ZERNIO_PUBLISHING_ENABLED` flag. No new flag.

## 4. Architecture

### 4.1 Three buckets at connect time

When an owner first connects Zernio, reviews fetched from `listAllReviews` split into three buckets based on `createTime` and `subscription_activated_at`:

| Bucket | Filter | Tier eligibility | Cap |
|---|---|---|---|
| Historical | `createTime < subscription_activated_at` AND `reviewReply === null` | Premium tier only | 50 |
| Gap | `createTime >= subscription_activated_at` AND `reviewReply === null` | All tiers | 25 |
| Future | Arrives after connect | All tiers (via webhook) | unbounded |

Reviews are sorted by `createTime DESC` BEFORE the cap is applied, so the most recent N within each bucket is what we keep — the `slice(0, N)` is no longer order-dependent.

The gap bucket is always processed regardless of tier — the customer paid for the gap window. The historical bucket is the premium-tier upsell. Each bucket has an independent cap; total backfill work per business is bounded by 75 reviews (premium) or 25 (founding/standard).

Reviews already replied to by the owner on Google (`reviewReply !== null`) are skipped in both backfill buckets — RepWorth doesn't generate drafts for already-handled reviews.

### 4.2 Webhook-driven steady state

After connect, ingestion runs entirely off Zernio webhooks:

```
Zernio fires review.new / review.updated
        ↓
worker/ingress/zernio.ts (existing route)
  1. ZERNIO_PUBLISHING_ENABLED check (existing)
  2. HMAC signature verify (existing)
  3. claim inbound_event for dedup (existing)
  4. Look up ALL active zernio_connections rows by zernio_account_id  ←── §4.3
  5. For each matching connection: INSERT job_outbox topic='ingest_zernio_review'
        payload={ business_id, zernio_account_id, zernio_location_id, zernio_review_id, correlation_id }
  6. 200 OK
        ↓
OutboxPoller dispatches → BullMQ → ZernioReviewIngestWorker (NEW)
  1. extractOutboxHandle + correlation logger
  2. Subscription guard (skip when cancelled / past_due grace expired / pending_payment)
  3. Verify zernio_connections row still active for (business_id, location_id)
  4. Mock-mode short-circuit (markOutboxCompleted + return) so local dev doesn't
     burn retries / generate spurious review_exceptions
  5. zernioClient.listReviews(accountId, { locationId, pageSize: 50 }) — walk up to 2 pages
  6. If not found in 100 reviews → throw ZernioIngestReviewNotFoundError →
     BullMQ retries → on exhaustion the ingest-worker on('failed') hook (§6.5)
     escalates to review_exceptions type='zernio_review_not_found' + markOutboxFailed
  7. Verify review.name's location segment:
       missing/unparseable → throw ZernioIngestUnparseableLocationError →
         on retry exhaustion the on('failed') hook escalates to
         review_exceptions type='zernio_unparseable_review_name' + admin notify
       parses but ≠ payload.zernio_location_id → no-op (review for sibling business)
       parses == payload.zernio_location_id → continue
  8. If target.reviewReply !== null → reconcileExternallyAnsweredReview (§6.3b),
     return without ingesting (the customer replied via Google directly)
  9. Build MonitoredReview via zernio-normalize.ts
       throws ZernioReviewNormalizationError (per-review malformed) →
         markOutboxCompleted with warning (no point retrying)
  10. Call processReview(monitored, business_id, correlation_id)
  11. markOutboxCompleted
```

The fetch-on-event pattern decouples us from Zernio's webhook payload shape. The current handler doesn't decode the payload at all (just counts events), and the payload format is not part of our integration contract today. Spending one Zernio API call per webhook is cheap (review events are sparse: ~5-15/business/month) and removes a class of bugs.

The `ZernioReviewNotFoundError` → transient-retry behavior addresses the case where a webhook arrives faster than `listReviews` consistency. After BullMQ exhausts retries (default policy), the outbox row is marked failed AND a `review_exceptions` row is written so ops can investigate. We do NOT silently skip — that was the round-1 bug.

### 4.3 Account-id non-uniqueness fan-out

`zernio_connections.zernio_account_id` is documented non-unique by design (`worker/ingress/zernio.ts:41-44`): the same Google account CAN be connected to multiple Zernio profiles owned by the same operator across multiple RepWorth businesses. The `account.disconnected` handler already fans out to all matching businesses; the new `review.new` / `review.updated` handler must do the same.

Webhook handler:

```ts
// Fan out — one outbox row per active connection. Ingest worker filters
// by location to keep the right review with the right business.
await tx`
  INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
  SELECT
    gen_random_uuid(),
    'ingest_zernio_review',
    'business',
    zc.business_id,
    jsonb_build_object(
      'business_id', zc.business_id,
      'zernio_account_id', ${accountId},
      'zernio_location_id', zc.zernio_location_id,
      'zernio_review_id', ${reviewId},
      'correlation_id', ${eventId}
    ),
    'pending'
  FROM zernio_connections zc
  WHERE zc.zernio_account_id = ${accountId}
    AND zc.status = 'active'
`;
```

The ingest worker then matches the fetched review's `name` (Zernio format `accounts/{accountId}/locations/{locationId}/reviews/{reviewId}`) against the payload's `zernio_location_id`. Mismatches → no-op (the review belongs to a sibling business's location). Matches → process via `processReview`.

This pattern is wasteful in the typical case (one connection per account) but correct in the edge case. Cost: one extra `listReviews` call per account-sharing fan-out target. Acceptable.

### 4.4 Identity strategy

```
provider              = 'zernio'
provider_review_id    = <Zernio review.id>            -- canonical, stable across edits
provider_review_name  = 'zernio://{accountId}/locations/{locationId}/reviews/{reviewId}'
provider_location_name = 'zernio://{accountId}/locations/{locationId}'
identityStrategy      = 'zernio_id'                   -- new value in the union
```

The `provider_review_name` and `provider_location_name` include the location segment, so two businesses sharing an account but different locations get distinct identity tuples even if Zernio ever returns the same review.id across locations (defense-in-depth — not expected in practice).

The existing `(provider, provider_review_name)` UNIQUE constraint at `supabase/migrations/001_initial_schema.sql:181` continues to enforce dedup. Zernio's review.id is documented stable across reviewer edits, so content-hash comparison continues to detect edits without identity churn.

### 4.5 No reconciliation poller (v1)

Zernio's webhook delivery contract is 7 retries over 51 hours. The combination of Zernio outage + RepWorth worker outage exceeding that window is the only failure mode that drops events. We accept this risk for v1 because:

- Reviewer edits naturally fire `review.updated`, providing organic backstop for missed `review.new` events.
- The `ZernioReviewNotFoundError` → retry → review_exceptions path catches eventual-consistency races.
- A single missed event has low business impact (the review still exists on Google; it's just not in our queue until the customer manually re-syncs or upgrades to receive a future cycle).

If missed-event rate becomes a problem, a `ZernioReconciliationPoller` calling `listReviews` every 6 hours per active connection is a straightforward future addition. Cost would be ~4 calls/business/day (~120/month) — still 6× cheaper than SerpAPI's 720/month. Not built today.

### 4.6 Backfill notification suppression

The existing `NotificationWorker` fires one approval email per `pending_approval` response. A first-connect backfill of up to 75 responses would produce a 75-email blast — actively bad UX even though the architecture would handle it.

**Resolution: skip the `send_notification` outbox enqueue entirely for backfill-sourced responses.** No `notification_deliveries` row is written. The response sits in `pending_approval` and is visible in the dashboard. The owner is on the dashboard the moment they finish the Zernio connect flow (`/dashboard/connect/select-location` redirects there); they see the queue immediately. Webhook-arriving reviews after connect resume normal email-per-review.

**Why no row is needed:** `NotificationFailoverPoller` (`worker/jobs/NotificationFailoverPoller.ts:152-167, 260-265`) gates both the all-failed and stale branches on `EXISTS (notification_deliveries WHERE response_id = X AND template = 'approval_request')`. If no row exists, EXISTS=false, the response is skipped — no false-positive admin alerts, no re-fire.

**Why we don't need a schema change:** the original v2 spec proposed `notification_deliveries.status='suppressed'`, but the table has no `status` column and `recipient TEXT NOT NULL`. Round-2 review caught this. Skipping the enqueue altogether is simpler and uses no new schema.

The `suppress_notification` flag rides through:
1. `zernio_initial_backfill` outbox payload (set true at enqueue time).
2. `ZernioBackfillWorker` → propagates into the `processReview` call.
3. `processReview` → propagates into the `generate_response` outbox payload.
4. `ResponseGeneratorWorker` → reads the flag; if true, **does NOT enqueue the `send_notification` outbox row.** Response stays in `pending_approval`. No further side-effects.

Two changes to existing types: `GenerateResponsePayload` adds `suppress_notification?: boolean`. `ResponseGeneratorWorker` reads the flag and gates the enqueue. NO `NotificationWorker` change — it never sees the flag because no outbox row is created.

## 5. Schema changes (migration 028)

```sql
-- supabase/migrations/028_zernio_backfill_runs.sql
--
-- Persists per-business summary of the one-shot Zernio first-connect backfill
-- so the dashboard can render reliable "X older reviews skipped" messaging
-- without dashboard-time Zernio API calls. Replaces the unreliable
-- "compare response count vs total Zernio reviews" approach.

CREATE TABLE IF NOT EXISTS zernio_backfill_runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  zernio_account_id        TEXT NOT NULL,
  zernio_location_id       TEXT NOT NULL,
  subscription_tier        TEXT NOT NULL,                  -- snapshot at backfill time
  subscription_activated_at TIMESTAMPTZ NOT NULL,           -- snapshot at backfill time

  -- Bucket counts (what we processed)
  gap_processed_count       INTEGER NOT NULL DEFAULT 0,
  historical_processed_count INTEGER NOT NULL DEFAULT 0,

  -- Cap-skip counts (what we did NOT process due to tier/cap limits)
  gap_skipped_count         INTEGER NOT NULL DEFAULT 0,    -- gap reviews beyond cap=25
  historical_skipped_count  INTEGER NOT NULL DEFAULT 0,    -- premium-only; non-premium = total historical
  oldest_skipped_create_time TIMESTAMPTZ,                  -- for "older than [date]" copy

  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One backfill run per business (the predicate guard in the connect callback
-- ensures it fires only on first activation; this index is defense-in-depth).
CREATE UNIQUE INDEX IF NOT EXISTS zernio_backfill_runs_one_per_business
  ON zernio_backfill_runs (business_id);

ALTER TABLE zernio_backfill_runs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE zernio_backfill_runs IS
  'Per-business summary of Zernio first-connect backfill. Dashboard reads '
  'skipped counts to render "X older reviews skipped" messaging. Tier and '
  'subscription_activated_at are snapshotted to make the row self-contained.';
```

**No `subscription_active_since` column added** — `businesses.subscription_activated_at` already exists (migration 014 line 69), is already written write-once via `COALESCE` in `worker/ingress/stripe.ts:105`, and is already used by `OnboardingDripWorker`. The original spec proposed a duplicate column; this revision uses the existing one.

The `subscription_tier` column already exists. The `'premium'` value is already conceptually allowed (cost limits in `tracker.ts:44` reference it; column comment in migration 001 line 89 lists it). Wiring it through schemas + UI + payment-link map is application-layer work (§6.10), not migration work.

## 6. Components

### 6.0 `zernioClient.listReviews` / `listAllReviews` — add `locationId` parameter

Current signature at `src/lib/zernio/client.ts:249-276`:

```ts
listReviews: (accountId, { pageSize?, pageToken? })
listAllReviews: (accountId, { pageSize, maxPages })
```

Without a `locationId` filter, Zernio's Get Reviews API uses the account's selected/default location. In the same-account-multi-location case (which the fan-out architecture in §4.3 must handle), this means location B's webhook would trigger a `listReviews` call that returns location A's reviews — the worker would never find the target review and would escalate to `review_exceptions`.

**Update both methods to accept and pass `locationId`:**

```ts
listReviews: (
  accountId: string,
  input: { locationId: string; pageSize?: number; pageToken?: string },
) =>
  request<{ reviews: ZernioReview[]; nextPageToken?: string }>({
    method: 'GET',
    path: `/v1/accounts/${encodeURIComponent(accountId)}/gmb-reviews?locationId=${encodeURIComponent(input.locationId)}&pageSize=${input.pageSize ?? 50}${input.pageToken ? `&pageToken=${encodeURIComponent(input.pageToken)}` : ''}`,
    endpointKind: 'list_reviews',
    timeoutMs: 15_000,
  }),

listAllReviews: async (
  accountId: string,
  opts: { locationId: string; pageSize: number; maxPages: number },
): Promise<ZernioReview[]> => {
  const all: ZernioReview[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < opts.maxPages; i++) {
    const page = await zernioClient.listReviews(accountId, {
      locationId: opts.locationId,
      pageSize: opts.pageSize,
      pageToken,
    });
    all.push(...page.reviews);
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return all;
},
```

**The exact query-param name is `locationId` per Zernio's Get Reviews docs as of 2026-04-29 — implementer MUST verify against the current Zernio docs before merging.** If the param name differs (e.g. `location_id`, `location`), adjust the URL string accordingly. If Zernio doesn't expose location filtering on this endpoint, fall back to client-side filtering by `extractLocationFromReviewName(z.name)` (already implemented in `zernio-normalize.ts`); cost is one extra page-fetch in the multi-location case.

**Existing callers of `listAllReviews`:** `src/lib/publishing/zernio-publisher.ts:63-66` (the legacy field-match path). Update it to pass `locationId` from the active connection. The early-return path (§6.11) already short-circuits the field-match for `provider='zernio'` rows; the legacy SerpAPI-row path remains the only consumer.

**Existing callers of `listReviews`:** none in production code today (only used internally by `listAllReviews`); the new ingest worker is the first direct consumer.

**Mock mode:** `src/lib/zernio/client.ts:199-201` returns `{ reviews: [], nextPageToken: undefined }` for `list_reviews` — unchanged. The new locationId param is ignored in mock.

### 6.1 Removed: `ZernioReviewSource` class

The original spec proposed a `ZernioReviewSource implements ReviewSource` class. Dropped. The `ReviewSource.fetchReviews(placeId)` interface was useful when SerpApi and a future GBP source needed to be swappable, but `placeId` is meaningless for Zernio (which scopes by accountId + locationId), making it a leaky abstraction.

Both the ingest worker and the backfill worker call `zernioClient` directly. The interface stays for `SerpApiSource` (still used by `DemoGenerationWorker`).

### 6.2 New module — `src/lib/reviews/zernio-normalize.ts`

```ts
import { detectLanguage } from './detect-language';
import { computeContentHash } from './types';
import type { MonitoredReview, NormalizedReview } from './types';
import type { ZernioReview } from '@/lib/zernio/types';

const LOG_PREFIX = '[zernio-normalize]';

export class ZernioReviewNormalizationError extends Error {
  constructor(reason: string, readonly raw: unknown) {
    super(`${LOG_PREFIX} ${reason}`);
    this.name = 'ZernioReviewNormalizationError';
  }
}

export function zernioReviewToNormalized(z: ZernioReview): NormalizedReview {
  if (!z.id || typeof z.id !== 'string' || z.id.trim().length === 0) {
    throw new ZernioReviewNormalizationError('missing review.id', z);
  }
  if (typeof z.rating !== 'number' || z.rating < 1 || z.rating > 5) {
    throw new ZernioReviewNormalizationError(`invalid rating: ${z.rating}`, z);
  }
  if (!z.createTime || isNaN(new Date(z.createTime).getTime())) {
    throw new ZernioReviewNormalizationError(`unparseable createTime: ${z.createTime}`, z);
  }

  const reviewerName = (z.reviewer?.displayName ?? '').trim() || 'Anonymous';
  const reviewText = (z.comment ?? '').trim() || null;

  const review: NormalizedReview = {
    reviewerName,
    starRating: z.rating,
    reviewText,
    reviewDate: z.createTime,
    detectedLanguage: detectLanguage(reviewText),
  };
  return review;
}

export function buildZernioMonitoredReview(
  z: ZernioReview,
  accountId: string,
  locationId: string,
): MonitoredReview {
  const review = zernioReviewToNormalized(z);
  return {
    review,
    identity: {
      provider: 'zernio',
      providerReviewId: z.id,
      providerReviewName: `zernio://${accountId}/locations/${locationId}/reviews/${z.id}`,
      providerLocationName: `zernio://${accountId}/locations/${locationId}`,
      identityStrategy: 'zernio_id',
    },
    contentHash: computeContentHash(review),
  };
}
```

Per-review validation throws `ZernioReviewNormalizationError`; the ingest + backfill workers catch it per review (matching SerpAPI's per-review isolation in `serpapi-monitor.ts:78-92`) so one malformed review doesn't abort a batch.

Also extract Zernio's location id from the review's `name` field (format `accounts/{a}/locations/{l}/reviews/{r}`) helper:

```ts
export function extractLocationFromReviewName(name: string): string | null {
  const m = name.match(/^accounts\/[^/]+\/locations\/([^/]+)\/reviews\/.+$/);
  return m ? m[1] : null;
}
```

### 6.3 New worker — `worker/jobs/ZernioReviewIngestWorker.ts`

Handles `ingest_zernio_review`. Pseudocode with explicit error handling:

```ts
// Local error classes so the BullMQ onFailed hook can reliably distinguish
// retry-exhausted ingest failures from generic Errors and escalate the right
// review_exceptions type.
export class ZernioIngestReviewNotFoundError extends Error {
  constructor(
    readonly businessId: string,
    readonly zernioAccountId: string,
    readonly zernioLocationId: string,
    readonly zernioReviewId: string,
  ) {
    super(`Zernio review ${zernioReviewId} not found in latest 100 — retrying`);
    this.name = 'ZernioIngestReviewNotFoundError';
  }
}

// Round-final-review M1 fix: previously the unparseable-location case threw
// a bare Error which fell through to the generic onFailed `markOutboxFailed`
// after retry exhaustion — silent failure with no admin trail. A typed class
// + dedicated onFailed branch escalates to review_exceptions cleanly.
export class ZernioIngestUnparseableLocationError extends Error {
  constructor(
    readonly businessId: string,
    readonly zernioAccountId: string,
    readonly zernioLocationId: string,
    readonly zernioReviewId: string,
    readonly reviewName: string,  // truncated to first 200 chars for safety
  ) {
    super(`Unparseable Zernio review.name: ${reviewName.slice(0, 200)}`);
    this.name = 'ZernioIngestUnparseableLocationError';
  }
}

export async function handleZernioReviewIngest(job: Job<IngestZernioReviewPayload>) {
  const logger = createWorkerLogger('[ZernioReviewIngestWorker]', job.data.correlation_id);
  const { business_id, zernio_account_id, zernio_location_id, zernio_review_id } = job.data;
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);

  // 1. Subscription guard
  const [biz] = await sql`
    SELECT subscription_status, updated_at FROM businesses WHERE id = ${business_id}
  `;
  if (!biz || !checkSubscription(biz.subscription_status, biz.updated_at, 'generator').allowed) {
    return markOutboxCompleted(outboxId, attempt);
  }

  // 2. Verify the connection still exists at the same location
  const [conn] = await sql`
    SELECT id FROM zernio_connections
    WHERE business_id = ${business_id}
      AND zernio_account_id = ${zernio_account_id}
      AND zernio_location_id = ${zernio_location_id}
      AND status = 'active'
  `;
  if (!conn) {
    logger.warn(`Connection mismatch — skipping`);
    return markOutboxCompleted(outboxId, attempt);
  }

  // 3. Mock-mode short-circuit — prevents spurious retries / review_exceptions
  // in local dev where zernioClient.listReviews always returns []. Without
  // this, every dev event would burn through BullMQ retries and escalate.
  if (process.env.MOCK_EXTERNAL_APIS === 'true') {
    logger.log(`Mock mode — short-circuiting ingest for ${zernio_review_id}`);
    return markOutboxCompleted(outboxId, attempt);
  }

  // 4. Fetch + locate the review (up to 2 pages = 100 reviews). Scope by
  // locationId so same-account-multi-location fan-out targets the right
  // GBP location (per §6.0).
  let target: ZernioReview | undefined;
  let pageToken: string | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      const page = await zernioClient.listReviews(zernio_account_id, {
        locationId: zernio_location_id,
        pageSize: 50,
        pageToken,
      });
      target = page.reviews.find(r => r.id === zernio_review_id);
      if (target) break;
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
  } catch (err) {
    return handleZernioIngestError(err, outboxId, attempt, { business_id, zernio_account_id, zernio_location_id }, logger);
  }

  if (!target) {
    // Eventual-consistency race or the review was deleted at Zernio. Throw the
    // dedicated error class so the BullMQ onFailed hook can identify it after
    // retry exhaustion and escalate to review_exceptions (see §6.5). Generic
    // Errors are indistinguishable from network/DB blips and would not be
    // safe to escalate.
    throw new ZernioIngestReviewNotFoundError(
      business_id, zernio_account_id, zernio_location_id, zernio_review_id,
    );
  }

  // 5. Verify location match — FAIL CLOSED on missing/unparseable location.
  // If Zernio's review.name shape drifts and we can't extract a location,
  // we MUST refuse to process — otherwise fan-out across same-account-multi-
  // location businesses would ingest the same review into every business.
  const reviewLocationId = extractLocationFromReviewName(target.name);
  if (!reviewLocationId) {
    logger.error(`Review ${zernio_review_id} name has unparseable location: ${target.name}`);
    // Throw the typed class so the ingest-worker onFailed hook (§6.5) can
    // escalate to review_exceptions on retry exhaustion. Bare Error would
    // fall through to generic markOutboxFailed with no admin trail.
    throw new ZernioIngestUnparseableLocationError(
      business_id, zernio_account_id, zernio_location_id, zernio_review_id, target.name,
    );
  }
  if (reviewLocationId !== zernio_location_id) {
    logger.log(`Review belongs to different location (${reviewLocationId} vs ${zernio_location_id}) — no-op`);
    return markOutboxCompleted(outboxId, attempt);
  }

  // 6. External-reply reconciliation (per §6.3b).
  // If Zernio reports the review already has a reviewReply, the customer
  // (or a teammate) replied via Google directly. We must NOT generate a draft
  // for it AND we must supersede any pending local draft, otherwise the
  // publisher's `ZernioReplyAlreadyExistsError` 409 path at
  // `worker/jobs/ResponsePublisherWorker.ts:278-292` would mark our (different,
  // unreviewed) draft as 'posted' — actively wrong.
  if (target.reviewReply !== null) {
    await reconcileExternallyAnsweredReview(
      target, business_id, zernio_account_id, zernio_location_id, logger,
    );
    return markOutboxCompleted(outboxId, attempt);
  }

  // 7. Process via existing pipeline
  let monitored: MonitoredReview;
  try {
    monitored = buildZernioMonitoredReview(target, zernio_account_id, zernio_location_id);
  } catch (err) {
    if (err instanceof ZernioReviewNormalizationError) {
      logger.warn(`Skipping malformed review ${zernio_review_id}: ${err.message}`);
      return markOutboxCompleted(outboxId, attempt);
    }
    throw err;
  }

  await processReview(monitored, business_id, job.data.correlation_id);
  await markOutboxCompleted(outboxId, attempt);
}
```

### 6.3b External-reply reconciliation — `reconcileExternallyAnsweredReview`

Lives in `worker/jobs/zernio-ingest-shared.ts` alongside `handleZernioIngestError`. Called from both ingest worker and backfill worker when a fetched Zernio review has `reviewReply !== null`.

```ts
export async function reconcileExternallyAnsweredReview(
  target: ZernioReview,
  businessId: string,
  accountId: string,
  locationId: string,
  logger: WorkerLogger,
): Promise<void> {
  const providerReviewName = `zernio://${accountId}/locations/${locationId}/reviews/${target.id}`;
  const targetCreatedAtMs = new Date(target.createTime).getTime();
  const targetReviewerName = target.reviewer.displayName.trim() || 'Anonymous';
  const targetComment = (target.comment ?? '').trim();

  await sql.begin(async (tx) => {
    // Lock + look up local review rows that could correspond to this physical
    // Google review. We check TWO populations:
    //
    //   1. provider='zernio' rows by exact identity (the new path).
    //   2. provider='serpapi_poll' legacy rows for this business by field-match.
    //
    // Why both: the publisher's field-match path (zernio-publisher.ts) still
    // supports legacy SerpAPI rows. If the customer replies externally to a
    // review that has an active SerpAPI-sourced draft, the publisher's 409
    // handler at ResponsePublisherWorker.ts:278-292 would mark our (different)
    // draft as 'posted' on next publish attempt — wrong. By superseding here
    // BEFORE publish ever runs, we close that gap.
    //
    // Field-match is a heuristic, intentionally narrow:
    //   - reviewer name exact (after trim)
    //   - star rating exact
    //   - review text exact (after trim) — the publisher uses the same key
    //   - createTime within ±24h (mirrors zernio-publisher.ts:75 MATCH_WINDOW_MS)
    //
    // False positives risk: two SerpAPI rows from the same reviewer with the
    // same text/rating within 24h are vanishingly rare. False negatives are
    // recoverable — the publisher's field-match would still 404 cleanly later.
    //
    // Legacy population is bounded — the v3 architecture stops producing
    // SerpAPI rows after cutover. Per CLAUDE.md, prod has zero customer data
    // today, so legacy rows in prod are also zero. This branch defends against
    // dev/staging fixtures and any in-flight rows at flag-flip time.

    const matchedRows = await tx<{ id: string; provider: string }[]>`
      SELECT id, provider FROM reviews
      WHERE business_id = ${businessId}
        AND (
          (provider = 'zernio' AND provider_review_name = ${providerReviewName})
          OR (
            provider = 'serpapi_poll'
            AND reviewer_name = ${targetReviewerName}
            AND star_rating = ${target.rating}
            AND COALESCE(NULLIF(trim(review_text), ''), '') = ${targetComment}
            AND ABS(EXTRACT(EPOCH FROM (review_date - to_timestamp(${targetCreatedAtMs} / 1000.0)))) < 86400
          )
        )
      FOR UPDATE
    `;

    if (matchedRows.length === 0) {
      logger.log(`External reply on previously-unseen review ${target.id} — not ingesting`);
      return;
    }

    // CRITICAL — distinguish "our reply" from "external reply".
    //
    // Zernio's `review.updated` event fires when a reply is added via the
    // Zernio API too. So when our ResponsePublisherWorker successfully posts
    // a reply, Zernio almost immediately fires review.updated. If this
    // helper supersedes responses based on `reviewReply !== null` alone, we
    // would race the publisher's status='posted' UPDATE and could mark our
    // own just-posted draft as 'superseded — already_replied_external'.
    //
    // Defense: load active responses' approved_text and compare to the
    // reply Zernio is reporting. If any active response's approved_text
    // (after trim) equals the Zernio-reported reply (after trim), this is
    // OUR reply — no-op and let the publisher's posted-update run normally.
    //
    // For pending_approval responses (approved_text is NULL by definition),
    // it cannot be our reply — we have not posted them yet. Any pending_approval
    // that exists when we observe an external reply IS stale and should be
    // superseded.
    const reviewIds = matchedRows.map(r => r.id);
    const externalReplyText = canonicalizeReplyText(target.reviewReply?.comment);  // §6.10d

    const activeResponses = await tx<{
      id: string;
      status: string;
      approved_text: string | null;
    }[]>`
      SELECT id, status, approved_text
      FROM responses
      WHERE review_id = ANY(${reviewIds}::uuid[])
        AND status IN ('pending_approval', 'approved', 'edited',
                       'awaiting_owner_connect')
    `;
    // NOTE: 'awaiting_manual_post' was deliberately dropped per §6.12b
    // (manual-post fallback decommissioned). This SQL must NOT include it
    // — that's a hard requirement of the §13 grep acceptance criterion.

    if (activeResponses.length === 0) {
      logger.log(`External reply detected but no active responses for review row(s) ${reviewIds.join(',')} — no-op`);
      return;
    }

    // Identify "our reply" matches: any approved/edited response whose
    // approved_text canonicalizes to the same string as the external reply.
    // canonicalizeReplyText (§6.10d) handles CRLF / Unicode-form / whitespace
    // normalization that round-tripping through Zernio + Google can introduce.
    const protectedIds = new Set(
      activeResponses
        .filter(r =>
          r.approved_text !== null &&
          canonicalizeReplyText(r.approved_text) === externalReplyText &&
          // pending_approval has approved_text=NULL by invariant; this filter
          // is a defensive belt-and-suspenders check.
          r.status !== 'pending_approval',
        )
        .map(r => r.id),
    );

    // Supersede every active response EXCEPT the ones that match (those
    // are our just-posted reply; the publisher will mark them posted).
    //
    // CRITICAL: do NOT early-return on protectedIds.size > 0. In the mixed
    // legacy/Zernio case (one zernio row with our matching reply + one
    // legacy serpapi_poll row with a different stale draft), early-return
    // would leave the stale draft active forever. Compute the set, supersede
    // only the unprotected ones.
    const supersedeIds = activeResponses
      .filter(r => !protectedIds.has(r.id))
      .map(r => r.id);

    if (supersedeIds.length === 0) {
      logger.log(
        `External reply matches every active response's approved_text ` +
        `(${protectedIds.size}) — likely our publish; no supersession`,
      );
      return;
    }

    const supersededRows = await tx`
      UPDATE responses
      SET status = 'superseded',
          posting_error = 'already_replied_external',
          updated_at = NOW()
      WHERE id = ANY(${supersedeIds}::uuid[])
      RETURNING id
    `;

    if (supersededRows.count > 0) {
      const providers = matchedRows.map(r => r.provider).join(',');
      logger.log(
        `Superseded ${supersededRows.count} active response(s) across ` +
        `${matchedRows.length} review row(s) [${providers}] because customer ` +
        `replied externally on Google. Protected ${protectedIds.size} ` +
        `matching response(s) (our reply).`,
      );
    }
  });
}
```

The supersession is silent — no admin notification. The customer chose to reply outside RepWorth; that's normal usage. If we later add a "responses superseded by external reply" weekly summary metric, this is the source.

**Defense in depth — both this helper AND the publisher's 409 handler enforce the invariant.** §6.10b updates the publisher's 409 path to verify text-match before marking 'posted'. The two paths defend the same invariant from different angles: this helper catches external replies at ingest time (proactive); §6.10b catches them at publish time (reactive, when ingest reconciliation was missed or field-match failed for a legacy row). Either path alone has gaps; together they're robust.

Error-class disposition table (shared by §6.3 + §6.4):

| Error class | Disposition |
|---|---|
| `ZernioAuthError` | Call new `applyIngestionAuthErrorFallback(businessId, accountId, locationId, reason: string)` (§6.5b) — disconnect connection + enqueue `notify_owner_connection_lost`. The `reason` argument is a short error message (e.g. `err.body.slice(0, 500)`) persisted in `zernio_connections.last_error`. markOutboxFailed permanent. |
| `ZernioPermanentError` | markOutboxFailed permanent (4xx other than auth) |
| `ZernioValidationError` | markOutboxFailed permanent (caller bug — re-running won't help) |
| `ZernioReviewNotFoundError` (from zernioClient — `publish_reply` 404) | N/A for ingestion — only thrown by publish path. |
| `ZernioIngestReviewNotFoundError` (our local) | Throw → BullMQ retry → on exhaustion, onFailed hook writes `review_exceptions` type='zernio_review_not_found' (§6.5) and markOutboxFailed |
| `ZernioIngestUnparseableLocationError` (our local) | Throw → BullMQ retry → on exhaustion, onFailed hook writes `review_exceptions` type='zernio_unparseable_review_name' (§6.5) and markOutboxFailed. Final-review M1 fix — replaces bare Error path. |
| `ZernioTransientError` (incl. timeout, 5xx, 408, 429) | Throw → BullMQ retry with exponential backoff |
| `ZernioReviewNormalizationError` (our local) | markOutboxCompleted with warning (no point retrying — payload shape is broken) |
| Generic `Error` (unexpected — should not occur in spec-introduced paths) | Throw → BullMQ retry; on exhaustion the generic onFailed path marks failed. Treat any sighting as a code bug to investigate. |

`handleZernioIngestError(err, outboxId, attempt, ctx, logger)` is a shared helper in `worker/jobs/zernio-ingest-shared.ts` (NEW) that switches on the error class and calls the right disposition. It is imported by both ingest and backfill workers.

### 6.4 New worker — `worker/jobs/ZernioBackfillWorker.ts`

```ts
export async function handleZernioBackfill(job: Job<ZernioInitialBackfillPayload>) {
  const logger = createWorkerLogger('[ZernioBackfillWorker]', job.data.correlation_id);
  const {
    business_id,
    zernio_account_id,
    zernio_location_id,
    subscription_tier,
    subscription_activated_at,
  } = job.data;
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);

  // Idempotent backfill claim: try to insert, fall through to existing row.
  // The schema's `completed_at IS NOT NULL` is the "done" sentinel. Earlier
  // drafts skipped on row-existence — that was a retry-bug: if listAllReviews
  // timed out AFTER the row was inserted, BullMQ retry would see the row and
  // exit, permanently losing the backfill. Now we only skip when actually
  // completed, otherwise resume.
  const runId = uuidv7();
  await sql`
    INSERT INTO zernio_backfill_runs (
      id, business_id, zernio_account_id, zernio_location_id,
      subscription_tier, subscription_activated_at
    ) VALUES (
      ${runId}, ${business_id}, ${zernio_account_id}, ${zernio_location_id},
      ${subscription_tier}, ${subscription_activated_at}
    )
    ON CONFLICT (business_id) DO NOTHING
  `;

  const [run] = await sql<{ id: string; completed_at: Date | null }[]>`
    SELECT id, completed_at FROM zernio_backfill_runs WHERE business_id = ${business_id}
  `;

  if (!run) {
    // Should be impossible — we just inserted (or upserted-no-op into) this row.
    throw new Error(`Backfill row not found for business=${business_id} after upsert`);
  }

  if (run.completed_at !== null) {
    // Truly done. Skip the work.
    logger.log(`Backfill already completed for business=${business_id} — skipping`);
    return markOutboxCompleted(outboxId, attempt);
  }

  // Row exists but completed_at IS NULL — either a fresh insert by this attempt
  // or a partial/crashed previous attempt. Either way, run the work. The
  // `processReview` calls below are idempotent at the (provider, provider_review_name)
  // UNIQUE level, so re-running a partial backfill is safe — already-ingested
  // reviews become 'unchanged' no-ops.

  // Subscription guard
  const [biz] = await sql`
    SELECT subscription_status, updated_at FROM businesses WHERE id = ${business_id}
  `;
  if (!biz || !checkSubscription(biz.subscription_status, biz.updated_at, 'generator').allowed) {
    await sql`UPDATE zernio_backfill_runs SET completed_at = NOW() WHERE business_id = ${business_id}`;
    return markOutboxCompleted(outboxId, attempt);
  }

  let all: ZernioReview[];
  try {
    all = await zernioClient.listAllReviews(zernio_account_id, {
      locationId: zernio_location_id,    // §6.0 — server-side scoping
      pageSize: 50,
      maxPages: 4,
    });
  } catch (err) {
    return handleZernioIngestError(err, outboxId, attempt, { business_id, zernio_account_id, zernio_location_id }, logger);
  }

  const activeSinceMs = new Date(subscription_activated_at).getTime();

  // Defense-in-depth: even though listAllReviews is location-scoped server-side,
  // also filter client-side by review.name location segment in case Zernio's
  // server-side filter has any drift.
  const locationScoped = all.filter(z => extractLocationFromReviewName(z.name) === zernio_location_id);

  // Split into answered (already has reviewReply on Google) vs unanswered.
  //
  // Answered reviews need reconciliation, NOT bucket-processing: any
  // pre-existing local active response (e.g. SerpAPI-sourced draft from
  // pre-flag-flip era) is stale and must be superseded with
  // already_replied_external. The reconcile helper handles "is it our
  // reply?" gracefully — if the matching local response has approved_text
  // matching the Zernio reply, it's a no-op; otherwise it's superseded.
  //
  // Unanswered reviews go through bucket caps + draft generation.
  const answered = locationScoped.filter(z => z.reviewReply !== null);
  const unanswered = locationScoped
    .filter(z => z.reviewReply === null)
    .sort((a, b) => new Date(b.createTime).getTime() - new Date(a.createTime).getTime());

  // Run reconciliation for any pre-existing drafts on already-answered reviews.
  //
  // Failure handling: collect errors per-review and continue (best-effort
  // attempt for the remaining answered set + the unanswered bucket), but if
  // ANY reconcile failed, throw at the end of the worker BEFORE setting
  // completed_at. That triggers BullMQ retry of the whole backfill — which
  // is idempotent (already-superseded responses become no-ops; processReview's
  // ON CONFLICT makes per-review re-runs safe; the backfill_runs row's
  // completed_at remains NULL so the worker's resume-on-incomplete logic
  // (§6.4) keeps the row valid for retry).
  //
  // Earlier draft swallowed errors and continued to set completed_at — that
  // was wrong because failed reconciles permanently leave stale legacy drafts
  // unsuperseded, which is exactly the bug the answered-review pass exists
  // to prevent.
  const reconcileFailures: { reviewId: string; error: string }[] = [];
  for (const z of answered) {
    try {
      await reconcileExternallyAnsweredReview(
        z, business_id, zernio_account_id, zernio_location_id, logger,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Backfill reconcile failed for review ${z.id}: ${msg}`);
      reconcileFailures.push({ reviewId: z.id, error: msg });
    }
  }

  const gapAll = unanswered.filter(z => new Date(z.createTime).getTime() >= activeSinceMs);
  const histAll = unanswered.filter(z => new Date(z.createTime).getTime() < activeSinceMs);

  const gap = gapAll.slice(0, 25);
  const historical = subscription_tier === 'premium' ? histAll.slice(0, 50) : [];

  const gapSkipped = gapAll.length - gap.length;
  const historicalSkipped = subscription_tier === 'premium'
    ? histAll.length - historical.length
    : histAll.length;
  const oldestSkipped = [...gapAll.slice(25), ...histAll.slice(historical.length)]
    .reduce((oldest: string | null, z) =>
      !oldest || z.createTime < oldest ? z.createTime : oldest, null);

  for (const z of [...gap, ...historical]) {
    let monitored: MonitoredReview;
    try {
      monitored = buildZernioMonitoredReview(z, zernio_account_id, zernio_location_id);
    } catch (err) {
      if (err instanceof ZernioReviewNormalizationError) {
        logger.warn(`Skipping malformed review ${z.id}: ${err.message}`);
        continue;
      }
      throw err;
    }

    // suppress_notification: true — see §4.6
    await processReview(monitored, business_id, job.data.correlation_id, {
      suppressNotification: true,
    });
  }

  // CRITICAL: if any reconcile failed, throw before setting completed_at.
  // BullMQ will retry the whole backfill (idempotent thanks to processReview's
  // ON CONFLICT and supersession idempotency). The backfill_runs row stays
  // valid (completed_at IS NULL) so the resume-on-incomplete logic in §6.4
  // re-enters cleanly. After BullMQ retries are exhausted, the row remains
  // with completed_at IS NULL — the next manual reconnect or a one-shot
  // ops re-enqueue can pick it up. We update the partial counts now so ops
  // can see what work was completed before the failure.
  await sql`
    UPDATE zernio_backfill_runs
    SET gap_processed_count = ${gap.length},
        historical_processed_count = ${historical.length},
        gap_skipped_count = ${gapSkipped},
        historical_skipped_count = ${historicalSkipped},
        oldest_skipped_create_time = ${oldestSkipped},
        updated_at = NOW()
    WHERE business_id = ${business_id}
  `;

  if (reconcileFailures.length > 0) {
    throw new Error(
      `Backfill reconciliation failed for ${reconcileFailures.length} review(s): ` +
      reconcileFailures.map(f => `${f.reviewId} (${f.error})`).join('; ') +
      ` — re-running on retry`,
    );
  }

  // All reconciles succeeded → mark fully completed.
  await sql`
    UPDATE zernio_backfill_runs
    SET completed_at = NOW(), updated_at = NOW()
    WHERE business_id = ${business_id}
  `;

  logger.log(
    `Backfill complete business=${business_id} tier=${subscription_tier}: ` +
    `gap=${gap.length}/${gapAll.length} historical=${historical.length}/${histAll.length}`,
  );

  await markOutboxCompleted(outboxId, attempt);
}
```

`processReview` is updated to accept an optional `options` arg (§6.6) carrying `suppressNotification` which propagates into the enqueued `generate_response` outbox payload.

### 6.5 BullMQ onFailed hook — escalate ingest typed errors to `review_exceptions`

The ingest worker registers an `on('failed')` hook that mirrors the publisher's pattern (worker/index.ts:139-194 for the publisher; the ingest hook is a NEW addition). It branches on the typed error classes that survive retry exhaustion and writes a `review_exceptions` row + admin notify outbox row before marking the outbox failed.

**Critical detail — ON CONFLICT predicate must match the existing partial unique index byte-for-byte.** Migration 005 created `idx_review_exceptions_collision_dedup` with predicate `(business_id, type, (payload->>'provider_review_id')) WHERE status='open' AND review_id IS NULL`. Postgres requires the ON CONFLICT clause to reference the same expressions. Therefore the payload key MUST be `provider_review_id`, NOT `zernio_review_id`. The semantics are equivalent (both refer to the review's identity in the upstream provider), and reusing the existing index avoids a migration.

```ts
// In worker/index.ts — register an on('failed') hook on ingestZernioReviewWorker
// (the BullMQ Worker registered in §6.3). Lands AFTER existing transient/auth
// classification (those throw their own typed errors handled in-worker), so
// the hook only sees genuine retry-exhaustion cases.
ingestZernioReviewWorker.on('failed', async (job, err) => {
  if (job.attemptsMade < (job.opts.attempts ?? 5)) return;  // not yet exhausted

  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // ── ZernioIngestReviewNotFoundError ──────────────────────────────
  if (err instanceof ZernioIngestReviewNotFoundError) {
    await sql`
      INSERT INTO review_exceptions (id, business_id, type, status, payload)
      VALUES (
        ${uuidv7()}, ${err.businessId}, 'zernio_review_not_found', 'open',
        ${jsonb({
          provider: 'zernio',
          provider_review_id: err.zernioReviewId,        // matches existing index key
          zernio_account_id: err.zernioAccountId,
          zernio_location_id: err.zernioLocationId,
          retries_exhausted_at: new Date().toISOString(),
        })}
      )
      ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
        WHERE status = 'open' AND review_id IS NULL
      DO NOTHING
    `;
    // Note: not enqueueing notify_admin_review_exception here because
    // zernio_review_not_found is high-volume during Zernio outages and
    // would spam admin email. Ops watches the review_exceptions table
    // directly. If ops volume is acceptable post-launch, add a notify
    // enqueue with a per-day rate limit.
    await markOutboxFailed(outboxId, 'zernio_review_not_found_after_retries', outboxAttempt);
    return;
  }

  // ── ZernioIngestUnparseableLocationError (final-review M1) ───────
  if (err instanceof ZernioIngestUnparseableLocationError) {
    // Persistent shape drift in Zernio's review.name format. Open one
    // exception per affected review id so ops gets one alert per drift
    // case, then mark outbox failed. Uses the SAME partial unique index
    // as zernio_review_not_found (different `type` value).
    const [exception] = await sql<{ id: string }[]>`
      INSERT INTO review_exceptions (id, business_id, type, status, payload)
      VALUES (
        ${uuidv7()}, ${err.businessId}, 'zernio_unparseable_review_name', 'open',
        ${jsonb({
          provider: 'zernio',
          provider_review_id: err.zernioReviewId,
          zernio_account_id: err.zernioAccountId,
          zernio_location_id: err.zernioLocationId,
          review_name_truncated: err.reviewName.slice(0, 500),
          retries_exhausted_at: new Date().toISOString(),
        })}
      )
      ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
        WHERE status = 'open' AND review_id IS NULL
      DO NOTHING
      RETURNING id
    `;

    // Unparseable shape IS unusual enough to warrant admin notify —
    // unlike the high-volume not-found case, this signals a Zernio
    // contract change and ops should investigate immediately.
    if (exception) {
      await sql`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts)
        VALUES (
          ${uuidv7()}, 'notify_admin_review_exception', 'business',
          ${err.businessId},
          ${jsonb({ review_exception_id: exception.id, business_id: err.businessId })},
          0, 5
        )
      `;
    }
    await markOutboxFailed(outboxId, 'zernio_unparseable_review_name', outboxAttempt);
    return;
  }

  // Anything else: bare markOutboxFailed (existing behavior).
  const reason = err instanceof Error ? err.message : String(err);
  await markOutboxFailed(outboxId, reason, outboxAttempt);
});
```

Two new exception types: `'zernio_review_not_found'` and `'zernio_unparseable_review_name'`. Both are string values — no schema migration needed. The existing partial unique index handles dedup across retry storms.

**AdminExceptionWorker rendering (§6.10b'):** when adding the new `'zernio_unparseable_review_name'` switch case, surface `review_name_truncated`, `zernio_account_id`, `zernio_location_id`, and the recommendation to verify Zernio's API documentation for shape drift. (Otherwise the generic fallback handles it but the type-specific copy is more actionable.)

### 6.5b New helper — `applyIngestionAuthErrorFallback`

Lives at `src/lib/zernio/auth-error-fallback.ts` (NEW). Distinct from `applyTransientExhaustionFallback` (which requires a `response_id` to park) — ingestion has no response to park. This helper handles the connection-side cleanup only.

```ts
export async function applyIngestionAuthErrorFallback(
  businessId: string,
  accountId: string,
  locationId: string,
  reason: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    // Disconnect the matching active connection. Scoped by location to avoid
    // accidentally disconnecting a sibling business sharing the same account
    // at a different location.
    const updated = await tx`
      UPDATE zernio_connections
      SET status = 'disconnected',
          disconnected_at = NOW(),
          disconnect_reason = 'auth_error_on_ingest',
          last_error = ${reason},
          last_error_at = NOW(),
          updated_at = NOW()
      WHERE business_id = ${businessId}
        AND zernio_account_id = ${accountId}
        AND zernio_location_id = ${locationId}
        AND status = 'active'
      RETURNING 1
    `;

    if (updated.count === 0) {
      // Connection already disconnected by another worker (publisher / webhook).
      // Don't enqueue another connection_lost notify — the prior path already did.
      return;
    }

    // Enqueue connection_lost notify (NOT reconnect_required — that template
    // is response-scoped). The migration 026 dedup index
    // notification_deliveries_connection_lost_dedup caps to one email per
    // business per UTC day, so this is safe even across many concurrent
    // ingest jobs hitting the same auth error.
    await tx`
      INSERT INTO job_outbox (
        id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
      ) VALUES (
        ${uuidv7()},
        'notify_owner_connection_lost',
        'business',
        ${businessId},
        ${jsonb({ kind: 'connection_lost', business_id: businessId })},
        0, 5
      )
    `;
  });
}
```

Reused by both ingest worker and backfill worker on `ZernioAuthError`. Mirrors the connection-disconnect side of `applyTransientExhaustionFallback` but omits the response transition + reconnect_required enqueue (those are response-scoped).

### 6.6 `processReview` updates

`src/lib/reviews/process-review.ts:33` is the source of the insert race the reviewer identified. Two concurrent first-time inserts both see no existing row; one wins, the other hits `(provider, provider_review_name)` UNIQUE 23505. Today the loser bubbles the error and BullMQ retries — wasteful but not wrong. Fix: handle the race cleanly and propagate the suppress flag.

```ts
export async function processReview(
  monitored: MonitoredReview,
  businessId: string,
  correlationId?: string,
  options?: { suppressNotification?: boolean },
): Promise<ProcessResult> {
  const { review, identity, contentHash } = monitored;
  const suppressNotification = options?.suppressNotification ?? false;

  return await sql.begin(async (tx) => {
    const [existing] = await tx<{ id: string; review_content_hash: string | null }[]>`
      SELECT id, review_content_hash
      FROM reviews
      WHERE provider = ${identity.provider}
        AND provider_review_name = ${identity.providerReviewName}
      FOR UPDATE
    `;

    if (!existing) {
      const reviewId = uuidv7();

      // ON CONFLICT DO NOTHING handles the race where another transaction
      // inserted between our SELECT FOR UPDATE (which found nothing) and our
      // INSERT. If we lose the race, count=0 and we DO NOT return 'unchanged'
      // — instead we fall through to the existing-row branch below to run the
      // content-hash comparison. Otherwise: if our payload had newer content
      // than the winner (e.g. backfill loses to a webhook with edited text,
      // or vice-versa), the newer content would be silently dropped.
      const inserted = await tx`
        INSERT INTO reviews (
          id, business_id, provider, provider_review_id,
          provider_review_name, provider_location_name,
          reviewer_name, star_rating, review_text, review_date,
          detected_language, review_content_hash, status, detected_at
        ) VALUES (
          ${reviewId}, ${businessId}, ${identity.provider}, ${identity.providerReviewId},
          ${identity.providerReviewName}, ${identity.providerLocationName},
          ${review.reviewerName}, ${review.starRating}, ${review.reviewText}, ${review.reviewDate},
          ${review.detectedLanguage}, ${contentHash}, 'new', NOW()
        )
        ON CONFLICT (provider, provider_review_name) DO NOTHING
      `;

      if (inserted.count > 0) {
        // We won the race. Enqueue generate_response and return 'new'.
        const outboxPayload: GenerateResponsePayload = {
          review_id: reviewId,
          business_id: businessId,
          version: 1,
          correlation_id: correlationId,
          suppress_notification: suppressNotification,
        };

        await tx`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          VALUES (
            ${uuidv7()}, 'generate_response', 'review', ${reviewId},
            ${jsonb(outboxPayload)}, 'pending'
          )
        `;

        return 'new' as const;
      }

      // Race loss — the winner inserted between our FOR UPDATE and our INSERT.
      // Re-read FOR UPDATE so we hold the lock, then fall through to the
      // existing-row content-hash logic. If our payload's contentHash differs
      // from what the winner wrote, the existing branch will run the update
      // path. If it matches, we'll return 'unchanged'.
      const [winner] = await tx<{ id: string; review_content_hash: string | null }[]>`
        SELECT id, review_content_hash
        FROM reviews
        WHERE provider = ${identity.provider}
          AND provider_review_name = ${identity.providerReviewName}
        FOR UPDATE
      `;
      // Fall through to the existing-row branch below using `winner` as `existing`.
      // (Rebind for clarity in the implementation; pseudocode here uses `existing = winner`.)
      // (Implementation will refactor the existing-branch logic into a shared helper
      //  so both initial-found and race-loser paths run the identical code.)
    }

    // ... existing content-hash branching unchanged, but every
    //     'generate_response' outbox row also propagates suppress_notification
    //     when set in options. Webhook-arriving (steady state) reviews never
    //     pass suppressNotification — flag defaults false.
  });
}
```

Implementation note: the cleanest refactor is to extract the existing content-hash branch (lines 75-228 in `process-review.ts` today) into an inner function `processExistingReview(tx, existing, monitored, businessId, correlationId, suppressNotification)`. Both the original-found path and the race-loss path call this helper with the same row.

### 6.6b Webhook payload parser — `src/lib/zernio/parse-review-webhook.ts` (NEW)

Round-3 review surfaced that the v3 webhook handler at §6.7 hand-rolled type-assertions on an undocumented payload shape (`(body as { account?: { id?: unknown } }).account?.id`). That couples the codebase to a guess about Zernio's payload format. Promote it to a documented parser with explicit validation + tests.

```ts
// src/lib/zernio/parse-review-webhook.ts
//
// Zernio review webhook payload shape (per Zernio docs as of 2026-04-29 — verify
// against current Zernio webhook spec during implementation):
//
//   {
//     event: 'review.new' | 'review.updated',
//     id: string,                              // event id (also in x-zernio-event-id)
//     account: { id: string },                 // Zernio account id (NOT Google's)
//     review: {
//       id: string,                            // Zernio review id (canonical)
//       name?: string,                         // 'accounts/{a}/locations/{l}/reviews/{r}'
//     },
//     // possibly: location: { id: string }    // not relied upon — derive from review.name
//   }
//
// Defense-in-depth: the parser accepts both `review.id` and the resource-name
// form `review.name`. If only `name` is present, we extract the bare id from
// the last URL segment.

export interface ParsedReviewWebhook {
  /** Top-level Zernio account.id from the webhook envelope. Used for the
   *  zernio_connections lookup and Zernio API calls. NOTE: this is distinct
   *  from the {accountResource} segment in any review resource-name path —
   *  the resource path segment is Google's account ID, a different ID space.
   *  Do NOT cross-check the two. */
  accountId: string;
  /** BARE review id (last path segment, never a slash-separated resource form).
   *  Compared directly to ZernioReview.id from listReviews. */
  reviewId: string;
  /** Location id extracted from a review resource-name path, if present.
   *  Optional — the ingest worker doesn't depend on this for routing
   *  (it fans out per active connection and filters by listReviews output),
   *  but logging it aids debugging multi-location fan-out. */
  locationIdFromPayload: string | null;
  /** Full resource-name form when supplied, retained for logging only. */
  fullReviewName: string | null;
}

export class ZernioReviewWebhookParseError extends Error {
  constructor(reason: string, readonly raw: unknown) {
    super(`[parse-review-webhook] ${reason}`);
    this.name = 'ZernioReviewWebhookParseError';
  }
}

// Resource-name shape per Google Business Profile API convention:
//   accounts/{accountResource}/locations/{locationResource}/reviews/{reviewResource}
// CRITICAL: the {accountResource} segment in this path is the Google Business
// account identifier — it is NOT the same ID space as the top-level Zernio
// `account.id` in the webhook envelope. Do NOT cross-check them. Use the
// top-level `account.id` for our DB lookup and Zernio API calls; use the
// resource-path segments only to extract location and bare review identifiers.
const REVIEW_NAME_RE = /^accounts\/([^/]+)\/locations\/([^/]+)\/reviews\/([^/]+)$/;

/**
 * Extract bare review id from either a bare string or a full resource-name path.
 * Zernio's webhook may deliver `review.id` in either form depending on event type
 * and integration version; listReviews always returns the bare form.
 */
function extractBareReviewId(value: string): { bareReviewId: string; locationFromPath: string | null } {
  const trimmed = value.trim();
  if (!trimmed) return { bareReviewId: '', locationFromPath: null };

  if (trimmed.includes('/')) {
    const m = trimmed.match(REVIEW_NAME_RE);
    if (m) {
      const [, , locationSegment, reviewSegment] = m;
      return { bareReviewId: reviewSegment, locationFromPath: locationSegment };
    }
    // Has slashes but doesn't match the canonical shape — refuse to guess.
    return { bareReviewId: '', locationFromPath: null };
  }

  // No slash — already bare.
  return { bareReviewId: trimmed, locationFromPath: null };
}

export function parseZernioReviewWebhook(body: unknown): ParsedReviewWebhook {
  if (!body || typeof body !== 'object') {
    throw new ZernioReviewWebhookParseError('body is not an object', body);
  }
  const b = body as Record<string, unknown>;

  // Top-level account.id — Zernio's account ID, used for DB lookup + API calls.
  const account = b.account;
  if (!account || typeof account !== 'object') {
    throw new ZernioReviewWebhookParseError('missing account object', body);
  }
  const accountId = (account as Record<string, unknown>).id;
  if (typeof accountId !== 'string' || accountId.trim().length === 0) {
    throw new ZernioReviewWebhookParseError('account.id missing or empty', body);
  }

  // review.id and/or review.name. Both can carry the resource-name form;
  // extract the bare review id from whichever is present and well-formed.
  const review = b.review;
  if (!review || typeof review !== 'object') {
    throw new ZernioReviewWebhookParseError('missing review object', body);
  }
  const r = review as Record<string, unknown>;

  let bareReviewId: string | null = null;
  let locationIdFromPayload: string | null = null;
  let fullReviewName: string | null = null;

  if (typeof r.id === 'string' && r.id.trim().length > 0) {
    const ext = extractBareReviewId(r.id);
    if (ext.bareReviewId) bareReviewId = ext.bareReviewId;
    if (ext.locationFromPath) locationIdFromPayload = ext.locationFromPath;
    if (r.id.includes('/')) fullReviewName = r.id.trim();
  }

  if (typeof r.name === 'string' && r.name.trim().length > 0) {
    const ext = extractBareReviewId(r.name);
    if (ext.bareReviewId) {
      // If both review.id and review.name yielded bare ids and they disagree,
      // Zernio is sending us inconsistent state. Refuse rather than guess.
      if (bareReviewId && bareReviewId !== ext.bareReviewId) {
        throw new ZernioReviewWebhookParseError(
          `review.id and review.name yield different bare ids: ${bareReviewId} vs ${ext.bareReviewId}`, body,
        );
      }
      bareReviewId = ext.bareReviewId;
    }
    if (ext.locationFromPath) {
      // Same agreement check for location segment.
      if (locationIdFromPayload && locationIdFromPayload !== ext.locationFromPath) {
        throw new ZernioReviewWebhookParseError(
          `review.id and review.name yield different location segments: ${locationIdFromPayload} vs ${ext.locationFromPath}`, body,
        );
      }
      locationIdFromPayload = ext.locationFromPath;
    }
    fullReviewName = r.name.trim();
  }

  if (!bareReviewId) {
    throw new ZernioReviewWebhookParseError('could not extract bare review id from review.id or review.name', body);
  }

  return { accountId, reviewId: bareReviewId, locationIdFromPayload, fullReviewName };
}
```

Tests in `src/lib/zernio/__tests__/parse-review-webhook.test.ts` cover:
- Nested `account.id` extracted as Zernio account id (used for API calls).
- Bare `review.id` (e.g. `'AbFv0LXyz123'`) — stored as-is.
- **Resource-name `review.id` (e.g. `'accounts/108472.../locations/9876/reviews/AbFv0LXyz123'`)** — bare `'AbFv0LXyz123'` extracted; full path retained as `fullReviewName`; location `'9876'` extracted as `locationIdFromPayload`.
- Resource-name `review.name` only (no `review.id`) — same extraction as above.
- Both `review.id` and `review.name` agreeing on bare id and location → accepted.
- Both yielding DIFFERENT bare ids → throws.
- Both yielding DIFFERENT location segments → throws.
- Missing `account` / `account.id` / `review` → throws.
- Empty strings → throws.
- Slash-containing `review.id` that doesn't match the canonical resource shape → throws.
- **Negative test (regression for round-4):** payload with top-level `account.id='zernio-acct-A'` and `review.name='accounts/google-acct-B/...'` — the two ID spaces differ; parser MUST accept this (no cross-check) and use `'zernio-acct-A'` as the accountId.

Webhook ingress (§6.7) becomes:

```ts
case 'review.new':
case 'review.updated': {
  let parsed;
  try {
    parsed = parseZernioReviewWebhook(body);
  } catch (err) {
    if (err instanceof ZernioReviewWebhookParseError) {
      console.warn(`${LOG_PREFIX} ${eventType} unparseable: ${err.message}`);
      break;  // 200 OK — Zernio shouldn't retry malformed payloads
    }
    throw err;
  }

  // Fan out: one outbox row per active connection at this account. The
  // ingest worker filters by location after fetching the review.
  await sql`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    SELECT
      gen_random_uuid(),
      'ingest_zernio_review',
      'business',
      zc.business_id,
      jsonb_build_object(
        'business_id', zc.business_id,
        'zernio_account_id', ${parsed.accountId},
        'zernio_location_id', zc.zernio_location_id,
        'zernio_review_id', ${parsed.reviewId},
        'correlation_id', ${eventId}
      ),
      'pending'
    FROM zernio_connections zc
    WHERE zc.zernio_account_id = ${parsed.accountId}
      AND zc.status = 'active'
  `;
  break;
}
```

### 6.7 `ResponseGeneratorWorker` skips `send_notification` enqueue

Per §4.6, suppression is implemented by NOT creating the downstream outbox row, NOT by writing a sentinel `notification_deliveries` row. Round-2 review caught two reasons the v2 sentinel approach was wrong:

1. `notification_deliveries` has no `status` column (verified at `supabase/migrations/001_initial_schema.sql:328`). The v2 INSERT would fail at runtime.
2. `recipient TEXT NOT NULL` would force us to invent a placeholder string ('suppressed', '__none__', etc.) that downstream queries might mistake for a real recipient.

**The change is in `ResponseGeneratorWorker`, not `NotificationWorker`:**

```ts
// In ResponseGeneratorWorker.ts after generating the response:

const suppressNotification = job.data.suppress_notification === true;

if (!suppressNotification) {
  const sendPayload: SendNotificationPayload = {
    response_id: responseId,
    business_id: businessId,
    correlation_id: correlationId,
  };
  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${uuidv7()}, 'send_notification', 'response', ${responseId},
      ${jsonb(sendPayload)}, 'pending'
    )
  `;
} else {
  logger.log(`suppress_notification=true — skipping send_notification enqueue for response ${responseId}`);
}
```

**No `NotificationWorker` change.** It never sees backfill responses because no outbox row is created.

**Failover safety verified:** `NotificationFailoverPoller` queries gate on `EXISTS (notification_deliveries WHERE response_id=X AND template='approval_request')`. With no row inserted, EXISTS=false → response is skipped → no false-positive admin alerts.

**Engagement / weekly summary safety:** these readers count `notification_deliveries` rows for engagement scoring. A backfill response not having a row simply means it wasn't notified-via-channel — semantically correct. No change needed.

### 6.8 Connect callback updates

`src/app/api/zernio/connect/select-location/route.ts` (verified by `ls` — earlier draft incorrectly said `/api/dashboard/connect/...` which doesn't exist) is the route that flips `zernio_connections.status='pending' → 'active'`. Add a same-transaction enqueue:

```ts
await sql.begin(async (tx) => {
  // ... existing logic that updates zernio_connections to status='active' ...

  // Backfill-needed predicate (final-review M2 fix).
  //
  // We enqueue the backfill outbox row when EITHER:
  //   (a) this is the very first time the business has had a connected_at-set
  //       Zernio connection (the original first-activation case), OR
  //   (b) a prior connection existed but no backfill has ever COMPLETED for
  //       this business (zernio_backfill_runs has no row OR row exists but
  //       completed_at IS NULL).
  //
  // Case (b) was the gap the original predicate missed: if a previous
  // backfill auth-failed mid-flight, the connection was disconnected with
  // connected_at non-null — and a re-connect would falsely satisfy
  // "not first activation" → no backfill enqueued → customer's dashboard
  // stays empty for historical/gap reviews forever.
  //
  // The combined predicate fires backfill exactly once per business per
  // successful completion: subsequent reconnects after a successful backfill
  // (zernio_backfill_runs.completed_at IS NOT NULL) correctly skip.
  const [{ needs_backfill }] = await tx<{ needs_backfill: boolean }[]>`
    SELECT (
      NOT EXISTS (
        SELECT 1 FROM zernio_connections
        WHERE business_id = ${businessId}
          AND id != ${justActivatedConnectionId}
          AND connected_at IS NOT NULL
      )
      OR NOT EXISTS (
        SELECT 1 FROM zernio_backfill_runs
        WHERE business_id = ${businessId}
          AND completed_at IS NOT NULL
      )
    ) AS needs_backfill
  `;

  if (needs_backfill) {
    // Idempotency note: the ZernioBackfillWorker also has a defense-in-depth
    // check (§6.4 — INSERT backfill_runs with ON CONFLICT, then check
    // completed_at). So even if this predicate fires when it shouldn't (e.g.
    // a race against another connect), the worker's resume-or-skip logic
    // makes a second outbox enqueue safe.
    const [bizRow] = await tx<{
      subscription_tier: string;
      subscription_activated_at: Date | null;
    }[]>`
      SELECT subscription_tier, subscription_activated_at
      FROM businesses WHERE id = ${businessId}
    `;

    if (bizRow.subscription_activated_at) {
      const correlationId = uuidv7();
      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${uuidv7()},
          'zernio_initial_backfill',
          'business',
          ${businessId},
          ${jsonb({
            business_id: businessId,
            zernio_account_id: accountId,
            zernio_location_id: locationId,
            subscription_tier: bizRow.subscription_tier,
            subscription_activated_at: bizRow.subscription_activated_at,
            correlation_id: correlationId,
          })},
          'pending'
        )
      `;
    } else {
      // Pre-payment connect — connect flow is gated on active subscription,
      // so this is unreachable. Defensive log.
      logger.warn(`Connect succeeded but subscription_activated_at is NULL for ${businessId}`);
    }
  }
});
```

### 6.9 Removed: SerpAPI ingestion producers and consumers

Verified producers of `topic='sync_reviews'` outbox rows (all THREE must be removed):

| Location | Action |
|---|---|
| `src/app/api/onboarding/business/route.ts:179-191` | Remove the `topic='sync_reviews'` branch entirely. PlaceAutocomplete-verified path now just sets `place_id_verified=true` and exits. |
| `src/lib/onboarding/create-business.ts:246-262` | Remove the `placeIdVerified` branch's sync_reviews enqueue. The `else if (googleMapsUrl)` branch's `validate_place_id` enqueue stays (the validation worker still serves the place-verification flow). |
| `worker/jobs/PlaceIdValidationWorker.ts:101-122` | Remove the entire `enqueueSyncReviews` helper and its call site. The worker still resolves the URL → placeId, persists the result, and marks `place_id_verified=true` — it just doesn't enqueue review sync anymore. |

Consumer side (also delete):

- `worker/jobs/ReconciliationPoller.ts` — entire file
- `worker/jobs/ReviewSyncWorker.ts` — entire file
- `worker/__tests__/ReviewSyncWorker.test.ts` — entire file
- `src/lib/reviews/serpapi-monitor.ts` — entire file
- `src/lib/reviews/mock-monitor.ts` — entire file
- `src/lib/reviews/__tests__/serpapi-monitor.test.ts` if present
- Plus any `sync_reviews` references in `src/lib/shared/queue-names.ts` and `worker/queues.ts`

`src/lib/shared/mock-mode.ts` — drop `getReviewMonitor()` (unused after consumer deletion). Keep `isMockMode()`.

`worker/__tests__/correlation-chain.test.ts` part A — delete or rewrite to test `ingest_zernio_review → generate_response` correlation chain instead.

`worker/__tests__/PlaceIdValidationWorker.test.ts` — update tests at lines 85, 120, 165 to assert that resolution does NOT enqueue sync_reviews (the inverse of today).

`supabase/migrations/004_sync_reviews_dedup_constraint.sql` and `supabase/migrations/018_correlation_and_dispatching_indexes.sql` left in place — historical migrations are immutable. The `idx_jo_sync_reviews_inflight` partial index becomes dead (no rows match the predicate after producer deletion) — harmless.

### 6.10 `'premium'` tier wiring

Decision (§Q1): use the existing `'premium'` slot. Don't add `'pro'`. Eight locations need updates:

| Location | Change |
|---|---|
| `src/lib/shared/schemas.ts:329` | `SelectPlanSchema` enum: `z.enum(['founding', 'standard', 'premium'])` |
| `src/app/onboarding/pay/PlanPickerClient.tsx:6` | `Plan.tier`: `'founding' \| 'standard' \| 'premium'`. Add Premium plan card to PLANS array. |
| `src/lib/payments/payment-link.ts:1-7` | Add `premium: 'STRIPE_PAYMENT_LINK_PREMIUM'` to TIER_ENV. Widen tier param type. |
| `worker/ingress/stripe.ts:179-182` | Add `[process.env.STRIPE_PRICE_PREMIUM ?? '']: 'premium'` to priceToTier. |
| `src/lib/costs/tracker.ts:42-45` | Already has `premium: 2_000`. No change. ✓ |
| `src/lib/responses/types.ts:20,42` | Already has `'premium'` in `BusinessContext` union. No change. ✓ |
| `src/app/api/admin/costs/route.ts:61` | Already references `DAILY_COST_LIMIT_CENTS_PREMIUM`. No change. ✓ |
| `src/app/api/onboarding/__tests__/select-plan.test.ts:159` | Update test that asserts `tier: 'premium'` returns 400 — flip to assert it succeeds. |
| `worker/startup-assert.ts:21-22` | `assertSelfServeSignupEnv` now requires `STRIPE_PAYMENT_LINK_PREMIUM` too. |
| `.env.example` | Add `STRIPE_PAYMENT_LINK_PREMIUM` and `STRIPE_PRICE_PREMIUM`. |

Three locations (cost limits + types + admin costs route) ALREADY reference `'premium'` end-to-end — they were placeholders waiting to be wired. The actual work is mostly schema + UI + payment-link mapping.

### 6.10b Publisher 409 path — verify text-match before marking `posted`

`worker/jobs/ResponsePublisherWorker.ts:278-292` currently treats any `ZernioReplyAlreadyExistsError` (Zernio 409 `reply_already_exists`) as idempotent success and unconditionally marks our response `posted`. That's unsafe: if webhook reconciliation missed the external-reply window (e.g. webhook lost in Zernio's 51h retry envelope) or our field-match heuristic failed for a legacy SerpAPI row, the 409 could mean "someone else already replied with different text" — and we'd display "your reply was posted" while a different reply is on Google.

This is a final line of defense parallel to §6.3b reconciliation. They're both defending the same invariant from different angles; both should hold.

**Helper extraction prerequisite (round-7).** The existing in-worker auth path (`ResponsePublisherWorker.ts:294-368`) and permanent path (lines 371-440) implement the canonical terminal sequences (disconnect-pinned-to-account + park response + notify; mark response failed + open exception + notify admin). The new 409 verifier needs the SAME sequences for the same error classes — and the existing helper `applyTransientExhaustionFallback` is NOT a drop-in replacement because it disconnects `WHERE business_id AND status='active'` without pinning the attempted `zernio_account_id`, which races a fresh reconnect (the in-worker auth path explicitly pins, lines 311-312).

Extract two new shared helpers that BOTH the in-worker paths AND the 409 verifier call:

| Helper | Lives in | Replaces | Used by |
|---|---|---|---|
| `handlePublisherAuthErrorTerminal({ response_id, business_id, account_id, location_id, error_body, outboxId, outboxAttempt, correlation_id, logger })` | `worker/jobs/publisher-error-handlers.ts` (NEW) | inline code at `ResponsePublisherWorker.ts:294-368` | in-worker auth branch, 409 verifier auth branch |
| `handlePublisherPermanentErrorTerminal({ response_id, business_id, review_id, endpoint_kind, http_status, error_body, outboxId, outboxAttempt, logger })` | same file | inline code at `ResponsePublisherWorker.ts:371-440` | in-worker permanent branch, 409 verifier permanent branch |

Both helpers do the FULL terminal sequence (DB mutations + notify outbox enqueues + markOutboxCompleted) so callers just `await ...; return`.

**Auth helper pins to BOTH account AND location** — the existing in-worker auth code at `ResponsePublisherWorker.ts:310-313` only pins by `business_id` + `zernio_account_id`, missing the location dimension. Within a single business the partial unique index `zernio_connections_one_active_per_business` allows only one active row at a time, but that doesn't protect against this race: business X disconnects from account A / location 1 → reconnects to account A / location 2 → a stale auth error in flight from the location-1 publish then disconnects the new location-2 row. Adding the `zernio_location_id` predicate eliminates the race. The existing in-worker auth callsite is updated to pass `zernio_location_id` from the connection it loaded.

**Round-11 follow-up — `applyTransientExhaustionFallback` also needs location pinning.** Round-10 closed the auth-path race but left the transient-exhaustion path (`zernio-publisher.ts:140` + the `worker/index.ts:155` callsite) still disconnecting `WHERE business_id AND status='active'` without pinning. Same stale-publish-vs-fresh-reconnect race applies. Fix:

1. **Widen the helper signature.** `applyTransientExhaustionFallback({ response_id, business_id, correlation_id, account_id?, location_id? })` — both new fields optional for backwards compat. When BOTH are provided, the disconnect WHERE clause adds `AND zernio_account_id = ${account_id} AND zernio_location_id = ${location_id}`. When either is absent, fall back to existing un-pinned behavior (the existing onFailed callsite always provides both via the new wrapper below; un-pinned mode is dead in practice but kept as a safety net for any future caller).

2. **Wrap publisher `ZernioTransientError` with attempt context.** New error class `PublisherTransientWithContext` in `worker/jobs/publisher-error-handlers.ts`:

   ```ts
   // ZernioTransientError's constructor signature is (kind: string, meta: Record<string, unknown>)
   // per src/lib/zernio/errors.ts:15-23. NOT (code, ...) — that's ZernioValidationError.
   // Forward inner.kind verbatim so retry-classification logic that switches on
   // kind (network_error, request_timeout, http_5xx, etc.) keeps working.
   export class PublisherTransientWithContext extends ZernioTransientError {
     constructor(
       inner: ZernioTransientError,
       readonly attemptContext: {
         response_id: string;
         business_id: string;
         account_id: string;
         location_id: string;
       },
     ) {
       super(inner.kind, inner.meta);
       this.cause = inner;
       this.name = 'PublisherTransientWithContext';
     }
   }
   ```

   Subclasses `ZernioTransientError` so `instanceof ZernioTransientError` continues to pass — backwards compat for any other detection paths.

3. **Wrap at every publisher rethrow site.** In `ResponsePublisherWorker.ts`, every `throw err` for a `ZernioTransientError` (the postReply catch at the end of the chain, plus any other transient propagation point in the file) becomes:

   ```ts
   if (err instanceof ZernioTransientError) {
     throw new PublisherTransientWithContext(err, {
       response_id, business_id,
       account_id: zernioConnection.zernio_account_id,
       location_id: zernioConnection.zernio_location_id,
     });
   }
   throw err;
   ```

4. **Failed hook unwraps and pins.** `worker/index.ts:155` already detects `instanceof ZernioTransientError`; the wrapper subclass passes that check too. Inside that branch, additionally check for `instanceof PublisherTransientWithContext` and pull the context fields:

   ```ts
   const ctx = err instanceof PublisherTransientWithContext ? err.attemptContext : null;
   await applyTransientExhaustionFallback({
     response_id: ctx?.response_id ?? job.data.response_id,
     business_id: ctx?.business_id ?? job.data.business_id,
     correlation_id: job.data.correlation_id,
     account_id: ctx?.account_id,        // pinned when wrapper is present
     location_id: ctx?.location_id,      // pinned when wrapper is present
   });
   ```

This closes the same stale-disconnect race for transient exhaustion that round-10 closed for auth errors. Tests added for the publisher-side wrap and the failed-hook unwrap; regression test mirrors round-10's: stale transient exhaustion for account A/location 1 must NOT disconnect a fresh active row for account A/location 2.

**Updated 409 logic:**

```ts
// In ResponsePublisherWorker.ts, replace the existing 409 branch (lines 278-292):
if (err instanceof ZernioReplyAlreadyExistsError) {
  // Fetch the canonical Zernio review to inspect the existing reply.
  // Walk pages — Zernio paginates at pageSize=50, and the target review
  // may be older than the most recent 50. v6 used a single page and
  // would have erroneously superseded responses for older reviews.
  // Use listAllReviews with locationId, capped at the same 4 pages the
  // existing field-match path uses (zernio-publisher.ts:63-66).
  let allReviews: ZernioReview[];
  try {
    allReviews = await zernioClient.listAllReviews(
      zernioConnection.zernio_account_id,
      {
        locationId: zernioConnection.zernio_location_id,  // §6.0
        pageSize: 50,
        maxPages: 4,
      },
    );
  } catch (lookupErr) {
    // Classify the lookup error. Critically: do NOT terminally fail the
    // outbox on transient errors (would convert network blip into permanent
    // loss). Match the disposition the publisher uses elsewhere in this
    // worker, sharing the new terminal helpers per the prerequisite above.
    if (lookupErr instanceof ZernioTransientError) {
      // Wrap in PublisherTransientWithContext (round-12 fix) so retry-exhaustion
      // hits the location-pinned fallback in worker/index.ts:155 instead of the
      // un-pinned legacy path. Bare-rethrow contradicted the round-11 rule that
      // ALL publisher transient throws carry account/location context.
      logger.warn(
        `409 verifier hit transient error for response ${response_id}: ${lookupErr.message} — wrapping with attempt context for retry`,
      );
      throw new PublisherTransientWithContext(lookupErr, {
        response_id,
        business_id,
        account_id: zernioConnection.zernio_account_id,
        location_id: zernioConnection.zernio_location_id,
      });
    }
    if (lookupErr instanceof ZernioAuthError) {
      logger.warn(
        `409 verifier hit auth error for response ${response_id} — handling via shared publisher auth-error helper`,
      );
      await handlePublisherAuthErrorTerminal({
        response_id,
        business_id,
        account_id: zernioConnection.zernio_account_id,     // pinned per §6.10b prerequisite
        location_id: zernioConnection.zernio_location_id,   // round-10 fix — race against fresh reconnect
        error_body: lookupErr.body.slice(0, 500),
        outboxId,
        outboxAttempt,
        correlation_id: job.data.correlation_id,
        logger,
      });
      return;
    }
    if (lookupErr instanceof ZernioPermanentError || lookupErr instanceof ZernioValidationError) {
      logger.error(
        `409 verifier hit permanent error for response ${response_id}: ${lookupErr.message}`,
      );
      const endpointKind =
        lookupErr instanceof ZernioPermanentError && typeof lookupErr.meta?.endpointKind === 'string'
          ? lookupErr.meta.endpointKind
          : 'list_reviews';
      const errBody =
        lookupErr instanceof ZernioPermanentError
          ? lookupErr.meta
          : { code: lookupErr.code, body: lookupErr.body };
      await handlePublisherPermanentErrorTerminal({
        response_id,
        business_id,
        review_id: response.review_id,
        endpoint_kind: endpointKind,
        http_status: 400,                  // mirrors existing in-worker permanent path
        error_body: errBody,
        outboxId,
        outboxAttempt,
        logger,
      });
      return;
    }
    // Unknown error (DB / parse / anything else). On a single attempt this
    // is likely transient (DB blip, GC pause). But after BullMQ retry
    // exhaustion, the existing worker `on('failed')` hook at worker/index.ts:173
    // falls through to bare `markOutboxFailed` for any error class it doesn't
    // recognize — which would leave the response active with no admin trail.
    //
    // Wrap unknown errors in `ZernioReplyVerificationIndeterminateError` with
    // reason='verifier_unknown_error' so the indeterminate failed-hook branch
    // (§6.10c) recognizes it and runs the full terminal sequence on
    // exhaustion. The original error message is captured in the `reason`
    // payload for ops debugging.
    logger.warn(
      `409 verifier hit unknown error for response ${response_id}: ` +
      `${lookupErr instanceof Error ? lookupErr.message : lookupErr} — wrapping as indeterminate, retrying`,
    );
    throw new ZernioReplyVerificationIndeterminateError({
      response_id, business_id, review_id: response.review_id,
      account_id: zernioConnection.zernio_account_id,
      location_id: zernioConnection.zernio_location_id,
      zernio_review_id: zernioReviewId,
      reason: 'verifier_unknown_error',
      underlying_error: lookupErr instanceof Error ? lookupErr.message : String(lookupErr),
    });
  }

  const found = allReviews.find(r => r.id === zernioReviewId);

  // Two cases trigger INDETERMINATE: review not found after pagination
  // exhaustion, OR review found but Zernio's listReviews shows reviewReply=null
  // (despite the 409 telling us a reply exists). Both could mean our own
  // already-posted reply that listReviews hasn't surfaced yet (eventual-
  // consistency lag) — superseding either case risks marking OUR reply as
  // already_replied_external. Throw a dedicated class so the publisher's
  // BullMQ onFailed hook can detect retry-exhaustion and escalate properly
  // (review_exceptions + admin notify + response.failed). NEVER supersede on
  // indeterminate.
  if (!found) {
    logger.warn(
      `409 verifier could not locate review ${zernioReviewId} after walking ${allReviews.length} reviews — indeterminate, retrying`,
    );
    throw new ZernioReplyVerificationIndeterminateError({
      response_id, business_id, review_id: response.review_id,
      account_id: zernioConnection.zernio_account_id,
      location_id: zernioConnection.zernio_location_id,
      zernio_review_id: zernioReviewId,
      reason: 'review_not_found_after_pagination',
      pages_walked: 4, reviews_seen: allReviews.length,
    });
  }

  const existingReply = found.reviewReply ?? null;

  if (existingReply === null) {
    // Zernio said reply_already_exists (409) but listReviews shows no reply.
    // Eventual-consistency lag at Zernio is the most likely explanation;
    // could also be our own just-posted reply that hasn't propagated to
    // listReviews. Indeterminate — retry then escalate.
    logger.warn(
      `409 verifier found review ${zernioReviewId} but reviewReply=null — indeterminate (Zernio lag?), retrying`,
    );
    throw new ZernioReplyVerificationIndeterminateError({
      response_id, business_id, review_id: response.review_id,
      account_id: zernioConnection.zernio_account_id,
      location_id: zernioConnection.zernio_location_id,
      zernio_review_id: zernioReviewId,
      reason: 'review_found_but_reply_null',
    });
  }

  const existingText = canonicalizeReplyText(existingReply.comment);
  const ourText = canonicalizeReplyText(approvedText);

  if (existingText === ourText) {
    // Our previously-posted reply — idempotent success.
    await sql`
      UPDATE responses
      SET status = 'posted', posted_at = NOW(), updated_at = NOW()
      WHERE id = ${response_id}
        AND business_id = ${business_id}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
    `;
    logger.log(
      `Response ${response_id} already posted on Zernio (409, text match), marked posted`,
    );
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // Different text — external reply confirmed (we have a visible reply on
  // Google whose text doesn't match what we tried to post). Supersede.
  await sql`
    UPDATE responses
    SET status = 'superseded',
        posting_error = 'already_replied_external',
        updated_at = NOW()
    WHERE id = ${response_id}
      AND business_id = ${business_id}
      AND status IN ('approved', 'edited', 'awaiting_owner_connect')
  `;
  // Do NOT log reply text snippets — that leaks customer-facing content into
  // production logs. Log lengths + short hash prefixes for ops debugging.
  // Hash inputs are the canonicalized texts so two byte-different-but-
  // semantically-equal strings hash the same, helping ops correlate.
  const fp = (s: string) =>
    createHash('sha256').update(s).digest('hex').slice(0, 12);
  logger.warn(
    `Response ${response_id} 409 text mismatch — ` +
    `existing(len=${existingText.length},fp=${fp(existingText)}) ` +
    `ours(len=${ourText.length},fp=${fp(ourText)}) ` +
    `— superseded as already_replied_external`,
  );
  await markOutboxCompleted(outboxId, outboxAttempt);
  return;
}
```

### 6.10b' AdminExceptionWorker — type-aware email rendering

`worker/jobs/AdminExceptionWorker.ts:61-72` currently hardcodes the email body for `review_edited_after_post`: `"<p><strong>What happened:</strong> The reviewer edited their review after a response was already posted..."`. The body also assumes `reviewer_name`, `star_rating`, and `review_text` are populated via the `LEFT JOIN reviews` at line 31 — but the new `'zernio_review_not_found'` exception type writes rows with `review_id IS NULL` (the review was never ingested), making those fields always null.

Three new exception types this spec introduces, plus the existing one:

| Type | Origin | review_id | Payload fields used in email |
|---|---|---|---|
| `review_edited_after_post` (existing) | process-review | NOT NULL | `response_status` |
| `zernio_review_not_found` (§6.5 NEW) | ingest-worker onFailed | NULL | `provider_review_id`, `zernio_account_id`, `zernio_location_id`, `retries_exhausted_at` |
| `zernio_permanent_4xx` (existing publisher) | publisher permanent | NOT NULL | `endpoint_kind`, `error_body`, `http_status` |
| `zernio_reply_verification_indeterminate` (§6.10c NEW) | publisher onFailed | NOT NULL | `reason`, `zernio_review_id`, `zernio_account_id`, `zernio_location_id`, `pages_walked`, `reviews_seen`, `underlying_error`, `retries_exhausted_at` |
| `zernio_unparseable_review_name` (§6.5 NEW — final-review M1) | ingest-worker onFailed | NULL | `provider_review_id`, `zernio_account_id`, `zernio_location_id`, `review_name_truncated`, `retries_exhausted_at` |

**Updated rendering** — extract `renderExceptionBody(exception, payload)` switching on `exception.type`. Each case writes appropriate copy. Default fallback emits a generic exception summary so future types we don't switch on still produce a useful (if less polished) email instead of misleading "reviewer edited" copy.

**Required SELECT column addition.** The current query at `AdminExceptionWorker.ts:27-34` does NOT select `re.review_id`. The new gating logic depends on it, so the SELECT must add `re.review_id` to its column list and `ExceptionRow` gains `review_id: string | null`. Without this column the renderer can't distinguish anonymous-reviewer-with-real-row (review_id non-null, reviewer_name null) from no-row-at-all (review_id null, reviewer_name null) and would conflate them.

```ts
// ExceptionRow is widened to include re.review_id so the reviewer block
// gates on row presence, NOT reviewer name (anonymous reviews have null
// reviewer_name but a valid review_id and should still render the block).
function renderExceptionBody(
  exception: ExceptionRow,
  payload: Record<string, unknown>,
): string {
  // Round-11 fix: gate on review_id, not reviewer_name. Anonymous reviewers
  // have reviewer_name=NULL but a real review_id — falsely emitting "no local
  // review record" for them was misleading.
  const reviewerBlock = exception.review_id !== null
    ? `<p><strong>Reviewer:</strong> ${escapeHtml(exception.reviewer_name ?? 'Unknown reviewer')} ${exception.star_rating ? `(${'★'.repeat(exception.star_rating)}${'☆'.repeat(5 - exception.star_rating)})` : ''}</p>` +
      `<p><strong>Current review text:</strong></p>` +
      `<blockquote style="border-left:3px solid #ccc;padding:8px 12px;margin:8px 0;color:#555;">` +
      `${exception.review_text ? escapeHtml(exception.review_text) : '<em>No text</em>'}</blockquote>`
    : '<p><em>No local review record (this exception was opened before the review was ingested).</em></p>';

  const fmt = (v: unknown) => v == null ? '—' : escapeHtml(String(v));

  switch (exception.type) {
    case 'review_edited_after_post':
      return `${reviewerBlock}
        <p><strong>What happened:</strong> The reviewer edited their review after a response was already posted. The response may no longer be appropriate for the updated review.</p>
        <p><strong>Response status at time of edit:</strong> ${fmt(payload.response_status)}</p>
        <p><strong>Action needed:</strong> Review the situation and decide whether to regenerate a new response, dismiss the exception, or handle it manually.</p>`;

    case 'zernio_review_not_found':
      return `${reviewerBlock}
        <p><strong>What happened:</strong> Zernio sent a webhook for a review (id <code>${fmt(payload.provider_review_id)}</code>), but after retries the worker could not locate it via Zernio's listReviews API. The review may have been deleted at Zernio, or there may be eventual-consistency lag.</p>
        <p><strong>Zernio account / location:</strong> ${fmt(payload.zernio_account_id)} / ${fmt(payload.zernio_location_id)}</p>
        <p><strong>Retries exhausted at:</strong> ${fmt(payload.retries_exhausted_at)}</p>
        <p><strong>Action needed:</strong> Verify the review's current state in the customer's Google Business Profile. If it still exists, manual reconciliation may be needed; if deleted, dismiss the exception.</p>`;

    case 'zernio_permanent_4xx':
      return `${reviewerBlock}
        <p><strong>What happened:</strong> Posting the reply via Zernio failed with a permanent 4xx error. This is request-specific (likely malformed input or a Zernio config drift), not a connection issue.</p>
        <p><strong>Endpoint:</strong> ${fmt(payload.endpoint_kind)}</p>
        <p><strong>HTTP status:</strong> ${fmt(payload.http_status)}</p>
        <p><strong>Action needed:</strong> Inspect the error_body in the exception payload, fix the underlying issue, and either regenerate or dismiss.</p>`;

    case 'zernio_reply_verification_indeterminate':
      return `${reviewerBlock}
        <p><strong>What happened:</strong> Zernio rejected our reply with 409 reply_already_exists, but verification could not determine whether the existing reply is ours or external (after retries).</p>
        <p><strong>Reason:</strong> ${fmt(payload.reason)}</p>
        <p><strong>Zernio account / location / review:</strong> ${fmt(payload.zernio_account_id)} / ${fmt(payload.zernio_location_id)} / ${fmt(payload.zernio_review_id)}</p>
        ${payload.underlying_error ? `<p><strong>Underlying error:</strong> ${fmt(payload.underlying_error)}</p>` : ''}
        <p><strong>Action needed:</strong> Check the customer's Google Business Profile to see what reply (if any) is now visible on this review. If it's our text, mark the response posted manually; if it's external, dismiss as already-replied-external.</p>`;

    case 'zernio_unparseable_review_name':
      // Final-review M1 type. Indicates Zernio's review.name shape drifted
      // (e.g. an extra path segment, different prefix). Cross-cutting bug:
      // affects ALL businesses sharing the same shape pattern, so prioritize.
      return `${reviewerBlock}
        <p><strong>What happened:</strong> Zernio's review.name field did not match the expected <code>accounts/{a}/locations/{l}/reviews/{r}</code> resource path. The ingest worker refused to process the review (fail-closed) because routing to the right business depends on extracting the location segment.</p>
        <p><strong>Affected review:</strong></p>
        <pre style="background:#f5f5f5;padding:8px;border-radius:4px;overflow:auto;">${escapeHtml(String(payload.review_name_truncated ?? '—'))}</pre>
        <p><strong>Zernio account / location:</strong> ${fmt(payload.zernio_account_id)} / ${fmt(payload.zernio_location_id)}</p>
        <p><strong>Action needed:</strong> Verify Zernio's API documentation for review.name shape changes. If Zernio's contract changed, update <code>extractLocationFromReviewName</code> and <code>REVIEW_NAME_RE</code> in <code>src/lib/reviews/zernio-normalize.ts</code> + <code>src/lib/zernio/parse-review-webhook.ts</code> to accept the new shape. Once fixed, run a one-shot script to re-enqueue affected ingest_zernio_review outbox rows. This exception type indicates a cross-cutting Zernio API contract change — investigate immediately.</p>`;

    default:
      // Generic fallback for future types — emits all primitive payload fields
      // verbatim. NEVER write the misleading review_edited copy as default.
      const safeFields = Object.entries(payload)
        .filter(([_, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)
        .map(([k, v]) => `<li><code>${escapeHtml(k)}</code>: ${fmt(v)}</li>`)
        .join('');
      return `${reviewerBlock}
        <p><strong>Exception type:</strong> <code>${escapeHtml(exception.type)}</code></p>
        <p>This exception type does not have a specific email template yet. Payload fields:</p>
        <ul>${safeFields}</ul>
        <p>See the admin dashboard for full payload + handling guidance.</p>`;
  }
}
```

Tests in `worker/__tests__/AdminExceptionWorker.test.ts`:
- `review_edited_after_post` renders existing copy (regression).
- `zernio_review_not_found` with `review_id IS NULL`: no reviewer block / "no local review record" copy; payload fields (`provider_review_id`, `zernio_account_id`, etc.) appear in the body.
- `zernio_permanent_4xx`: endpoint + http_status fields surface; no "reviewer edited" copy.
- `zernio_reply_verification_indeterminate`: `reason`, account/location/review ids, `underlying_error` (when present) surface.
- **Anonymous-reviewer regression** (round-11): exception with `review_id` non-null and `reviewer_name=null` → reviewer block IS rendered with "Unknown reviewer" copy (NOT the "no local review record" branch).
- Unknown type: falls through to the generic fallback; lists payload fields; does NOT emit any of the type-specific hardcoded copy.

### 6.10c `ZernioReplyVerificationIndeterminateError` + onFailed escalation

```ts
// In ResponsePublisherWorker.ts (or worker/jobs/publisher-error-handlers.ts):
export class ZernioReplyVerificationIndeterminateError extends Error {
  constructor(readonly meta: {
    response_id: string;
    business_id: string;
    review_id: string;
    account_id: string;
    location_id: string;
    zernio_review_id: string;
    reason:
      | 'review_not_found_after_pagination'
      | 'review_found_but_reply_null'
      | 'verifier_unknown_error';
    pages_walked?: number;
    reviews_seen?: number;
    /** Captured underlying error message when reason='verifier_unknown_error'.
     *  Lets ops correlate the exception row with the original failure
     *  without scrubbing logs. */
    underlying_error?: string;
  }) {
    super(`[409 verifier indeterminate] ${meta.reason} (response=${meta.response_id})`);
    this.name = 'ZernioReplyVerificationIndeterminateError';
  }
}
```

**`worker/index.ts` publisher onFailed hook** — add a branch BEFORE the existing transient-fallback branch:

```ts
publisherWorker.on('failed', async (job, err) => {
  // ... existing handle/outbox extraction ...

  if (err instanceof ZernioReplyVerificationIndeterminateError) {
    // BullMQ retries exhausted on 409 verification. We've gotten 409 +
    // indeterminate verification N times in a row — give up cleanly with
    // the full terminal sequence (mirrors handlePublisherPermanentErrorTerminal
    // shape but with type='zernio_reply_verification_indeterminate' so ops
    // can distinguish from straight 4xx failures).
    await sql.begin(async (tx) => {
      const updated = await tx`
        UPDATE responses
        SET status = 'failed',
            posting_error = 'zernio_reply_verification_indeterminate',
            updated_at = NOW()
        WHERE id = ${err.meta.response_id}
          AND business_id = ${err.meta.business_id}
          AND status IN ('approved', 'edited', 'awaiting_owner_connect')
        RETURNING 1
      `;

      if (updated.count === 0) return;  // already terminal

      const [exception] = await tx<{ id: string }[]>`
        INSERT INTO review_exceptions (
          id, business_id, review_id, response_id, type, payload
        ) VALUES (
          ${uuidv7()}, ${err.meta.business_id}, ${err.meta.review_id},
          ${err.meta.response_id}, 'zernio_reply_verification_indeterminate',
          ${jsonb({
            reason: err.meta.reason,
            zernio_account_id: err.meta.account_id,
            zernio_location_id: err.meta.location_id,
            zernio_review_id: err.meta.zernio_review_id,
            pages_walked: err.meta.pages_walked,
            reviews_seen: err.meta.reviews_seen,
            underlying_error: err.meta.underlying_error,
            retries_exhausted_at: new Date().toISOString(),
          })}
        )
        ON CONFLICT (review_id, type) WHERE status = 'open'
        DO UPDATE SET payload = review_exceptions.payload
        RETURNING id
      `;

      if (exception) {
        await tx`
          INSERT INTO job_outbox (
            id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
          ) VALUES (
            ${uuidv7()}, 'notify_admin_review_exception', 'review',
            ${err.meta.review_id},
            ${jsonb({ review_exception_id: exception.id, business_id: err.meta.business_id })},
            0, 5
          )
        `;
      }
    });
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── ZernioTransientError branch — UPDATED per round-11/12 ──────────
  // Was: bare `await applyTransientExhaustionFallback({ response_id, business_id, correlation_id })`.
  // Now: unwrap PublisherTransientWithContext when present so the fallback
  // can pin the disconnect to the attempted account+location. The instanceof
  // ZernioTransientError check still passes (PublisherTransientWithContext
  // subclasses it), so the existing detection condition is unchanged.
  if (err instanceof ZernioTransientError) {
    const ctx = err instanceof PublisherTransientWithContext ? err.attemptContext : null;
    try {
      await applyTransientExhaustionFallback({
        response_id: ctx?.response_id ?? job.data.response_id,
        business_id: ctx?.business_id ?? job.data.business_id,
        correlation_id: job.data.correlation_id,
        account_id: ctx?.account_id,        // pinned when wrapper present
        location_id: ctx?.location_id,      // pinned when wrapper present
      });
      await markOutboxCompleted(outboxId, outboxAttempt);
    } catch (fallbackErr) {
      // Existing safety net: if even the fallback throws, mark outbox failed
      // so the row doesn't get stuck in 'dispatched'.
      const reason = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      await markOutboxFailed(
        outboxId,
        `zernio_transient_max_attempts_fallback_failed: ${reason}`,
        outboxAttempt,
      );
    }
    return;
  }

  // ── Non-transient unhandled errors — existing behavior (markOutboxFailed only) ──
  // Note: this fall-through is acceptable now that all our spec-introduced
  // failure modes throw a typed class handled by an explicit branch above
  // (indeterminate, transient-with-context). Anything reaching here is a
  // pre-existing bare-Error path or a code-bug throw, not one of the
  // categorized publisher failure modes.
  const reason = err instanceof Error ? err.message : String(err);
  await markOutboxFailed(outboxId, reason, outboxAttempt);
});
```

The new indeterminate branch lands BEFORE the updated transient branch; the transient branch's `instanceof ZernioTransientError` check still catches both bare `ZernioTransientError` (legacy or third-party callsites) and the new `PublisherTransientWithContext` (publisher-emitted). Only the wrapper variant carries `attemptContext` for pinning.

### 6.10d Shared `canonicalizeReplyText` helper

Comparing reply text by `.trim()` alone is brittle: Zernio/Google may normalize CRLF→LF, Unicode forms (NFC vs NFD), and surrounding whitespace at different points. A round-trip through their systems can produce text that's semantically identical but byte-different from what we sent.

```ts
// src/lib/zernio/canonicalize-reply.ts (NEW)
//
// Used by BOTH the publisher 409 verifier (§6.10b) AND the ingest reconcile
// helper (§6.3b) to compare reply text. Conservative normalization: trim
// outer whitespace, collapse \r\n and \r → \n, Unicode-normalize to NFC.
// Does NOT collapse internal whitespace (would change meaning).

export function canonicalizeReplyText(text: string | null | undefined): string {
  if (text == null) return '';
  return text
    .replace(/\r\n?/g, '\n')   // CRLF / CR → LF
    .normalize('NFC')           // canonical-composition Unicode normalization
    .trim();
}
```

Tests in `src/lib/zernio/__tests__/canonicalize-reply.test.ts`:
- `'hello'` === `'hello'` ✓
- `'hello\r\nworld'` === `'hello\nworld'` ✓
- `'hello\rworld'` === `'hello\nworld'` ✓
- `'café'` (precomposed é) === `'café'` (combining acute) ✓ via NFC
- `'  hello  '` === `'hello'` ✓
- internal whitespace preserved: `'a  b'` !== `'a b'` ✓ (intentional — different meaning)
- null / undefined → `''` ✓

Updated callsites:
- §6.10b 409 verifier: `canonicalizeReplyText(existingReply.comment) === canonicalizeReplyText(approvedText)`
- §6.3b reconcile: `canonicalizeReplyText(externalReplyText) === canonicalizeReplyText(r.approved_text)` (replacing the `.trim()` comparison)

**Tests:** add to `worker/__tests__/ResponsePublisherWorker.test.ts`:
- 409 + target review found on PAGE 1 with matching text → response `posted` ✓
- 409 + target review found on PAGE 2+ with matching text → response `posted` ✓ (regression for round-7 single-page bug)
- 409 + target review found with different text → response `superseded` with `already_replied_external` ✓
- 409 + target review found but `reviewReply === null` → throws `ZernioReplyVerificationIndeterminateError` with `reason='review_found_but_reply_null'`; BullMQ retries; response NOT superseded (round-8 fix — v7 superseded; the reply-null state is also indeterminate)
- 409 + target review NOT found after exhausting 4 pages → throws `ZernioReplyVerificationIndeterminateError` with `reason='review_not_found_after_pagination'`; BullMQ retries; response NOT superseded
- **Final-attempt exhaustion** (round-8 explicit test): mock BullMQ to invoke the `on('failed')` handler with `attemptsMade === maxAttempts`. Verify response transitions to `failed` with `posting_error='zernio_reply_verification_indeterminate'`; `review_exceptions` row inserted with type `'zernio_reply_verification_indeterminate'`; admin notify outbox enqueued; outbox completed.
- 409 + listReviews throws `ZernioTransientError` → caught and rethrown as `PublisherTransientWithContext` carrying `{ response_id, business_id, account_id, location_id }` (round-12 regression: ensure NOT a bare `ZernioTransientError`); BullMQ retries; on exhaustion the failed hook sees the wrapper and pins the disconnect to the attempted account+location.
- 409 + listReviews throws `ZernioAuthError` → `handlePublisherAuthErrorTerminal` invoked with the attempted account_id (regression for round-7 unpinned-disconnect bug); response transitions to `awaiting_owner_connect`; reconnect/connection-lost notify rows enqueued; outbox completed
- 409 + listReviews throws `ZernioPermanentError` → `handlePublisherPermanentErrorTerminal` invoked; response transitions to `failed`; `review_exceptions` row inserted with type `'zernio_permanent_4xx'`; admin notify outbox enqueued; outbox completed (regression for round-7 outbox-failed-without-exception bug)
- 409 + listReviews throws unknown error → wrapped in `ZernioReplyVerificationIndeterminateError` with `reason='verifier_unknown_error'` and `underlying_error` populated; on retry exhaustion → indeterminate failed-hook branch fires (response failed + review_exception with type=`'zernio_reply_verification_indeterminate'` + admin notify), NOT bare `markOutboxFailed` (round-9 fix).
- **Canonicalization regression** (round-8): existing reply has `'hello\r\nworld'`, our `approvedText` has `'hello\nworld'` → text match → `posted` (not falsely superseded). Same with NFC vs NFD Unicode forms.
- **Log redaction regression** (round-9): on text mismatch, log line contains `len=` and 12-char `fp=` hash prefix only. Assert no slice of either reply's plaintext appears in the log output.

Plus tests for the extracted helpers + new utilities:
- `worker/__tests__/publisher-error-handlers.test.ts` (NEW):
  - `handlePublisherAuthErrorTerminal` pins the disconnect to the supplied `account_id` (does NOT disconnect a sibling fresh active row at a different account)
  - Skips notify enqueues if response already terminal (mirrors existing in-worker behavior at lines 324-332)
  - `handlePublisherPermanentErrorTerminal` writes review_exception with ON CONFLICT DO UPDATE; idempotent on re-call
  - Existing in-worker auth + permanent paths refactored to call the helpers — regression: existing tests for those paths still pass
- `src/lib/zernio/__tests__/canonicalize-reply.test.ts` (NEW): identity, CRLF→LF, CR→LF, NFC normalization, trim, internal-whitespace preserved, null/undefined.

### 6.11 `lookupZernioReviewId` early-return

`src/lib/publishing/zernio-publisher.ts:48` currently selects `reviewer_name, review_date, review_text, star_rating`. Round-2 review surfaced two correctness gaps in the v2 spec: (a) the prefix-only `startsWith("zernio://${accountId}/")` check would let a same-account different-location row through; (b) the publisher caller already has `zernio_location_id` in scope (`worker/jobs/ResponsePublisherWorker.ts:111-116`), so we should pass it in and require an EXACT match.

**Updated function signature:** `lookupZernioReviewId(businessId, ourReviewId, accountId, locationId)`. The publisher caller passes `zernioConnection.zernio_location_id`.

```ts
const [ourReview] = await sql<OurReviewRowExpanded[]>`
  SELECT reviewer_name, review_date, review_text, star_rating,
         provider, provider_review_id, provider_location_name
  FROM reviews
  WHERE id = ${ourReviewId} AND business_id = ${businessId}
  LIMIT 1
`;

if (!ourReview) {
  throw new ZernioReviewNotFoundError({ ourReviewId, accountId, reason: 'review_not_found' });
}

// Early-return for Zernio-sourced rows: provider_review_id IS canonical.
// REQUIRE EXACT location match against the active connection — a same-account
// different-location row is NOT safe to short-circuit, since posting to that
// review id would target the wrong GBP location.
if (ourReview.provider === 'zernio') {
  const expectedLocationName = `zernio://${accountId}/locations/${locationId}`;
  if (ourReview.provider_location_name === expectedLocationName) {
    await redis.setex(cacheKey, CACHE_TTL_SECONDS, ourReview.provider_review_id);
    return ourReview.provider_review_id;
  }
  // Provider says zernio but location MISMATCH — fall through to field-match
  // (which will throw ReviewNotFoundError if it can't reconcile). This is the
  // safe path: never short-circuit when location identity is uncertain.
}

// Existing field-match path for legacy provider='serpapi_poll' rows
// (or zernio rows where the connection swapped to a different location
// post-ingestion).
```

The publisher caller at `worker/jobs/ResponsePublisherWorker.ts` already loads `zernio_location_id` alongside `zernio_account_id` from the connection row (line 111-116). Pass it through to `lookupZernioReviewId` as a fourth argument.

### 6.12 Files modified — full list

- `src/lib/reviews/types.ts` — widen `ReviewIdentity.provider` to `'serpapi_poll' | 'zernio'`; add `'zernio_id'` to `identityStrategy`.
- `src/lib/reviews/index.ts` — drop `SerpApiMonitor`, `MockSerpApiMonitor` exports. Add `buildZernioMonitoredReview`, `extractLocationFromReviewName`, `ZernioReviewNormalizationError`.
- `src/lib/reviews/process-review.ts` — accept `options.suppressNotification`; ON CONFLICT DO NOTHING on review insert; propagate flag through every `generate_response` outbox payload.
- `src/lib/shared/mock-mode.ts` — drop `getReviewMonitor()`.
- `src/lib/shared/queue-names.ts` — remove `'sync_reviews'`. Add `'ingest_zernio_review'`, `'zernio_initial_backfill'`.
- `src/lib/shared/worker-types.ts` — add `IngestZernioReviewPayload`, `ZernioInitialBackfillPayload`. Add `suppress_notification?: boolean` to `GenerateResponsePayload` and the relevant `send_notification` payload.
- `worker/queues.ts` — drop `sync_reviews`. Add `ingest_zernio_review`, `zernio_initial_backfill`.
- `worker/index.ts` — unregister `handleReviewSync` + `startReconciliationPoller`. Register `handleZernioReviewIngest` + `handleZernioBackfill`.
- `worker/ingress/zernio.ts` — replace counter with fan-out outbox enqueue per §4.3.
- `worker/jobs/ResponseGeneratorWorker.ts` — read `suppress_notification` flag from `generate_response` payload; SKIP the `send_notification` outbox enqueue when true (§6.7). No `notification_deliveries` row written.
- `src/lib/publishing/zernio-publisher.ts` — `lookupZernioReviewId` now takes `locationId` arg; exact `provider_location_name` match required for early-return (§6.11). Caller `worker/jobs/ResponsePublisherWorker.ts` passes `zernio_location_id`. Also: `listAllReviews` calls in the field-match path (line 63-66) now pass `locationId`.
- `worker/jobs/ResponsePublisherWorker.ts` — major refactor (§6.10b/c):
  - Extract the existing in-worker auth-error block (lines 294-368) into `handlePublisherAuthErrorTerminal` in the new shared helpers module. Replace the in-worker block with a call.
  - Extract the existing in-worker permanent-error block (lines 371-440) into `handlePublisherPermanentErrorTerminal`. Replace with a call.
  - Replace the unconditional 409 mark-posted (lines 278-292) with the new verify-first flow that paginates listReviews (max 4 pages) and dispatches via the same helpers on classified errors. Throw `ZernioReplyVerificationIndeterminateError` on indeterminate (not-found OR found-but-reply-null).
- `worker/index.ts` — publisher `on('failed')` hook gets a new branch for `ZernioReplyVerificationIndeterminateError` (§6.10c). Lands BEFORE the existing `ZernioTransientError` branch. Full terminal sequence: response→`failed` with `posting_error='zernio_reply_verification_indeterminate'`, INSERT review_exceptions type='zernio_reply_verification_indeterminate', enqueue admin notify, complete outbox.
- `worker/jobs/AdminExceptionWorker.ts` (lines 61-72) — replace hardcoded `review_edited_after_post` body with type-aware `renderExceptionBody()` switch (§6.10b'). Generic fallback for unknown types. Reviewer/review-text block conditional on `review_id` presence (round-10 fix — `zernio_review_not_found` rows have `review_id IS NULL`).
- `src/lib/zernio/client.ts` — `listReviews` and `listAllReviews` signatures take `locationId` (§6.0). Updates `mockResponse` for `list_reviews` (no behavior change — still returns empty).
- `worker/jobs/PlaceIdValidationWorker.ts` — remove `enqueueSyncReviews` helper and its call site. Worker exits after marking `place_id_verified=true`.
- `src/app/api/onboarding/business/route.ts` — remove `topic='sync_reviews'` branch from §6.9.
- `src/lib/onboarding/create-business.ts` — remove sync_reviews branch from §6.9.
- `src/app/api/zernio/connect/select-location/route.ts` — add backfill outbox enqueue per §6.8. (Verified path; v3-spec mistakenly said `/api/dashboard/connect/...`)
- `src/lib/publishing/zernio-publisher.ts` — expanded SELECT + gated early-return per §6.11.
- `src/lib/shared/schemas.ts` — `SelectPlanSchema` accepts `'premium'`.
- `src/app/onboarding/pay/PlanPickerClient.tsx` — Premium plan card + widened type.
- `src/lib/payments/payment-link.ts` — add Premium tier branch.
- `worker/ingress/stripe.ts` — add `STRIPE_PRICE_PREMIUM` mapping.
- `worker/startup-assert.ts` — require `STRIPE_PAYMENT_LINK_PREMIUM`.
- `src/app/api/onboarding/__tests__/select-plan.test.ts:159` — flip the "rejects premium" test.
- `.env.example` — add `STRIPE_PAYMENT_LINK_PREMIUM`, `STRIPE_PRICE_PREMIUM`.
- `.claude/CLAUDE.md` — update tech stack, remove SerpAPI polling references, add backfill behavior, document migration 028.

### 6.12b Remove `awaiting_manual_post` — manual-post fallback decommissioned

**Decision:** drop manual-post entirely. When Zernio is disconnected or down, surface a single "Google integration unavailable" message to the owner instead of routing through a sales-partner copy-paste workflow.

**Why this is a clean cut:** the status `'awaiting_manual_post'` is **already dormant** in the current shipped code. The post-PR-#9 publisher flow at `worker/jobs/ResponsePublisherWorker.ts:119-167` transitions no-connection responses to `'awaiting_owner_connect'`, NOT `'awaiting_manual_post'`. Approval helpers (`token-mode.ts`, `session-mode.ts`, `callback-mode.ts`) write `'approved'` or `'edited'`, never `'awaiting_manual_post'`. The status persists in the schema and a few code paths only as a backward-compat artifact for pre-Zernio in-flight rows. Per CLAUDE.md, prod has zero customer data — there are no `'awaiting_manual_post'` rows in prod to worry about.

**Files DELETED:**
- `src/app/admin/businesses/[id]/manual-post-section.tsx`
- `src/app/admin/businesses/[id]/components/ManualPostFlow.tsx`
- `src/app/api/admin/businesses/[id]/mark-posted/route.ts` (and any tests under it)
- `src/lib/notifications/email/templates/manual-post.ts` (the `buildManualPostEmailHtml` template — admin/sales-partner email body for the manual-post workflow; orphaned once the workflow is gone)
- Any tests directly exercising `buildManualPostEmailHtml` (`src/lib/notifications/email/templates/__tests__/manual-post.test.ts` if present)
- `worker/__tests__/resend-webhook-bounce.test.ts` test case at lines 192-197: `'does NOT flag owner_email_bounced when hard bounce comes from admin_manual_post template'` — the template no longer exists so the test is dead code.

**Files MODIFIED:**
- `src/app/admin/businesses/[id]/page.tsx` — drop the `awaitingPost` filter at line 51 and the `<ManualPostFlow ... />` render call.
- `src/components/dashboard/ReviewsList.tsx:13` and `src/app/admin/businesses/[id]/components/ReviewsList.tsx:21` — remove the `awaiting_manual_post: 'bg-orange-100 text-orange-800'` color class entry.
- `src/lib/shared/response-status.ts` — remove `'awaiting_manual_post'` from `HANDLED_STATUSES`, `AWAITING_PUBLISH_STATUSES`, the `ResponseStatus` union, and any other helper sets.
- `src/lib/shared/__tests__/response-status.test.ts` — update tests (remove the `'awaiting_manual_post'` assertions; keep the `'awaiting_owner_connect'` ones).
- `src/lib/shared/constants.ts:9` — remove `AWAITING_MANUAL_POST: 'awaiting_manual_post'` constant.
- `src/lib/reviews/process-review.ts:161` — remove `activeResponse.status === 'awaiting_manual_post' ||` from the active-status check (the OR-chain shrinks to `'posted' || 'awaiting_owner_connect'` and similar).
- `worker/jobs/ResponsePublisherWorker.ts:82-86` — the legacy comment explaining the exclusion of `'awaiting_manual_post'` from `ZERNIO_PUBLISHABLE_STATES` becomes stale; rewrite the comment to reflect that the status no longer exists.
- `worker/__tests__/ResponsePublisherWorker.test.ts:133` — drop the `['awaiting_manual_post']` table-row test case.
- `src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx:186` — replace the "fall back to the manual-post path until the owner connects" copy with "stay queued in the dashboard until the owner connects Google" or similar (the no-Zernio-connection path produces zero ingested reviews now, so there's nothing to "fall back" to anyway).
- `src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx:237-239` — remove or rewrite the comments referencing `awaiting_manual_post` transitions.
- `src/app/admin/runbook/page.tsx:67` — replace the line claiming "Manual posting is normal for MVP" with copy aligned to the Zernio-only flow.
- `src/lib/notifications/email.ts:13` — remove the `export * from './email/templates/manual-post';` barrel re-export (the file it points to is being deleted).
- `src/lib/notifications/email/headers.ts:10` — clean the comment listing "manual-post instructions" as an example use of the `internal` template family. Replace with a different remaining example (admin exception, partner alerts) so the comment stays accurate.
- `src/lib/notifications/email/templates/internal.ts:3` — same: the leading comment mentions "manual-post instructions"; rewrite to reference still-extant use cases.
- `src/lib/notifications/email/templates/shared.ts:7` — same: comment lists `manual-post` in the family enumeration; remove that entry from the comment.
- `src/lib/notifications/delivery.ts:8` — comment mentions "ResponsePublisherWorker (admin manual-post emails)"; rewrite to drop the manual-post mention.
- `worker/ingress/resend.ts:122,270` — both lines are inside comments enumerating admin/partner template names and mention `admin_manual_post`. Drop just that token from the enumerations (the surrounding bounce-classification logic still runs for other admin templates like `admin_exception`).
- `src/lib/notifications/__tests__/delivery.test.ts:51-55` — the "accepts null response_id for admin-directed deliveries" test passes `'admin_manual_post'` as the template fixture. Replace with a still-valid admin-directed template name (e.g. `'admin_exception'`) so the test continues to assert the null-response_id path without resurrecting the dead template name. Round-final-4 fix.
- `.claude/CLAUDE.md` line 139 — remove `'awaiting_manual_post'` from the response status enum list.
- `.claude/CLAUDE.md` line 142 — delete the `awaiting_manual_post` description paragraph.

**Schema changes (migration 029 — NEW):**

```sql
-- supabase/migrations/029_drop_awaiting_manual_post.sql
--
-- Decommission the manual-post fallback: terminate any orphaned in-flight
-- rows in dev/staging, and rebuild the partial unique indexes from
-- migrations 023 + 026 to drop the dead status from the predicate. The
-- status value itself stays as a free-form TEXT (responses.status is
-- unconstrained TEXT post-migration 026) — no enum to alter.

-- 1. Bulk-terminate any existing 'awaiting_manual_post' rows. Sets a
--    distinct posting_error so ops can audit the migration's effect.
--    Prod has zero such rows per CLAUDE.md status; this is defensive
--    for dev/staging environments and any rare legacy in-flight data.
UPDATE responses
  SET status = 'failed',
      posting_error = 'manual_post_deprecated_2026_04',
      updated_at = NOW()
  WHERE status = 'awaiting_manual_post';

-- 2. Rebuild the non-terminal uniqueness index without the dead status.
--    Mirrors migration 026 line 49-57 but drops 'awaiting_manual_post'.
DROP INDEX IF EXISTS responses_one_non_terminal_per_review;

CREATE UNIQUE INDEX IF NOT EXISTS responses_one_non_terminal_per_review
  ON responses (review_id)
  WHERE status IN (
    'pending_approval',
    'approved',
    'edited',
    'awaiting_owner_connect'
  );

COMMENT ON INDEX responses_one_non_terminal_per_review IS
  'Enforces "at most one non-terminal response per review". Migration 029 '
  'dropped awaiting_manual_post from the predicate after the manual-post '
  'fallback was decommissioned.';

-- 3. Drop the dedup index from migration 024. Its predicate is
--    `template = 'admin_manual_post'`, which can no longer be satisfied
--    after manual-post is decommissioned (no more admin_manual_post
--    delivery rows are produced). The index is harmless but stale; drop
--    for cleanliness so future ops queries against pg_indexes don't show
--    an orphan entry. Round-final-2 review item L2.
DROP INDEX IF EXISTS notification_deliveries_response_template_uniq;
```

**"Service down" messaging:**

The existing `awaiting_owner_connect` flow already covers the disconnected case with a "Connect Google" banner. For the Zernio-API-outage case (transient retry exhaustion → response also parks at `awaiting_owner_connect` via the existing `applyTransientExhaustionFallback` path), the same banner appears even though the connection might still be active server-side. Acceptable v1 UX with one copy tweak:

- Update the dashboard "Connect Google" banner copy to use this two-clause wording: *"Reconnect Google Business to resume publishing. If you've already reconnected and this still appears, our Google Reviews integration may be temporarily unavailable; we'll resume automatically once it's restored."*
- Update the `notify_owner_reconnect` email template body to use the same wording.

**Why the two-clause framing matters.** An earlier draft used "No action needed" as the trailing line. Round-final-2 review caught that this could suppress reconnects in the most common case (genuine auth-failure disconnect): the owner reads "no action needed" and ignores the banner indefinitely. The corrected copy LEADS with the reconnect ask (which is the right action ~95% of the time — disconnect is far more likely than a Zernio outage) and only THEN offers the fallback explanation. Owner who hasn't reconnected: prompted correctly. Owner who has reconnected: gets the explanation that further wait is appropriate.

This single-message-covers-both-cases approach avoids needing a programmatic "is Zernio up?" status indicator while still steering owners toward the right action.

**Tests:**
- Update `src/lib/shared/__tests__/response-status.test.ts` to drop `awaiting_manual_post` references.
- Update `worker/__tests__/ResponsePublisherWorker.test.ts:133` table.
- Add migration 029 dry-run test: insert a fixture `awaiting_manual_post` row → apply migration → assert row's status is now `'failed'` with `posting_error = 'manual_post_deprecated_2026_04'`; assert the partial unique index doesn't include `'awaiting_manual_post'` in its predicate.

### 6.13 NEW files (final list)

- `src/lib/reviews/zernio-normalize.ts` (§6.2)
- `worker/jobs/ZernioReviewIngestWorker.ts` (§6.3) — exports `ZernioIngestReviewNotFoundError`
- `worker/jobs/ZernioBackfillWorker.ts` (§6.4)
- `worker/jobs/zernio-ingest-shared.ts` — shared `handleZernioIngestError` helper + `reconcileExternallyAnsweredReview` helper (§6.3, §6.3b)
- `src/lib/zernio/auth-error-fallback.ts` — `applyIngestionAuthErrorFallback` helper (§6.5b). Distinct from publisher's response-scoped fallback.
- `src/lib/zernio/parse-review-webhook.ts` — `parseZernioReviewWebhook` + `ZernioReviewWebhookParseError` (§6.6b)
- `src/lib/zernio/__tests__/parse-review-webhook.test.ts` — payload parser unit tests (nested account, bare review id, resource-name, agreement/disagreement, malformed cases)
- `worker/jobs/publisher-error-handlers.ts` — `handlePublisherAuthErrorTerminal` + `handlePublisherPermanentErrorTerminal` (§6.10b — extracted from existing in-worker code; pinned to attempted `account_id`; idempotent permanent-exception upsert). ALSO exports `ZernioReplyVerificationIndeterminateError` class (§6.10c).
- `worker/__tests__/publisher-error-handlers.test.ts`
- `src/lib/zernio/canonicalize-reply.ts` — `canonicalizeReplyText(text)` shared helper (§6.10d; CRLF→LF + Unicode NFC + trim; preserves internal whitespace).
- `src/lib/zernio/__tests__/canonicalize-reply.test.ts`
- `src/lib/reviews/__tests__/zernio-normalize.test.ts`
- `worker/__tests__/ZernioReviewIngestWorker.test.ts`
- `worker/__tests__/ZernioBackfillWorker.test.ts`
- `worker/__tests__/zernio-ingest-shared.test.ts`
- `src/lib/zernio/__tests__/auth-error-fallback.test.ts`
- `supabase/migrations/028_zernio_backfill_runs.sql`
- `supabase/migrations/029_drop_awaiting_manual_post.sql` (§6.12b — bulk-fail orphan rows + rebuild non-terminal uniqueness index without the dead status)

## 7. Mock mode

`MOCK_EXTERNAL_APIS=true` already short-circuits `zernioClient.request()` (`src/lib/zernio/client.ts:128`). The mock returns `{ reviews: [], nextPageToken: undefined }` for `list_reviews`. Behavior with this short-circuit:

- **Ingest worker:** §6.3 step 4 (the mock-mode short-circuit branch in the worker pseudocode) intercepts BEFORE listReviews is called and `markOutboxCompleted` immediately. Without that branch, the empty-list result would trigger `ZernioIngestReviewNotFoundError` on every dev event, burn through BullMQ retries, and escalate to `review_exceptions` — undesirable in dev. The §6.3 branch is the canonical mitigation.
- **Backfill worker:** doesn't need an explicit short-circuit. `listAllReviews` returns `[]` via the mock, the `answered`/`unanswered` filters produce empty buckets, no `processReview` calls fire, the backfill_runs row's count fields all stay at 0, and `completed_at` is set normally. A backfill_runs row IS written (one per business per first-connect event), but with all-zero counts — harmless in dev.

For local dev / E2E that needs synthetic Zernio reviews flowing through the full pipeline, a future `MOCK_ZERNIO_REVIEWS_FIXTURE` env var pointing at a JSON file is a straightforward addition. Out of scope.

## 8. Concurrency & idempotency

- **Webhook → outbox:** existing `claim_inbound_event` dedup. Duplicate webhook delivery → zero outbox rows on second claim.
- **Webhook fan-out:** §4.3 inserts one outbox row per active connection. Each row is independently dispatched, processed, idempotent.
- **Outbox → worker:** `processReview` uses `FOR UPDATE` + `ON CONFLICT DO NOTHING` (§6.6). Concurrent first-time inserts: one wins, one becomes 'unchanged' no-op.
- **Backfill vs webhook race:** if a webhook arrives mid-backfill for a review the backfill is also inserting, one wins via the `ON CONFLICT` path. No duplicate work.
- **Backfill runs uniqueness:** `zernio_backfill_runs_one_per_business` partial unique index + `ON CONFLICT (business_id) DO NOTHING` on the upsert. Re-firing is safe and observable.
- **Backfill enqueue idempotency:** the connect-callback `first` predicate (§6.8) prevents re-enqueue on disconnect/reconnect. If a bug bypasses it, the worker's `ON CONFLICT DO NOTHING` on the backfill_runs row becomes the second-line guard — the second attempt does nothing.
- **Stripe webhook replay:** `subscription_activated_at` already uses `COALESCE` write-once at `worker/ingress/stripe.ts:105`. No change needed.

## 9. Cost model

| Scenario | Old (SerpAPI) | New (Zernio) | Savings |
|---|---|---|---|
| Polling per active business | 720 calls/month | 0 | 100% |
| Webhook-driven ingestion | n/a | ~5-15 Zernio calls/month/business | n/a |
| First-connect backfill | n/a | 1-4 calls/business (one-time) | n/a |
| Demo prospect | ~1-3 SerpAPI calls/demo (unchanged) | unchanged | 0% |
| Onboarding form prefill | ~1 SerpAPI call/signup (unchanged) | unchanged | 0% |
| URL→placeId resolution | ~0-1 SerpAPI calls (unchanged) | unchanged | 0% |

Zernio API cost is included in the existing Inbox add-on subscription — already paid for.

## 10. Testing strategy

### 10.1 Unit tests

- **`zernio-normalize.test.ts`** — identity construction with location segment; content hash determinism; null comment handling; anonymous reviewer; rejection of malformed inputs (missing id, invalid rating, unparseable createTime); `extractLocationFromReviewName` happy + malformed paths.
- **`ZernioBackfillWorker.test.ts`** — gap-only / historical-only / mixed bucket handling; cap enforcement; tier gating (founding+standard skip historical, premium includes); answered-vs-unanswered split; answered review with active legacy SerpAPI draft → superseded; answered review with our reply text → no-op (no false supersession); `createTime DESC` sort applied before slice; subscription-guard early exit; suppress_notification flag propagated; backfill_runs row written with correct counts; mock-mode short-circuit; **reconcile failure handling: at least one reconcile throws → counts updated but `completed_at` stays NULL → worker throws → BullMQ retry → resume runs cleanly** (round-6 fix).
- **`ZernioReviewIngestWorker.test.ts`** — review found in page 1; found in page 2; not found → throws `ZernioIngestReviewNotFoundError` for retry; location mismatch (defined but different) → no-op; location unparseable → throws (fail closed); account-id mismatch → no-op; subscription guards; mock-mode short-circuit (no spurious exceptions / review_exceptions); per-error-class disposition table; ZernioAuthError → calls applyIngestionAuthErrorFallback.
- **`zernio-ingest-shared.test.ts`** — error-class dispatch matrix (auth → fallback helper called, permanent → markFailed, transient → throw, etc.).
- **`auth-error-fallback.test.ts`** — disconnects only matching connection (not sibling locations); enqueues connection_lost notify; second concurrent invocation no-ops on already-disconnected row.
- **`process-review.test.ts`** updates — ON CONFLICT race-loss with SAME content → returns 'unchanged'; race-loss with DIFFERENT (newer) content → falls through to existing-row update branch and emits 'updated'; suppress_notification propagates into generate_response payload.
- **`reconcile-externally-answered.test.ts`** (NEW or part of `zernio-ingest-shared.test.ts`):
  - **Mixed legacy/Zernio scenario** (round-9 regression): two matched review rows for the same physical Google review — one zernio row with active approved response whose `approved_text` matches the external reply, one legacy serpapi_poll row with active approved response whose text DIFFERS. Assert: zernio response is PROTECTED (not superseded); legacy response IS superseded with `posting_error='already_replied_external'`.
  - All-protected case: every active response matches the external reply → no supersession, no rows mutated.
  - All-stale case: no active response matches → all superseded.
  - Pending-approval edge: pending response (approved_text=NULL) cannot match → always superseded when any external reply detected.
- **`ResponseGeneratorWorker.test.ts`** updates — `suppress_notification=true` skips send_notification enqueue; `false` enqueues normally; assert no notification_deliveries row written either way.
- **`zernio-publisher.test.ts`** updates — exact location-name match enables early-return; mismatched location falls through to field-match (regression check); legacy `provider='serpapi_poll'` rows still hit field-match.

### 10.2 Integration tests (real Postgres + mocked Zernio HTTP)

- End-to-end webhook → fan-out outbox → ingest worker → review row → response generated.
- Multi-connection fan-out: two businesses sharing one zernio_account_id, different locations. Webhook for review at location A → only business A's review row created.
- Backfill: seeded `zernio_connections` row + first-activation predicate trip → backfill outbox → worker fetches mocked Zernio response → reviews + responses created → backfill_runs row populated → no notification emails fired.
- Race: backfill mid-loop pauses; webhook arrives for same review id → both serialize via `ON CONFLICT` → exactly one review row.

### 10.3 Migration 028 dry-run

Apply migration in a Supabase branch DB; insert one fixture row; assert the partial unique index rejects a duplicate `business_id`.

### 10.4 Manual smoke (staging)

Wire one staging business to a real Zernio sandbox profile, post a fresh review on the sandbox GBP, verify webhook → outbox → ingest → review row → response generated. Captured as an amendment to `docs/zernio-launch-runbook.md` (existing).

## 11. Future work (intentionally deferred)

- **Notification digest engineering.** This spec resolves the first-connect blast via suppression. If the steady-state webhook stream produces clusters (e.g. 5 reviews in 10 minutes from a viral Yelp post), the existing one-email-per-review behavior would resume. A future digest worker (10-minute settle window, single email) would smooth the spike.
- **Zernio reconciliation backstop poller.** If missed-event rate exceeds an acceptable threshold, add a 6-hourly `listReviews` poll per active connection. Same outbox/worker shape.
- **Drop legacy `lookupZernioReviewId` field-match.** Once all `provider='serpapi_poll'` rows have aged out of the active response queue, the field-match fallback in `zernio-publisher.ts` is dead code. Schedule a cleanup PR after 90 days.
- **Tier-upgrade backfill.** A customer who joins on standard then upgrades to premium doesn't get retroactive historical backfill today. Possible follow-up: trigger `zernio_initial_backfill` on `standard → premium` Stripe transition. Requires a `tier_changed_at` column.
- **Mock Zernio reviews fixture.** Local dev with synthetic review streams beyond the empty-list mock (env-gated JSON file).

## 12. Rollout

1. Apply migrations in prod Supabase via SQL editor (per `feedback_supabase_migrations.md`), in strict order:
   - First: **028** (`zernio_backfill_runs` table — additive schema for the new ingestion path).
   - Then: **029** (`drop_awaiting_manual_post` — bulk-fail orphans + rebuild `responses_one_non_terminal_per_review` without the dead status + drop the now-unsatisfiable `notification_deliveries_response_template_uniq` index from migration 024). Must run AFTER 028 so the cutover sequence stays consistent.
2. Merge code changes behind `ZERNIO_PUBLISHING_ENABLED=false`.
3. Set `STRIPE_PAYMENT_LINK_PREMIUM` and `STRIPE_PRICE_PREMIUM` in prod env. Worker startup assertion now requires the payment link when `SELF_SERVE_SIGNUP_ENABLED=true`.
4. Manual smoke on staging Zernio sandbox: post review → verify webhook → outbox → ingest → response in dashboard.
5. Manual smoke on premium plan: complete a Stripe Checkout via the new Payment Link → tier flips to `'premium'` → backfill on connect respects historical bucket cap.
6. Flip `ZERNIO_PUBLISHING_ENABLED=true` in prod (no separate ingestion flag — same gate as publishing).
7. Onboard one pilot customer per existing `docs/zernio-launch-runbook.md`.

## 13. Acceptance criteria

- [ ] `pnpm test` passes including new ingest + backfill worker tests + updated process-review tests.
- [ ] `pnpm lint` clean.
- [ ] Migration 028 applied in dev; `zernio_backfill_runs` table present with the partial unique index.
- [ ] All three `sync_reviews` producers deleted; grep for `'sync_reviews'` returns only historical migrations and updated tests.
- [ ] `pending_payment` business onboarded → no `sync_reviews` outbox row created (zero ingestion until Zernio connect).
- [ ] `MOCK_EXTERNAL_APIS=true` ingest worker boots clean, no SerpAPI calls observed in logs during a synthetic review event, no spurious `review_exceptions` rows created.
- [ ] With real Zernio sandbox: webhook → outbox fan-out → ingest worker → review row → response draft visible in dashboard end-to-end.
- [ ] First-connect backfill on staging produces exactly the expected gap+historical counts for a fixture with 100 reviews split across the cutoff date; `zernio_backfill_runs` row populated; ZERO approval emails sent.
- [ ] Premium-plan picker visible in `/onboarding/pay`; Stripe Payment Link redirects correctly; webhook flips tier to `'premium'`.
- [ ] Old `provider='serpapi_poll'` rows in dev still publish via existing field-match path (regression check on the gated early-return).
- [ ] No SerpAPI call observed for any business during steady-state (post-connect) operation; SerpAPI call counts remain only on demo + onboarding-prefill + URL-resolver code paths.
- [ ] Webhook fan-out test: 2 businesses sharing one zernio_account_id at different locations → review for location A only creates a row in business A.
- [ ] Manual-post UI/code/status fully removed: grep for `awaiting_manual_post` returns matches ONLY in historical migrations (001, 023, 026), the new migration 029, and the spec itself. No production source files reference the dead status.
- [ ] Migration 029 applied (in prod, AFTER migration 028):
   - Any pre-existing `awaiting_manual_post` rows are now `'failed'` with `posting_error='manual_post_deprecated_2026_04'`.
   - `responses_one_non_terminal_per_review` index predicate excludes `'awaiting_manual_post'` (verify via `\d+ responses_one_non_terminal_per_review` in psql / Supabase SQL editor).
   - `notification_deliveries_response_template_uniq` index is GONE (verify via `\d+ notification_deliveries` showing it no longer listed; or `SELECT indexname FROM pg_indexes WHERE indexname = 'notification_deliveries_response_template_uniq'` returns zero rows).
- [ ] Admin UI for `/admin/businesses/[id]` no longer renders the "Awaiting Manual Post" section (no `<ManualPostFlow />` component on the page).
- [ ] Approval banner + `notify_owner_reconnect` email body contain the EXACT v17 two-clause wording from §6.12b: *"Reconnect Google Business to resume publishing. If you've already reconnected and this still appears, our Google Reviews integration may be temporarily unavailable; we'll resume automatically once it's restored."* (Snapshot test on the email template body asserting the exact string is present.)
- [ ] `src/lib/notifications/email/templates/manual-post.ts` deleted; barrel re-export at `src/lib/notifications/email.ts:13` removed; grep for `buildManualPostEmailHtml` returns zero matches in source.

## 14. Changelog v18 → v19 (this revision)

Round-final-4 — 1 Low item, applied:

- **L1:** added `src/lib/notifications/__tests__/delivery.test.ts:51-55` to §6.12b's MODIFY list. The "accepts null response_id for admin-directed deliveries" test fixture was passing `'admin_manual_post'` as the template name. Round-final-2 cleaned every other reference to `admin_manual_post`, but this one slipped past the audit. Replace with `'admin_exception'` (still-valid admin-directed template) so the test continues to assert the null-response_id invariant without resurrecting the dead template name in the codebase. Plan step 18b updated to match.

## 15. Changelog v17 → v18

Round-final-3 doc-consistency review — 3 Low items, all applied:

- **L1 (§13 acceptance copy):** the banner/email-copy acceptance criterion now spells out the exact v17 two-clause wording ("Reconnect Google Business to resume publishing. If you've already reconnected and this still appears...") instead of the partial "If you've already connected..." snippet that risked locking in the stale v16 copy at verification time. Snapshot-test reference added.
- **L2 (header + rollout migration list):** updated the spec header `**Related migrations:**` line and §12 rollout step 1 to enumerate BOTH 028 AND 029 with strict apply order ("028 BEFORE 029"). v17 listed only 028.
- **L3 (§13 acceptance for migration 024 index drop):** added an explicit verification step for `notification_deliveries_response_template_uniq` removal — mirrors the plan step 18a check via `\d+ notification_deliveries` + `pg_indexes` query. Also expanded the migration-029 acceptance into sub-bullets so each operation (orphan UPDATE, response index rebuild, notification index drop) has its own checkpoint.
- Bonus: cleaned the v15 → v16 changelog entry's "No action needed" quotation, replaced with a pointer to the v17 corrected wording so future readers don't accidentally lift the deprecated phrasing.

## 16. Changelog v16 → v17

Round-final-2 review on the manual-post removal — 4 issues, all applied:

- **M1 (§6.3b):** removed `'awaiting_manual_post'` from the active-response IN-clause in `reconcileExternallyAnsweredReview`. v16 still listed it; the §13 grep acceptance criterion would have failed when the new `worker/jobs/zernio-ingest-shared.ts` was implemented from this pseudocode. Added an inline comment forbidding re-introduction.
- **M2 (§6.12b "Service down" messaging):** replaced the "No action needed" trailing copy with a two-clause structure: lead with "Reconnect Google Business to resume publishing", then offer the temporarily-unavailable fallback explanation. Earlier copy could have suppressed reconnects in the most common case (genuine auth-failure disconnect ≠ rare Zernio outage). Now leads with the correct action and only adds the fallback for already-reconnected owners.
- **L1 (§6.12b file lists):** added the missed manual-post email artifacts:
  - DELETE: `src/lib/notifications/email/templates/manual-post.ts` (template body) + the resend bounce test case for `admin_manual_post`.
  - MODIFY: `src/lib/notifications/email.ts:13` (drop barrel re-export), `email/headers.ts:10`, `email/templates/internal.ts:3`, `email/templates/shared.ts:7`, `notifications/delivery.ts:8`, `worker/ingress/resend.ts:122,270`, `ZernioConnectionPanel.tsx:186` — all comment cleanups referencing the deprecated workflow.
- **L2 (migration 029):** added `DROP INDEX IF EXISTS notification_deliveries_response_template_uniq;` as step 3 of the migration. The migration-024 index's predicate is `template='admin_manual_post'` which can no longer be satisfied — orphan stays in `pg_indexes` if not dropped explicitly. Round-final-2 review item.

## 17. Changelog v15 → v16

User-driven scope decision: drop the manual-post fallback entirely. When Zernio is disconnected or down, the dashboard surfaces a "Google integration unavailable" message — there is no longer a sales-partner copy-paste workflow.

- **§6.12b NEW** — full deletion + cleanup spec for the manual-post path:
  - Confirmed `'awaiting_manual_post'` is already dormant in shipped code: the post-PR-#9 publisher's no-connection branch transitions to `'awaiting_owner_connect'`, NOT `'awaiting_manual_post'`. Approval helpers write `'approved'`/`'edited'`. The status persists only as a backward-compat artifact for pre-Zernio in-flight rows. Prod has zero such rows per CLAUDE.md.
  - Files DELETED: `manual-post-section.tsx`, `ManualPostFlow.tsx`, `mark-posted/route.ts`.
  - Files MODIFIED (12 source + tests + CLAUDE.md): drop the status from response-status helpers, dashboard color maps, `process-review.ts:161` active-status check, ResponsePublisherWorker excluded-states comment, runbook copy, ZernioConnectionPanel comments.
  - Migration 029 NEW: bulk-UPDATE any orphan `'awaiting_manual_post'` rows to `'failed'` with `posting_error='manual_post_deprecated_2026_04'` (defensive — prod no-op, drains dev/staging); rebuild the migration-026 partial unique index `responses_one_non_terminal_per_review` without the dead status in its WHERE predicate.
- **"Service down" messaging** — single-banner approach. Updated dashboard `Connect Google` banner copy + `notify_owner_reconnect` email body. (NB: the v16 wording shipped here used a "No action needed" trailer that round-final-2 review (v17) replaced with a two-clause structure leading with the reconnect ask. See v16 → v17 changelog entry for the final wording.) Avoids needing a programmatic Zernio-status indicator.
- **§13 acceptance criteria** added 4 new checkboxes covering: grep for `awaiting_manual_post` returns historical migrations only; migration 029 applied; admin UI no longer renders the manual-post section; updated banner/email copy.
- **Plan** added Phase D' (steps 18a/18b/18c) between the producer-removal and consumer-removal phases. Migration 029 ships in 18a; code deletions in 18b; copy updates in 18c.

## 18. Changelog v14 → v15

Self-review pass after v14 surfaced 3 medium + 4 low items — all applied:

- **M1:** §6.3 + §6.5 — added `ZernioIngestUnparseableLocationError` typed class + dedicated branch in a new `ingestZernioReviewWorker.on('failed')` hook. v14 threw a bare `Error` for unparseable review.name, which fell through to the generic `markOutboxFailed` after retry exhaustion — silent failure with no admin trail. The new branch writes `review_exceptions type='zernio_unparseable_review_name'` + admin notify (this signals a Zernio API contract change; warrants immediate ops attention, unlike the high-volume `zernio_review_not_found` case which deliberately omits admin notify). §6.10b' AdminExceptionWorker rendering extended with a switch case for the new type.
- **M2:** §6.8 — replaced the strict "first activation only" predicate with a combined `needs_backfill` check that ALSO enqueues backfill when `zernio_backfill_runs` has no row with `completed_at IS NOT NULL`. v14 would have permanently lost backfill for any business whose first attempt auth-failed mid-flight: the connection's `connected_at` was set before disconnect, so reconnect falsely satisfied the strict predicate → no backfill enqueue → empty dashboard forever. New predicate fires backfill exactly once per business per successful completion. ZernioBackfillWorker's defense-in-depth (ON CONFLICT + completed_at check from §6.4) makes a second outbox enqueue safe.
- **M3:** §6.3 error class table — `applyIngestionAuthErrorFallback(businessId, accountId, locationId, reason: string)` table row now lists all four params (v14 listed only three; the §6.5b definition has four).
- **L1:** §4.2 architecture overview — synced to match §6.3 actual pseudocode. Now mentions: mock-mode short-circuit (step 4), `locationId` param on listReviews (step 5), typed-error throws + onFailed escalations (steps 6+7 — `ZernioIngestReviewNotFoundError` + new `ZernioIngestUnparseableLocationError`), external-reply reconciliation (step 8), normalization-error handling (step 9). Earlier overview missed all six.
- **L2:** §7 mock-mode wording — replaced the "Mitigation: ... Add explicit branch" phrasing (which read like a TODO) with documentation that the §6.3 short-circuit IS the canonical mitigation already applied.
- **L3:** plan step 6b — `extractLocationFromReviewName` reference now correctly notes the function is introduced in step 7 (not "already in zernio-normalize"). Affects only the hypothetical fallback path (if Zernio doesn't expose locationId filtering).
- **L4:** plan — moved CLAUDE.md update (was step 21) to step 24, after rollout. Reasoning: if rollout reveals a divergence from the spec, the reality should anchor CLAUDE.md, not the spec.

## 19. Changelog v13 → v14

Round-13 review surfaced 1 issue — verified correct, applied:

- **L1:** §6.10c onFailed escalation pseudocode — replaced the v13 placeholder `// ... existing ZernioTransientError branch unchanged ...` with the actual updated branch. v11 widened `applyTransientExhaustionFallback` to take optional `account_id`/`location_id`; v11/v12 wrapped publisher transient throws in `PublisherTransientWithContext`. The "unchanged" comment contradicted both. Now the spec spells out the exact unwrap pattern: detect `instanceof PublisherTransientWithContext` inside the `ZernioTransientError` branch, extract `attemptContext`, pass account+location to the pinned fallback. Bare `ZernioTransientError` (no context) still falls through to un-pinned mode as the documented safety net.

## 20. Changelog v12 → v13

Round-12 review surfaced 2 issues — both verified correct, both applied:

- **C1:** §6.10b PublisherTransientWithContext constructor — `super(inner.kind, inner.meta)` instead of v12's `super(inner.code, inner.meta)`. `ZernioTransientError` exposes `kind: string` per `src/lib/zernio/errors.ts:15-23` (only `ZernioValidationError` has `code`). v12 would have failed TypeScript compilation. Inline comment added pointing at the actual constructor signature so a future reader doesn't re-introduce the bug.
- **M1:** §6.10b 409 verifier transient branch — replaced bare `throw lookupErr` with `throw new PublisherTransientWithContext(lookupErr, { response_id, business_id, account_id, location_id })`. v12 contradicted the round-11 rule that every publisher transient rethrow carries attempt context — the 409 verifier was the one missed callsite. Without the wrap, retry-exhaustion would hit the un-pinned legacy fallback for a publish that just failed verification with a fresh reconnect possibly already at a different location. Test case updated from "rethrow as-is" to "rethrow as PublisherTransientWithContext with carry-along context" + confirmation the failed hook unwraps and pins.

## 21. Changelog v11 → v12

Round-11 review surfaced 2 issues — both verified correct, both applied:

- **M1:** §6.10b prereq, "Round-11 follow-up" subsection — the existing `applyTransientExhaustionFallback` (used for `ZernioTransientError` retry exhaustion at `worker/index.ts:155`) had the same un-pinned-disconnect race that round-10 fixed for the auth path. Two-part fix:
  1. New `PublisherTransientWithContext` error class wraps `ZernioTransientError` with `{ response_id, business_id, account_id, location_id }`. Subclasses ZernioTransientError so existing `instanceof` checks continue to pass.
  2. `applyTransientExhaustionFallback` signature widened to accept optional `account_id` + `location_id`; when both are supplied, the disconnect WHERE clause adds `AND zernio_account_id = … AND zernio_location_id = …`. Backwards compatible (un-pinned mode retained as a safety net for any future caller that lacks context).
  3. Publisher rethrows `ZernioTransientError` wrapped in the new class. Failed hook unwraps to extract context and pass to the pinned fallback. Regression test: stale transient exhaustion for account A/location 1 must NOT disconnect a fresh active row for account A/location 2.
- **L1:** §6.10b' AdminExceptionWorker — reviewer block gates on `exception.review_id !== null` (not `exception.reviewer_name`). Anonymous reviewers have `reviewer_name=NULL` but a real `review_id` and should render the block with "Unknown reviewer" copy. The SELECT at `AdminExceptionWorker.ts:27-34` must add `re.review_id` to its column list (called out explicitly in the spec). New regression test for the anonymous-reviewer case.

## 22. Changelog v10 → v11

Round-10 review surfaced 3 issues — all verified correct, all applied:

- **M1:** §6.10b prereq table — `handlePublisherAuthErrorTerminal` signature gains `location_id` parameter; the helper's disconnect WHERE clause now includes `zernio_location_id`. v10 (and the existing in-worker code at `ResponsePublisherWorker.ts:310-313`) only pinned by `business_id` + `zernio_account_id`. The shipped code's missing location pin is a pre-existing race: business X disconnects from account A / location 1 → reconnects to account A / location 2 → a stale auth error in flight from the location-1 publish then disconnects the new location-2 row. Updating the helper + having the existing in-worker callsite pass `zernio_location_id` closes this. Regression test added.
- **M2:** §6.10b' NEW — `AdminExceptionWorker.ts:61-72` factored into a `renderExceptionBody()` switch on `exception.type`. Each new exception type (`zernio_review_not_found`, `zernio_permanent_4xx`, `zernio_reply_verification_indeterminate`) gets its own body copy + payload fields. Generic fallback for unknown types lists payload primitives. Reviewer/review-text block conditional on `review_id` presence — `zernio_review_not_found` rows have `review_id IS NULL` (review never ingested) so the LEFT JOIN reviews returns null fields. v10 would have rendered the misleading `"reviewer edited their review after a response was already posted"` copy for every new Zernio exception type. New tests for each type.
- **L1:** Plan step 15c updated to include `underlying_error?: string` in the `ZernioReplyVerificationIndeterminateError` payload shape, matching spec §6.10c. Doc-sync only.

## 23. Changelog v9 → v10

Round-9 review surfaced 3 issues — all verified correct, all applied:

- **M1:** §6.3b reconcile — replaced the early-return on "any active response matches" with per-response set-difference logic. Computes `protectedIds` (active responses whose canonicalized `approved_text` matches the external reply) and supersedes only `activeResponses` not in that set. Mixed legacy/Zernio scenario from round-9 — one matching zernio row + one stale legacy serpapi_poll row — now correctly protects the zernio response while superseding the legacy one. v9's `if (ourReplyMatches.length > 0) return` would have left the stale legacy draft active forever. New regression test enumerated.
- **M2:** §6.10b 409 verifier — unknown lookup errors now wrapped in `ZernioReplyVerificationIndeterminateError` with `reason='verifier_unknown_error'` (and `underlying_error` payload) before throwing. On BullMQ retry exhaustion the existing indeterminate failed-hook branch (§6.10c) fires the full terminal sequence. v9 rethrew unknown errors raw — they fell through to bare `markOutboxFailed` at `worker/index.ts:173` after exhaustion, leaving response active with no admin trail.
- **L1:** §6.10b text-mismatch log — replaced 60-char text slices with `len=N` + 12-char SHA-256 `fp=` prefixes. Hash inputs are the canonicalized texts so byte-different-but-semantically-equal strings hash the same (helps ops correlate without leaking content). Test added for log-redaction regression (assert no plaintext slice appears in the log output).

## 24. Changelog v8 → v9

Round-8 review surfaced 3 issues — all verified correct, all applied:

- **C1:** §6.10c NEW — `ZernioReplyVerificationIndeterminateError` class with carry-along context (response_id, business_id, review_id, account_id, location_id, zernio_review_id, reason). Publisher `on('failed')` hook in `worker/index.ts` gets a new branch BEFORE the existing transient-fallback handling, doing the full terminal sequence: response→`failed` with `posting_error='zernio_reply_verification_indeterminate'`, INSERT `review_exceptions type='zernio_reply_verification_indeterminate'`, enqueue admin notify, mark outbox completed. v8 threw a generic `Error` which fell through to the worker's bare `markOutboxFailed` at line 173-175 — leaving the response in 'approved' status forever with no admin trail.
- **C2:** §6.10b 409 verifier — `found && reviewReply === null` now throws `ZernioReplyVerificationIndeterminateError` with `reason='review_found_but_reply_null'` instead of superseding. v8 superseded on this case under "conservative bias", but Zernio's listReviews lag could mean our own just-posted reply hasn't propagated; superseding would mark our reply as `already_replied_external`. Indeterminate cases retry then escalate; supersession only occurs on confirmed text mismatch with a visible reply.
- **M1:** §6.10d NEW — `canonicalizeReplyText(text)` shared helper in `src/lib/zernio/canonicalize-reply.ts`. Normalizes CRLF→LF, Unicode NFC, trims outer whitespace. Used by BOTH the publisher 409 verifier (§6.10b text comparison) AND the ingest reconcile helper (§6.3b "is it our reply?" check). Preserves internal whitespace deliberately. v8 used `.trim()` only — round-tripping through Zernio + Google can introduce CRLF or Unicode-form differences that would have caused false text-mismatch supersessions.

## 25. Changelog v7 → v8

Round-7 review surfaced 3 issues — all verified correct, all applied:

- **C1:** §6.10b 409 verifier — switched from `listReviews({ pageSize: 50 })` (single page) to `listAllReviews({ pageSize: 50, maxPages: 4 })`. v7 would have falsely superseded responses for any review older than the most recent 50, where the publisher's 409 was actually about our own already-posted reply on page 2+. New disposition: review NOT found after exhausting pagination → throw → BullMQ retry → onFailed escalation. NEVER supersede on indeterminate. Test list expanded with explicit page-2-match and not-found-after-pagination regression cases.
- **M1:** §6.10b prerequisite — extract `handlePublisherAuthErrorTerminal` + `handlePublisherPermanentErrorTerminal` shared helpers in new `worker/jobs/publisher-error-handlers.ts`. The new auth helper pins disconnect to the attempted `zernio_account_id` (mirroring `ResponsePublisherWorker.ts:311-312`) — v7 reused `applyTransientExhaustionFallback` which lacks the account pin and races a fresh reconnect. The existing in-worker auth + permanent code blocks are refactored to call the helpers (deduplication; both paths now share the same canonical sequence). `applyTransientExhaustionFallback` retains its onFailed-hook callsite where account pinning isn't easily threaded.
- **M2:** §6.10b 409-permanent disposition — uses `handlePublisherPermanentErrorTerminal` (which marks response failed + opens review_exception type='zernio_permanent_4xx' + enqueues admin notify + completes outbox) instead of the bare `markOutboxFailed` of v7. Without this, the dashboard would have kept an active 'approved' response next to a failed outbox row with no exception trail — silent stuck state.

## 26. Changelog v6 → v7

Round-6 review surfaced 3 issues — all verified correct, all applied:

- **M1:** §6.10b publisher 409 verifier — error classification added. v6 unconditionally `markOutboxFailed` on any listReviews error, converting transient network blips into permanent outbox failure. Now: `ZernioTransientError` → rethrow (BullMQ retry); `ZernioAuthError` → `applyTransientExhaustionFallback` + outbox completed (response transitions to `awaiting_owner_connect`); `ZernioPermanentError` / `ZernioValidationError` → markOutboxFailed terminal; unknown errors (DB, parse, etc.) → rethrow for retry. Test list updated with 4 new error-class cases.
- **M2:** §6.4 backfill — reconcile failures collected into a `reconcileFailures` array and continued (best-effort attempt for remaining work). At end of worker: partial counts written; if any reconcile failed, THROW before setting `completed_at`. BullMQ retries the whole backfill (idempotent via processReview ON CONFLICT + supersession). v6 swallowed errors and continued to set `completed_at`, permanently leaving stale legacy drafts on already-answered reviews — exactly the bug the answered-review pass exists to prevent.
- **L1:** §6.3b — replaced the stale "alternative considered + rejected" paragraph (which falsely claimed v3+ avoided modifying the publisher) with a "defense in depth" note acknowledging that v6+ updates BOTH the reconcile path AND the publisher 409 path; both invariants close the same gap from different angles.

## 27. Changelog v5 → v6

Round-5 review surfaced 3 issues — all verified correct, all applied:

- **C1:** §6.3b `reconcileExternallyAnsweredReview` — now distinguishes "our reply" from "external reply" by comparing `target.reviewReply.comment` to active responses' `approved_text` (after trim). If any approved/edited response has matching text, NO supersession (it's our just-posted reply that Zernio is reflecting back via `review.updated`; the publisher's `posted` UPDATE will run shortly). Otherwise supersede. Without this fix, the publisher and the ingest worker would race on the same just-posted response, with reconcile sometimes overwriting `posted` to `superseded`.
- **M1:** §6.4 backfill — split `locationScoped` into `answered` and `unanswered`. Answered reviews now run through `reconcileExternallyAnsweredReview` (which gracefully no-ops on "our reply" matches and supersedes on text-mismatch). Unanswered go through bucket caps as before. Without this, pre-existing local active drafts (e.g. SerpAPI-sourced from pre-flag-flip era) on already-answered reviews would never be superseded — silent staleness.
- **M2:** §6.10b NEW — publisher's 409 `reply_already_exists` handler at `ResponsePublisherWorker.ts:278-292` now fetches the existing reply via `listReviews` and compares text. Exact match → mark posted; mismatch or unverifiable → supersede with `already_replied_external` (or markOutboxFailed on listReviews failure). Final line of defense parallel to §6.3b reconciliation — both invariants close the same gap from different angles.

## 28. Changelog v4 → v5

Round-4 review surfaced 4 issues — all verified correct, all applied:

- **C1:** §6.6b parser — `extractBareReviewId` helper extracts the bare review id from EITHER `review.id` or `review.name`, whether bare or in resource-name form. v4 parser stored `review.id` as-is; if Zernio's webhook delivers `review.id='accounts/.../reviews/AbFv0Lxyz'`, the ingest worker's `r.id === zernio_review_id` comparison against listReviews' bare `id` would have never matched. Now: bare-or-resource-form on either field, bare extracted, agreement check between forms, full resource name retained for logging.
- **C2:** §6.6b parser — REMOVED the cross-check between top-level `account.id` (Zernio account) and the `accounts/{...}` segment in resource-name paths (Google Business account). They're different ID spaces per Zernio's docs; v4 would have rejected valid webhooks. Now: top-level `account.id` is used for our DB lookup + Zernio API calls; resource-path segments are used only to extract location and bare review id, never compared to the top-level. New regression test in §6.6b's test list explicitly covers this case.
- **M1:** §6.3b `reconcileExternallyAnsweredReview` — extended to also field-match legacy `provider='serpapi_poll'` rows (reviewer name + star rating + comment + createTime ±24h, mirroring `zernio-publisher.ts:71-76`). Without this, an external reply to a review with an active SerpAPI-sourced draft would still hit the publisher's 409→`mark posted` bug at `ResponsePublisherWorker.ts:278-292`. Single SQL with OR-branch handles both populations atomically.
- **L1:** §6.8 — fixed remaining stale `/api/dashboard/connect/select-location/route.ts` reference. Verified path is `src/app/api/zernio/connect/select-location/route.ts`.

## 29. Changelog v3 → v4

Round-3 review surfaced 6 issues — all verified correct, all applied:

- **C1:** §6.4 — backfill row-existence check now gates on `completed_at IS NOT NULL`. v3 exited if the row existed AT ALL — meaning a `listAllReviews` timeout AFTER row insert would permanently skip backfill on the next BullMQ retry. Now: row exists with `completed_at IS NULL` → resume the work; processReview's UNIQUE constraint makes per-review re-runs idempotent.
- **C2:** §6.6b NEW — `parseZernioReviewWebhook` documented parser with explicit `ParsedReviewWebhook` type, `ZernioReviewWebhookParseError`, full validation (nested account.id, review.id and/or review.name resource-name form, cross-check agreement, malformed rejection), and tests. v3 had inline `(body as { account?: { id?: unknown } }).account?.id` type-casting on an undocumented payload shape.
- **C3:** §6.0 NEW — `zernioClient.listReviews` and `listAllReviews` now require `locationId`. v3 omitted location from the API call → in same-account-multi-location case, Zernio's API would return reviews from the account's default/selected location, not the connection's location, causing every cross-location webhook to escalate to `review_exceptions`. Caller updates documented in §6.4 + §6.11. Implementer must verify the exact Zernio query-param name before merging (assumed `locationId` per current docs).
- **M1:** §6.3b NEW — `reconcileExternallyAnsweredReview`. v3 ingest worker called processReview blindly even when Zernio reports `reviewReply !== null` — the customer answered via Google directly. The publisher's `ZernioReplyAlreadyExistsError` (409) handler at `ResponsePublisherWorker.ts:278-292` would then mark our (different) draft as 'posted' — wrong. Now: if external reply detected, supersede any local active response with `posting_error='already_replied_external'`; never queue a publish.
- **M2:** Plan corrected — line 166 stale "reuse `applyTransientExhaustionFallback`" replaced with "use `applyIngestionAuthErrorFallback`". Verification line 188 stale "verify `notification_deliveries.status='suppressed'`" replaced with "verify NO `notification_deliveries` row written for backfill responses".
- **L1:** Plan/spec — connect callback path corrected from `/api/dashboard/connect/select-location/route.ts` to `/api/zernio/connect/select-location/route.ts` (verified by `ls`).

## 30. Changelog v2 → v3

Round-2 review surfaced 9 issues — all verified correct, all applied:

- **C1:** §4.6 + §6.7 — backfill suppression now SKIPS `send_notification` enqueue entirely. v2's `notification_deliveries.status='suppressed'` would have failed (no `status` column; `recipient NOT NULL`). Verified `NotificationFailoverPoller` filters on `EXISTS approval_request` rows so missing rows are safe.
- **C2:** §6.5 — `review_exceptions` ON CONFLICT now uses payload key `provider_review_id` (matches existing `idx_review_exceptions_collision_dedup` from migration 005). v2 used `zernio_review_id` which would have hit "no matching unique constraint" runtime error.
- **C3:** §6.5b — new `applyIngestionAuthErrorFallback` helper (no `response_id` required). v2 said to reuse `applyTransientExhaustionFallback`, which is response-scoped and incompatible with ingestion paths.
- **M1:** §6.6 — race-loss path now re-reads FOR UPDATE and runs the existing-row content-hash branch (handles updates). v2 returned 'unchanged' → newer content from race-loser would have been silently dropped.
- **M2:** §6.3 — dedicated `ZernioIngestReviewNotFoundError` class with carry-along context. onFailed hook checks `instanceof`. v2 threw a generic `Error` indistinguishable from network blips.
- **M3:** §6.3 — review.name location parse now FAILS CLOSED. If location is missing or unparseable, throw (retry then escalate); never process. v2's `if (reviewLocationId && reviewLocationId !== ...)` would have allowed unparseable-location reviews to ingest into every fan-out target.
- **M4:** §6.11 — `lookupZernioReviewId` now requires EXACT `provider_location_name === zernio://{accountId}/locations/{locationId}`. v2's `startsWith` check would have allowed same-account different-location rows. Caller passes `zernio_location_id`.
- **M5:** Plan §A2 — startup-assert env var ordering note made explicit ("set env var in prod BEFORE merging step 2"). Spec unchanged.
- **L1:** §6.4 — `zernio_backfill_runs` upsert now checks `inserted.count`. If the row already exists (count=0), exit early without re-running listAllReviews. Belt-and-suspenders against the connect-callback first-activation predicate being bypassed.

## 31. Changelog v1 → v2

- **Critical 1:** §6.9 added — explicit deletion of three `sync_reviews` producers (onboarding wizard, admin onboarding, PlaceIdValidationWorker). v1 only addressed the consumer side.
- **Critical 2:** §4.2 + §6.5 added — "review not found" path is now BullMQ-transient-retry → `review_exceptions` escalation, not silent skip.
- **Critical 3:** §4.3 added — webhook fan-out across all active connections sharing an account_id; ingest worker filters by location.
- **Medium 1:** Migration 028 dropped the `subscription_active_since` column. Spec now uses existing `businesses.subscription_activated_at` (migration 014).
- **Medium 2:** §6.6 — `processReview` adds `ON CONFLICT (provider, provider_review_name) DO NOTHING` for the first-insert race.
- **Medium 3:** §4.6 + §6.7 — backfill responses suppress notifications; owner sees them in the dashboard. Replaces the v1 "future work: digest" punt.
- **Medium 4:** §6.4 — backfill sorts by `createTime DESC` before slicing buckets.
- **Medium 5:** §5 + §6.4 — new `zernio_backfill_runs` table replaces v1's "compare counts" hand-wave.
- **Medium 6:** Decision Q1 — use existing `'premium'` slot, don't add `'pro'`. §6.10 lists 8 wiring locations + 2 already-correct ones.
- **Medium 7:** §6.11 — `lookupZernioReviewId` SELECT expanded; early-return gated on provider AND location-prefix match.
- **Medium 8:** §6.3 added explicit error-class disposition table.
- **Low 1:** §6.1 — dropped `ZernioReviewSource implements ReviewSource` (leaky abstraction). Workers call zernioClient directly.
- **Low 2:** moot after Low 1.
- **Low 3:** §6.2 — `zernio-normalize` does runtime validation per review; per-review try/catch in workers mirrors SerpAPI's per-review isolation.
