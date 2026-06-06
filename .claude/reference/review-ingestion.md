# RepWorth — Review Deduplication & Ingestion

## Core Principle

Identity is stable (immutable fields only). Content is mutable (detected via
hash comparison). These are separate concerns — never mix them.

> **Multi-location naming note (since migration 034):** `reviews.business_id`
> and `responses.business_id` now mean "location_id" — one Google Business
> Profile location, not the billing parent. The dedup logic below is
> unchanged: a review's identity is scoped to its `business_id` (= location).
> Two locations under the same `account_id` never collide because each
> Place ID has its own `business_id`. When working on aggregate dashboards
> or CSV bulk-imports, scope by `account_id` first, then fan out per
> `business_id`.

> **Auto-approval lane note (since the auto-approval feature, migration 055):** the
> new-vs-content-changed distinction this dedup logic produces now feeds `origin_lane`
> on the `generate_response` job. A **first-time new** review → `live_ingest_new` (the
> ONLY lane eligible for auto-approval); a content-changed / supersede-regenerate review
> → `live_ingest_update`, and Zernio backfill/import → `backfill` — both always manual.
> So if you change what counts as "new" vs "update/import" here, you are also changing
> what can auto-post to Google. See the auto-approval design spec §5 (origin lanes).

## Stable Identity Construction (SerpAPI mode)

Identity must NOT include mutable text (review body, star rating can be
edited by the reviewer on Google).

**Priority order:**
1. Use SerpAPI's raw review ID if present (`provider_review_id`)
2. Fall back to SHA-256 hash of immutable fields:
   `SHA-256(reviewerName + "|" + reviewDate + "|" + reviewerProfileUrl)`

**Why prefer source-provided IDs:** Synthetic hashes collide on common/
anonymous reviewer names (e.g. "A Google User" + same date from different
locations). Always use the source-provided identifier when available.

**Fields used:**
```typescript
provider = 'serpapi_poll'
provider_review_id = serpapi_raw_id ?? SHA256(name + "|" + date + "|" + profileUrl)
```

## Synthetic Resource Names

These are constructed consistently so they're stable across re-ingestion:

```
provider_review_name  = 'serpapi://{placeId}/reviews/{provider_review_id}'
provider_location_name = 'serpapi://{placeId}'
```

## Mutable Content Detection

```typescript
review_content_hash = SHA256(starRating + "|" + reviewText)
```

On every ingestion, compare `review_content_hash` to the stored value.
If different: the review was edited — treat as an update, NOT a new review.

### Sentiment is (re)classified at the same write sites (Wave 3 PR 5a)

`reviews.sentiment_*` is populated by `classifySentiment(starRating)`
(`src/lib/reviews/sentiment.ts`, deterministic star-based `deterministic_star_v1`)
at exactly the content-write points dedup decides:

- **NEW** review → the INSERT in `process-review.ts` sets sentiment.
- **UPDATED** (content hash changed) → the content UPDATE recomputes sentiment.
- **`insertImportedReview`** (`worker/jobs/zernio/zernio-ingest-shared.ts`, the
  external-reply path that bypasses `processReview`) also sets it.
- **UNCHANGED** and the status-only writes (deleted→new revival, soft-delete) do
  **not** touch sentiment.

