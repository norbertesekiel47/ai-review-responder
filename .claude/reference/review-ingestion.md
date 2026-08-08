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
> (Since #675 the consented Review import enqueues **no generation at all**, so the
> `backfill` lane gains no new rows — the vocabulary survives for pre-#675 rows.)

> **Trial note (since migration 069 / PR #362):** the new `'trialing'` subscription
> status is treated like `'active'` for ingestion — `trialing` accounts ARE included in
> the backfill-resume enqueue (`worker/ingress/stripe/shared.ts`) and the per-cadence
> review pollers. `accounts.subscription_activated_at` (mirrored to
> `businesses.subscription_activated_at`) is set at **trial start** for trials (not at
> first payment); it still gates the backfill-resume enqueue and is recorded on the
> run row, but since #675 it **buckets nothing** — the gap/historical split is dead
> vocabulary; the import selects purely by the Import window (see the Consented
> Review import section below).
> Don't re-gate ingestion on "paying" status; gate on `subscriptionGrantsFullAccess`.

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
needed.

> **Google-native resource name capture (migration 070):** `ZernioReview.name`
> carries Google's review resource name
> (`accounts/{a}/locations/{l}/reviews/{r}`). Ingest persists it to
> `reviews.google_review_name` via `normalizeGoogleReviewName`
> (`src/lib/reviews/zernio-normalize.ts` — fail-open to NULL; capture is
> provenance, never a reason to fail ingest) at the review-content write sites:
> `processReview` INSERT, the content-changed UPDATE (COALESCE — never clobbers
> a stored value), and `insertImportedReview` (INSERT + conflict-arm backfill).
> It is **NOT dedup identity** — that remains `(provider,
> provider_review_name)`. Consumer: the future direct-GBP posting adapter,
> which addresses replies by exactly this resource name. Outbox dedup index (`job_outbox_ingest_zernio_review_inflight`)
handles duplicate webhook deliveries:

```sql
-- migration 030 partial unique index
(aggregate_id, (payload->>'zernio_review_id'))
WHERE topic = 'ingest_zernio_review' AND status NOT IN ('completed', 'failed')
```

Webhook fan-out uses `INSERT ... ON CONFLICT DO NOTHING` against this index.

**Per-location routing (multi-location hardening, 2026-06):** the webhook fan-out is
scoped per location. `worker/ingress/zernio/zernio.ts` reads
`parsed.locationIdFromPayload` (parsed from the review resource name
`accounts/{a}/locations/{loc}/reviews/{r}` by `parseZernioReviewWebhook`) and
narrows the fan-out to `zernio_connections WHERE zernio_account_id = …
AND zernio_location_id = <loc>` — so a review only lands on the location it
belongs to (no cross-routing across an account's locations). The ingest worker
then **fails closed** on a location mismatch: `extractLocationFromReviewName`
(`src/lib/reviews/zernio-normalize.ts`) returning null →
`ZernioIngestUnparseableLocationError`; a parsed location ≠ the connection's
`zernio_location_id` → no-op (it's a sibling location's review). The fan-out also
**skips archived locations** (PR A spend-leak fix): `guardZernioJobEligibility`
short-circuits jobs for an archived `business`, so an archived location never
ingests or generates a draft.

## Consented Review import (#675, PR #689)

`ZernioBackfillWorker` (topic `zernio_initial_backfill`) is the consented
Review import executor — NOT a backfill that answers anything. Selection is
the pure `selectImportWindow`: newest **100** reviews with `createTime ∈
[now − 12 months, live-ingest cutoff)`; the CONTEXT.md glossary owns both the
**Import window** and **Live-ingest cutoff** terms. The cutoff
(`liveIngestCutoff` in `zernio-ingest-shared.ts`, shared with
`ZernioRecentReviewPoller`) makes lane ownership disjoint by construction:
live lane ≥ cutoff, import < cutoff. Null `connected_at` → poller owns
nothing, import unbounded above.

- **No generation, no notifications**: unanswered reviews store via
  `importReview` (draft-free since #674 — zero `job_outbox` writes); answered
  reviews go through `reconcileExternallyAnsweredReview({ consentedImport:
  true })` regardless of `EXTERNAL_REPLY_IMPORT_ENABLED`.
- **Counters**: runs write collapsed `imported_count`/`skipped_count` (+
  `oldest_skipped_create_time`) on `zernio_backfill_runs`; the four legacy
  `gap_*`/`historical_*` columns freeze at DEFAULT 0 (#680 drops them).
  `skipped_count` counts cap overflow + PHI/malformed only — out-of-window
  reviews are unselected, not "skipped".
- **Pagination**: `ZERNIO_IMPORT_MAX_PAGES` (default 6) caps `listReviews`
  paging (pageSize 50, page-boundary dedup by review id). Early stops
  (target met / floor passed) are trusted only while ordering is clean; a
  non-descending page disables both for the run and it pages to feed end,
  best-effort (the staging sandbox feed IS non-descending in practice — see
  lab-notes). Cap exhausted with `nextPageToken` set and <100 in-window →
  **terminal** `ZernioImportPaginationCapExhaustedError` (failed outbox row +
  Sentry; NO `review_exceptions` row — distinct from the ingest worker's
  `zernio_pagination_cap_exhausted` exception path); `completed_at` stays
  NULL so ops can bump the cap and re-enqueue (consent permitting, spec §5.3).
- **Idempotency**: one-shot per business for `run_reason='initial'`
  (`completed_at` sentinel); reactivation runs key on `correlation_id`.
- **Consent**: the enqueue gates shipped at **#677** (below, which absorbed
  #676) and the fail-closed worker pre-flight at **#679**. The release
  constraint both carried is **discharged**.

### Who may enqueue an import (#677, PR #691)

Enforcement today is at the **four product enqueue paths**, each gating on
`import_decision='accepted'` while holding the `businesses` row lock. All four
delegate to ONE `enqueueInitialImport` in `src/lib/reviews/import-consent.ts`:

| Producer | File |
|---|---|
| Connect finalize | `src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts` |
| Stripe activation resume | `worker/ingress/stripe/shared.ts` |
| Reactivation catch-up | `src/lib/locations/archive-location-tx.ts` |
| The owner's decision route | `src/app/api/dashboard/import-offer/route.ts` |

Before #677 these were three hand-copied guards that had **already diverged**,
and none matched the banner's read model — a completed *reactivation* run
permanently suppressed the one-time initial import while `ImportOfferBanner`,
correctly scoped to `initial`, reported `importing` forever on a 4s poll. The
shared function scopes its guard to `br.run_reason='initial' AND completed_at
IS NOT NULL`, matching `readImportOfferView` exactly.

Reactivation is deliberately **not** routed through it: it enqueues with
`backfill_reason: 'reactivation'`, and the worker's `ON CONFLICT … WHERE
run_reason = 'initial'` does not dedup it, because the archived-period catch-up
must recur.

### The chokepoint (#679, PR #698)

The four gates above are producer-side, so they only bind code that goes through
a producer. `guardImportConsent` (`worker/jobs/zernio/job-eligibility.ts`) closes
the rest: `ZernioBackfillWorker` runs it **before** `guardZernioJobEligibility`
and before the run-row INSERT, and proceeds only on `accepted`.

| Derived state | Outcome |
|---|---|
| `accepted` | proceed |
| `pending` / `declined` / derived `expired` / no `businesses` row | log `import consent blocked — skipping backfill` with a structured `reason`, complete the outbox row, mint no run row |

Three properties to preserve if you touch it:

- **It is a separate function from `guardZernioJobEligibility`, not a `jobKind`
  branch.** A merged guard would have two callers, one of which (the live-ingest
  worker) must never reach consent code.
- **Its body must stay inside `sql.begin` with `SELECT … FOR UPDATE` and
  `markOutboxCompleted(tx, …)`.** Without both, the guard can read `pending`
  while the owner accepts; the acceptance's in-flight dedup then inserts no
  replacement and the guard completes the row, leaving `accepted` with no
  completed run and no runnable outbox row. `FOR UPDATE` is a no-op outside
  `sql.begin()` under transaction pooling. Lock order is business-before-outbox,
  matching all four producers.
- **Every skip is skip-as-success** — completed, never failed or retried, so a
  declined or expired import cannot churn the queue forever.

Because every producer converges here, the admin / hand-inserted path is covered
too: spec D8's "admin path included" holds structurally, not by convention.

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

> **Exhaustion write path (PR #508, P1):** the `zernio_review_not_found` and
> `zernio_pagination_cap_exhausted` rows are written by the ingest `'failed'`
> hook (`handleIngestFailed`, `worker/jobs/zernio/ingest-failed-hook.ts`)
> after BullMQ retries exhaust. Since #508 that hook is **crash-proof** (a
> last-resort never-rethrow guard — one review's failure bookkeeping must never
> take down the worker) and its coupled terminal writes run **CAS-first inside
> `sql.begin`** via `withOwnedTerminalTransition`: the `markOutboxFailed` CAS is
> the FIRST statement of the tx, the exception INSERT commits only when this
> attempt owns the terminal transition (a stale attempt writes nothing), and a
> mid-sequence failure rolls the whole unit back for atomic watchdog recovery —
> the crash guard never splits a rolled-back coupled tx.
> `insertReviewExceptionIfAbsent` is the single owner of the
> byte-for-byte-critical `ON CONFLICT` predicate.

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

**Branch 3 — "matched WITH active responses":** the supersede/protect logic
is flag-independent — protecting our own already-posted replies from being
clobbered by a webhook echo remains the same regardless of the flag. Since
#675 the branch has a **consented tail**: in the consented lane
(`consentedImport: true`), after superseding stale active drafts the external
reply IS stored (PHI-gated via `phiGateAndImportExternalReply`) — UNLESS
`protectedIds.size > 0`, i.e. one of the active responses is our own posted
reply, which already represents the text locally (an imported `posted` row
would duplicate it). The live lane (flag path) still converges on a later
poll instead; a one-shot import cannot, which is why the tail exists.

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

**The published-reply text** is shown on the **Reviews list**
(`dashboard/reviews/history`) via the `PastReplyCard` component. That surface
is **no longer flag-gated**: `PAST_REPLIES_VIEW_ENABLED` was retired at #678
(spec `docs/superpowers/specs/2026-08-05-consented-review-import-design.md`
§6.3a S4) because the Reviews list is the consented **Review import**'s only
destination — keeping the gate would have let `import_decision='accepted'`
coexist with the imported reviews landing on a `notFound()`. Consequence for
rollout: `EXTERNAL_REPLY_IMPORT_ENABLED` alone now decides both the write and
the exposure, so there is no silent-soak window — flipping it on shifts the
dashboard "total responded" count and surfaces the imported replies in the
same step. `EDIT_REPLIES_ENABLED` still separately gates every mutation
(Regenerate → republish), which is the risk that actually warranted a flag.

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

- **`first_review_ingested`** — enqueued from `processReview` **and from
  `importReview`** (#674 — both call the shared `maybeEnqueueFirstReviewIngested`)
  with `event_key = first_review_ingested:<account_id>`. The "is this the account's
  first review?" check is an account-scoped `EXISTS` subquery, but correctness
  does **not** depend on that read winning a race: the account-scoped key plus
  `analytics_events.event_key UNIQUE` + `ON CONFLICT DO NOTHING` is the real
  dedup, so concurrent first reviews collapse to one row — including a live
  ingest and an import racing on the same account's first review.
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
