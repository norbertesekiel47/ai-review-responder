# Edit Existing Replies — Tier-Mirrored

**Date:** 2026-05-01
**Author:** Norbert (with Claude Code)
**Status:** Draft v1
**Related migrations:** 03X (next free) — adds `reviews.external_reply_ingested_at`, partial unique index `responses_one_posted_per_review`, counter `zernio_backfill_runs.external_reply_ingested_count`. Number to be confirmed when the implementation plan is written.
**Related specs:** `2026-04-29-zernio-ingestion-replace-serpapi-design.md` (Zernio webhook ingestion — establishes the backfill / reconcile pipeline this design extends).
**Feature flag:** `EDIT_EXISTING_REPLIES_ENABLED` (new), default `false`.

---

## 1. Motivation

When a business onboards through `/dashboard/connect`, `ZernioBackfillWorker` walks `listAllReviews` and routes each review one of two ways:

- **Unanswered reviews** (`reviewReply === null`) → bucket into gap/historical, process via `processReview`, generate AI drafts (subject to tier caps).
- **Already-answered reviews** (`reviewReply !== null`) → handed to `reconcileExternallyAnsweredReview`, which **silently no-ops on previously-unseen reviews**:

```ts
if (matchedRows.length === 0) {
  logger.log(`External reply on previously-unseen review ${target.id} — not ingesting`);
  return;
}
```

The result: any review the owner already replied to on Google before connecting RepWorth disappears from our database. For the Tanicia Resort onboarding (2026-05-01), this means 8 of 158 reviews never made it into the dashboard. The owner has no record of past engagement, voice learning has zero examples to bootstrap from, and there's no path to refine a reply through RepWorth even though Zernio supports doing so.

This spec ingests the silently-dropped reviews into our DB as `posted` responses, surfaces them in a new "Past Replies" tab, and gives owners — within their tier — the ability to edit / regenerate / re-publish.

## 2. Non-goals

- **Bulk regenerate / "regenerate all".** Deferred to v2 if demand emerges. v1 is one-at-a-time only.
- **Email approval round-trip for edits.** Owner is on the dashboard by definition when editing. Dashboard click logged via `approval_audit_log.auth_method='owner_session'` IS the approval.
- **AI drafts for unanswered historical reviews.** Already covered by today's tier-capped backfill behavior; not changing.
- **Dynamic tier definition.** Premium already exists end-to-end (Stripe Payment Link, env vars, schema). We expand what premium unlocks, not what the tier IS.
- **Inbox add-on changes.** Already a dependency we pay for. The spec assumes it stays active; failure mode is documented in §4.7.
- **A new outbox topic for edit-publishing.** `publish_response` is reused — the publisher learns to DELETE before POST when a sibling `posted` response exists.

## 3. Goals

1. Persist already-replied reviews into `reviews` + `responses` so they're queryable and visible in the dashboard. (Note: these rows do **not** seed the voice-learning hook — that hook reads `edited_text IS NOT NULL` per `src/lib/responses/voice-learning.ts:30`, and an imported reply has no draft-vs-edit history. Voice learning continues to bootstrap from RepWorth-driven owner edits only.)
2. Add a "Past Replies" tab to `/dashboard` listing them, grouped into "From your active period" (gap) and "From before you joined" (historical).
3. Per the C-2 tier rule:

   | Action | Standard / Founding | Premium |
   |---|---|---|
   | **See** existing replies | ✅ all | ✅ all |
   | **Edit / regenerate** reply for **gap** review | ✅ | ✅ |
   | **Edit / regenerate** reply for **historical** review | ❌ | ✅ |

4. Two edit modes per review: **manual** (textarea pre-filled with current reply) and **AI regenerate** (uses current voice settings + voice-learning examples, lands as a `pending_approval` draft).
5. Optimistic concurrency on save — `review_content_hash` + `responses.version` snapshotted on edit-open, re-validated on publish. Stale clients refused with a clear error.
6. Reuse the existing `publish_response` outbox topic + `ResponsePublisherWorker` infrastructure; add a DELETE-before-POST branch when a sibling `posted` response exists.
7. Preserve the project invariants in `.claude/CLAUDE.md` — explicit owner approval per response, tier gate enforced server-side (not just hidden in UI), audit trail in `approval_audit_log`.
8. Two-phase rollout via `EDIT_EXISTING_REPLIES_ENABLED` flag — Phase A (data ingestion only, UI off) for soak; Phase B flips the flag to light the UI.

## 4. Architecture

### 4.1 The C-2 tier rule (formalized)

For a given review and the connected business:

```
isHistorical = business.subscription_activated_at IS NULL
                  OR review.review_date < business.subscription_activated_at
isPremium    = business.subscription_tier === 'premium'

canEdit = NOT isHistorical OR isPremium
```

Boundary: a review where `review_date == subscription_activated_at` is treated as **gap** (the `>=` predicate). Reviewers can't post a review the same instant a business activates Stripe in practice, so the boundary is purely defensive.

**NULL `subscription_activated_at` handling.** The connect flow logs a warning when `subscription_activated_at` is NULL at `src/app/api/zernio/connect/select-location/route.ts:469` (the column was added in migration 014 but legacy rows from before that migration could lack it). Edit-existing fails closed in this case: a NULL activation timestamp means we can't anchor the gap/historical boundary, so EVERY review is treated as historical. Standard owners get no edit affordance; premium owners can still edit (subject to the historical cap). This matches the cautious stance of the existing connect-flow code.

The check lives in a new helper `assertCanEditReply(reviewId, user)` (see §4.2) and runs at every API entry point — UI lock states are layered on top, but the server is authoritative.

### 4.2 Component touch list

**Worker layer**