So any change that counts as a content update for dedup also refreshes sentiment;
adding a new review-content write path means adding the `classifySentiment` call
there too (migration 052's SQL backfill uses the same star→label/score mapping).

## Collision Handling

If two reviews produce the same identity key but have different content
on first encounter (before any `review_content_hash` is stored):

- Do NOT silently merge
- Insert into `review_exceptions` with `type = 'identity_collision'`
- Log the conflicting provider_review_ids for ops review

## Zernio Mode

Zernio provides canonical review IDs. Use them directly — no SHA-256 fallback
needed. Outbox dedup index (`job_outbox_ingest_zernio_review_inflight`)
handles duplicate webhook deliveries:

```sql
-- migration 030 partial unique index
(aggregate_id, (payload->>'zernio_review_id'))
WHERE topic = 'ingest_zernio_review' AND status NOT IN ('completed', 'failed')
```

Webhook fan-out uses `INSERT ... ON CONFLICT DO NOTHING` against this index.

## ReviewSource Contract

ALL review sources (SerpAPI, manual paste, Zernio, future GBP API) must
normalize to `NormalizedReview` DTO before anything downstream sees the data.
No source-specific fields leak into the prompt builder or response generator.

```typescript
interface NormalizedReview {
  provider: string
  provider_review_id: string
  provider_review_name: string
  provider_location_name: string
  review_content_hash: string
  reviewer_name: string
  star_rating: number
  review_text: string
  review_date: string
  // ... other normalized fields
}
```

## Exception Types in `review_exceptions`

| `type` | Meaning |
|---|---|
| `'identity_collision'` | Two reviews mapped to same identity key with different content on first encounter |
| `'zernio_review_not_found'` | Entire Zernio feed walked (durable not-found) — review genuinely missing |
| `'zernio_pagination_cap_exhausted'` | Hit `ZERNIO_INGEST_MAX_PAGES` limit with `nextPageToken` still set — indeterminate, may need cap increase |
| `'zernio_likely_phi_review'` | Wave 1 (PR #85): review text tripped the PHI scanner (`src/lib/security/phi-scanner.ts`) — ingest of that review is **blocked before any persistence** and the row is opened for operator review. Raw review text is never stored in the payload or logs. |

These are distinct types deliberately. Do NOT conflate cap-exhausted with
durable not-found — ops decisions differ (bump cap vs accept gap).

> **PHI-exception dedup (`openPhiReviewException`, `worker/jobs/zernio/zernio-ingest-shared.ts`):**
> opened idempotently via `ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
> WHERE status = 'open' AND review_id IS NULL DO NOTHING` so a review re-seen on
> every poll/backfill cycle does not spawn duplicate exceptions or re-fire the
> admin alert. The exception row + its `notify_admin_review_exception` outbox row
> are written in ONE **caller-owned** transaction (each call site wraps it in
> `sql.begin`; `TransactionSql` has no `.begin`, so the function itself never
> opens the tx). The Sentry alert fires only when the INSERT actually created a
> row (skipped on the `DO NOTHING` no-op). Every Zernio ingest path is gated:
> webhook (`ZernioReviewIngestWorker`), backfill (`ZernioBackfillWorker`),
> recent-review poller (`ZernioRecentReviewPoller`), and the externally-answered
> reconcile path (`reconcileExternallyAnsweredReview`, which gates before each
> import branch — so replied reviews are NOT a bypass).

## GBP API Migration Path (Phase 5)

When Google Business Profile API access is approved, the deduplication logic
stays identical. Only the provider identifiers change:

| Field | SerpAPI mode | GBP API mode |
|---|---|---|
| `provider` | `'serpapi_poll'` | `'google'` |
| `provider_review_id` | SerpAPI ID or SHA-256 hash | Canonical Google review resource name |
| `provider_review_name` | `serpapi://{placeId}/reviews/{id}` | Google resource name |
| `provider_location_name` | `serpapi://{placeId}` | Google location resource name |
| `review_content_hash` | SHA-256(starRating + "\|" + text) | Same — unchanged |

Steps for migration:
1. Build `gbp-api-source.ts` implementing `ReviewSource` interface
2. Normalize to the same `NormalizedReview` DTO
3. Swap `provider` value on new ingestion
4. Migrate existing `provider='serpapi_poll'` rows to `provider='google'`
   with canonical Google resource names
5. Content hash logic stays identical — no re-hashing needed

The outbox pattern, approval flow, response generation, and notification
pipeline are completely unaffected. This is a mechanical swap at the
ingestion boundary only.

## Reconciliation (Externally-Answered Reviews)

When Zernio indicates `reviewReply !== null` on a fetched review, call
`reconcileExternallyAnsweredReview` instead of `processReview`. This marks
the review as already-responded externally, avoiding generating a duplicate
AI response for something the owner already handled manually.


### External-reply ingestion path (feat/past-replies-view, 2026-05-02)

`reconcileExternallyAnsweredReview` was extended on `feat/past-replies-view`
with two NEW flag-gated branches that turn the silent
"previously-unseen" / "matched but no active responses" no-ops into actual
ingestion. Gated by `EXTERNAL_REPLY_IMPORT_ENABLED='true'` — when off,
today's silent-no-op behavior is preserved verbatim.

**Branch 1 — "previously-unseen review with reply" (no match):** INSERTs a
new `reviews` row (with `external_reply_ingested_at = NOW()` to mark its
provenance) AND a new `responses` row with:
- `status = 'posted'` — the reply already exists on Google.
- All three text columns = `canonicalizeReplyText(reviewReply.comment)`.
- `edited_text = NULL` — voice learning won't pick it up
  (`src/lib/responses/voice-learning.ts:30` filters `edited_text IS NOT NULL`).
- `llm_provider`/`llm_model`/`prompt_tokens`/`completion_tokens` all NULL
  — signals "not RepWorth-generated".
- `version = 1` (no prior responses for this brand-new review row).
- `approved_at = posted_at = reviewReply.updateTime`.

**Branch 2 — "matched but no active responses":** INSERTs the response row
only (the review row already exists). Same shape as Branch 1, but
`version = COALESCE((SELECT MAX(version) FROM responses WHERE review_id =
${reviewId}), 0) + 1` because terminal rows (failed, superseded) might
already occupy version 1. Migration 031's `responses_one_posted_per_review`
partial unique index protects against duplicate `posted` rows on retry.

**Branch 3 — "matched WITH active responses":** today's supersede/protect
logic UNCHANGED. The flag does NOT affect this branch — protecting our own
already-posted replies from being clobbered by a webhook echo remains the
same regardless of the flag.

**Race-safety on the review INSERT:** Branch 1 uses
`ON CONFLICT (provider, provider_review_name) DO UPDATE SET id = reviews.id RETURNING id`.
NOT `DO NOTHING + RETURNING` — under concurrent transactions,
`DO NOTHING + RETURNING` returns no row when the conflicting INSERT loses
the race AND the same statement's snapshot can't see the just-committed
sibling. `DO UPDATE` always RETURNs the row id, whether INSERTed or
pre-existing. The no-op `SET id = id` triggers a row-level lock + xmin
bump but no observable data change.

**Idempotency target on the response INSERT:**
`ON CONFLICT (review_id) WHERE status = 'posted' DO NOTHING RETURNING 1`
— uses migration 031's partial unique index. The `RETURNING 1` lets
`insertImportedResponse` return a boolean indicating whether the INSERT
actually fired vs hit the conflict. The caller uses that to gate the
counter bump (`bumpExternalReplyIngestedCount`) so retries / repeated
backfills don't inflate `external_reply_ingested_count`.

**Loose-equality `reviewReply` guards:** The `listReviews` Zernio client
method now normalizes `reviewReply` to either `null` or an object (never
`undefined`) at the API chokepoint via `?? null`. Downstream callers
(`ZernioBackfillWorker`, `ZernioReviewIngestWorker`,
`reconcileExternallyAnsweredReview`) also use loose-equality `!= null` /
`== null` as defense-in-depth — if any future code path constructs a
`ZernioReview` outside `listReviews`, the omitted-field case still doesn't
misroute as "answered" and crash on `.comment`.

**The published-reply text** is shown in the dashboard's "Past Replies"
tab via the read-only `PastReplyCard` component (gated by the SEPARATE
`PAST_REPLIES_VIEW_ENABLED` flag). The dual-flag rollout decouples the
write decision from the UI-expose decision — operators can ingest silently
first, soak, then turn on the UI.

## Onboarding-demo lane (PR #2, 2026-05-04)

The pre-pay demo (`/onboarding/start` → `/onboarding/demo`) ingests reviews
DIFFERENTLY from the post-pay Zernio path. Key separations to keep in mind
when touching either codebase:

**No `reviews` table writes.** The demo SerpAPI fetch goes through
`fetchSerpApiReviews` and the result is snapshotted as JSONB into
`onboarding_demos.reviews_snapshot`. Nothing is INSERTed into `reviews`.
This means:

- The dedup logic above (provider_review_id, content hash, identity
  collision exceptions) does NOT run. The demo is an ephemeral preview,
  not part of the canonical review timeline.
- When the user pays and onboards, the post-pay Zernio webhook ingestion
  re-fetches their reviews into `reviews` from scratch via the proper
  pipeline. There is no "promote demo snapshot to canonical reviews"
  step — the demo data is throwaway.
- The 30-day cleanup pass in `CleanupAbandonedSignupsPoller` deletes
  completed `onboarding_demos` rows; nothing in `reviews` is affected.

**Per-user uniqueness via partial index.** Migration 032 enforces "at
most one completed demo per user" via:

```sql
CREATE UNIQUE INDEX onboarding_demos_one_completed_per_user
  ON onboarding_demos (user_id)
  WHERE generation_status = 'completed';
```

This is structurally similar to migration 031's
`responses_one_posted_per_review`, but the failure mode is different:

- `responses_one_posted_per_review` collisions abort the import — a
  duplicate `posted` reply is a structural bug.
- `onboarding_demos_one_completed_per_user` collisions are EXPECTED on
  concurrent regenerate. `lifecycle.completeDemo` catches Postgres
  23505, archives the loser, and closes the loser's outbox in a single
  tx. The winner remains the canonical completed demo.

**Source field, not provider field.** `onboarding_demos.source` is one
of `'serpapi'` or `'curated_fallback'`. This is NOT the same as the
`reviews.provider` field — it tracks whether the demo was generated
from real reviews or from the canned fixture. CHECK constraint enforces
`source IS NOT NULL` whenever `generation_status = 'completed'`.

**Reads must filter `archived`.** Any `ORDER BY created_at DESC LIMIT 1`
on `onboarding_demos` MUST also filter `generation_status <> 'archived'`
because the 23505-archived loser can have a newer `created_at` than the
winning completed row. See lab-notes for the full rationale.

**Curated fallback bypasses dedup entirely.** When SerpAPI fails OR no
review meets the `positive-with-moderate-tail` anchor (no review with
`starRating >= 4`), the worker writes the static fixture from
`src/lib/demos/__fixtures__/fallback-source-reviews.ts` into the demo
snapshot. The fixture is not real review data, so no dedup or content-
hash logic applies.

## Activation-event idempotency (Wave 2, PR #87)

The same "dedup by a stable key, not by re-deriving from content" philosophy
governs the Wave 2 activation funnel. The first-review and first-draft signals
fire from the ingest / response-generation workers, which BullMQ may retry, so
they must be exactly-once per account:

- **`first_review_ingested`** — enqueued from `processReview` with
  `event_key = first_review_ingested:<account_id>`. The "is this the account's
  first review?" check is an account-scoped `EXISTS` subquery, but correctness
  does **not** depend on that read winning a race: the account-scoped key plus
  `analytics_events.event_key UNIQUE` + `ON CONFLICT DO NOTHING` is the real
  dedup, so concurrent first reviews collapse to one row.
- **`first_response_drafted`** — same pattern, `event_key =
  first_response_drafted:<account_id>`, enqueued after the response row commits.
  A retry-after-commit re-runs the check, sees the committed sibling, and the
  key+conflict dedups regardless.

Rule of thumb mirrors review dedup: **derive a deterministic key and let the DB
unique constraint enforce once-only** — never rely on a read-then-write check
being atomic. (Per-attempt client intent events like `gbp_connect_started` use a
non-deterministic key by design — they are NOT durable facts; see
`docs/analytics/events.md`.)

## Flagged-response hold (Wave 3, migration 051)

The same once-only discipline applies to held moderation flags. When
`ResponseGeneratorWorker` holds a high-severity unsafe draft it inserts a
`flagged_responses` row inside the response transaction. BullMQ can retry the
generation job, so the flag insert must not stack duplicates:

- **Partial unique index** `idx_flagged_responses_open_response` on
  `(response_id) WHERE status = 'open'` — at most one OPEN flag per response.
  After an admin dispositions it (`approved_for_owner_review` /
  `dismissed_false_positive` / `requires_regeneration`) the row leaves `open`, so
  a later genuine re-flag is still allowed.
- In practice a true retry-after-commit re-enters the Step-5 existing-response
  early-return in `ResponseGeneratorWorker` (the `UNIQUE (review_id, version)` on
  `responses`), so persist isn't re-run and `responseId` is freshly generated per
  call anyway — the partial unique index is defense-in-depth, the same
  belt-and-suspenders posture as the analytics `event_key` uniqueness above.