| File | Change | New / modified |
|---|---|---|
| `worker/jobs/zernio-ingest-shared.ts` | `reconcileExternallyAnsweredReview` returns `Promise<void>` today. Rather than introducing a discriminated result for the new helper to inspect (which would require updating both call sites in a coordinated way), we keep the new logic **inside** `reconcileExternallyAnsweredReview` itself — the function picks up new branches for "no match" and "matched but no active responses" (both gated by `EDIT_EXISTING_REPLIES_ENABLED`) and calls private helpers `insertImportedReview` + `insertImportedResponse` as needed. From the caller's perspective the contract is unchanged. | Modified |
| `worker/jobs/ZernioBackfillWorker.ts` | No code changes required — `reconcileExternallyAnsweredReview` is called exactly as today. Bumping `external_reply_ingested_count` happens inside the shared helper via a follow-up SQL UPDATE keyed on the active backfill run (looked up by business_id, completed_at IS NULL). | Modified (counter bump only) |
| `worker/jobs/ZernioReviewIngestWorker.ts` | No code changes required — identical reasoning. | Unchanged |
| `worker/jobs/ResponsePublisherWorker.ts` | New DELETE-before-POST branch when sibling `posted` response exists. Failure-mode handling per §4.7. Gated by `EDIT_EXISTING_REPLIES_ENABLED` (when off, falls through to today's POST-only behavior). | Modified |
| `worker/index.ts` | Extend the existing `publish_response` BullMQ `onFailed` hook (where `applyTransientExhaustionFallback` lives today) to recognize the orphan-marker on retry exhaustion. The hook runs in one tx using the **canonical review → response lock order** (matches `processReview` at `process-review.ts:36`-`:155`) and **business-scopes every statement** with `business_id` from the failed job's payload. Behavior: (1) read response's `review_id` (scoped); (2) `reviews FOR UPDATE` (scoped); (3) `responses FOR UPDATE` (scoped); (4) if status is no longer publishable → `markOutboxCompleted` (idempotent no-op; processReview won the race); (5) if `posting_error LIKE '%_after_delete_succeeded'` → transition to `status='failed'` with `posting_error='post_after_delete_failed_retry_exhausted'` (status-guarded, business-scoped, affected-row-checked) and `markOutboxFailed`; (6) otherwise → ROLLBACK and fall through to today's `applyTransientExhaustionFallback`. Full SQL in §4.5 "Retry exhaustion conversion" block. | Modified |

**Zernio client layer**

| File | Change |
|---|---|
| `src/lib/zernio/client.ts` | Add `deleteReply(accountId, reviewId)` targeting `DELETE /v1/inbox/reviews/{reviewId}/reply` with **`timeoutMs: 15_000` explicitly** (matches `postReply`'s 15s timeout — the §4.5 publisher lock-window rationale assumes the DELETE+POST external I/O caps at ~30s combined; inheriting the client's default 10s would shorten the bound but a future change to that default could break the rationale, and conversely if implementers forget to set the timeout the lock could hang indefinitely on a stuck connection). Add `'delete_reply'` to `mockResponse`'s switch statement returning `undefined`. Add `'delete_reply'` to `NO_BODY_ENDPOINTS` (DELETE response has minimal body; consistent with other DELETE endpoints). |
| `src/lib/zernio/types.ts` | Add `'delete_reply'` to `EndpointKind`. |

**Note on path inconsistency.** Existing `postReply` uses legacy `/v1/accounts/{accountId}/gmb-reviews/{reviewId}/reply`; new `deleteReply` uses documented `/v1/inbox/reviews/{reviewId}/reply`. Functionally fine — both endpoints work in production. Deferred follow-up: migrate `postReply` to the documented path. Out of scope here.

**Edit / concurrency layer (new module)**

| File | Purpose |
|---|---|
| `src/lib/responses/edit-existing.ts` | Exports `assertCanEditReply(reviewId, user)` (tier + ownership gate, throws structured errors mapping to HTTP codes) and `validateOptimisticConcurrency(tx: TxClient, reviewId, snapshot: { hash, version })` (re-checks review hash + posted-row version, throws structured errors on mismatch). **Takes a transaction handle as the first argument** so it cannot be safely called outside an open tx — see §4.6 for the TOCTOU rationale (caller MUST have already acquired `SELECT FROM reviews WHERE id=... FOR UPDATE` before invoking, or the optimistic check is racy). |

**API routes**

| Route | Verb | Body / Query | Returns |
|---|---|---|---|
**Critical state-machine constraint.** Drafts MUST stay in `status='pending_approval'` until `/publish` runs. The status `'edited'` is included in `HANDLED_STATUSES` per `src/lib/shared/response-status.ts:46`, which means an `'edited'` row counts as "responded" in dashboard metrics. If `/draft` (manual) inserted directly as `'edited'` and the owner closed the drawer before `/publish`, the dashboard would show "responded" for a row that Google never saw an updated reply for. To prevent that orphan-handled state, all routes treat the row as `'pending_approval'` until the same transaction that flips it to a publishable status (`'edited'` or `'approved'`) ALSO inserts the `publish_response` outbox row. There is no public route that transitions a row INTO a HANDLED status without simultaneously enqueuing publishing work.

| Route | Verb | Body / Query | Returns |
|---|---|---|---|
| `/api/dashboard/past-replies/draft` | POST | `{ review_id, mode: 'manual' \| 'regenerate', new_text?, snapshot: { hash, version } }` | **manual:** `{ response_id }` — row is INSERTed synchronously with **`status='pending_approval'`** (NOT `'edited'`); the owner-edited text lives in `edited_text` so voice learning will pick it up after eventual publish. **regenerate:** `{ outbox_id }` — `generate_response` outbox enqueued; worker creates the `pending_approval` row when generation completes. Client polls `/draft-status?outbox_id=...`. **In-flight guard (both modes):** the route checks for an existing in-flight regenerate before proceeding (see "In-flight regenerate guard" note below); rejects with 409 `regenerate_in_progress` if one is found. Also enforces "no existing non-terminal response" via the migration-023 constraint when manual mode INSERTs. |
| `/api/dashboard/past-replies/draft/:response_id` | PATCH | `{ new_text, snapshot: { hash, version } }` | `204` — used for "Edit further" after AI regenerate. UPDATEs the existing draft's `approved_text` and `edited_text`; **status remains `'pending_approval'`** (only `/publish` transitions out of it). Idempotent. |
| `/api/dashboard/past-replies/draft/:response_id` | DELETE | — | `204` — discards a draft. UPDATE response SET status='superseded' inside a tx with `FOR UPDATE`; safe to call even if status has already moved past `'pending_approval'` (no-op in that case). Used for "Cancel" CTA in the regenerate-preview state. |
| `/api/dashboard/past-replies/publish` | POST | `{ response_id, snapshot: { hash, version } }` | `{ outbox_id }` — in **one transaction**: validates response is `'pending_approval'`, transitions to `'edited'` (if `edited_text IS NOT NULL`) or `'approved'` (if NULL), inserts `approval_audit_log` row, enqueues `publish_response` outbox. Atomic — either all three happen or none, so the row never sits in a handled state without an outbox to publish it. |
| `/api/dashboard/past-replies/:response_id/retry` | POST | `{}` (no snapshot) | `{ outbox_id }` — used by recovery UI when `status='failed'`. **Validates against an allowlist of `posting_error` prefixes** (`delete_failed_*` and `post_after_delete_failed_*`); rejects with 409 `not_recoverable_via_retry` for other failure causes — including `review_content_changed` (set by `process-review.ts:210` for `pending_approval` drafts) AND `stale_after_review_changed` (set by the new process-review branch in §4.5 when a customer edits the review AFTER an edit-publisher failure, invalidating the previously recoverable row). Lock order: review → response → INSERTs (see §4.7 SQL). In one tx: UPDATEs to `'approved'`, transitions `posting_error` per the failed prefix (`delete_failed_*` → cleared to NULL since the sibling `'posted'` is still alive on Google; `post_after_delete_failed_*` → re-installed as `'pending_after_delete_succeeded'` so the next publisher attempt's `isOrphanRetry` stays true and the worker uses the no-DELETE branch with orphan-recoverable failure semantics), audit-logs via `insertAuditLogSession`, enqueues `publish_response`. **Does NOT call `validateOptimisticConcurrency`** — see "Recovery validation" note below. |
| `/api/dashboard/past-replies/:response_id/restore-original` | POST | `{}` (no snapshot) | `{ response_id: <new> }` — used by recovery UI when DELETE-success+POST-fail orphaned the live reply. **Validates: `posting_error` starts with `post_after_delete_failed_*` AND no `'posted'` sibling exists AND a `'superseded'` sibling exists.** This is the only recovery path that can succeed without a current `'posted'` row (Google's reply slot is empty). Rejects with 409 if the conditions aren't met. **Does NOT call `validateOptimisticConcurrency`** — see "Recovery validation" note. See §4.7 for the full SQL spec. |
| `/api/dashboard/past-replies/draft-status` | GET | `?outbox_id=<uuid>` | Reads `job_outbox` row state (the worker doesn't create a `failed` response row on generation failure — `worker/jobs/ResponseGeneratorWorker.ts:182` marks the outbox failed instead). **Auth:** before reading the outbox, the route MUST verify `job_outbox.payload->>'business_id' = user.businessId` and the resolved `response_id` (when present) also belongs to the same business. Without this check, polling by raw `outbox_id` could leak generation status, errors, or response text across tenant boundaries. Responses: `{ status: 'generating' }` while pending/dispatching/dispatched, `{ response_id, status: 'pending_approval', response_text }` on completion (looked up from the response row created by the worker), `{ status: 'failed', error }` on outbox failure. |

**Cross-cutting requirements — apply to ALL seven routes above (POST `/draft`, PATCH `/draft/:id`, DELETE `/draft/:id`, POST `/publish`, POST `/:id/retry`, POST `/:id/restore-original`, GET `/draft-status`):**

- **CSRF:** all mutating routes (POST/PATCH/DELETE) wrapped with `withSameOrigin` middleware. The GET `/draft-status` is exempt from origin checking (GET requests are not subject to the same CSRF threat model) but still requires the auth + ownership checks below.
- **Auth:** owner session via `requireRole`.
- **Feature flag:** `EDIT_EXISTING_REPLIES_ENABLED=true` required; otherwise return 503 `feature_disabled`.
- **Tier gate:** `assertCanEditReply` BEFORE any side effects, BEFORE optimistic checks. (Note: `assertCanEditReply` does not apply to `/draft-status` — that's a read-only status poll. But `/draft-status` MUST verify the outbox/response belongs to the user's business per the route description above.)
- **Ownership:** every route resolves `business_id` from the user's session and uses it to scope DB lookups; nothing is keyed off client-supplied `business_id`.
- **Optimistic concurrency:** `validateOptimisticConcurrency` BEFORE any DB writes on `/draft`, PATCH `/draft/:id`, `/publish`. (DELETE `/draft/:id` and GET `/draft-status` skip this — DELETE is idempotent and `/draft-status` is read-only.)
- **Recovery validation (NOT optimistic concurrency):** `/retry` and `/restore-original` do NOT call `validateOptimisticConcurrency` because by definition they operate on the post-failure state where there may be NO `posted` row (DELETE succeeded but POST failed → sibling is `'superseded'`, candidate is `'failed'`, no `'posted'` exists). Standard validation would throw `ResponseChangedError` and lock recovery forever. Instead, these routes use `FOR UPDATE` on the failed candidate row and a status check inside the tx — if two `/retry` clicks race, the second sees `status != 'failed'` (because the first already transitioned it to `'approved'`) and refuses with 409 `already_recovered`.
- **Tx atomicity:** routes that transition status into a `HANDLED_STATUSES` value (`/publish`, `/retry`) MUST INSERT the `publish_response` outbox row in the same transaction. No public route leaves a row in HANDLED state without an outbox to act on it.

**In-flight regenerate guard.** The migration-023 partial unique index on `responses` only protects against two non-terminal RESPONSE ROWS. In regenerate mode, the response row doesn't exist until the worker completes — so the index can't catch two concurrent `/draft` (regenerate) calls. A naive `SELECT 1 FROM job_outbox` check is also race-unsafe: under default Postgres `READ COMMITTED` isolation, two concurrent transactions can both read no row and both INSERT.

We serialize via a row-level lock on the `reviews` row. Both `/draft` (manual) and `/draft` (regenerate) acquire the same lock, so they cannot interleave. The check covers BOTH non-terminal response rows AND in-flight regenerate outbox rows — either condition rejects the new draft:

```sql
BEGIN;

-- 1. Acquire a stable lock keyed on the review. Two concurrent /draft calls
--    on the same review will serialize here — second waits until first commits.
--    NON-STRICT with explicit no-row → 404 (route returns clean error,
--    not an unhandled exception).
SELECT id INTO _r FROM reviews
WHERE id = $review_id AND business_id = $user_business_id
FOR UPDATE;
IF NOT FOUND THEN RAISE 'review_not_found'; END IF;   -- 404

-- 2a. Reject if any non-terminal response already exists. This catches:
--     - manual draft already pending (would violate migration-023 partial
--       unique index when this route INSERTs)
--     - regenerate-in-flight worker has already INSERTed pending_approval
--     - Edge case the partial unique index alone wouldn't catch in regenerate
--       mode — without this check, regenerate would enqueue an outbox row,
--       worker would spend on LLM, then fail on the migration-023 index when
--       trying to INSERT pending_approval at ResponseGeneratorWorker.ts:300.
SELECT 1 INTO _existing FROM responses
WHERE review_id = $review_id
  AND status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect');
IF FOUND THEN
  RAISE 'draft_already_exists';   -- 409 'draft_already_exists'
END IF;

-- 2b. Reject if a regenerate is in flight (worker hasn't INSERTed yet,
--     so step 2a wouldn't catch it).
SELECT 1 INTO _existing FROM job_outbox
WHERE topic = 'generate_response'
  AND aggregate_id = $review_id
  AND status IN ('pending', 'dispatching', 'dispatched');
IF FOUND THEN
  RAISE 'regenerate_in_progress';   -- 409 'regenerate_in_progress'
END IF;

-- 3. Manual mode: INSERT response row (migration-023 partial unique index
--    is defense in depth; step 2a should have caught any duplicate).
-- 3'. Regenerate mode: INSERT job_outbox row.

COMMIT;
```

The `reviews` row lock is brief (held only for the SELECT + INSERT path, no LLM calls or external I/O inside the lock window) so contention is negligible. This pattern matches how `src/app/api/zernio/connect/start/route.ts` serializes the connect flow — short critical section, lock released at COMMIT.

**Optional database-level enforcement (future):** a partial unique index on `job_outbox(aggregate_id) WHERE topic='generate_response' AND status IN ('pending','dispatching','dispatched')` would catch the race even without the row lock. Adds complexity to outbox UPDATEs (status transitions to 'completed' must happen before any new INSERT for the same review). Tracked as out-of-scope follow-up.

**Frontend**

| File | Purpose |
|---|---|
| `src/app/(authenticated)/dashboard/past-replies/page.tsx` | Server component. Reads reviews where `responses.status='posted'` and renders the bucketed view (Q6 option B — section divider). |
| `src/components/dashboard/PastReplyCard.tsx` | Single row. Shows review summary, current reply text, Edit button (or lock badge per tier rule). |
| `src/components/dashboard/EditReplyDrawer.tsx` | Slide-out drawer / modal. Two-mode UI per Q3: "Edit manually" textarea OR "Regenerate with AI" → preview → publish. Polls `/draft-status` during regen. |
| `src/components/dashboard/HistoricalUpgradeBanner.tsx` | Single soft banner at top of historical section for non-premium owners. |
| Existing dashboard navigation | Add "Past Replies" tab item. |

**Migration**

The migration **must not run inside a transaction** because of the `CREATE UNIQUE INDEX CONCURRENTLY` statement. Apply it via the Supabase SQL editor with the multi-statement transaction box unchecked, OR split the file at the obvious boundary if the migration runner doesn't support per-statement isolation.

```sql
-- supabase/migrations/03X_edit_existing_replies.sql
-- IMPORTANT: this file mixes transactional DDL with CONCURRENTLY index
-- creation. Apply non-transactionally.

-- 1. Track which reviews came in already-replied at first ingest.
ALTER TABLE reviews ADD COLUMN external_reply_ingested_at TIMESTAMPTZ NULL;

-- 2. Counter for backfill summary visibility.
ALTER TABLE zernio_backfill_runs
  ADD COLUMN external_reply_ingested_count INTEGER NOT NULL DEFAULT 0;

-- 3. At any time exactly ONE responses row per review can be 'posted'
--    (Google has at most one live reply per review). Protects against
--    publisher bugs that might double-post.
--
--    CONCURRENTLY is REQUIRED — migration 023's note (supabase/migrations/
--    023_non_terminal_response_uniqueness.sql:20) flags that plain index
--    creation can take ACCESS EXCLUSIVE on responses, which is a sizable
--    table. CONCURRENTLY uses a less-blocking approach (RowExclusive +
--    ShareUpdateExclusive) at the cost of doing two table scans and not
--    running inside a transaction.
CREATE UNIQUE INDEX CONCURRENTLY responses_one_posted_per_review
  ON responses (review_id)
  WHERE status = 'posted';
```

**Pre-flight check before applying** — must run against the target database before the migration:

```sql
SELECT review_id, count(*) FROM responses
  WHERE status = 'posted'
  GROUP BY review_id
  HAVING count(*) > 1;
-- expect: empty
```

If non-empty, BLOCK migration and surface to ops; investigate the duplicate `posted` rows before proceeding. The CONCURRENTLY index build will fail mid-way if duplicates exist — leaving the index in an INVALID state that requires `DROP INDEX` + re-creation. Pre-flight catches it cleanly.

**Maintenance window.** Even with CONCURRENTLY, expect the index build to take O(seconds) per 100k responses rows. Run during a quiet window. If interrupted, the resulting INVALID index needs cleanup (`DROP INDEX responses_one_posted_per_review` + retry).

### 4.3 Ingestion flow (gated by `EDIT_EXISTING_REPLIES_ENABLED`)

**Important:** unlike earlier drafts of this spec, ingestion is **gated by the same flag as the UI**. When the flag is off, `reconcileExternallyAnsweredReview` falls back to today's silent-no-op behavior. The reason: imported `posted` responses count toward dashboard metrics via `src/lib/dashboard/service.ts:98` (HANDLED_STATUSES includes `'posted'`) and surface in the value-summary widget — so ingesting them would change customer-visible numbers BEFORE the UI surfaces them, breaking the "Phase A is invisible" promise. Gating both behind one flag means the ingest + UI light up together at flag-flip time.

```
ZernioBackfillWorker / ZernioReviewIngestWorker
    │
    │ for each review with reviewReply !== null
    ▼
reconcileExternallyAnsweredReview(review, ...)
    │
    │  matchedRows = SELECT FROM reviews WHERE provider='zernio' OR
    │                                          (provider='serpapi_poll' AND field-match)
    ▼
    ├── matchedRows.length == 0
    │     │
    │     IF EDIT_EXISTING_REPLIES_ENABLED:
    │     ├─► insertImportedReview() + insertImportedResponse()   [NEW]
    │     ELSE:
    │     └─► no-op (today's behavior, unchanged)
    │
    ├── matchedRows.length > 0 AND no active non-superseded response
    │     │  (today: no-op at zernio-ingest-shared.ts:146)
    │     │
    │     IF EDIT_EXISTING_REPLIES_ENABLED:
    │     ├─► insertImportedResponse() ONLY                        [NEW]
    │     │   (review row already exists; we just need a 'posted' response
    │     │    reflecting the existing Google reply)
    │     ELSE:
    │     └─► no-op (today's behavior, unchanged)
    │
    └── matchedRows.length > 0 AND active responses exist
          └─► existing supersede/protect logic (today's behavior, unchanged)
```

**`insertImportedReview` — new helper.** INSERTs the review row with all required columns. **Race-safe via ON CONFLICT DO UPDATE.** A plain `ON CONFLICT DO NOTHING RETURNING id` is NOT race-safe: under concurrent transactions the conflicting INSERT can wait for the other tx to commit, then the DO NOTHING branch fires (correct), but `RETURNING` is empty AND the same statement's snapshot still cannot see the just-committed sibling row (snapshot consistency). A subsequent SELECT in the same statement (e.g. via UNION ALL CTE) sees the same snapshot and also returns nothing, leaving us with no id.

`ON CONFLICT DO UPDATE` is race-safe because the UPDATE always RETURNs the row id, whether it was just INSERTed or already existed. We use a no-op UPDATE (`SET id = id`) to avoid touching any data:

```sql
INSERT INTO reviews (
  id, business_id, provider, provider_review_id, provider_review_name,
  provider_location_name, reviewer_name, star_rating, review_text, review_date,
  detected_language, review_content_hash, detected_at, status,
  external_reply_ingested_at
)
VALUES (
  gen_random_uuid(), $business_id, 'zernio', $zernio_review_id,
  $provider_review_name, $provider_location_name, $reviewer_name, $star_rating,
  $review_text, $review_date, $detected_language, $review_content_hash, NOW(),
  'new', NOW()
)
ON CONFLICT (provider, provider_review_name) DO UPDATE
  SET id = reviews.id  -- no-op; we just want a row returned
RETURNING id
```

Idempotency target is `(provider, provider_review_name)` — the actual unique constraint per `supabase/migrations/001_initial_schema.sql:181`, NOT just `provider_review_name`.

**Note on `external_reply_ingested_at` semantics on race:** if two ingest paths race and only one's INSERT actually creates the row, the loser's `NOW()` value is discarded (DO UPDATE doesn't touch `external_reply_ingested_at`). The column reflects when the first ingest committed — within sub-second precision either way.

**Note on the no-op UPDATE.** Setting `id = reviews.id` triggers no observable change (same value), but Postgres still issues a row-level write lock and bumps the row's `xmin`. This is harmless for our use case — `reviews` rows aren't long-lived hot rows and the bump doesn't affect any application logic. If this becomes a concern later, the alternative is a dedicated lock-then-INSERT-or-SELECT pattern keyed on the same business+review combination, but the no-op UPDATE is simpler and sufficient.

**`insertImportedResponse` — new helper.** INSERTs the `posted` response. Both `response_text` and `original_draft_text` are `NOT NULL` per `supabase/migrations/001_initial_schema.sql:194,215`, so all three text columns get the same imported text. Schema also enforces `UNIQUE (review_id, version)` per `supabase/migrations/001_initial_schema.sql:234`, so for the **"matched but no active responses"** branch we cannot blindly use `version=1` (an existing terminal response may already occupy v1). Compute version dynamically:

```sql
INSERT INTO responses (
  id, review_id, business_id,
  response_text,           -- = canonicalize(reviewReply.comment)
  approved_text,           -- = canonicalize(reviewReply.comment)
  original_draft_text,     -- = canonicalize(reviewReply.comment)
  edited_text,             -- NULL (not edited from a draft)
  response_language,
  version,                 -- = COALESCE((SELECT MAX(version) FROM responses
                           --              WHERE review_id = $review_id), 0) + 1
  status,                  -- 'posted'
  approved_at,             -- = reviewReply.updateTime (best signal we have)
  posted_at,               -- = reviewReply.updateTime
  llm_provider,            -- NULL (signals "not RepWorth-generated")
  llm_model,               -- NULL
  prompt_tokens,           -- NULL
  completion_tokens        -- NULL
)
SELECT
  gen_random_uuid(), $review_id, $business_id,
  $reply_text, $reply_text, $reply_text, NULL,
  $detected_language,
  COALESCE((SELECT MAX(version) FROM responses WHERE review_id = $review_id), 0) + 1,
  'posted',
  $update_time, $update_time,
  NULL, NULL, NULL, NULL
ON CONFLICT (review_id) WHERE status = 'posted' DO NOTHING
```

For the **"no match" branch**, the review row was just inserted by `insertImportedReview` so the MAX subquery returns NULL → `version=1`. For the **"matched but no active responses" branch**, MAX(version) returns the highest existing version (could be 1, 2, or higher from prior superseded/failed rows) and we land at MAX+1. Both unique constraints (`unique_review_version` AND `responses_one_posted_per_review`) are respected.

The `ON CONFLICT` clause uses the new `responses_one_posted_per_review` partial unique index (see §4.2 migration). Re-running backfill or replaying webhooks doesn't duplicate.

### 4.4 Edit flow (Phases 2-4 — owner edits and publishes)

**Phase 2: Owner opens Past Replies tab.**

```
GET /dashboard/past-replies?page=N (paginated, default 50/page)
    │
    ▼
Server component reads:
    SELECT r.id, r.review_text, r.review_date, r.review_content_hash,
           resp.id as response_id, resp.approved_text, resp.posted_at, resp.version,
           r.external_reply_ingested_at
    FROM reviews r
    JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted'
    WHERE r.business_id = $current_business
    ORDER BY r.review_date DESC
    LIMIT 50 OFFSET (page - 1) * 50;

    -- Two count queries for the section headers (cheap, indexed):
    SELECT count(*) FROM reviews r
      JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted'
      WHERE r.business_id = $b AND r.review_date >= $activated_at;   -- gap_total
    SELECT count(*) FROM reviews r
      JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted'
      WHERE r.business_id = $b AND
            ($activated_at IS NULL OR r.review_date < $activated_at); -- hist_total

    Bucket the page's rows into the section the owner is viewing.

    is_premium = business.subscription_tier === 'premium'

    Render:
      Section "From your active period (N=gap_total)"  -> gap; edit enabled
      Section "From before you joined (M=hist_total)"  -> historical
                                                          if !is_premium → lock badges + HistoricalUpgradeBanner
                                                          if is_premium → edit enabled
      Pagination controls: Previous / page X of Y / Next
```

**Index recommendation.** The query orders by `(reviews.business_id, review_date DESC)` and joins to responses. **Verify against current indexes during plan-writing — only add if absent.** Most existing per-business queries already use a similar pattern. If we DO need to add it, use CONCURRENTLY for the same reason as the `responses_one_posted_per_review` index: `reviews` is sizable in production, plain `CREATE INDEX` would take an `ACCESS EXCLUSIVE` lock per the migration-023 note pattern. The migration is already non-transactional (per §4.2), so adding CONCURRENTLY here is safe:

```sql
-- only create if not already covered by an existing index
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_business_review_date
  ON reviews (business_id, review_date DESC);
```

Note: `CREATE INDEX CONCURRENTLY` requires running outside a transaction — already required for this migration file (per §4.2's "must not run inside a transaction" comment).

**Phase 3a: Manual edit.**

```
EditReplyDrawer opens (manual mode)
    │  client snapshots: { hash: review.review_content_hash,
    │                      version: posted_response.version }
    │  textarea pre-filled with response.approved_text
    │  owner edits
    ▼
POST /api/dashboard/past-replies/draft
    body: { review_id, mode: 'manual', new_text, snapshot }
    │
    ▼
Route handler:
    1. assertCanEditReply(review_id, user)            [tier + ownership gate]
       (NOT pre-tx: this is a pure permission check, no race risk)
    2. Inside ONE tx (lock order: review → posted response → INSERT, EVERY route):
       a. SELECT id, review_content_hash FROM reviews
            WHERE id = $review_id AND business_id = $user_business_id
            FOR UPDATE
          (this is the same lock used by the in-flight guard in §4.2 — same
           order, same row. processReview at src/lib/reviews/process-review.ts:36
           also acquires this lock when ingesting a webhook update; if processReview
           is mid-flight, our route blocks here until it commits, then sees the
           updated review_content_hash. No TOCTOU window.)
       b. **In-flight guard (§4.2) — runs BEFORE optimistic check.** Reject if
          a non-terminal response or in-flight generate_response outbox row
          exists for this review. Critical: the publisher does NOT acquire
          the reviews lock when transitioning approved/edited → posted at
          worker/jobs/ResponsePublisherWorker.ts:436. Without this guard
          running first, validateOptimisticConcurrency could pass against
          an old `posted` row at the exact moment a previous approved edit
          is becoming the new `posted` row — letting Owner B start a draft
          based on stale state. The guard catches that previous edit (still
          in 'approved' or 'edited' until the publisher commits) and 409s.
            SELECT 1 FROM responses WHERE review_id=$id AND status IN
              ('pending_approval','approved','edited','awaiting_owner_connect')
              → 409 'draft_already_exists' if found
            SELECT 1 FROM job_outbox WHERE topic='generate_response'
              AND aggregate_id=$id AND status IN ('pending','dispatching','dispatched')
              → 409 'regenerate_in_progress' if found
       c. validateOptimisticConcurrency(tx, review_id, snapshot) INSIDE THE TX:
            IF reviews.review_content_hash differs from snapshot.hash → 409 'review_changed'
            IF SELECT FROM responses WHERE review_id=$id AND status='posted'
               returns no row → 409 'response_changed'
            IF posted_response.version differs from snapshot.version → 409 'response_changed'
            (validates against the LIVE 'posted' row, not the just-INSERTed draft)
       d. Compute next_version = COALESCE(MAX(version), 0) + 1 from responses
          WHERE review_id = $review_id. NOT posted.version + 1 — a prior
          terminal row at higher version (e.g. posted=v1, failed=v2) would
          collide with UNIQUE(review_id, version) per
          supabase/migrations/001_initial_schema.sql:234. The same idiom is
          already used by src/lib/reviews/process-review.ts:175-184 for the
          identical reason (preventing collision with terminal versions).
       e. INSERT responses (
            status='pending_approval',                     -- NOT 'edited' — see §4.2 atomicity rule
            response_text=<posted.approved_text>,          -- the "before" text (what was on Google)
            approved_text=new_text,                        -- the new owner-edited text
            original_draft_text=<posted.approved_text>,    -- NOT NULL; same as response_text
            edited_text=new_text,                          -- voice-learning signal: owner edited from
                                                           -- response_text to edited_text. Picked up
                                                           -- AFTER /publish transitions to a posted state.
            version=next_version)
       — migration-023 partial unique index protects against concurrent INSERTs
       — COMMIT (steps 2a-d run in one tx; the reviews row lock is held throughout)
    3. RETURN { response_id }
    │
    ▼
Client → POST /api/dashboard/past-replies/publish
    body: { response_id, snapshot: { hash, version } }
    │
    ▼
Route handler:
    1. assertCanEditReply (defense in depth, pre-tx)
    2. Inside ONE tx (lock order: review → candidate response → posted response → outbox):
       a. SELECT id, review_content_hash FROM reviews
            WHERE id = (SELECT review_id FROM responses WHERE id = $response_id)
              AND business_id = $user_business_id
            FOR UPDATE
          (acquire the review lock FIRST, before any response-row reads, to match
           the lock order used by /draft and process-review.ts:36 — prevents deadlock.)
       b. validateOptimisticConcurrency INSIDE THE TX:
            re-read review_content_hash and the live 'posted' row's version
            and compare against snapshot. The window between /draft and /publish
            is exactly when a customer-edits-review-on-Google webhook can land —
            without re-validating in-tx, the publisher could DELETE+POST stale text.
       c. SELECT response FOR UPDATE WHERE id = response_id
          Validate response.status = 'pending_approval' AND response.business_id = user.businessId
          (any other state = response_changed; race with another flow)
    4. UPDATE responses SET
         status = CASE WHEN edited_text IS NOT NULL THEN 'edited' ELSE 'approved' END,
         approved_at = NOW(),
         approved_text = COALESCE(approved_text, response_text)
       WHERE id = response_id

       -- WHY this CASE + COALESCE:
       --
       --   Manual flow:   approved_text was set at /draft; edited_text=new_text
       --                  → status becomes 'edited', approved_text unchanged
       --   Regen as-is:   AI worker did NOT set approved_text or edited_text
       --                  (worker/jobs/ResponseGeneratorWorker.ts:300 inserts only
      --                   response_text, original_draft_text, version, status, llm_*)
       --                  → status becomes 'approved' (edited_text IS NULL),
       --                    approved_text = response_text via COALESCE
       --                  This mirrors the existing approveBySession behavior at
       --                  src/lib/approval/session-mode.ts:80 which sets
       --                  `approved_text = response_text` on accept-as-is.
       --                  Without COALESCE, approved_text stays NULL and the publisher
       --                  posts an empty string per worker/jobs/ResponsePublisherWorker.ts:178.
       --   Regen edited:  PATCH set both approved_text AND edited_text
       --                  → status becomes 'edited', approved_text unchanged
    5. Audit-log via insertAuditLogSession() helper at
       src/lib/approval/audit.ts:60 (NOT a hand-rolled INSERT — the helper
       includes actor_user_id which a hand-rolled INSERT would forget,
       leaving the audit trail unable to identify WHICH owner approved):
         tx (transaction handle, this whole route is one tx),
         response_id,
         user.businessId,
         action = 'approve_edit',
         audit: SessionAuditContext = { actorUserId: user.id, ipAddress: request.ip }
                (NO tokenHash / deviceCookieHash — those are AuditContext-only;
                SessionAuditContext per src/lib/approval/types.ts only carries
                actorUserId + ipAddress, and the helper writes NULL for the
                token columns internally per audit.ts:71)
         metadata = { mode: 'manual' | 'regenerate_as_is' | 'regenerate_edited' }
       (the helper sets id=uuidv7() AND auth_method='owner_session' internally
       per audit.ts:69-74)
    6. INSERT job_outbox row (topic='publish_response',
                              aggregate_id=response_id,
                              payload={response_id, business_id})
    7. RETURN { outbox_id }

    -- Steps 3-6 ALL happen in the same tx. If any step fails, the row stays
    -- 'pending_approval' (never enters HANDLED_STATUSES without an outbox row).
```

**Phase 3b: AI regenerate.**

```
EditReplyDrawer opens (regenerate mode)
    │
    ▼
POST /api/dashboard/past-replies/draft
    body: { review_id, mode: 'regenerate', snapshot }
    │
    ▼
Route handler:
    1. assertCanEditReply (pre-tx)
    2. Inside ONE tx (lock order: review → in-flight checks → optimistic check
       → INSERT outbox). **Guard runs BEFORE optimistic check, same as Phase 3a**
       (the publisher can transition approved/edited → posted without taking
       the reviews lock; running the guard first catches an in-flight publish
       and 409s, preventing snapshot validation from passing against a
       posted row that's about to be superseded).
       a. SELECT id, review_content_hash FROM reviews
            WHERE id = $review_id AND business_id = $user_business_id
            FOR UPDATE
       b. In-flight guards from §4.2:
            SELECT 1 FROM responses WHERE review_id=$id AND status IN
              ('pending_approval','approved','edited','awaiting_owner_connect')
              → 409 'draft_already_exists' if found
            SELECT 1 FROM job_outbox WHERE topic='generate_response'
              AND aggregate_id=$id AND status IN ('pending','dispatching','dispatched')
              → 409 'regenerate_in_progress' if found
       c. validateOptimisticConcurrency(tx, review_id, snapshot)
       d. Compute next_version = COALESCE(MAX(version), 0) + 1 from responses
          WHERE review_id = $review_id. NOT posted.version + 1 — a prior
          terminal v2 (e.g. failed) would make ResponseGeneratorWorker treat
          the regenerate as an idempotent no-op:
          worker/jobs/ResponseGeneratorWorker.ts:118 short-circuits when
          `SELECT FROM responses WHERE review_id = ... AND version = $version`
          finds an existing row, regardless of that row's status. Computing
          next_version dynamically guarantees we always target a never-used
          (review_id, version) tuple.
       e. INSERT job_outbox
            topic='generate_response'
            aggregate_id = review_id
            payload conforms to GenerateResponsePayload from
               src/lib/shared/worker-types.ts:16:
              review_id, business_id,
              version = next_version                -- computed in step d
              suppress_notification = true          -- existing field
         (NOTE: the payload schema is fixed by the existing worker contract;
          we do NOT add a `source` or `target_version` field. The worker uses
          `version` from the payload when INSERTing the new pending_approval
          response row at worker/jobs/ResponseGeneratorWorker.ts:29.)
       — COMMIT (steps 2a-e in one tx)
    3. RETURN { outbox_id }
    │
    ▼
Client polls GET /api/dashboard/past-replies/draft-status?outbox_id=<id>
       every 1.5s (max 60s before showing "taking longer than expected")
    │
    │  Polling reads job_outbox.status (NOT a response row, since
    │  ResponseGeneratorWorker doesn't insert a 'failed' response on
    │  permanent generation failure — see worker/jobs/ResponseGeneratorWorker.ts:182).
    │
    │  outbox.status='pending'/'dispatching'/'dispatched':
    │    { status: 'generating' }
    │  outbox.status='completed':
    │    look up the response row created by the worker (one non-terminal
    │    row per review per migration-023; aggregate_id=review_id)
    │    return { response_id, status: 'pending_approval', response_text }
    │  outbox.status='failed':
    │    { status: 'failed', error: outbox.last_error }
    ▼
Meanwhile, ResponseGeneratorWorker:
    - generates draft using current voice settings + voice-learning
    - INSERTs responses row (status='pending_approval',
                              llm_provider/model/tokens populated,
                              version = payload.version  -- existing payload field name)
    │
    ▼
Client sees status='pending_approval' → captures response_id from poll response
                                       → shows preview
                                       → owner picks one of:
                                          (a) "Update on Google" → publish as-is
                                          (b) "Edit further" → see Phase 3c
                                          (c) "Cancel" → discard the draft (see below)
    │
    ▼
(a) "Update on Google":
    POST /publish with { response_id, snapshot } — same flow as Phase 3a Step 4 onward.
    /publish transitions pending_approval → approved before enqueuing.

(c) Cancel: client-only — drawer closes. The pending_approval row stays in DB.
    On next opening of EditReplyDrawer for the same review, the existing
    pending_approval row is detected and the drawer opens straight to the
    preview state (matching the migration-023 invariant — only one non-terminal
    can exist at a time anyway). Owner can either Edit further, Update on
    Google, or call DELETE /api/dashboard/past-replies/draft/:response_id
    to truly discard (transitions row to 'superseded').
```

**Phase 3c: "Edit further" — owner edits an AI-generated draft.**

```
Drawer is in regenerate-preview state with pending_approval row R2.
Owner clicks "Edit further" → drawer transitions to a textarea pre-filled with R2.approved_text.
Owner edits the text inline. On save:
    │
    ▼
PATCH /api/dashboard/past-replies/draft/<R2.id>
    body: { new_text, snapshot }
    │
    ▼
Route handler:
    1. assertCanEditReply (pre-tx, permission only)
    2. Inside ONE tx (lock order: review → candidate response → UPDATE):
       a. SELECT id, review_content_hash FROM reviews
            WHERE id = $review_id AND business_id = $user_business_id
            FOR UPDATE
       b. validateOptimisticConcurrency(tx, review_id, snapshot)
          (in-tx; same TOCTOU rationale as /draft and /publish)
       c. SELECT R2 FOR UPDATE WHERE id = response_id AND business_id = user.businessId
          Validate R2.status = 'pending_approval'
          (any other state means another flow already moved past this draft —
           return 409 'response_changed')
       d. UPDATE responses SET
            status='pending_approval',              -- UNCHANGED — only /publish transitions
                                                    -- the row into a HANDLED status (per the
                                                    -- atomicity rule in §4.2). Setting 'edited'
                                                    -- here would orphan the row in HANDLED
                                                    -- without an outbox if the owner closes
                                                    -- the drawer instead of clicking Update.
            approved_text=new_text,
            edited_text=new_text                    -- voice-learning signal preserved for
                                                    -- when /publish eventually transitions
                                                    -- to 'edited'
          WHERE id = R2.id
    3. RETURN 204
```

PATCH is idempotent — applying the same `{ new_text }` twice produces the same end-state.

The migration-023 partial unique index ("at most one non-terminal response per review") guarantees there's only one draft to PATCH; we don't need to worry about which of multiple drafts to update.

### 4.5 DELETE+POST sequencing (Phase 4 — publisher)

**Async-publisher race with `processReview` — pre-existing concern, addressed for the new branch.**

The existing publisher (`worker/jobs/ResponsePublisherWorker.ts`) reads the response without a lock, calls Zernio externally (line 285), then does a status-guarded UPDATE at line 436. Between read and update, `processReview` at `src/lib/reviews/process-review.ts:292` can supersede an `'approved'` / `'edited'` response when the customer edits the review. If that happens AFTER the publisher has called Zernio but BEFORE the final UPDATE, Google receives stale text and the local UPDATE no-ops (status no longer matches the WHERE clause). This race exists today for the fresh-publish path and is a known pre-existing concern; **fixing it across the entire publisher is out of scope for this spec**. We address it for the NEW edit-publisher branch (DELETE+POST) by holding the response + review locks through the external mutation, with affected-row-count assertions on every status-guarded UPDATE.

The edit-publisher branch runs DELETE+POST inside one **open transaction** that holds locks across the external calls. External side effects CANNOT be rolled back — once Zernio's DELETE returns 200, Google's reply slot is empty and no `ROLLBACK` undoes that. So the protocol has explicit per-stage commit decisions: each external outcome (success / permanent / transient / auth / 409) maps to a specific COMMIT or ROLLBACK + THROW path that leaves the DB consistent with reality on Google.

```
BEGIN tx (single bullmq job execution; ~10-20s including external I/O)

-- 0. PublishResponsePayload (src/lib/shared/worker-types.ts:40) carries
--    only { response_id, business_id, correlation_id? } — NOT review_id.
--    Every existing producer (token/callback approval, /publish, the
--    DrainOwnerConnectWorker re-enqueue, this spec's /retry) sends those
--    two fields and nothing else. To get review_id WITHOUT widening the
--    payload contract (which would force every producer to be updated
--    in lockstep), do a business-scoped non-locking read here, mirroring
--    the onFailed hook pattern. The non-locking read is safe because
--    review_id is immutable on a response row — it's set on INSERT and
--    never updated.
-- ── PHASE A: Non-locking pre-flight (no tx open yet) ────────────────────
--
-- The edit-publisher tx holds review + response locks across external
-- I/O for ~30s. We DON'T want to pay that cost on fresh publishes (no
-- sibling, no orphan-marker) — those should delegate to today's flow.
-- So we do a non-locking read first to decide whether to enter the
-- locked tx at all.
--
-- Soundness: review_id is immutable on a response row. posting_error
-- can change between this read and the locked re-read (e.g., process-
-- review marks stale, or another publisher commits during the gap),
-- but we re-validate everything inside the tx — the pre-flight is just
-- a fast-path filter. If the situation changed by the time we lock,
-- the locked re-checks catch it and exit cleanly.

SELECT review_id, posting_error INTO _r0
FROM responses
WHERE id = $response_id AND business_id = $business_id;

IF NOT FOUND THEN
  -- Bad payload: response id doesn't belong to this business, OR row
  -- deleted between enqueue and dispatch. Mark failed for ops review.
  markOutboxFailed; logSentry('publish_payload_business_mismatch'); return;
END IF;

-- Subscription guard. Mirrors the existing fresh-publish path at
-- worker/jobs/ResponsePublisherWorker.ts:101-105 (the architectural
-- rule in .claude/CLAUDE.md is that EVERY customer-facing worker
-- checks subscription_status before producing customer-visible output).
-- Edit-publisher is no exception: a 'cancelled' or expired-grace
-- 'past_due' business must not be able to push edits to Google.
--
-- Run BEFORE Phase B's locked tx so we don't waste lock-window
-- capacity on subscriptions we shouldn't honor anyway. The
-- non-locking read is safe — checkSubscription only cares about
-- subscription_status which doesn't race with edit operations.
SELECT subscription_status, updated_at INTO _biz
FROM businesses WHERE id = $business_id;
-- (no row → tenant misconfiguration; treat as not allowed)

IF NOT FOUND OR NOT checkSubscription(_biz.subscription_status, _biz.updated_at, 'publisher').allowed THEN
  -- Same disposition as today's publisher subscription-skip behavior:
  -- mark outbox completed (not failed) so it doesn't loop, no external
  -- calls. Re-activation later (past_due → active, etc.) will be picked
  -- up by the existing reconciliation paths or by re-enqueue when the
  -- owner takes another action.
  markOutboxCompleted; return;
END IF;

isOrphanRetry = (_r0.posting_error LIKE '%_after_delete_succeeded')
_review_id    = _r0.review_id

-- Non-locking sibling probe.
existingPostedProbe = SELECT id FROM responses
                       WHERE review_id = _review_id
                         AND status = 'posted'
                         AND id != $response_id
                       LIMIT 1;

-- BRANCH DECISION (no locks held yet):
IF existingPostedProbe IS NULL AND NOT isOrphanRetry:
  -- True fresh-publish. The lock-window discipline this section
  -- documents applies ONLY to the edit-publisher branch. Skip Phase B
  -- entirely and let today's existing fresh-publish code run.
  --
  -- IMPLEMENTATION: there is no clean "delegateToFreshPublishFlow()"
  -- function to call — the existing fresh-publish path lives inline
  -- in `handlePublishResponse` and depends on context that isn't yet
  -- materialized at this point in the code (logger, outbox handle,
  -- subscription guard result, loaded business row, active Zernio
  -- connection, approved_text, zernioReviewId lookup). Two equivalent
  -- shapes are acceptable:
  --
  --   (a) INLINE shape (smaller scope, lower risk). Place Phase A
  --       AFTER all the existing setup (subscription guard,
  --       business/response load, Zernio connection check, reviewId
  --       lookup) but BEFORE the existing postReply call at
  --       worker/jobs/ResponsePublisherWorker.ts:285. When this branch
  --       fires, control simply CONTINUES to the existing inline code.
  --       Pseudocode:
  --
  --           // (no sentinel call, no return — execution falls through)
  --           // continues directly to the existing postReply block
  --
  --       The pre-flight read of responses(review_id, posting_error)
  --       becomes a redundant read of an already-loaded row — accept
  --       the redundancy.
  --
  --   (b) HELPER shape (cleaner long-term). Refactor the inline
  --       fresh-publish code at line 285+ into `freshPublish(ctx)`
  --       taking an explicit FreshPublishContext struct (logger,
  --       outboxId, attempt, response, business, zernioConnection,
  --       approvedText, zernioReviewId). This branch then calls it
  --       and returns its result. Pseudocode:
  --
  --           return freshPublish(ctx);
  --
  -- The two shapes are NOT both "fall through and also return" —
  -- shape (a) does NOT return (control just continues); shape (b)
  -- DOES return (the helper handles the publish end-to-end). Pick
  -- one; do not write the contradictory mix.
  --
  -- Either way, this branch MUST NOT call markOutboxCompleted/Failed
  -- itself — that's the responsibility of whichever code path actually
  -- runs the publish (the existing inline code in shape (a), or the
  -- new helper in shape (b)).
END IF;

-- ── PHASE B: Locked edit-publisher tx ──────────────────────────────────
-- We're either editing a live reply (existingPostedProbe was non-null)
-- or running an orphan-retry (isOrphanRetry true). Open the tx and
-- acquire locks in canonical order.

BEGIN tx;

-- 1. Acquire locks in canonical order (review → response). processReview's
--    content-change branch acquires the same review lock, so it will block
--    on this lock until our tx commits — that's the whole point.
SELECT id FROM reviews
  WHERE id = _review_id AND business_id = $business_id
  FOR UPDATE;
IF NOT FOUND THEN
  -- Defense in depth: response.review_id FK is supposed to point at a
  -- visible review row. If it doesn't, schema invariant is broken.
  COMMIT; markOutboxFailed; logSentry('publish_orphan_response_review'); return;
END IF;

-- 2. Lock the response row with status guard. Verify the orphan-marker
--    state still matches what the pre-flight read saw — between Phase A
--    and now, processReview might have superseded the row, OR the
--    posting_error might have been cleared by an admin tool.
SELECT id, status, approved_text, version, posting_error, review_id INTO response
FROM responses
  WHERE id = $response_id
    AND status IN ('approved', 'edited', 'awaiting_owner_connect')
    AND business_id = $business_id
  FOR UPDATE;

IF NOT FOUND THEN
  -- Row moved out of publishable state between Phase A and now (e.g.,
  -- processReview supersede). Idempotent exit — outbox completes,
  -- no external calls.
  COMMIT; markOutboxCompleted; return;
END IF;
IF response.review_id != _review_id THEN
  -- Should be impossible (review_id is immutable). Defense in depth.
  COMMIT; markOutboxFailed; logSentry('publish_review_id_drift'); return;
END IF;

-- Re-evaluate isOrphanRetry against the locked row's current state.
-- (If posting_error was cleared between Phase A and the lock, drop
-- back to fresh-publish semantics for this attempt.)
isOrphanRetry = (response.posting_error LIKE '%_after_delete_succeeded')

-- 3. Existing-posted detection (locked re-check).
existingPosted = SELECT id, version FROM responses
                  WHERE review_id = _review_id
                    AND status = 'posted'
                    AND id != $response_id
                  LIMIT 1 FOR UPDATE;

-- 4. Re-validate the branch decision under the lock. If the row is no
--    longer in the edit-publisher branch (sibling superseded between
--    Phase A and now AND orphan marker was cleared), we shouldn't be
--    in this tx at all — release locks and hand off to the existing
--    fresh-publish code per the same shape (a) or shape (b) chosen for
--    Phase A's branch above. Implementer must use the SAME shape in
--    both places — don't mix.
IF existingPosted IS NULL AND NOT isOrphanRetry:
  COMMIT;  -- release locks; no external I/O happened
  -- Shape (a): control continues to the existing fresh-publish code
  --            (no `return`). Shape (b): `return freshPublish(ctx);`
END IF;

-- 5. DELETE branch (only if a sibling 'posted' currently exists; an orphan
--    retry has no sibling and skips this entirely).
IF existingPosted IS NOT NULL:
  TRY:
    zernioClient.deleteReply(...)             ← external; tx still open
  CATCH ZernioReplyAlreadyDeletedError (404):
    -- Reply already gone (race with another flow, or owner deleted via
    -- Google Business directly). Treat as DELETE success — the slot is
    -- empty regardless of who emptied it. Continue to POST below using the
    -- DELETE-succeeded code path; sibling will be superseded along with
    -- whatever POST commits.
    deleteSucceeded = true
  CATCH ZernioAuthError:
    -- True 401/403: token revoked. Existing handlePublisherAuthErrorTerminal
    -- pattern at worker/jobs/publisher-error-handlers.ts:151 parks the row
    -- AND marks the outbox COMPLETED (not failed) — the drain worker handles
    -- re-enqueue on reconnect. Mirror that semantic here.
    UPDATE responses SET status='awaiting_owner_connect',
                         posting_error='zernio_auth_error'
      WHERE id = $response_id;
    -- existingPosted UNCHANGED (DELETE didn't succeed; old reply still on Google).
    COMMIT; markOutboxCompleted (NOT failed); trigger connection-lost flow; return
  CATCH ZernioTransientError:
    -- DELETE didn't succeed externally; nothing to commit. Roll back, throw.
    ROLLBACK; throw err
  CATCH ZernioPermanentError (incl. inbox_addon_required):
    UPDATE responses SET status='failed',
                         posting_error='delete_failed_<error_kind>'
      WHERE id = $response_id;
    COMMIT; markOutboxFailed; return
  ELSE:
    deleteSucceeded = true

-- 4. POST branch. After this point, deleteSucceeded == true if a DELETE happened
--    (including the 404-as-success case), false if there was no sibling at all.
--    The orphan retry path (isOrphanRetry) skips DELETE entirely — Google's
--    reply slot was already emptied by an earlier attempt.
postDeleteCommitted = deleteSucceeded OR isOrphanRetry

TRY:
  zernioClient.postReply(...)                  ← external; tx still open
CATCH ZernioReplyAlreadyExistsError (409):
  -- Tx-aware verifier (see §4.5b) takes `tx` and returns a disposition.
  disposition = await verify409InTx(tx, ...)
  switch disposition:
    case 'matches_our_text':
      -- Our reply IS on Google (perhaps from a duplicate publish race; verifier
      -- confirmed by canonicalized text match).
      IF existingPosted IS NOT NULL: UPDATE existingPosted SET status='superseded';
      UPDATE responses SET status='posted', posted_at=NOW(), posting_error=NULL
        WHERE id = $response_id;
      COMMIT; markOutboxCompleted; return
    case 'mismatch':
      -- Some text exists on Google that doesn't match ours.
      IF postDeleteCommitted:
        -- DELETE succeeded earlier in this tx (or in a previous retry). The
        -- old reply is GONE; whatever's on Google now is something else
        -- entirely (third-party tool, owner via Google dashboard, etc.).
        -- Local existingPosted MUST move to 'superseded' — keeping it 'posted'
        -- would lie about Google's state.
        IF existingPosted IS NOT NULL: UPDATE existingPosted SET status='superseded';
        UPDATE responses SET status='superseded' WHERE id = $response_id;
        -- Open a review_exception for admin reconciliation; we don't
        -- auto-ingest the third-party reply because we don't know its
        -- provenance and ingesting could mis-attribute it.
        INSERT INTO review_exceptions (
          id, business_id, review_id, response_id, type, status, payload
        ) VALUES (
          gen_random_uuid(), $business_id, $review_id, $response_id,
          'edit_publish_409_mismatch_after_delete', 'open',
          jsonb_build_object('verifier_text', verifier_observed_text,
                             'expected_text', $approved_text)
        );
        COMMIT; markOutboxFailed; return
      ELSE:
        -- No DELETE happened (or no sibling existed). Today's verify-first
        -- supersede semantics — the old posted row lived through this attempt.
        UPDATE responses SET status='superseded' WHERE id = $response_id;
        COMMIT; markOutboxFailed; return
    case 'indeterminate':
      IF postDeleteCommitted AND existingPosted IS NOT NULL:
        -- DELETE happened, sibling supersede MUST commit. Verification was
        -- inconclusive → propagate orphan-marker so retry's POST-only path
        -- still uses post_after_delete_failed_* if it permanent-fails.
        UPDATE existingPosted SET status='superseded';
        UPDATE responses SET posting_error='pending_after_delete_succeeded'
          WHERE id = $response_id;  -- status stays 'approved'/'edited'
        COMMIT; throw transient    -- BullMQ retries; no-DELETE branch will run
      ELSE IF isOrphanRetry:
        -- Already in orphan retry; just retry POST.
        COMMIT; throw transient
      ELSE:
        -- No external commit happened (no DELETE, no successful POST). Clean rollback.
        ROLLBACK; throw transient
CATCH ZernioAuthError:
  IF postDeleteCommitted AND existingPosted IS NOT NULL:
    UPDATE existingPosted SET status='superseded';
  -- CRITICAL: when postDeleteCommitted is true, set the suffixed posting_error
  -- so isOrphanRetry detects it on the drain worker's re-enqueue. Plain
  -- 'zernio_auth_error' would lose the orphan-marker context — when the owner
  -- reconnects and the drain worker re-enqueues, the next attempt's
  -- isOrphanRetry would be FALSE, the worker would fall into fresh-publish
  -- semantics, and a permanent failure there would use today's generic error
  -- names (NOT recoverable through /retry).
  UPDATE responses SET
    status='awaiting_owner_connect',
    posting_error = CASE
      WHEN $postDeleteCommitted = true
        THEN 'zernio_auth_error_after_delete_succeeded'
      ELSE 'zernio_auth_error'
    END
    WHERE id = $response_id;
  COMMIT; markOutboxCompleted (NOT failed; per existing helper at line 151);
  trigger connection-lost flow; return
CATCH ZernioTransientError:
  IF postDeleteCommitted AND existingPosted IS NOT NULL:
    -- DELETE succeeded externally. Commit existingPosted → superseded
    -- AND set the orphan-marker on the candidate so retry knows this is
    -- a post-after-DELETE-success path even though no sibling 'posted'
    -- exists for it to detect.
    UPDATE existingPosted SET status='superseded';
    UPDATE responses SET posting_error='pending_after_delete_succeeded'
      WHERE id = $response_id;  -- status stays 'approved'/'edited'
    COMMIT; throw err  -- retry; sees no sibling AND posting_error sentinel
                        -- → no-DELETE branch with orphan-marker semantics
  ELSE IF isOrphanRetry:
    -- Already in orphan retry; just throw for retry. posting_error stays as-is.
    COMMIT; throw err
  ELSE:
    ROLLBACK; throw err
CATCH ZernioPermanentError:
  IF postDeleteCommitted:
    IF existingPosted IS NOT NULL: UPDATE existingPosted SET status='superseded';
    -- Orphan state forming (or extending an orphan retry). Use the
    -- post_after_delete_failed_* prefix so /retry and /restore-original
    -- both recognize the row.
    UPDATE responses SET status='failed',
                         posting_error='post_after_delete_failed_<error_kind>'
      WHERE id = $response_id;
  ELSE:
    -- True fresh-publish permanent failure (no DELETE happened).
    UPDATE responses SET status='failed',
                         posting_error='<error_kind>'
      WHERE id = $response_id;
  COMMIT; markOutboxFailed; return

-- 5. Success path. Clear the orphan-marker on success regardless of which
--    path got us here.
IF existingPosted IS NOT NULL:
  affected = UPDATE existingPosted SET status='superseded'
              WHERE id = existingPosted.id AND status='posted'
              RETURNING 1;
  IF affected != 1: THROW assertion 'sibling_lost_during_publish'
affected = UPDATE responses SET status='posted', posted_at=NOW(),
                                  posting_error=NULL
            WHERE id = $response_id
              AND status IN ('approved', 'edited', 'awaiting_owner_connect')
            RETURNING 1;
IF affected != 1: THROW assertion 'candidate_lost_during_publish'
COMMIT; markOutboxCompleted;
```

**Orphan-marker convention.** Any response row whose `posting_error LIKE '%_after_delete_succeeded'` (suffix match) carries forward the "DELETE already happened on Google" context across BullMQ retries. The known marker values are:

| Marker value | Set by | Row state when set |
|---|---|---|
| `pending_after_delete_succeeded` | Publisher transient catch + 409 indeterminate catch (after DELETE-success) | `'approved'` / `'edited'` (still publishable) |
| `zernio_auth_error_after_delete_succeeded` | Publisher auth catch (after DELETE-success) | `'awaiting_owner_connect'` (drain worker re-enqueues; marker survives) |

Any future `_after_delete_succeeded` suffix the publisher might add is automatically detected by the same `LIKE '%_after_delete_succeeded'` predicate. Detection happens at the start of every publisher attempt (`isOrphanRetry`).

**Distinct from the markers — terminal recoverable failures.** When BullMQ exhausts retries on an orphan-marker row, the `worker/index.ts` onFailed hook converts it to `status='failed'` with `posting_error='post_after_delete_failed_retry_exhausted'`. This value is NOT itself a marker (it doesn't end with `_after_delete_succeeded`); it's in the `post_after_delete_failed_*` allowlist that recovery routes accept. Conceptually:
- Marker = "in-progress orphan retry; another worker attempt is expected".
- `post_after_delete_failed_retry_exhausted` = "retry attempts exhausted; row is now waiting for owner-driven /retry or /restore-original".

The lifecycle is:
- BullMQ retries: orphan-marker (e.g., `'pending_after_delete_succeeded'`) on a publishable row → publisher detects `isOrphanRetry`=true on each attempt.
- Retry exhaustion: hook converts to `status='failed'` with `posting_error='post_after_delete_failed_retry_exhausted'`. Row visible to recovery routes.
- Recovery via `/retry`: transitions back to `'approved'` AND **re-installs the orphan marker** (`posting_error='pending_after_delete_succeeded'`) because the row is still in the post-DELETE-success state externally — Google still has no reply for that review. Without re-installing the marker, the next publisher attempt would see no `existingPosted` (sibling is `'superseded'`) AND no marker, delegate to fresh-publish, and on permanent failure use today's generic `posting_error` names instead of `post_after_delete_failed_*`. /retry's SQL implements this with a CASE expression keyed on the failed row's previous posting_error prefix.
- Recovery via `/restore-original`: distinct path — INSERTs a new `'pending_approval'` row with the original imported reply text. The `'failed'` row stays as-is (not transitioned). `isOrphanRetry` doesn't apply to the new row (its posting_error is NULL); when published, the worker's `existingPostedProbe` finds no live sibling (correctly — Google's slot is empty), the row has no orphan marker, BUT this is the one case where delegating to fresh-publish IS correct: the new row IS a fresh publish into an empty slot. The /restore-original UI explains "you'll be publishing a fresh reply" so the owner expects this semantic.

The marker is:
- SET by the publisher when committing a sibling supersede after a DELETE-success without a successful POST. Re-installed by `/retry` on `post_after_delete_failed_*` recovery (the row's still-orphan-state context survives across the failed → approved transition; see §4.7 SQL CASE expression).
- READ by the publisher at the start of each attempt (`isOrphanRetry` flag).
- CLEARED on successful POST (set to NULL alongside `status='posted'`).

The marker is NOT in the `delete_failed_*` / `post_after_delete_failed_*` allowlist, so recovery routes don't accidentally pick it up — it's an internal worker state, not a user-visible failure.

**Retry exhaustion conversion — required `worker/index.ts` change.** When BullMQ exhausts retries on a `publish_response` job, today's `onFailed` hook calls `applyTransientExhaustionFallback`, which parks the response at `awaiting_owner_connect` and clears the original error. That'd lose the orphan-marker context — recovery routes wouldn't see a `failed` row to act on, and the row would loop forever between `awaiting_owner_connect` (after exhaustion) and a no-DELETE retry (after the drain worker re-enqueues, which would just exhaust again).

The hook needs an orphan-marker check that runs BEFORE the generic fallback:

```sql
-- In worker/index.ts publish_response onFailed handler, BEFORE
-- applyTransientExhaustionFallback. Lock order MUST match processReview
-- (review → response, per src/lib/reviews/process-review.ts:36 → :155).
-- Locking only the response row would deadlock or interleave incorrectly:
-- processReview holds reviews FOR UPDATE, then waits for the response
-- lock; if our hook took the response lock first, both could converge
-- on the same response without the hook seeing the latest review state,
-- and the row could end up converted to recoverable when it should have
-- been marked stale_after_review_changed.
--
-- ALL reads and writes are business-scoped. The publisher's existing
-- code explicitly checks response.business_id !== business_id before
-- acting (worker/jobs/ResponsePublisherWorker.ts pattern). The hook
-- preserves that tenant boundary on every statement — the conversion
-- of an orphan-marker row to a recoverable failed state is a
-- privileged operation, and a missing business_id check would let an
-- attacker (or a buggy job-id collision) convert a different tenant's
-- row.
--
-- $business_id comes from the BullMQ job's error context (the
-- publish_response payload always includes business_id; pass it
-- through to the onFailed handler).
BEGIN;

-- 0. Read the review_id (scoped). NON-STRICT: SELECT INTO STRICT would
--    raise NO_DATA_FOUND on no row, which propagates as an unhandled
--    exception out of onFailed and looks like a worker crash to ops.
--    No-row here means tenant mismatch or row deleted — both benign;
--    we want to close the outbox cleanly, not crash.
SELECT review_id INTO _review_id
FROM responses
WHERE id = $response_id AND business_id = $business_id;

IF NOT FOUND THEN
  -- Row not visible to this business. Close the outbox so it doesn't
  -- linger in failure state for ops review.
  COMMIT; markOutboxCompleted; return;
END IF;

-- Lock acquisition. STRICT here is OK ONLY if the previous statement
-- found a row; reviews(id) is FK-referenced from responses.review_id,
-- so the row exists. Still use IF NOT FOUND for defense-in-depth.
SELECT id INTO _r FROM reviews
WHERE id = _review_id AND business_id = $business_id
FOR UPDATE;

IF NOT FOUND THEN
  -- Inconsistent state: response references a review row that's not
  -- visible to its business. Sentry alert + close outbox.
  -- (Should be impossible if FKs are honored.)
  COMMIT; markOutboxCompleted; logSentry('orphan_response_review'); return;
END IF;

-- 1. Now lock the response row, business-scoped. If processReview was
--    running concurrently, it has already committed (it released the
--    response lock when it committed); we now read the post-processReview
--    state.
SELECT id, status, posting_error INTO _resp
FROM responses
WHERE id = $response_id AND business_id = $business_id
FOR UPDATE;

IF NOT FOUND THEN
  -- Race: response was deleted between step 0 read and this lock
  -- acquisition (admin reset, hard delete, etc.). Nothing to convert.
  COMMIT; markOutboxCompleted; return;
END IF;

-- 2. Status guard. processReview's supersede branch (line 292) can move
--    an 'approved'/'edited' orphan-marker row to 'superseded'. The hook
--    must NOT un-supersede that — only convert publishable rows.
IF _resp.status NOT IN ('approved', 'edited', 'awaiting_owner_connect') THEN
  -- Row is no longer publishable (processReview won the race, or another
  -- worker already converted). This is an idempotent benign no-op — the
  -- response is in a deliberate terminal state, and the publish work
  -- this outbox row was tracking is no longer needed. markOutboxCompleted,
  -- NOT failed: a failed outbox here would put a real row in ops/admin
  -- failure surfaces for a response that was intentionally moved on.
  COMMIT; markOutboxCompleted; return;
END IF;

IF _resp.posting_error LIKE '%_after_delete_succeeded' THEN
  -- Orphan-marker present AND row still publishable. Convert. All
  -- mutations business-scoped.
  UPDATE responses
  SET status = 'failed',
      posting_error = 'post_after_delete_failed_retry_exhausted',
      updated_at = NOW()
  WHERE id = $response_id AND business_id = $business_id
    AND status IN ('approved', 'edited', 'awaiting_owner_connect');
  -- (Affected-row check belongs here in real code: assert affected==1.)
  COMMIT;
  markOutboxFailed;   -- this branch is the genuine retry exhaustion;
                      -- ops should see a failed outbox tied to a
                      -- recoverable failed row.
  return;
END IF;
ROLLBACK;  -- nothing to commit; let the generic fallback run
-- Falls through to applyTransientExhaustionFallback for non-orphan cases
-- (today's behavior, unchanged).
```

**Outbox disposition split.** The two terminal branches have different semantics, so they get different outbox dispositions:

| Hook branch | Response state after | Outbox disposition | Why |
|---|---|---|---|
| Status guard caught `'superseded'`/etc. | unchanged (already terminal) | `markOutboxCompleted` | Idempotent no-op; the row was deliberately moved on by `processReview`. A `failed` outbox here would noise up admin's outbox failure list with rows that don't represent real failures. |
| Orphan-marker present, row still publishable | `'failed'` with `'post_after_delete_failed_retry_exhausted'` | `markOutboxFailed` | This is genuine retry exhaustion — ops/Sentry should see this; the row is now in the recovery flow waiting for owner action. |
| Neither (no orphan-marker) | unchanged | (falls through to generic fallback at `applyTransientExhaustionFallback`; uses today's existing disposition) | Out of this hook's scope. |

**Why this matters for stale-content protection.** With the canonical lock order:
1. Customer edits review on Google → webhook → processReview tx starts.
2. processReview acquires `reviews FOR UPDATE` → updates `review_content_hash` → fires the stale-marking UPDATE for any `failed`-with-allowlisted-prefix rows AND supersedes any `'approved'`/`'edited'` rows.
3. processReview commits.
4. onFailed hook eventually fires → acquires `reviews FOR UPDATE` (now safe — processReview already released) → re-reads response row.
5. If processReview superseded the row in step 2, the hook's status guard catches it and exits (idempotent no-op). The row is `'superseded'`, not `'failed'`, so neither recovery routes nor the stale-marking branch act on it — `processReview` already queued a fresh generation.
6. If processReview didn't see this row (no content change), the hook proceeds normally with the conversion.

Without the lock-order fix, the hook could "win" the race and convert a row to `'failed'`+`'post_after_delete_failed_retry_exhausted'`, after which `processReview` would mark it `'stale_after_review_changed'` (correct, but only because of fortunate prefix-matching). With the fix, the order is deterministic: `processReview` always commits before the hook reads, so the hook sees the post-`processReview` state and acts correctly.

**Auth disposition note.** The existing `handlePublisherAuthErrorTerminal` at `worker/jobs/publisher-error-handlers.ts:151` marks the publish outbox **completed** (not failed) — the drain worker (`DrainOwnerConnectWorker`) handles the re-enqueue on reconnect. The new edit-publisher branch mirrors this exactly: `markOutboxCompleted` on auth catches, NOT `markOutboxFailed`. BullMQ should not retry the original outbox row; the drain worker creates a fresh one when the owner reconnects.

The `auth + post-delete-succeeded` corner case is handled by the existing drain worker as well: `DrainOwnerConnectWorker` re-enqueues `awaiting_owner_connect` rows by their existing `id`, so the orphan-marker (`posting_error='pending_after_delete_succeeded'`)... wait, we're setting `posting_error='zernio_auth_error'` on the auth branch, which would overwrite the orphan marker. To preserve both signals, we use a richer encoding:

```sql
-- Auth branch when postDeleteCommitted:
UPDATE responses SET
  status='awaiting_owner_connect',
  posting_error='zernio_auth_error_after_delete_succeeded'
  WHERE id = $response_id;
```

The `_after_delete_succeeded` suffix on the auth posting_error survives the drain worker's re-enqueue (drain doesn't touch posting_error). When the new outbox runs, `isOrphanRetry` reads either of `'pending_after_delete_succeeded'` OR `'zernio_auth_error_after_delete_succeeded'` (or any future `_after_delete_succeeded` suffix) as the orphan marker. Detection is `posting_error LIKE '%_after_delete_succeeded'`.

**Drain re-enqueue race acceptance.** `DrainOwnerConnectWorker` at `worker/jobs/DrainOwnerConnectWorker.ts:46` bulk-selects `'awaiting_owner_connect'` rows without `FOR UPDATE` (today's behavior, predates this spec). A concurrent `processReview` content-change can supersede an `'awaiting_owner_connect'` row in the window between the drain's SELECT and its outbox INSERT, producing a `publish_response` outbox row for a candidate that's now `'superseded'`. The publisher then reads the row, sees status outside `('approved','edited','awaiting_owner_connect')`, takes the early-exit branch in §4.5 step 1's `IF NOT FOUND`, and `markOutboxCompleted` without making any external call.

**This is an idempotent no-op and is acceptable** — no external state changes, no incorrect DB writes, just a wasted outbox row. We explicitly accept the race rather than locking in the drain because:
- Drain locking would broaden the row-lock window across the bulk select, blocking process-review for longer.
- The publisher's existing early-exit branch already handles the case correctly (any concurrent supersede during the dispatch window has the same outcome).
- The orphan-recovery semantics don't depend on drain serialization — they depend on the orphan-marker survival, which is per-row and isn't affected by drain's bulk-select timing.

A test exists for this race (see §6.1 publisher-edit lock-protocol tests, "Drain re-enqueue races processReview" entry) so any regression that turns the no-op into a real bug surfaces immediately.

**Why the per-CATCH commits matter.** External side effects can't roll back. After `deleteReply` returns 200, Google has no reply — that's reality. Any DB state that doesn't reflect it is wrong. Each CATCH branch above commits the DB state that matches the external outcome:

| External outcome | DB commit semantics | Outbox |
|---|---|---|
| DELETE 404 (`ZernioReplyAlreadyDeletedError`) | Treated as DELETE success — proceed to POST branch with the same post-DELETE semantics as a 200 result. | (same as POST outcome) |
| DELETE permanent failure | sibling 'posted' UNCHANGED, candidate 'failed' with `delete_failed_*` | failed |
| DELETE transient failure | nothing externally committed → ROLLBACK + retry | (BullMQ retries) |
| DELETE auth | sibling UNCHANGED, candidate 'awaiting_owner_connect' with `posting_error='zernio_auth_error'` | **completed** (drain worker re-enqueues on reconnect; mirrors `handlePublisherAuthErrorTerminal:151`) |
| DELETE success + POST permanent | sibling 'superseded' (matches Google), candidate 'failed' with `post_after_delete_failed_*` | failed |
| DELETE success + POST transient | sibling 'superseded' (matches Google), candidate STAYS `'approved'`/`'edited'` with `posting_error='pending_after_delete_succeeded'` so retry's no-DELETE path keeps orphan-context | (BullMQ retries) |
| DELETE success + POST auth | sibling 'superseded' (matches Google), candidate `'awaiting_owner_connect'` with `posting_error='zernio_auth_error_after_delete_succeeded'` | **completed** (drain worker re-enqueues; orphan-marker survives re-enqueue) |
| DELETE success + POST 409 matches our text | sibling 'superseded', candidate 'posted', posting_error cleared | completed |
| DELETE success + POST 409 mismatch | sibling 'superseded' (Google's old reply IS gone — DELETE happened), candidate 'superseded'. Open `review_exception` `edit_publish_409_mismatch_after_delete` so admin can reconcile the third-party text on Google. | failed |
| DELETE success + POST 409 indeterminate | sibling 'superseded', candidate stays publishable with `posting_error='pending_after_delete_succeeded'` so retry's no-DELETE path keeps orphan-context | (BullMQ retries) |
| No DELETE + POST 409 mismatch (today's path) | sibling, if any, stays `'posted'` (DELETE didn't happen). Candidate 'superseded'. | failed |
| No DELETE + POST 409 indeterminate (today's path) | nothing externally committed → ROLLBACK + retry | (BullMQ retries) |
| DELETE success + POST success | sibling 'superseded', candidate 'posted', posting_error cleared | completed |
| Orphan retry (isOrphanRetry, no sibling) — POST permanent | candidate 'failed' with `post_after_delete_failed_*` (NOT generic — orphan context preserved) | failed |
| Orphan retry — POST transient/auth | candidate stays publishable / parks at awaiting_owner_connect, orphan-marker preserved for next retry | (retries / drain) |
| Orphan retry — POST success | candidate 'posted', posting_error cleared | completed |

### 4.5b Tx-aware 409 verifier

The existing `verify409AndDispose` at `worker/jobs/publisher-error-handlers.ts:443` uses the global `sql` client and calls `markOutboxCompleted` itself. Reusing it inside the edit-publisher tx would self-deadlock: the outer tx holds `responses FOR UPDATE` on the candidate row; the verifier opens a separate connection and waits to read/update the same row.

The new `verify409InTx(tx, ...)` mirrors the existing verifier's logic but:
- Takes the open `TxClient` as its first argument so reads use the same snapshot/locks as the outer tx.
- Does NOT call `markOutboxCompleted` — outcomes are returned as a discriminated union (`'matches_our_text' | 'mismatch' | 'indeterminate'`).
- Does NOT do the final response state UPDATE — the outer tx applies it based on the returned disposition.
- Does NOT update existingPosted — the outer tx applies that based on the disposition + sibling state.

Implementation note: the verifier still walks Zernio's listReviews via the same client/cache logic as today, so the existing reply-page-cache (`getCachedZernioReviewPage`) and `canonicalizeReplyText` comparison are reused. Only the DB-mutation layer is changed.

**Why holding locks through external I/O is acceptable here:**
- The blocked operation (`processReview` content-change) is webhook-driven, not user-facing. Zernio retries webhook deliveries for up to 51 hours — a 30-second stall is invisible.
- The lock window is bounded by Zernio's 15s timeouts (DELETE) + 15s (POST) — at most ~30s.
- No other transactions take the same locks except `processReview` and concurrent edit attempts (which we WANT to serialize).
- The alternative (no lock) is exactly the bug we're trying to fix.

**Affected-row-count assertions everywhere.** Every status-guarded UPDATE in the worker MUST capture the row count and assert it equals the expected value (1 for single-row updates). A 0-row result means a concurrent transaction won the race; depending on the path, that's either a benign no-op (mark outbox completed and exit) or an integrity bug (assertion throws, BullMQ retries with a clean read).

**Fresh-publish branch (no sibling 'posted' — today's path):** out of scope here. Documenting the pre-existing race in the runbook as a known issue; tracked separately. The edit-publisher branch's protection does not extend to it because we're not modifying that code path.



**Zernio client classifier additions.** The current classifier at `src/lib/zernio/client.ts:60` treats ALL 401/403 as `ZernioAuthError` and routes generic non-publish 404 → `ZernioPermanentError` via the catch-all 4xx branch at line 101. For `delete_reply` we need three special-cases, placed **before** those generic branches:

```ts
// Add to classifyAndParse() — placed BEFORE the generic 401/403 and 4xx branches.
if (res.status === 404 && endpointKind === 'delete_reply') {
  // Reply already gone (race with another flow, or owner deleted via Google
  // Business directly). Caller treats as success — proceed to POST.
  throw new ZernioReplyAlreadyDeletedError();
}
if (res.status === 403 && endpointKind === 'delete_reply') {
  const body = (await res.json().catch(() => ({}))) as { code?: string };
  if (body?.code === 'inbox_addon_required') {
    // Billing-side issue, not auth. The token is valid; the addon lapsed.
    // Surface as ZernioPermanentError so connection-lost flow does NOT fire.
    throw new ZernioPermanentError('inbox_addon_required', { endpointKind, body });
  }
  // Fall through to the existing generic 401/403 handler (true auth failure).
}
```

A new error class `ZernioReplyAlreadyDeletedError` joins the existing classifier hierarchy. The publisher's catch ladder distinguishes it from the auth/permanent paths.

**Publisher logic — high-level flow.** This diagram is an introductory overview. **The authoritative state-machine — including all eight external outcomes, the orphan-marker convention, the tx-aware 409 verifier, and the per-CATCH commit semantics — is the pseudocode + outcome table earlier in §4.5 (above). Implementers should treat this diagram as orientation only; if the diagram and the outcome table disagree, the outcome table wins.**

```
publish_response outbox dispatched
    │
    ▼
ResponsePublisherWorker (inside one open tx, holding reviews + response
locks throughout — see §4.5 pseudocode for the locking + isOrphanRetry
detection + orphan-marker handling + tx-aware verify409InTx logic).
    │
    ▼
existingPosted = SELECT * FROM responses
                  WHERE review_id = X AND status='posted' AND id != current.id
                  LIMIT 1 FOR UPDATE
    │
    ├── existingPosted exists (this is an edit):
    │      a. deleteReply → outcomes per the §4.5 outcome table
    │      b. postReply → outcomes per the §4.5 outcome table, including
    │         tx-aware verify409InTx for 409 (NOT the existing
    │         verify409AndDispose — see §4.5b for why).
    └── existingPosted doesn't exist (truly fresh post):
           [unchanged — today's POST-only flow; uses today's posting_error
            naming, not the new delete_*/post_after_delete_* prefixes]
```

**Posting-error naming convention.** The DELETE+POST branch uses **prefixed posting_error values** so recovery routes can distinguish recoverable failure stages from non-recoverable ones:

| Stage | posting_error prefix | Recoverable via |
|---|---|---|
| DELETE failed (sibling 'posted' still there) | `delete_failed_*` | `/retry` re-runs DELETE+POST |
| DELETE succeeded, POST failed (sibling 'superseded', orphan state) | `post_after_delete_failed_*` | `/retry` skips DELETE (no sibling 'posted'), POSTs only; OR `/restore-original` brings back old reply |
| Stale-after-review-changed (recoverable row was invalidated when the customer edited the underlying review) | `stale_after_review_changed` (set by process-review when it detects content change on a recoverable failed row — see below) | NOT recoverable — the draft was for old review text |
| Today's fresh-draft path | (today's error names, untouched, e.g. `review_content_changed` set by process-review for `pending_approval` rows) | NOT recoverable through these routes |

This explicit prefixing means recovery routes can validate the failure category, not just `status='failed'`. The recovery routes' allowlist (§4.7) accepts only `delete_failed_*` and `post_after_delete_failed_*`.

**Stale-edit invalidation — required process-review change.** Today's `processReview` at `src/lib/reviews/process-review.ts:165-172` SELECTs `status NOT IN ('superseded', 'failed')`, so it **ignores** `failed` rows entirely when a customer edits a review. That leaves a hole in the recovery allowlist: a row with `posting_error='delete_failed_inbox_addon_required'` would survive a customer review-edit unchanged, and `/retry` would then republish stale text against the new review.

This spec requires a modification to `processReview`'s content-change branch.

**Critical placement constraint:** the stale-marking UPDATE must run **once per content-change, before any conditional branch returns** — NOT only inside the `pending_approval` branch at lines 206-212. The branches are:

```ts
// Today's structure of the content-change block (paraphrased from process-review.ts):
if (no activeResponse) {
  // ─── insertion point A ───  ← MUST run stale-marking HERE
  return queueFreshGeneration();        // this branch is the "orphan-state failed row" case
}

if (activeResponse.status === 'pending_approval') {
  // ─── insertion point B ───  ← MUST also run stale-marking HERE (or earlier)
  failPendingResponse();                 // existing line 206-212 logic
  return queueFreshGeneration();
}

// Other statuses (approved, edited, awaiting_owner_connect):
// ─── insertion point C ───   ← MUST also run stale-marking HERE (or earlier)
supersedeActive();                       // existing line 292+ logic
return queueFreshGeneration();
```

Implementing the stale-marking only inside branch B (the natural-looking "alongside pending_approval invalidation" placement) leaves orphan-state failed rows untouched — when there's no active response, branch A returns first and the failed row escapes invalidation. Same for branch C if the active response is `'approved'`/`'edited'`/`'awaiting_owner_connect'`.

**Required structure:** a single UPDATE at the TOP of the content-change block, before any of the three branches:

```sql
-- ─── At the very top of the content-change block, BEFORE any branch ───
-- Runs unconditionally whenever a content change is detected, regardless
-- of whether an active response exists or what its status is. The
-- `reviews FOR UPDATE` lock acquired earlier in processReview at line 36
-- still serializes us against recovery routes — they wait for our
-- COMMIT before reading the failed row's posting_error.
UPDATE responses
SET posting_error = 'stale_after_review_changed', updated_at = NOW()
WHERE review_id = $review_id
  AND status = 'failed'
  AND (posting_error LIKE 'delete_failed_%'
       OR posting_error LIKE 'post_after_delete_failed_%');
```

After this UPDATE, recovery routes will reject the row (`stale_after_review_changed` is not in the allowlist) and surface a different recovery UX in the dashboard: "This review was updated after your edit failed. Start a new edit instead."

### 4.5c Mock-mode behavior

When `MOCK_EXTERNAL_APIS=true`, the Zernio client at `src/lib/zernio/client.ts:128` short-circuits all HTTP calls to `mockResponse<T>()`. This applies to the new `deleteReply` endpoint in the same way as existing endpoints — `mockResponse` returns benign success/`undefined` for `delete_reply` (added to the existing switch statement; `delete_reply` is in `NO_BODY_ENDPOINTS`).

**The new edit-publisher branch runs the SAME locked-tx discipline in mock mode as in production.** Specifically:

- Phase A pre-flight runs identically (DB reads aren't mock-gated).
- Phase B's `BEGIN tx` and the `reviews FOR UPDATE` + `responses FOR UPDATE` locks ARE acquired against real Postgres — local concurrency tests (e.g., the publisher-edit lock-protocol tests in §6.1) require this so they exercise the lock window.
- `zernioClient.deleteReply(...)` and `zernioClient.postReply(...)` return canned mock responses without actual external I/O. The lock window in mock mode is sub-millisecond per call.
- Per-CATCH commit semantics, affected-row assertions, and outbox dispositions all run identically.
- The 409 verifier tx-aware path also runs in mock mode; `verify409InTx` walks Zernio's `listReviews` via the same client, which short-circuits to `mockResponse` for `list_reviews` (returns `{ reviews: [], nextPageToken: undefined }` per `src/lib/zernio/client.ts:200`).

**Implementer note:** do NOT add an `if (mockMode)` short-circuit at the publisher level. The point of mock mode is to exercise the same code paths without burning external API calls; gating the whole edit-publisher branch behind `!mockMode` would silently break local QA of the new flow. The existing publisher (`worker/jobs/ResponsePublisherWorker.ts`) does NOT have any mock-mode guards — it relies on the client's short-circuit. The new edit-publisher branch follows the same pattern.

**What does NOT work locally with mock mode alone:** the 409 mismatch / orphan-state branches need `listReviews` to return non-empty results to be meaningfully tested. For those scenarios, tests inject a custom `fetch` mock at the worker test level (the publisher-edit test plan in §6.1 already does this). Mock mode is for "local dev clicks Connect → confirms code paths run end-to-end without throwing"; it's not the right harness for failure-mode validation.

### 4.6 Optimistic concurrency

The snapshot captured when the drawer opens references the **live posted row**, not "the latest non-terminal row" — so validation must compare against `responses.status='posted'` specifically. (An earlier draft of this spec checked the latest non-terminal row, which broke at `/publish` time: after `/draft` had INSERTed a draft, the "latest non-terminal" was the new draft itself, whose version is `posted.version + 1`, not matching the snapshot. That bug is fixed here.)

**TOCTOU correctness — validation MUST run inside the same transaction as the write, AFTER acquiring `reviews FOR UPDATE`.** A previous draft of this spec ran `validateOptimisticConcurrency` before the write tx, which left a window: `processReview` at `src/lib/reviews/process-review.ts:36` acquires the `reviews FOR UPDATE` lock and updates `review_content_hash` at line 143 in a separate tx; if a route validated the old committed hash, then waited on the lock, the lock release would expose the new hash too late — the route had already passed validation and would write/publish stale text.

The fix is to do everything (lock review row, validate, write) inside one transaction, with a consistent lock order across every route: **`reviews` row → candidate/posted response rows → INSERTs/UPDATEs → outbox row → COMMIT**. Every route in §4.4 follows this order.

`validateOptimisticConcurrency` therefore takes the **transaction handle** as its first arg, signaling to implementers that there's no safe way to call it standalone:

```ts
async function validateOptimisticConcurrency(
  tx: TxClient,                                  // must be inside an open tx
  reviewId: string,
  snapshot: { hash: string; version: number },
): Promise<void> {
  // The caller MUST have already acquired `SELECT ... FROM reviews FOR UPDATE`
  // at the start of the same transaction. This function does not re-acquire
  // the lock — it just reads the review_content_hash that the locked row
  // exposes (consistent within the tx).

  // 1. Review hasn't changed since the editor was opened.
  const [review] = await tx`
    SELECT review_content_hash FROM reviews WHERE id = ${reviewId}
  `;
  if (!review) throw new NotFoundError('review_not_found');
  if (review.review_content_hash !== snapshot.hash) {
    throw new ReviewChangedError(); // 409 'review_changed'
  }

  // 2. The 'posted' row we snapshotted is still 'posted' with the same
  //    version. The posted row only transitions to 'superseded' when
  //    ResponsePublisherWorker successfully DELETE+POSTs a new reply, AT
  //    WHICH POINT the version of the new posted row is one greater. So:
  //      - same version → safe (publisher hasn't run since the drawer opened)
  //      - different version → another flow already published; refuse
  //      - no posted row at all → either DELETE-success / POST-fail recovery
  //        state, or we never had one. Treat as response_changed.
  const [posted] = await tx`
    SELECT version FROM responses
    WHERE review_id = ${reviewId} AND status = 'posted'
  `;
  if (!posted) throw new ResponseChangedError(); // 409 'response_changed'
  if (posted.version !== snapshot.version) {
    throw new ResponseChangedError();
  }
}
```

This validation is correct for both `/draft` (no in-flight draft yet — only the live posted row exists) and `/publish` (the in-flight draft exists alongside the still-`posted` row, validation looks past the draft and confirms the posted row is unchanged).

The 409 responses include the current state in the body so the client can update its UI without an extra round-trip:

```json
{ "error": "review_changed",
  "current_review_text": "Great food, service was actually fine",
  "current_review_hash": "abc..." }
```

**Layered defense:**
- The migration-023 partial unique index ("at most one non-terminal response per review") prevents two `/draft` calls from both succeeding even if they both pass the optimistic check — the second INSERT fails on the unique constraint, the user sees "another edit is in progress".
- The new `responses_one_posted_per_review` partial unique index (this spec's migration) prevents two `posted` rows existing — protects against publisher bugs.
- Row-level `FOR UPDATE` locks at `/publish` time on the candidate response guarantee atomic transition of `pending_approval` → `'approved'`/`'edited'` together with the audit-log INSERT and the outbox INSERT. The route does NOT touch the live `'posted'` sibling — that supersede happens later in the async edit-publisher branch (§4.5), under its own locks, after Zernio confirms DELETE+POST. **The route is responsible for "ready to publish" atomicity; the worker is responsible for "supersede + new-posted" atomicity.**

### 4.7 Failure-mode disposition

| Failure point | State after | Owner-facing UX | Auto-recovery? |
|---|---|---|---|
| `/draft` 409 review_changed | no DB writes | "The customer updated this review. Take another look." Refresh button. | No — owner re-reads new text |
| `/draft` 409 response_changed | no DB writes | "Someone else updated this reply. Refresh to see the latest." | No — owner refreshes |
| `/draft` migration-023 conflict | no DB writes | "Another edit is in progress." | No — second owner waits |
| Regenerate LLM failure | `job_outbox.status='failed'`; **no response row inserted** (`worker/jobs/ResponseGeneratorWorker.ts:182` marks the outbox failed without creating a response row). `/draft-status` reads this and reports `{ status: 'failed' }`. | "Couldn't generate a draft. Try again or edit manually." | Owner clicks retry → fresh `/draft` (mode='regenerate') → new outbox |
| `/publish` 409 (re-validation) | no DB writes | Same as `/draft` 409s | No — owner refreshes |
| DELETE 404 | sibling → `superseded`, proceed to POST | (transparent) | Yes — proceeds normally |
| DELETE auth (401/403, true auth failure) | `handlePublisherAuthErrorTerminal` at `worker/jobs/publisher-error-handlers.ts:151-159` parks the response at `status='awaiting_owner_connect'` with `posting_error='zernio_auth_error'`. Sibling `'posted'` row stays as-is (DELETE didn't succeed). Connection-lost email fires; the existing reconnect banner appears. | "Connection to Google needs to be restored. Reconnect to publish your edit." | Yes — after the owner reconnects, `DrainOwnerConnectWorker` at `worker/jobs/DrainOwnerConnectWorker.ts:46` sweeps `awaiting_owner_connect` rows and re-enqueues them into `publish_response`. Owner does NOT use `/retry`; the drain worker handles it automatically. |
| DELETE transient | response stays `approved`, BullMQ retry | (transparent if recovers) | Yes |
| DELETE permanent — `inbox_addon_required` (403 with that code, classified as `ZernioPermanentError` per §4.5, NOT auth) | response → `failed`, `posting_error='delete_failed_inbox_addon_required'`. Sibling stays `'posted'` because DELETE didn't actually succeed. | "Couldn't update reply: Inbox add-on required" + Sentry alert | No — ops/billing fix the addon, then owner clicks `/retry` (allowlist accepts `delete_failed_*`) |
| DELETE permanent — other 4xx | response → `failed`, `posting_error='delete_failed_<error_kind>'`. Sibling stays `'posted'` (DELETE didn't succeed). | "Couldn't update reply" + posting_error in dashboard | Owner clicks `/retry` (allowlist accepts `delete_failed_*`) |
| POST after successful DELETE — permanent failure | response → `failed`, `posting_error='post_after_delete_failed_<error_kind>'`. Sibling already `'superseded'` from the successful DELETE. Google has no reply (orphan state). | "Edit failed mid-publish — your old reply is no longer on Google." [Retry posting] [Restore original] | Owner clicks `/retry` (no-DELETE branch) or `/restore-original` |
| DELETE success + POST transient | sibling already `superseded`; retry POST only | (transparent if recovers) | Yes — DELETE is idempotent (404 → continue) |
| DELETE success + POST permanent | response → `failed`, sibling → `superseded`. Reply gone from Google. | "Edit failed mid-publish. Your old reply is no longer on Google." [Retry posting] [Restore original] | Owner-driven |
| Inbox add-on lapses globally | many edits fail with 403 | Surface a top-of-dashboard banner: "Reply editing requires the Inbox add-on" | Ops fix |

**Recovery from DELETE-success + POST-permanent.** A naive "re-enqueue the failed response" doesn't work — `ResponsePublisherWorker` at `worker/jobs/ResponsePublisherWorker.ts:91` only publishes responses in `('approved', 'edited', 'awaiting_owner_connect')`, NOT `'failed'`. The `failed` row would be skipped silently, the outbox marked completed, and Google still has no reply.

In this orphan state there is also **no `'posted'` row** for the review (the original was DELETE-superseded, the new one POST-failed). Standard `validateOptimisticConcurrency` throws `ResponseChangedError` when no `'posted'` row exists — which would lock recovery forever. The recovery routes therefore use **status-locking validation** instead, scoped to this specific post-failure state.

Both routes operate inside one transaction. SQL outline:

**[Retry posting]** → `POST /api/dashboard/past-replies/:response_id/retry`

```sql
BEGIN;

-- 0. Lock the review row FIRST (consistent lock order: review → response
--    everywhere). This serializes against process-review.ts's content-change
--    invalidation tx, so we're guaranteed to read the latest posting_error
--    AFTER any in-flight stale-marking has committed.
--    The review_id comes from a quick SELECT we do before the lock acquisition.
--    NON-STRICT throughout: explicit no-row handling maps to typed HTTP errors
--    rather than uncaught exceptions.
SELECT review_id INTO _review_id
FROM responses WHERE id = :response_id AND business_id = :user_business_id;

IF NOT FOUND THEN
  RAISE 'response_not_found';   -- 404
END IF;

SELECT id INTO _r FROM reviews
WHERE id = _review_id AND business_id = :user_business_id
FOR UPDATE;

IF NOT FOUND THEN
  RAISE 'review_not_found';     -- 404 (defense in depth — FK should prevent)
END IF;

-- 1. Lock the failed candidate. Status check inside the tx serializes
--    against concurrent /retry clicks. SELECT all columns we reference
--    later in this tx, including posting_error for the audit log AND
--    the allowlist check.
SELECT id, status, business_id, posting_error INTO _row
FROM responses
WHERE id = :response_id
  AND business_id = :user_business_id
FOR UPDATE;

IF NOT FOUND THEN
  RAISE 'response_not_found';   -- 404 (race: row deleted between step 0 and now)
END IF;

IF _row.status != 'failed' THEN
  RAISE 'already_recovered';   -- 409 'already_recovered'
END IF;

-- 1a. Non-terminal-sibling check. /draft intentionally ignores 'failed'
--     rows when computing the in-flight guard (a failed row is, by name,
--     done with — owner is allowed to start a new draft). That means an
--     owner can have a recoverable failed row AND a fresh
--     pending_approval/approved/edited/awaiting_owner_connect draft
--     simultaneously. If we transitioned this failed row to 'approved'
--     while the new draft also exists, we'd have two non-terminal rows
--     and trip the migration-029 partial unique index — surfacing as a
--     500 instead of a controlled 409.
SELECT 1 INTO _existing FROM responses
WHERE review_id = _review_id
  AND status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect');
IF FOUND THEN
  RAISE 'newer_draft_exists';   -- 409 'newer_draft_exists'
  -- UI shows: "You started a new edit for this review. Either publish
  --           the new edit or cancel it before retrying this old failure."
END IF;

-- 2. Allowlist the failure category. Only edit-publisher failures are
--    safe to retry. Excluded by design:
--      - 'review_content_changed' (process-review.ts:210, set on
--         pending_approval drafts when the customer edited the review)
--      - 'stale_after_review_changed' (set by process-review's NEW branch
--         documented in §4.5 — invalidates an earlier-recoverable failed
--         row when the customer edited the review post-failure)
--      - any other posting_error (today's fresh-publish path errors, etc.)
IF _row.posting_error IS NULL
   OR NOT (
     _row.posting_error LIKE 'delete_failed_%'
     OR _row.posting_error LIKE 'post_after_delete_failed_%'
   ) THEN
  RAISE 'not_recoverable_via_retry';   -- 409 'not_recoverable_via_retry'
END IF;

-- 2a. Branch-shape validation. The failure prefix encodes which state
--     the world should be in for the recovery to be safe:
--
--       delete_failed_*      → DELETE didn't succeed → sibling 'posted'
--                              row MUST still exist on Google + locally.
--                              Recovery re-runs DELETE+POST.
--       post_after_delete_*  → DELETE succeeded → sibling MUST be
--                              'superseded' locally (and reply slot empty
--                              on Google). Recovery uses no-DELETE POST.
--
--     If the world's actual shape doesn't match the prefix, /retry is
--     unsafe. The most dangerous case: an old `post_after_delete_failed_*`
--     row left behind after `/restore-original` published the original
--     reply back to Google. Without this check, /retry on that stale row
--     would: (a) pass the allowlist, (b) transition to 'approved' with
--     the orphan marker, (c) publisher reads no orphan-state but DOES
--     find a live 'posted' sibling (the restored original), (d) DELETEs
--     the restored original from Google, (e) POSTs the failed edit text.
--     Net effect: the recovery the owner just did is undone.
SELECT id INTO _live_posted FROM responses
  WHERE review_id = _review_id AND status = 'posted'
  LIMIT 1;

IF _row.posting_error LIKE 'delete_failed_%' THEN
  IF _live_posted IS NULL THEN
    -- delete_failed_* expects a live sibling. None present means
    -- /restore-original already ran, or some other path superseded
    -- the sibling. Either way, retry would mis-publish.
    RAISE 'sibling_state_mismatch';   -- 409
  END IF;
ELSE -- posting_error LIKE 'post_after_delete_failed_%'
  IF _live_posted IS NOT NULL THEN
    -- post_after_delete_failed_* expects an EMPTY reply slot. A live
    -- posted row means /restore-original already ran (or someone
    -- republished externally). Retry would DELETE the live reply
    -- and replace it with the failed edit text — exactly the bug
    -- this validation prevents.
    RAISE 'live_reply_exists';        -- 409 'live_reply_exists'
  END IF;
END IF;

-- 3. Defense in depth: transition the row back to publishable. The
--    posting_error transition depends on which branch we're in:
--      - delete_failed_*  → sibling is still 'posted' on Google. Next
--                            publisher attempt sees existingPosted, enters
--                            edit-publisher branch normally. NO orphan
--                            marker needed; clear posting_error.
--      - post_after_delete_failed_*  → sibling is 'superseded'. Next
--                            publisher attempt sees no existingPosted.
--                            To keep the no-DELETE-POST branch (rather
--                            than delegating to fresh-publish which would
--                            use today's generic posting_error names on
--                            permanent failure), SET the orphan marker
--                            'pending_after_delete_succeeded' so
--                            isOrphanRetry is true on the next attempt.
UPDATE responses
SET status = 'approved',
    posting_error = CASE
      WHEN _row.posting_error LIKE 'post_after_delete_failed_%'
        THEN 'pending_after_delete_succeeded'   -- preserve orphan context
      ELSE NULL                                  -- delete_failed_* → no marker needed
    END,
    approved_at = NOW(),
    approved_text = COALESCE(approved_text, response_text)  -- safety: should already be set
WHERE id = :response_id;

-- 4. Audit + outbox in same tx. Use insertAuditLogSession() helper at
--    src/lib/approval/audit.ts:60 so id (uuidv7), actor_user_id, auth_method,
--    and the NULL token/cookie columns are all set correctly (a hand-rolled
--    INSERT would have to remember to fill all of those, and any drift would
--    leave the audit trail unable to identify which owner clicked retry).
--    Implementation calls:
--      await insertAuditLogSession(
--        tx,
--        response_id,
--        business_id,
--        'retry_after_failure',
--        { actorUserId: user.id, ipAddress: req.ip },  -- SessionAuditContext shape
--        { previous_posting_error: _row.posting_error }
--      );
-- (no manual SQL block needed — the helper's own SQL is canonical)

INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
VALUES (
  gen_random_uuid(), 'publish_response', 'response', :response_id,
  jsonb_build_object('response_id', :response_id, 'business_id', :business_id),
  'pending'
);

COMMIT;
```

When the worker picks this up, behavior depends on which failure stage `/retry` is recovering from:

- **`posting_error='delete_failed_*'` recovery** — the original `'posted'` sibling is still alive on Google (DELETE never succeeded). When the worker reads the response, `existingPosted` lookup returns the still-alive sibling row, so the worker re-enters the **DELETE+POST sequence** from §4.5 step 2a. This is correct: we still need to remove the old reply from Google before posting the new one.

- **`posting_error='post_after_delete_failed_*'` recovery** — the old `'posted'` sibling is `'superseded'` (DELETE already succeeded last time). When the worker reads the response, `existingPosted` lookup returns NULL, so the worker takes the **no-DELETE branch** and POSTs the recovered text directly into the empty reply slot on Google.

Both branches converge on a normal `'posted'` end state. The worker doesn't read the original failed prefix directly — instead, `/retry` **normalizes the prefix into the worker-visible state** before enqueuing the publish_response outbox row:
- `delete_failed_*` recovery → `posting_error` cleared to NULL, sibling `'posted'` row still alive. Publisher's pre-flight reads no orphan marker AND a live sibling → enters DELETE+POST branch.
- `post_after_delete_failed_*` recovery → `posting_error` re-installed as `'pending_after_delete_succeeded'`, sibling already `'superseded'`. Publisher's pre-flight reads `isOrphanRetry=true` AND no live sibling → enters no-DELETE POST branch.

The branch the worker takes depends entirely on `(isOrphanRetry, existingPostedProbe)` — those two derived values encode everything needed. The original failed prefix is recovery-route input only; the worker never re-reads it.

**[Restore original]** → `POST /api/dashboard/past-replies/:response_id/restore-original`

```sql
BEGIN;

-- 0. Lock the review row FIRST (consistent lock order matching /retry).
--    NON-STRICT with explicit no-row handling — see /retry comment above.
SELECT review_id INTO _review_id
FROM responses WHERE id = :response_id AND business_id = :user_business_id;

IF NOT FOUND THEN
  RAISE 'response_not_found';   -- 404
END IF;

SELECT id INTO _r FROM reviews
WHERE id = _review_id AND business_id = :user_business_id
FOR UPDATE;

IF NOT FOUND THEN
  RAISE 'review_not_found';     -- 404 (defense in depth)
END IF;

-- 1. Lock the failed candidate. Same recovery validation as /retry,
--    but stricter: only post_after_delete_failed_* is restorable
--    (delete_failed_* leaves the original on Google, no need to restore).
--    'stale_after_review_changed' explicitly rejected — restoring a stale
--    edit's "before" text might also be stale relative to the now-changed
--    review.
SELECT id, review_id, status, business_id, posting_error INTO _failed
FROM responses
WHERE id = :response_id
  AND business_id = :user_business_id
FOR UPDATE;

IF NOT FOUND THEN
  RAISE 'response_not_found';   -- 404
END IF;

IF _failed.status != 'failed' THEN
  RAISE 'already_recovered';
END IF;

IF _failed.posting_error IS NULL
   OR NOT _failed.posting_error LIKE 'post_after_delete_failed_%' THEN
  RAISE 'not_in_orphan_state';   -- 409 'not_in_orphan_state'
END IF;

-- 1b. Defense in depth: confirm there is NO 'posted' sibling and at
--     least one 'superseded' sibling. If a 'posted' sibling exists,
--     the orphan state isn't real (someone else republished) and
--     restoring would create a duplicate live reply.
IF EXISTS (SELECT 1 FROM responses
           WHERE review_id = _failed.review_id AND status = 'posted') THEN
  RAISE 'live_reply_exists';   -- 409 'live_reply_exists'
END IF;

-- 1c. Non-terminal-sibling check (same rationale as /retry step 1a).
--     If a fresh pending_approval/approved/edited/awaiting_owner_connect
--     draft exists, INSERTing another would violate migration-029's
--     partial unique index and surface as a 500. Reject explicitly
--     with a clear 409.
IF EXISTS (SELECT 1 FROM responses
           WHERE review_id = _failed.review_id
             AND status IN ('pending_approval', 'approved', 'edited',
                            'awaiting_owner_connect')) THEN
  RAISE 'newer_draft_exists';   -- 409 'newer_draft_exists'
END IF;

-- 2. Find the superseded sibling that holds the **deleted live reply** —
--    NOT just any superseded row. Multiple kinds of rows transition to
--    'superseded' over time:
--      a. The previously-posted reply that our DELETE removed from Google
--         (this is what we want to restore).
--      b. Earlier published replies superseded by an even earlier successful
--         edit (also previously posted; second-best candidate).
--      c. Pending/approved drafts that were superseded by a regeneration
--         or abandonment (NEVER posted; approved_text may be NULL since
--         ResponseGeneratorWorker at worker/jobs/ResponseGeneratorWorker.ts:300
--         inserts pending_approval rows without approved_text).
--    Restoring (c) would either leak a draft that never went live OR
--    violate NOT NULL on the new INSERT below if approved_text is NULL.
--
--    Filter by posted_at IS NOT NULL to keep only previously-posted rows
--    (categories a + b). ORDER BY posted_at DESC, version DESC picks the
--    most recently posted — which is the row we just DELETE-superseded
--    in this orphan state.
SELECT id, approved_text, response_text, original_draft_text, response_language,
       version, posted_at
INTO _superseded
FROM responses
WHERE review_id = _failed.review_id
  AND status = 'superseded'
  AND posted_at IS NOT NULL
ORDER BY posted_at DESC, version DESC
LIMIT 1
FOR UPDATE;

IF NOT FOUND THEN
  RAISE 'no_original_to_restore';   -- 404 'no_original_to_restore'
  -- Should be impossible in the intended orphan recovery state (DELETE
  -- success implies a previously-posted sibling). Defense in depth.
END IF;

-- DEFERRED HARDENING (out of scope for v1): when the publisher commits
-- a sibling supersede after a DELETE-success, persist the exact
-- existingPosted.id as recovery metadata on the candidate row (e.g., via
-- a JSONB column or a dedicated FK). Then /restore-original would
-- target that specific row by id rather than inferring from
-- (status='superseded' AND posted_at IS NOT NULL ORDER BY posted_at DESC).
-- The current heuristic is correct for the typical orphan-state shape
-- (one DELETE-superseded sibling per review at the time of recovery)
-- but isn't airtight against pathological histories — e.g., several
-- successful edits in quick succession all leaving DELETE-superseded
-- rows behind. Track as follow-up if recovery edge cases surface.

-- 3. INSERT a new pending_approval row with FULL column population.
--    response_text and original_draft_text are NOT NULL per
--    supabase/migrations/001_initial_schema.sql:194,215.
--    UNIQUE(review_id, version) per :234 — use COALESCE(MAX(version), 0) + 1
--    to avoid colliding with the still-extant 'failed' row at version N.
INSERT INTO responses (
  id, review_id, business_id,
  -- All three text columns get the same restored value. Use COALESCE
  -- to be defensive: even though the SELECT filters posted_at IS NOT NULL
  -- (so approved_text SHOULD be set on a previously-posted row), older
  -- rows from a pre-spec era could have approved_text=NULL with response_text
  -- carrying the actual posted text. COALESCE protects the NOT NULL invariants.
  response_text,           -- = COALESCE(_superseded.approved_text, _superseded.response_text, _superseded.original_draft_text)
  approved_text,           -- = same COALESCE expression
  original_draft_text,     -- = same COALESCE expression (NOT NULL — line 215)
  edited_text,             -- NULL — restoring isn't an "edit", so /publish picks 'approved'
  response_language,       -- = _superseded.response_language
  version,                 -- = COALESCE((SELECT MAX(version) FROM responses
                           --             WHERE review_id = _failed.review_id), 0) + 1
  status,                  -- 'pending_approval' (NOT terminal — owner still has to publish)
  llm_provider,            -- NULL (not RepWorth-generated text)
  llm_model,               -- NULL
  prompt_tokens,           -- NULL
  completion_tokens        -- NULL
)
VALUES (
  gen_random_uuid(), _failed.review_id, _failed.business_id,
  COALESCE(_superseded.approved_text, _superseded.response_text, _superseded.original_draft_text),
  COALESCE(_superseded.approved_text, _superseded.response_text, _superseded.original_draft_text),
  COALESCE(_superseded.approved_text, _superseded.response_text, _superseded.original_draft_text),
  NULL,
  _superseded.response_language,
  COALESCE((SELECT MAX(version) FROM responses WHERE review_id = _failed.review_id), 0) + 1,
  'pending_approval',
  NULL, NULL, NULL, NULL
)
RETURNING id INTO _new_id;

-- The OLD failed row is INTENTIONALLY left in place (status='failed',
-- posting_error='post_after_delete_failed_*'). Earlier drafts of this
-- spec retired it to 'superseded' here, but that strands the review on
-- cancel: if the owner closes the drawer without publishing the new
-- pending_approval row C (or explicitly cancels via DELETE /draft),
-- the old failed row would already be retired with no recovery path,
-- leaving Google's reply slot empty forever.
--
-- Leaving the failed row in place is safe because layered defenses
-- block the dangerous re-recovery scenarios:
--
--   While restore draft C exists (status='pending_approval'/'edited'):
--     /retry on the old failed row hits the non-terminal-sibling check
--     (step 1a) → 409 'newer_draft_exists'. Cannot interfere.
--     /restore-original on the same id hits its own non-terminal-sibling
--     check (step 1c) → 409 'newer_draft_exists'.
--
--   After restore draft C publishes (status='posted'):
--     /retry on the old failed row passes step 1, the allowlist (step 2),
--     but FAILS the new branch-shape validation (step 2a):
--     post_after_delete_failed_* requires NO live posted sibling, but
--     C is now 'posted' → 409 'live_reply_exists'. Cannot undo the
--     recovery.
--
--   After the owner abandons restore draft C (canceled via DELETE /draft,
--   status='superseded'):
--     /retry on the old failed row passes all checks AND the branch-shape
--     validation (no live posted sibling) → it can re-run as a normal
--     orphan retry of the failed edit. This is the correct semantic — the
--     owner abandoned the restore, so retrying the failed edit text is
--     the right fallback.
--
-- 4. Audit via insertAuditLogSession() helper as in /retry above:
--   await insertAuditLogSession(
--     tx,
--     _new_id,                                       -- the just-INSERTed pending_approval row
--     _failed.business_id,
--     'restore_original',
--     { actorUserId: user.id, ipAddress: req.ip },   -- SessionAuditContext shape
--     { failed_response_id: response_id,
--       restored_from_superseded_id: _superseded.id }
--   );

COMMIT;

-- Returns { response_id: _new_id }. Owner reviews via the standard
-- preview UI, then clicks "Update on Google" → /publish runs the
-- normal pending_approval → approved transition + outbox enqueue.
```

Both paths preserve the original reply text — it lives in `approved_text` of the `superseded` row, not lost.

**Critical invariants for both recovery paths:**
1. The failed-and-recovered row must NOT be re-enqueued without first transitioning to a publishable status (per the §4.2 atomicity rule).
2. Recovery validation is **status-locking, not optimistic-concurrency** — the orphan state has no `'posted'` row, which would break standard validation.
3. `restore-original`'s INSERT must populate `response_text` AND `original_draft_text` (both NOT NULL) and use `MAX(version)+1` to avoid colliding with the still-`failed` row.

## 5. UX

### 5.1 Past Replies tab structure

Top-level dashboard nav gains a "Past Replies" item linking to `/dashboard/past-replies`. The page renders two sections in chronological order (newest first) within each section:

- **From your active period (N)** — gap reviews. Edit enabled for all tiers.
- **From before you joined (M)** — historical reviews.
  - For premium owners: edit enabled.
  - For standard / founding owners: lock badge per row + one `HistoricalUpgradeBanner` at the top of the section.

The N and M counts are computed server-side and shown in the section header.

### 5.2 EditReplyDrawer states

Drawer opens on Edit click with three top-level states:

1. **Initial** — shows review snapshot, current Google reply (read-only), two CTAs: "Edit manually" / "Regenerate with AI".
2. **Manual editing** — textarea pre-filled with current reply, character count, "Update on Google" / "Cancel".
3. **Regenerating** — loading indicator with copy "Generating a new reply using your voice settings…", polls `/draft-status` every 1.5s. Maximum poll duration 60s before showing "Generation taking longer than expected."

After regenerate completes, transitions to:

4. **Regenerate preview** — shows the AI draft, two CTAs: "Update on Google" / "Edit further" (opens textarea pre-filled with the AI draft, falls into state 2).

After publish click, drawer transitions to:

5. **Publishing** — loading indicator, polls response status. Closes on `posted` with success toast or transitions to:

6. **Recovery** — shown if response ends up `failed`. Per the recovery UX in §4.7.

### 5.3 Standard-tier lock state

Per Q6 option B (section divider with one upgrade banner):

- The historical section header reads "From before you joined (M)".
- Immediately below, a single `HistoricalUpgradeBanner` card with copy along the lines of "Premium customers can edit replies to historical reviews using their current brand voice. [See Premium plans →]".
- Each historical row renders the reply text fully, but in place of the Edit button shows a small "🔒 Premium feature" badge.

No modal-on-click bait-and-switch (Q6 option C explicitly rejected).

### 5.4 Visual differentiator for imported replies

A small label on each row indicates whether the reply came in via Google directly (`reviews.external_reply_ingested_at IS NOT NULL`) versus a fresh draft posted through RepWorth. Possible copy: "Imported from Google · 2024-08-14" vs "Posted via RepWorth · 2026-04-22". Helps owners orient themselves and reinforces that we tracked their pre-RepWorth replies.

## 6. Testing

### 6.1 Unit tests (Vitest)

**`worker/jobs/__tests__/zernio-ingest-shared.test.ts`** — new test cases covering the new branches inside `reconcileExternallyAnsweredReview`:
- "No match" branch with flag ON: INSERTs review (`insertImportedReview`) + posted response (`insertImportedResponse`) in one tx; sets `reviews.external_reply_ingested_at`; bumps `zernio_backfill_runs.external_reply_ingested_count`.
- "No match" branch with flag OFF: silent no-op (today's behavior preserved).
- "Matched but no active responses" branch with flag ON: INSERTs posted response only (review already exists); bumps counter.
- "Matched but no active responses" branch with flag OFF: silent no-op.
- "Matched WITH active responses" branch: today's supersede/protect logic unchanged regardless of flag (regression guard).
- Canonicalizes reply text (BOM, NFC, CRLF) — same canonicalization as publishing.
- Idempotency: ON CONFLICT `(provider, provider_review_name)` works for the review insert; ON CONFLICT on the partial unique index works for the posted response. Repeat calls are safe.
- Doesn't fire on `reviewReply === null`.

**`worker/jobs/__tests__/ResponsePublisherWorker-edit.test.ts`** — new file. Branch-outcome tests + lock-protocol tests:

*Pre-flight guards:*
- **Subscription guard skips on cancelled/past-due business.** Pre-seed an edit-publisher candidate row + a business with `subscription_status='cancelled'`. Run publisher. Assert: NO Zernio calls fire; the response row is unchanged; outbox is `markOutboxCompleted` (not failed). Same expected behavior with `past_due` past the 7-day grace window.
- **Subscription guard allows active business through.** Pre-seed candidate + `subscription_status='active'`. Assert publisher proceeds to Phase B normally.
- **Subscription guard skips on missing business row.** Pre-seed candidate row but DELETE the business row before running. Assert outbox completes idempotently (no Zernio calls, no crash).

*Branch outcomes:*
- Existing `posted` sibling exists → DELETE called before POST.
- **No sibling AND no orphan-marker → delegate to today's fresh-publish flow** (regression guard: the new edit-publisher tx must NOT pay the lock-window cost on fresh publishes). Assert: no `reviews FOR UPDATE` acquired, no DELETE called; the existing un-modified fresh-publish code path runs end-to-end.
- **No sibling AND orphan-marker present (isOrphanRetry) → enters edit-publisher branch** (the no-DELETE POST path). Assert lock acquired, no DELETE, POST called, success transitions candidate → 'posted' with `posting_error=NULL`.
- DELETE 404 → skip supersede, proceed to POST.
- DELETE auth error → existing fallback fires; sibling UNCHANGED.
- DELETE permanent (`inbox_addon_required`) → response → `failed` with `posting_error='delete_failed_inbox_addon_required'`, sibling UNCHANGED.
- DELETE succeeds + POST permanent → response → `failed` with `post_after_delete_failed_*`, sibling → `superseded`.
- DELETE succeeds + POST transient → sibling COMMITTED as `superseded`, candidate stays `'approved'`/`'edited'`, throw triggers BullMQ retry; verify next attempt sees no sibling 'posted' and takes no-DELETE branch.
- DELETE succeeds + POST auth → sibling → `superseded`, candidate → `awaiting_owner_connect`.
- 409 verifier dispositions, **split by post-DELETE-committed state**:
  - **Fresh-publish 409 matches** (no DELETE happened): candidate → 'posted', sibling (if any) → 'superseded'.
  - **Fresh-publish 409 mismatch** (no DELETE): candidate → 'superseded', sibling stays 'posted'.
  - **Fresh-publish 409 indeterminate** (no DELETE): ROLLBACK + retry; no DB writes.
  - **Edit-publisher 409 matches after DELETE success**: sibling → 'superseded' (matches Google), candidate → 'posted', posting_error cleared.
  - **Edit-publisher 409 mismatch after DELETE success**: sibling → 'superseded' (DELETE happened, old reply gone), candidate → 'superseded', `review_exceptions` row of type `'edit_publish_409_mismatch_after_delete'` opened with both verifier-observed text and our expected text.
  - **Edit-publisher 409 indeterminate after DELETE success**: sibling → 'superseded' (must commit the DELETE truth), candidate stays publishable with `posting_error='pending_after_delete_succeeded'`, throw transient → retry takes the no-DELETE branch with orphan-marker context.
  - **Orphan-retry 409** (isOrphanRetry, no current sibling): treat the same as edit-publisher post-DELETE 409 cases above (sibling supersede branches are no-ops since there's no sibling, but candidate dispositions match).
- `applyTransientExhaustionFallback` still works in the new branch.

*Lock-protocol tests (require real Postgres via `TEST_DATABASE_POOL_URL`):*
- **Publisher holds reviews FOR UPDATE while processReview blocks.** Start a publisher run with mocked Zernio that takes 2s to respond. In parallel, fire a `processReview` content-change tx for the same review. Assert the processReview tx blocks for ~2s waiting on the publisher's lock, then proceeds AFTER the publisher commits, observing the new `posted` state (not the pre-publish `approved` state). Confirms the lock window genuinely serializes the two flows.
- **POST-failure-after-DELETE commits the orphan state.** Mock Zernio: deleteReply returns 200, postReply throws permanent error. Run the publisher. Assert post-tx-commit state: sibling `posted` row → `'superseded'` AND candidate row → `'failed'` with `posting_error` matching `post_after_delete_failed_*`. The orphan-state row visible to recovery routes proves the commit happened despite the throw.
- **POST-transient-after-DELETE retry behavior.** Mock Zernio: deleteReply returns 200, postReply throws transient on first attempt and 200 on second. Run publisher (BullMQ retries on throw). Assert: after first attempt's commit, sibling is `'superseded'`, candidate stays `'approved'`. After second attempt's commit, candidate is `'posted'`. Verify the second attempt did NOT call deleteReply again (no sibling 'posted' at that point).
- **409 verifier no-deadlock.** Mock Zernio's postReply to return 409 with `reply_already_exists`. Mock listReviews to return our canonicalized text. Run publisher. Assert it completes without deadlock (the tx-aware `verify409InTx` reads via the open `tx`, not a fresh connection). Time the run — should be <1s after the 409 response, not blocked indefinitely.
- **Affected-row-count assertion guards.** Manually pre-seed a stale `superseded` row in place of the expected `posted` sibling (simulate concurrent supersede). Run publisher. Assert it throws `'sibling_lost_during_publish'` AND BullMQ retries with a clean read (after which the assertion no longer fires).
- **Orphan-marker retry exhaustion converts to recoverable failed.** Pre-seed a publishable response with `posting_error='pending_after_delete_succeeded'` (orphan-marker carryover state). Mock Zernio's postReply to throw transient on every attempt. Run publisher; let BullMQ exhaust retries. Assert the `worker/index.ts` `onFailed` hook converts the row to `status='failed'` with `posting_error='post_after_delete_failed_retry_exhausted'` (NOT `awaiting_owner_connect` from the generic fallback). Then assert `POST /retry` against this row succeeds (the new `posting_error` matches the recovery allowlist).
- **Auth-after-DELETE-success preserves orphan-marker through drain.** Mock Zernio: deleteReply 200, postReply throws auth error. Run publisher. Assert response → `'awaiting_owner_connect'` with `posting_error='zernio_auth_error_after_delete_succeeded'` (suffixed). Manually invoke `DrainOwnerConnectWorker`'s re-enqueue logic. On the next publisher attempt, mock postReply to throw permanent. Assert the candidate transitions to `'failed'` with `posting_error='post_after_delete_failed_*'` (NOT a fresh-publish generic name) — proves `isOrphanRetry` correctly read the suffixed marker.
- **Drain re-enqueue races processReview on a suffixed orphan row.** Pre-seed `'awaiting_owner_connect'` row with `posting_error='zernio_auth_error_after_delete_succeeded'`. Open a long-running tx that holds `SELECT FROM reviews WHERE id=X FOR UPDATE`. While the tx is open, run `DrainOwnerConnectWorker`'s bulk select-and-enqueue for the affected business — it does NOT acquire the review lock and proceeds to INSERT a `publish_response` outbox row. Now commit the long-running tx that runs `processReview`'s content-change branch (which supersedes the `'awaiting_owner_connect'` row and clears its publishability). When the BullMQ worker picks up the drain-inserted outbox row, assert the publisher takes the early-exit `IF NOT FOUND` branch (response is `'superseded'` now), no external Zernio calls fire, outbox completes idempotently. This regression-guards the §4.5 documented "drain race acceptance" behavior — a future change that makes the publisher act on superseded rows would break this test.
- **`worker/index.ts` onFailed hook lock-order serialization.** Pre-seed an orphan-marker row (`'approved'` with `posting_error='pending_after_delete_succeeded'`). Open a long-running tx that holds `SELECT FROM reviews WHERE id=X FOR UPDATE`. Trigger BullMQ retry exhaustion on the publish_response job for that response. Assert the onFailed hook's tx blocks waiting on the review lock. Commit the outer tx (running `processReview`'s content-change supersede). Assert: hook unblocks, reads response is now `'superseded'`, takes the status-guarded early-exit, does NOT convert to `'failed'`. Confirms the lock-order fix in §4.5's "Retry exhaustion conversion" prevents the hook from un-superseding processReview's work.

**`src/lib/zernio/__tests__/client.test.ts`** — new test cases:
- `deleteReply` URL contract (`DELETE /v1/inbox/reviews/{reviewId}/reply`, body `{ accountId }`).
- Mock-mode short-circuit returns benign success.
- 401 → `ZernioAuthError`.
- 403 with `inbox_addon_required` code → `ZernioPermanentError`.

**`src/lib/responses/__tests__/edit-existing.test.ts`** — new file:
- Premium owner + historical → passes.
- Standard owner + gap → passes.
- Standard owner + historical → throws `PremiumRequiredError`.
- Standard owner + business with NULL `subscription_activated_at` → throws `PremiumRequiredError` (fail-closed, all-historical).
- Premium owner + business with NULL `subscription_activated_at` → passes (still capped per backfill).
- Owner of different business → `ForbiddenError`.
- Non-existent review → `NotFoundError`.
- Hash + version match → passes.
- Hash mismatch → `ReviewChangedError` with current review text in payload.
- Version mismatch → `ResponseChangedError`.
- No `posted` row exists for the review → `ResponseChangedError`.
- After /draft INSERTs a draft, /publish-time validation against the (still-)posted row passes (regression guard for the pre-fix bug where validation would reject the publisher's own /draft output).
- Activation boundary edge: review_date == subscription_activated_at counts as gap.

**API route tests** — `src/app/api/dashboard/past-replies/__tests__/*.test.ts` — new files. Beyond the happy-path and tier-gate cases listed in §4.4, these MUST include:
- **Cross-origin 403** — confirm each mutating route rejects requests with a wrong `Origin` header. Routes covered: POST `/draft`, PATCH `/draft/:id`, **DELETE `/draft/:id`** (all DELETEs are mutating per the §4.2 cross-cutting checklist), POST `/publish`, POST `/:id/retry`, POST `/:id/restore-original`. GET `/draft-status` is exempt (CSRF doesn't apply to GETs). The pattern at `src/app/api/dashboard/channels/telegram/start/route.ts:82` (uses `withSameOrigin`) is the right model. (Note: nearby dashboard routes like `src/app/api/dashboard/reviews/[reviewId]/approve/route.ts:12` are NOT wrapped today, which makes the test guard especially important — the absence of the wrapper would slip through visual review.)
- **Retry — `post_after_delete_failed_*` (orphan branch)** — `failed` row with that prefix, sibling already `'superseded'`, no `'posted'` for the review → `POST /retry` → row → `'approved'` → publisher reads no `existingPosted` → POST-only branch → row → `'posted'`.
- **Retry — `delete_failed_*` (sibling-still-alive branch)** — `failed` row with that prefix, sibling still `'posted'` → `POST /retry` → row → `'approved'` → publisher reads `existingPosted` is the still-alive sibling → re-enters DELETE+POST sequence → on success, sibling → `'superseded'`, candidate → `'posted'`. Verifies the worker's branch dispatch logic actually differs based on sibling state.
- **Retry — rejected by `review_content_changed`** — `failed` row whose `posting_error='review_content_changed'` (set by `process-review.ts:210` when the customer edited the review while a draft was pending) → `POST /retry` → 409 `not_recoverable_via_retry`. Confirms the allowlist excludes today's pre-existing failure code.
- **Retry — rejected by `stale_after_review_changed`** (the review-changed-after-edit-failure invalidation case) — pre-seed a `failed` row with `posting_error='delete_failed_inbox_addon_required'`. Trigger `processReview` with a content-changed payload for the same review. Verify the row's `posting_error` flips to `stale_after_review_changed`. Then `POST /retry` → 409 `not_recoverable_via_retry`. This regression-guards the new process-review branch documented in §4.5.
- **Restore-original — happy path** — `failed` row with `post_after_delete_failed_*`, no live `'posted'`, has a `'superseded'` sibling → `POST /restore-original` → new `'pending_approval'` row INSERTed with the original imported reply text and `version = MAX(existing) + 1` → standard `/publish` → publishes original to Google.
- **Restore-original — rejected by `not_in_orphan_state`** — `failed` row with `posting_error='delete_failed_inbox_addon_required'` (sibling still alive) → `POST /restore-original` → 409 `not_in_orphan_state` (this branch is /retry's territory, not /restore-original's).
- **Restore-original — rejected by `live_reply_exists`** — Pre-seed the orphan state, then INSERT a fresh `'posted'` row to simulate someone-else-republished → `POST /restore-original` → 409 `live_reply_exists`.
- **Restore-original creates pending draft, OLD failed row stays failed** — orphan state with failed row F (`posting_error='post_after_delete_failed_*'`) → `POST /restore-original` → assert: new `'pending_approval'` row C exists; F still `'failed'` with same `posting_error` (NOT retired). Confirms the spec's intentional choice to leave F in place so abandoning C still has a recovery path.
- **Stale /retry blocked while restore draft exists (newer-draft-exists)** — orphan state with failed row F → `POST /restore-original` (creates pending draft C) → before publishing C, fire `POST /retry` on F's id → 409 `newer_draft_exists` (caught by /retry's step 1a non-terminal-sibling check). C remains untouched.
- **Stale /retry blocked after restore publishes (live_reply_exists)** — orphan state with failed row F → `POST /restore-original` → publish C through `/publish` and the publisher → C becomes `'posted'` (Google has the original reply) → fire `POST /retry` on F's id → 409 `live_reply_exists` (caught by /retry's step 2a branch-shape check). The restored reply is NOT undone.
- **Canceling restore draft re-enables /retry on F** — orphan state with failed row F → `POST /restore-original` (creates C) → owner cancels via `DELETE /draft/:C` → C → `'superseded'` → fire `POST /retry` on F → succeeds (no live posted, no non-terminal sibling, valid post_after_delete_failed_* allowlist). Confirms the abandon-restore recovery path documented in §4.7.
- **Restore draft text matches the originally-imported reply** — orphan state where the original posted reply was imported (not RepWorth-generated) → `POST /restore-original` → the new pending_approval row's `approved_text`, `response_text`, AND `original_draft_text` all equal the original imported reply's canonicalized text. `version = MAX(existing) + 1` (NOT 1, because F is still at some version N).
- **Recovery routes lock review row first** — Open a long-running tx that holds `SELECT FROM reviews WHERE id=X FOR UPDATE`. Fire `POST /retry` for a failed row on review X in parallel. Assert the route blocks until the tx commits, then proceeds. (Confirms the §4.7 lock order serializes recovery against process-review's content-change branch.)

### 6.2 Integration tests (Vitest + real Supabase)

**`worker/__tests__/integration-edit-existing-reply.test.ts`** — new file:

- **Full ingest path:** seed business + connection → run `ZernioBackfillWorker` with mocked `listReviews` returning mixed answered/unanswered → verify reviews + responses rows post-run, both buckets correct, `external_reply_ingested_count` populated.
- **Manual edit happy path:** pre-seed external-reply review → POST `/draft` (manual) → verify `responses.status='pending_approval'` (NOT `'edited'`; see §4.2 atomicity rule) and `edited_text=new_text` → POST `/publish` → verify response transitioned to `'edited'` (because edited_text was set), `approved_at` populated, `approval_audit_log` row exists, outbox row enqueued → run `ResponsePublisherWorker` (mocked Zernio) → verify final state response `'posted'`, sibling `'superseded'`, no notification deliveries.
- **Manual edit abandoned mid-flow regression guard:** POST `/draft` (manual) → owner closes drawer (no `/publish` call) → assert dashboard's "responded" count is UNCHANGED — the new `pending_approval` row must NOT count as handled. Reads `dashboard/service.ts` `total_responded` count before and after the abandoned draft.
- **Regenerate accept-as-is:** POST `/draft` (regenerate) → run `ResponseGeneratorWorker` (mocked LLM) → verify `pending_approval` draft inserted with `approved_text IS NULL`, `edited_text IS NULL` → POST `/publish` (no PATCH) → verify response transitioned to `'approved'` (because edited_text IS NULL), `approved_text = response_text` (via the `COALESCE` logic at §4.4 step 4), `approved_at` populated → run publisher → response `'posted'` with the AI-generated text actually present (NOT empty).
- **Regenerate then edit-further:** POST `/draft` (regen) → worker creates pending_approval → PATCH `/draft/:id` with new_text → verify `approved_text=new_text`, `edited_text=new_text`, `status='pending_approval'` (still!) → POST `/publish` → verify status transitioned to `'edited'` → publish to Google.
- **Regenerate happy path:** same setup → POST `/draft` (regenerate) → run `ResponseGeneratorWorker` (mocked LLM) → verify `pending_approval` draft inserted → POST `/publish` → continue as above.
- **Concurrency: two simultaneous /draft (manual) calls on the same review** → first succeeds, second blocks on the `reviews` row lock per §4.2 in-flight guard, then either fails the in-flight check (if the first INSERTed an outbox row) or fails the migration-023 unique-index conflict (if the first INSERTed a response row). 409 either way; no double draft.
- **Concurrency: two simultaneous /draft (regenerate) calls on the same review** → first succeeds, second blocks on the `reviews` row lock, then sees the in-flight `generate_response` outbox row inside its transaction, fails with 409 `regenerate_in_progress`. No second outbox row, no second LLM call. Use real Postgres (TEST_DATABASE_POOL_URL) and run two routes in parallel via `Promise.all` to exercise the actual locking, not just sequential calls.
- **Concurrency: /draft (manual) racing /draft (regenerate)** → same row lock serializes both. Whichever wins commits first; the other gets 409.
- **Optimistic mismatch:** owner snapshots state → simulated webhook updates `review_content_hash` → owner clicks `/publish` → 409 `review_changed`.

### 6.3 E2E tests (Playwright)

**`e2e/edit-existing-reply.spec.ts`** — new file (skips gracefully without `TEST_DATABASE_POOL_URL`):

- Premium owner happy path (login → tab → edit manually → publish → verify).
- Standard tier gate (gap rows have Edit, historical rows show lock + banner).
- Regenerate flow (with stubbed LLM).
- Cancel mid-edit (no DB writes).

### 6.4 Manual QA on staging

Per `docs/runbooks/zernio-ingestion-test-runbook.md` pattern. Before flipping `EDIT_EXISTING_REPLIES_ENABLED`:

1. Run a real backfill on a Zernio sandbox account with mixed answered/unanswered reviews.
2. Verify Past Replies tab populates with correct counts.
3. Edit one historical reply via the dashboard; verify change reflects on Google within ~1 min.
4. Open editor in two browser tabs on the same row → publish in tab 1 → publish in tab 2 should fail with optimistic-concurrency error.
5. Force a Zernio 401 (rotate API key to bogus) → verify connection-lost flow fires.
6. Verify zero notification emails fire during edit-publish (`SELECT count(*) FROM notification_deliveries WHERE response_id = X` for the edited response = 0).

### 6.5 Migration testing

- `ALTER TABLE reviews ADD COLUMN external_reply_ingested_at` and the counter column add: instant in PG 15+ (NULL default + DEFAULT 0 are metadata-only changes).
- Pre-flight check that no existing data violates the new partial unique index BEFORE running migration (see §4.2 SQL block).
- `CREATE UNIQUE INDEX CONCURRENTLY responses_one_posted_per_review` — note the index build is on the `responses` table (NOT `reviews` as an earlier draft of this spec mistakenly stated). Validate the running index is in a valid state post-migration:

```sql
SELECT indexname, indisvalid FROM pg_indexes
  JOIN pg_class ON pg_class.relname = indexname
  JOIN pg_index ON pg_index.indexrelid = pg_class.oid
  WHERE indexname = 'responses_one_posted_per_review';
-- expect: indisvalid = true
```

If `indisvalid=false`, the CONCURRENTLY build was interrupted; drop and retry.

- Counter column adds with default 0; existing `zernio_backfill_runs` rows backfill correctly.

### 6.6 Acceptance criteria

- All existing tests pass (1707+ baseline).
- ~30-40 new test cases across the surfaces above.
- TSC clean.
- Lint clean.
- Manual QA on staging completes the 6-item checklist successfully.
- Migration applies on staging without violating the new unique-index pre-flight.

## 7. Rollout

### 7.1 Two phases

**Phase A — Code shipped, flag off.** Apply migration. Ship code with `EDIT_EXISTING_REPLIES_ENABLED=false`:
- Past Replies route returns 404. Edit/publish/retry endpoints return 503.
- **Ingestion of imported replies is ALSO gated by the flag** (see §4.3). When off, `reconcileExternallyAnsweredReview` falls back to today's silent-no-op behavior. **Reasoning:** an imported `posted` response counts in `src/lib/dashboard/service.ts:98`'s "total responded" metric (`HANDLED_STATUSES` includes `'posted'`) and surfaces in `src/components/dashboard/ValueSummary.tsx:13`'s value summary. If we ingested without lighting the UI, the existing dashboard's "responded" count would jump for customers without explanation — breaking Phase A's "no user-facing change" promise.
- Phase A is therefore a literal no-op for owners. The migration applies, the new schema is ready, the new code paths exist but aren't reached.
- Soak for ≥1 week. Watch for migration-related errors, run TSC + tests in CI to confirm the new code compiles cleanly, manually verify the flag-off branches in staging.

**Phase B — Flip the flag.** Set `EDIT_EXISTING_REPLIES_ENABLED=true`:
- Imported replies start getting ingested into the DB on every webhook + on next reconnect's backfill.
- UI lights up at `/dashboard/past-replies`.
- Dashboard "total responded" counts may rise for businesses with imported replies — this is the intended effect.
- Edit / publish endpoints become available.
- Watch DELETE+POST error rates, optimistic-concurrency 409 rates, dashboard-metric jumps.

The split's value isn't the data layer (since the data layer doesn't activate until Phase B) — it's that we get a deployable code change to soak before flipping any switch. If TSC + tests + flag-off branch checks all pass on staging for a week, Phase B is a one-line config change with confidence.

### 7.2 Backfilling existing customers

Customers who onboarded BEFORE this ships have no `external_reply_ingested_at` data. Two retroactive paths:

**A — Opportunistic.** `ZernioReviewIngestWorker` already runs on every `review.updated` webhook. Add a check: if the webhook arrives for a business that has connections but no `responses.status='posted'` row for that review, ingest it via the new helper. Eventually-consistent fill via natural webhook traffic. Zero ops overhead.

**B — One-time admin script.** `pnpm tsx scripts/zernio-backfill-external-replies.ts <business-id>` walks Zernio for that business and ingests anything missing. Useful for VIPs who want immediate filling.

We ship A and B. A automatic-on-flag-flip (re-walk every business) is **explicitly rejected** — re-walks every business's Zernio quota at once.

### 7.3 Monitoring

| Metric | Threshold | Surface |
|---|---|---|
| `responses.status='failed'` count where `posting_error` mentions DELETE+POST | > 1% of edit attempts | Sentry alert |
| `external_reply_ingested_count` distribution per `zernio_backfill_runs` | track | weekly internal review |
| 409 `review_changed` from `/publish` | > 5% of publishes | UI race smell — investigate |
| 403 `inbox_addon_required` from Zernio | any | Sentry alert (billing/addon issue) |
| Time from `/draft` to `/publish` | track p50/p95 | sanity check |

### 7.4 Rollback

- **Flag flip back to off** — instant. UI dies. Edit endpoints return 503. Ingestion of imported replies also stops (per the same flag-gate at §4.3); already-ingested rows stay in the DB but no new ones are created until the flag flips back on.
- **Migration rollback** — risky. The new column + index are backward compatible (NULLable + partial). If genuine bug requires undo, write a forward migration to drop them; don't UN the original.
- **Worker bug in DELETE-before-POST** — the new branch is gated by the env flag inside `ResponsePublisherWorker`. Flipping the flag off restores POST-only behavior without a redeploy.

## 8. Out of scope

- Bulk regenerate.
- Email approval flow for edits.
- AI drafts for unanswered historical reviews (today's behavior, unchanged).
- `postReply` migration to documented `/v1/inbox/...` path (deferred follow-up).
- Inbox add-on billing UX.
- Voice-learning algorithm changes — imported replies do **not** seed voice learning (the existing query at `src/lib/responses/voice-learning.ts:30` filters on `edited_text IS NOT NULL`, and imported rows have `edited_text=NULL`). Voice learning continues to bootstrap from owner-driven RepWorth edits only. Widening the query to include imported replies is tracked as an optional follow-up in §9, not part of this design.
- Tier definition changes — premium already exists; we expand what it unlocks.
- New outbox topics — `publish_response` reused.
- Edit history UI ("show me what I changed") — out of scope; row-by-row history stored in `superseded` rows, accessible to admin queries but not surfaced to owners in v1.

## 9. Open questions

- **Mobile UX.** EditReplyDrawer on mobile — drawer or full-screen modal? Defer to design polish during implementation; both are reasonable.
- **Voice learning bootstrap.** Imported replies do NOT seed voice learning (per §3 note — voice learning queries `edited_text IS NOT NULL` and imported replies have `edited_text=NULL`). Voice learning still warms up only after ≥5 owner-driven RepWorth edits as today. **Optional follow-up:** widen the voice-learning query to also include rows where `original_draft_text == approved_text AND llm_provider IS NULL` (the imported-reply signal). This would give voice learning eight free examples on day 1 for Tanicia. Out of scope for this design — track separately.
