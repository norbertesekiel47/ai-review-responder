# Zernio Ingestion — Test Runbook

This runbook walks through validating the Zernio webhook-driven review ingestion implementation (the work that replaced SerpAPI polling). It complements `docs/zernio-launch-runbook.md` (publishing side, already in production behind the flag).

**Audience:** engineer running pre-merge QA, staging smoke, or post-rollout verification. Skim §1, then run the §3 scenario list against your environment.

**Spec of record:** `docs/superpowers/specs/2026-04-29-zernio-ingestion-replace-serpapi-design.md`.
**Plan of record:** `docs/superpowers/plans/2026-04-29-zernio-ingestion-replace-serpapi-plan.md`.

If a step fails, stop and investigate. The scenarios build on prior state — running a downstream check on a broken upstream produces misleading results.

---

## 1. What this is testing

Three subsystems shipped together on `feat/zernio-ingestion-replace-serpapi`:

| Subsystem | New surface area |
|---|---|
| **Webhook-driven ingestion** | `worker/ingress/zernio/zernio.ts` fan-out → `ZernioReviewIngestWorker` → `processReview` |
| **First-connect backfill** | `select-location` callback enqueues → `ZernioBackfillWorker` (tier-aware caps) |
| **Publisher 409 verify-first** | `ResponsePublisherWorker` 409 catch → `verify409AndDispose` (reads page-cache, walks listReviews, classifies outcome) |

Plus three operational changes that surface only on specific failure paths:

| Operational change | When it matters |
|---|---|
| Manual-post fallback **decommissioned** | A response can no longer transition to `awaiting_manual_post`. Migration 029 bulk-fails any orphan rows. |
| Premium tier wired end-to-end | Stripe Payment Link → `subscription_tier='premium'` → `historical` backfill cap=50 (founding/standard get cap=0) |
| Post-activation backfill resume | Stripe `checkout.session.completed` / `invoice.paid` re-enqueues `zernio_initial_backfill` if active connection exists + no completed run |

The same `ZERNIO_PUBLISHING_ENABLED` flag controls publishing AND ingestion. No new flag.

---

## 2. Pre-flight setup

### 2.1 Migrations applied

In your target Supabase env (dev → staging → prod, each separately), apply in order:

```
028_zernio_backfill_runs.sql            -- new table, must come first
029_drop_awaiting_manual_post.sql       -- depends on 028 conceptually; rebuilds non-terminal index
030_ingest_zernio_review_outbox_dedup.sql  -- partial unique index for outbox dedup
```

Verify each:

```sql
-- 028
\d+ zernio_backfill_runs
-- expect: index zernio_backfill_runs_one_per_business

-- 029
\d+ responses_one_non_terminal_per_review
-- expect: predicate WHERE status IN ('pending_approval', 'approved', 'edited',
--         'awaiting_owner_connect') — 'awaiting_manual_post' MUST be absent
SELECT indexname FROM pg_indexes
  WHERE indexname = 'notification_deliveries_response_template_uniq';
-- expect: 0 rows

-- 030
\d+ job_outbox_ingest_zernio_review_inflight
-- expect: partial unique on (aggregate_id, (payload->>'zernio_review_id'))
--         WHERE topic='ingest_zernio_review' AND status IN
--         ('pending','dispatching','dispatched')
```

### 2.2 Env vars

Required when `ZERNIO_PUBLISHING_ENABLED=true`:

| Var | Purpose |
|---|---|
| `ZERNIO_API_KEY` | Worker → Zernio HTTP calls |
| `ZERNIO_WEBHOOK_SECRET` | HMAC verification on `/ingress/zernio` |
| `WORKER_PUBLIC_URL` | Used by Zernio dashboard webhook config |
| `STRIPE_PAYMENT_LINK_PREMIUM` | Required when `SELF_SERVE_SIGNUP_ENABLED=true` |
| `STRIPE_PRICE_PREMIUM` | Required so Stripe webhook maps the new price → `subscription_tier='premium'` |

Optional:

| Var | Default | Purpose |
|---|---|---|
| `ZERNIO_INGEST_MAX_PAGES` | `4` | Caps `ZernioReviewIngestWorker.listReviews` walk. Hitting cap with `nextPageToken` set escalates to `zernio_pagination_cap_exhausted` (distinct from durable not-found). |

### 2.3 Local mock mode

Set `MOCK_EXTERNAL_APIS=true` in `.env.local` to short-circuit Zernio HTTP calls. The ingest worker exits early without burning retries. `pnpm dev` and `pnpm worker` both honor this. Use this for fast iteration; switch to a real Zernio sandbox connection for end-to-end smoke.

### 2.4 Branch baseline

```bash
git checkout feat/zernio-ingestion-replace-serpapi
pnpm install
pnpm tsc --noEmit       # expect: 0 errors
pnpm test               # expect: 1707 passing (re-run if bounced-skip flakes)
pnpm lint               # expect: clean
```

---

## 3. Pre-merge verification scenarios

These run against unit + integration tests already in the branch. None require live Zernio API access.

### 3.1 Webhook fan-out

**Goal:** A webhook for one Zernio account fans out to exactly the active connections at that account/location.

```bash
pnpm vitest run src/lib/zernio/__tests__/parse-review-webhook.test.ts
pnpm vitest run worker/__tests__/zernio-end-to-end.integration.test.ts
```

Expected:
- 13 tests in parse-review-webhook (incl. nested-account.id, location-segment-extract, mismatch-throws, no-cross-check-account-id-against-resource-path).
- 6 tests in end-to-end integration (incl. multi-location no-op when sibling location).

### 3.2 Ingest worker pagination + error dispatch

```bash
pnpm vitest run worker/__tests__/ZernioReviewIngestWorker.test.ts
pnpm vitest run worker/__tests__/zernio-ingest-shared.test.ts
```

Expected:
- 13 tests in ingest worker. Critical ones to spot-check:
  - `throws ZernioIngestReviewNotFoundError when entire feed walked without nextPageToken` (asserts `pagesWalked` + `reviewsSeen`)
  - `throws ZernioIngestPaginationCapExhaustedError when cap is hit and Zernio still has more pages` (asserts `cap=4`, `reviewsSeen=200`)
  - `honors ZERNIO_INGEST_MAX_PAGES env var override`
  - `MOCK_EXTERNAL_APIS=true → short-circuit (no listReviews call, no review_exceptions)`
- 10 tests in ingest-shared (auth-fallback dispatch matrix + reconcile per-response protect-set).

### 3.3 Backfill worker (tier-aware)

```bash
pnpm vitest run worker/__tests__/ZernioBackfillWorker.test.ts
```

Expected: 7 tests. Spot-check the matrix:
- Founding tier + 30 historical reviews → `historical=0`, `historicalSkipped=30`, all gap reviews processed up to cap=25
- Premium tier + 60 historical → `historical=50` (cap), `historicalSkipped=10`
- All processed `processReview` calls receive `{ suppressNotification: true }`
- Reconcile failure mid-loop → counts updated, `completed_at` NOT set, worker throws → BullMQ retry resumes cleanly

### 3.4 Publisher 409 verify-first

```bash
pnpm vitest run worker/__tests__/ResponsePublisherWorker.test.ts
pnpm vitest run worker/__tests__/publisher-error-handlers.test.ts
pnpm vitest run src/lib/publishing/__tests__/zernio-publisher.test.ts
```

Expected:
- ResponsePublisherWorker: ~24 tests. Critical ones:
  - `409 + target found page 1 with matching text → response marked posted`
  - `409 + target NOT found → throws ZernioReplyVerificationIndeterminateError reason='review_not_found_after_pagination'`
  - `409 + target found but reviewReply=null → throws ZernioReplyVerificationIndeterminateError reason='review_found_but_reply_null'`
  - `409 + listReviews ZernioTransientError → caught + rethrown as PublisherTransientWithContext`
  - `409 canonicalization: existing CRLF vs ours LF → text match → posted`
  - Non-publishable terminal states (`failed`, `superseded`, `pending_approval`, `awaiting_manual_post`) → no Zernio call
- publisher-error-handlers: 12 tests (extracted helpers + verify409AndDispose outcomes)
- zernio-publisher: 5 tests (page-cache write key includes locationId; getCachedZernioReviewPage reads it back)

### 3.5 process-review state machine

```bash
pnpm vitest run src/lib/reviews/__tests__/process-review.test.ts
```

Expected: ~6 tests. Critical:
- ON CONFLICT race-loss falls through to existing-row branch
- `suppress_notification=true` propagates into outbox payload
- `awaiting_owner_connect` parked response superseded with `posting_error='review_content_changed_during_park'` when content changes (Medium 5 fix)
- `posted` response NOT superseded on content change (just exception opened)

### 3.6 Stripe activation backfill resume

```bash
pnpm vitest run worker/__tests__/stripe-activation-enqueue.test.ts
```

Expected: ~9 tests. Critical:
- `flag=ON + active connection + no completed run → enqueues zernio_initial_backfill` with correct payload (account/location/tier snapshot)
- `flag=ON + no zernio_backfill_runs row at all (admin connected pre-checkout) → still enqueues`
- `flag=ON + in-flight outbox row exists → INSERT ... SELECT WHERE NOT EXISTS executes but produces count=0`
- `flag=OFF → NO outbox INSERT`

### 3.7 Field-match canonical predicate

```bash
pnpm vitest run src/lib/reviews/__tests__/zernio-field-match.test.ts
```

Expected: 5+ tests covering exact match, reviewer mismatch, rating mismatch, text mismatch, ±24h date-window edges. Both SQL fragment in `zernio-ingest-shared.ts` and JS predicate in `zernio-publisher.ts` use the canonical `fromZernioReview` + `matchesLocalRow`.

### 3.8 Canonicalize reply text

```bash
pnpm vitest run src/lib/zernio/__tests__/canonicalize-reply.test.ts
```

Expected: 12 tests. Spot-check BOM/zero-width handling — round-trip through Google can introduce these silently.

### 3.9 Acceptance grep audit (§13 of plan)

Run from repo root:

```bash
# Should match only historical migrations + absence-assertions in tests
git grep "'sync_reviews'" -- src/ worker/
git grep awaiting_manual_post -- src/ worker/
git grep ManualPostFlow -- src/ worker/
git grep buildManualPostEmailHtml -- src/ worker/
git grep getReviewMonitor -- src/ worker/
```

Acceptable matches:
- `sync_reviews` — only in test absence-assertions (`expect(...).toBe(false)` shape)
- `awaiting_manual_post` — only in absence-assertions / regression-guard comments / migration 029
- `ManualPostFlow` — zero
- `buildManualPostEmailHtml` — zero
- `getReviewMonitor` — zero

---

## 4. Local manual smoke (mock mode)

These exercise the full pipeline without touching real Zernio. Run with `MOCK_EXTERNAL_APIS=true` set in `.env.local`.

### 4.1 Webhook → outbox fan-out → mock-mode worker short-circuit

**Prerequisite — seed a `zernio_connections` row.** The webhook fan-out is `INSERT … SELECT … FROM zernio_connections WHERE zernio_account_id = $accountId AND status = 'active'`. With no matching row, the INSERT inserts zero rows, the worker never picks up a job, and there are no logs to observe — the webhook still returns `200 received:true`, but nothing else happens. Two ways to seed:

**Option A — run the connect flow once** (recommended; mirrors real onboarding):
```
pnpm dev   # in a third terminal
# Browser → log in as a test owner → /dashboard/connect → complete the (mocked) flow.
# The select-location callback writes a row to zernio_connections with a real
# generated account id. Read it back:
```
```sql
SELECT zernio_account_id, zernio_location_id, business_id, status
FROM zernio_connections
WHERE status = 'active'
ORDER BY connected_at DESC LIMIT 1;
```

**Option B — insert a row directly** (faster for iteration):
```sql
-- pick any owner business id from your local DB
INSERT INTO zernio_connections (
  id, business_id, zernio_account_id, zernio_location_id, status, connected_at
) VALUES (
  gen_random_uuid(),
  '<your-test-business-id>',
  'mock-account-1',
  'mock-location-1',
  'active',
  NOW()
);
```

**Now fire the webhook**, passing whichever account id matches the seeded row:

```bash
# Terminal 1
pnpm worker

# Terminal 2 — arg order is <account-id> <event>.
# If you used Option B's mock-account-1, pass "" to use the script's default mock account.
# If you used Option A, pass the real account id from the SELECT above.
bash scripts/zernio-fire-webhook.sh "" review.new
```

Expected log sequence in worker (look past the Fastify access log JSON to the application logs):
```
[ingress/zernio] review.new received eventId=evt-... account=mock-account-1 review=mock-review-1 (account-wide fan-out)
[ingress/zernio] review.new fan-out enqueued 1 outbox row(s)
[ZernioReviewIngestWorker] Mock mode — short-circuiting ingest for mock-review-1
```

If the fan-out matched zero connections you'll see this instead, and no worker job runs:
```
[ingress/zernio] review.new fan-out matched 0 active connections for account=mock-account-1 — webhook ignored (no business has connected this account/location)
```
That's the seed-step prerequisite biting; go back to the SELECT above and confirm a row exists with the account id you're firing.

Verify:
```sql
SELECT topic, status, last_error
FROM job_outbox
WHERE topic = 'ingest_zernio_review'
ORDER BY created_at DESC LIMIT 5;
-- All recent rows: status='completed', last_error IS NULL
```

**If the SELECT returns zero rows** but the webhook returned 200, the seed step was skipped or the account id you passed doesn't match a row with `status='active'`. Re-check the `zernio_connections` query above and re-fire.

### 4.2 Outbox dedup on webhook retry

Fire the same webhook twice in rapid succession (replay the same event ID):

```bash
# Pin EVENT_ID via env so both calls send the same id (script otherwise auto-generates).
EVENT_ID=evt_test_dedup bash scripts/zernio-fire-webhook.sh "" review.new
sleep 1
EVENT_ID=evt_test_dedup bash scripts/zernio-fire-webhook.sh "" review.new
```

Expected:
- Second call returns `200 received:true duplicate:true` (claimInboundEvent dedup).
- No additional `ingest_zernio_review` outbox rows beyond the first delivery's fan-out.

### 4.3 Ingestion partial-index dedup (migration 030)

In SQL (simulate a worker crash mid-fan-out — manually re-INSERT to test the index):

```sql
-- Assuming there's an in-flight ingest_zernio_review row for biz X / review Y
INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
VALUES (
  gen_random_uuid(), 'ingest_zernio_review', 'business',
  '<biz-uuid>',
  jsonb_build_object('zernio_review_id', 'rev_xyz', 'business_id', '<biz-uuid>'),
  'pending'
)
ON CONFLICT (aggregate_id, (payload->>'zernio_review_id'))
  WHERE topic = 'ingest_zernio_review'
    AND status IN ('pending', 'dispatching', 'dispatched')
DO NOTHING;
-- expect: 0 rows affected
```

---

## 5. Staging end-to-end smoke (real Zernio sandbox)

Set `ZERNIO_PUBLISHING_ENABLED=true`, `MOCK_EXTERNAL_APIS=false`, real `ZERNIO_API_KEY`/`ZERNIO_WEBHOOK_SECRET` in staging env. Confirm Zernio dashboard webhook URL points at `${WORKER_PUBLIC_URL}/ingress/zernio`.

### 5.1 First-connect backfill — non-premium tier

1. Create a test business at the founding or standard tier.
2. Have the test owner complete the Zernio connect flow (`/dashboard/connect` → OAuth → `/select-location`).
3. Watch worker logs:
   ```
   [select-location] needs_backfill=true → enqueued zernio_initial_backfill for biz=<id>
   [ZernioBackfillWorker] Starting backfill for biz=<id> tier=standard
   [ZernioBackfillWorker] Backfill complete biz=<id> tier=standard: gap=N/M historical=0/K
   ```
4. Verify in Supabase:

   > **SUPERSEDED by migration 103 (#680) — do not run this query as written.**
   > The four `gap_*`/`historical_*` counters were DROPPED from
   > `zernio_backfill_runs`; reusing this SELECT now raises SQLSTATE 42703
   > (undefined_column). They collapsed into `imported_count` (= gap + historical
   > processed) and `skipped_count` (= gap + historical skipped) at #675, so the
   > per-lane split this step reads is no longer recorded anywhere. This runbook is
   > *completed* and kept as history — the query below is preserved as it ran, not
   > rewritten. For an equivalent check today, select `imported_count`,
   > `skipped_count`, `oldest_skipped_create_time`, `completed_at`.

   ```sql
   SELECT business_id, subscription_tier, gap_processed_count,
          gap_skipped_count, historical_processed_count,
          historical_skipped_count, oldest_skipped_create_time, completed_at
     FROM zernio_backfill_runs WHERE business_id = '<id>';
   -- subscription_tier='standard'
   -- historical_processed_count=0
   -- historical_skipped_count = total reviews older than activation
   -- completed_at IS NOT NULL
   ```
5. Check the dashboard at `/dashboard`: gap reviews should show `pending_approval` responses; **zero approval emails** sent during backfill (suppress_notification=true). Confirm:
   ```sql
   SELECT count(*) FROM notification_deliveries
     WHERE business_id = '<id>'
       AND template = 'approval_request'
       AND created_at > '<connect_time>';
   -- expect: 0
   ```

### 5.2 First-connect backfill — premium tier

Repeat 5.1 with a `subscription_tier='premium'` business. Confirm:
- `historical_processed_count` ≤ 50 (cap) — *column dropped by migration 103 (#680); folded into `imported_count`*
- `historical_skipped_count` = total older reviews − processed — *column dropped by migration 103 (#680); folded into `skipped_count`*
- All historical reviews get `pending_approval` responses

### 5.3 Steady-state webhook ingestion

After backfill completes, post a fresh review on the sandbox GBP (or have Zernio fire a `review.new` simulating one).

Watch logs:
```
[ingress/zernio] review.new accountId=<a> reviewId=<r> → 1 ingest_zernio_review outbox row
[ZernioReviewIngestWorker] Found review on page 0
[process-review] new review inserted, generate_response enqueued
[ResponseGeneratorWorker] Generated response for review=<r>
[NotificationWorker] Sent approval email to owner
```

Verify:
```sql
SELECT id, provider, provider_review_name, status
  FROM reviews WHERE business_id = '<id>'
  ORDER BY created_at DESC LIMIT 1;
-- provider='zernio', status='new'
```

### 5.4 Approval → publish → 409 verify-first

1. Owner clicks approve in the email → response transitions to `approved`.
2. `ResponsePublisherWorker` posts to Zernio.
3. **Force a 409 scenario** by manually posting the same comment via Zernio dashboard *before* the worker fires. The worker should then receive `ZernioReplyAlreadyExistsError` → `verify409AndDispose` → walk listReviews → find target → compare text → mark `posted` (text match) OR `superseded` (text mismatch).

Expected log on text match:
```
[ResponsePublisherWorker] Response <id> already posted on Zernio (409, text match), marked posted
```

Expected log on text mismatch (rare in practice — would mean owner manually replied with different text):
```
[ResponsePublisherWorker] Response <id> 409 text mismatch — existing(len=42,fp=abc123def456) ours(len=38,fp=789xyz012345) — superseded as already_replied_external
```

### 5.5 Auth error path

Revoke Zernio's connection from the Google account (sandbox). Trigger any review action.

Expected:
- `ZernioAuthError` on next `listReviews` or `postReply`
- Connection flips to `disconnected` with `disconnect_reason='auth_error_on_post'` (or `auth_error_on_ingest` on the ingestion path) and `last_error` is **redacted** (no Bearer tokens visible)
- `notify_owner_reconnect` outbox row enqueued with `kind='reconnect_required'`
- Owner receives the two-clause v17 reconnect email
- Dashboard banner shows the orange "Reconnect Google Business" CTA

Verify:
```sql
SELECT business_id, status, disconnect_reason, last_error, last_error_at
  FROM zernio_connections WHERE business_id = '<id>';
-- last_error must NOT contain 'Bearer ...' or 'token=...'

SELECT topic, payload->>'kind' AS kind, status
  FROM job_outbox WHERE aggregate_id = '<id>'
    AND topic IN ('notify_owner_reconnect', 'notify_owner_connection_lost')
  ORDER BY created_at DESC LIMIT 5;
-- kind='reconnect_required' on the response-scoped row
-- kind='connection_lost' on the business-scoped row
```

### 5.6 Multi-location fan-out (only if you have a multi-location sandbox)

1. Connect two RepWorth businesses to the same Zernio account at two different locations (loc-A, loc-B).
2. Post a review on the sandbox GBP at loc-A.
3. Verify the webhook handler enqueues exactly ONE `ingest_zernio_review` outbox row — not two:
   ```sql
   SELECT business_id, payload->>'zernio_location_id' AS loc, status
     FROM job_outbox WHERE topic = 'ingest_zernio_review'
       AND payload->>'zernio_review_id' = '<rev_id>'
     ORDER BY created_at DESC;
   -- 1 row with loc = 'loc-A' (the parsed location from review.name)
   -- NO row for the loc-B sibling business
   ```
4. The biz-A response generates; the biz-B has no row for this review.

If location can't be parsed from the webhook payload, the handler falls back to account-wide fan-out (one row per active connection). The ingest worker's location filter then drops sibling-location reviews via no-op + `markOutboxCompleted`.

### 5.7 Pagination cap exhaustion

Hard to trigger on a sandbox unless you've manually accumulated 200+ reviews. To force it:
- Set `ZERNIO_INGEST_MAX_PAGES=1` in worker env.
- Post a review on a location that has any other newer review (so the target is on page 2+).
- Worker exhausts the 1-page cap → throws `ZernioIngestPaginationCapExhaustedError` → BullMQ retries 5× → onFailed escalates.

Verify:
```sql
SELECT type, payload->>'cap' AS cap, payload->>'reviews_seen' AS seen,
       payload->>'pages_walked' AS walked
  FROM review_exceptions
  WHERE type = 'zernio_pagination_cap_exhausted'
  ORDER BY created_at DESC LIMIT 5;
-- cap=1, walked=1, reviews_seen>0
```

Sentry should also have a `zernio_pagination_cap_exhausted` warning event. Restore `ZERNIO_INGEST_MAX_PAGES` (or unset to default).

### 5.8 Indeterminate verifier path

After 5.4 succeeds in a normal run, force the indeterminate path:
- Set `ZERNIO_INGEST_MAX_PAGES=1` to make the 409 verifier walk too short.
- Post a 409-triggering reply on an OLD review (one that's past page 1).
- Worker hits `ZernioReplyAlreadyExistsError` → verifier walks 1 page → can't find target → throws `ZernioReplyVerificationIndeterminateError(reason='review_not_found_after_pagination')` → BullMQ retries 5× → failed-hook fires.

Verify:
```sql
SELECT type, status, payload->>'reason' AS reason, payload->>'pages_walked' AS walked
  FROM review_exceptions
  WHERE type = 'zernio_reply_verification_indeterminate'
  ORDER BY created_at DESC LIMIT 5;
-- reason='review_not_found_after_pagination', walked=1
```

Response status should be `failed` with `posting_error='zernio_reply_verification_indeterminate'`. Admin notify enqueued.

### 5.9 Past_due → active billing recovery resumes backfill

1. Set up a business with completed connect but skipped backfill (e.g., toggle `subscription_status='past_due'` manually, manually clear `completed_at` from `zernio_backfill_runs`).
2. Trigger Stripe `invoice.paid` (Stripe CLI or fixture event in dev).
3. Watch worker:
   ```
   [ingress/stripe] Business <id> recovered from past_due to active
   [ingress/stripe] Re-enqueued zernio_initial_backfill for business=<id> (post-activation backfill resume)
   [ZernioBackfillWorker] Starting backfill ...
   ```
4. Confirm new outbox row exists for `topic='zernio_initial_backfill'` with `aggregate_id=<biz>`.

### 5.10 Manual-post decommission verification

```sql
-- No new responses can land at awaiting_manual_post.
SELECT count(*) FROM responses WHERE status = 'awaiting_manual_post';
-- expect: 0 (migration 029 bulk-failed them; new code paths can't produce it)

-- Non-terminal uniqueness index excludes the dead status.
\d+ responses_one_non_terminal_per_review
-- expect: WHERE status IN ('pending_approval', 'approved', 'edited',
--         'awaiting_owner_connect') — 'awaiting_manual_post' absent.
```

UI smoke:
- `/admin/businesses/[id]` should NOT render `<ManualPostFlow />` anywhere.
- Email templates: searching the codebase for `buildManualPostEmailHtml` returns 0 hits in `src/` and `worker/`.

---

## 6. Production rollout

After staging passes 5.1–5.10:

1. **Apply migrations 028 → 029 → 030** in prod Supabase SQL editor (use the queries in §2.1 to verify each).
2. **Set env vars** in Vercel + Railway:
   - `STRIPE_PAYMENT_LINK_PREMIUM`, `STRIPE_PRICE_PREMIUM`
   - Optional: `ZERNIO_INGEST_MAX_PAGES` (default 4 is fine to start)
3. **Confirm Zernio webhook URL** in Zernio dashboard points at `${WORKER_PUBLIC_URL}/ingress/zernio` (no URL change — same endpoint now handles `review.new`/`review.updated` in addition to `account.disconnected`).
4. **Flip the flag**: `ZERNIO_PUBLISHING_ENABLED=true` in prod env. Same flag controls both publishing AND ingestion — no new flag.
5. **Pilot one customer** end-to-end (5.1–5.5 against a real prod business).
6. **Watch for 24h**:
   - Sentry: zero `unwrapped_transient` errors in publisher worker.
   - Sentry: `zernio_pagination_cap_exhausted` warning rate.
   - DB: `SELECT count(*) FROM review_exceptions WHERE type LIKE 'zernio_%' AND created_at > now() - interval '1 day'` — should be near zero.
   - Outbox health: `SELECT topic, count(*), max(created_at) FROM job_outbox WHERE topic IN ('ingest_zernio_review', 'zernio_initial_backfill') AND status='dispatched' AND created_at < now() - interval '1 hour' GROUP BY topic` — stuck-dispatched rows should be 0.

---

## 7. Common failure modes

| Symptom | Likely cause | Diagnostic | Fix |
|---|---|---|---|
| Webhook returns 401 invalid_signature | `ZERNIO_WEBHOOK_SECRET` mismatch with Zernio dashboard | `console.warn` in worker logs; Zernio retry queue grows | Rotate secret in Zernio dashboard + update env var; worker handles `sha256=` prefix automatically |
| `zernio_review_not_found` review_exceptions accumulate | Reviews deleted on Google between webhook fire + worker run | `payload->>'pages_walked'` and `reviews_seen` show full feed walked | Verify in customer's GBP whether review actually exists; if deleted, dismiss exceptions |
| `zernio_pagination_cap_exhausted` rate climbs | Customer has 200+ reviews; webhook for old review.updated misses target | Sentry warning + review_exception payload shows `cap=4 reviews_seen=200` | Bump `ZERNIO_INGEST_MAX_PAGES` env var (one-line worker restart); investigate whether Zernio offers `getReview(id)` direct fetch |
| Backfill silently completes with 0 reviews | Malformed `subscription_activated_at` ISO string | Worker throws "malformed subscription_activated_at" → outbox `failed` row | Check `businesses.subscription_activated_at` column for the affected biz; ensure Stripe activation set a valid timestamp |
| Owner gets connection_lost email but no reconnect email | `kind` field missing from `notify_owner_reconnect` payload | `OwnerEmailWorker` falls through to `sendConnectionLost` | Already fixed (Round 1). Verify by grepping `worker/jobs/publisher/publisher-error-handlers.ts` for `kind: 'reconnect_required'` — must be present. |
| Owner emails reference a stale parked response after content change | `processReview` not superseding `awaiting_owner_connect` on edit | Customer edited review → exception opened, response stayed parked → `DrainOwnerConnectWorker` re-queued stale response | Already fixed (Round 2 / Medium 5). Verify `process-review.ts` UPDATE to `superseded` with `posting_error='review_content_changed_during_park'` exists in the `awaiting_owner_connect` branch. |
| Multiple Zernio connections at one business all disconnected on a single transient error | Un-pinned legacy fallback in `applyTransientExhaustionFallback` | Sentry `unwrapped_transient` event + multi-row UPDATE on `zernio_connections` | Already fixed (Round 2 / Medium 1). Verify `applyTransientExhaustionFallback` requires `account_id`+`location_id`. Check that publisher wraps every transient throw with `PublisherTransientWithContext`. |
| 409 verifier fires on every retry | Page cache miss, full 4-page walk repeats | Sentry `zernio_409_verifier_pages_walked_at_cap` warning | Page cache should populate during `lookupZernioReviewId`'s field-match — verify Redis key `zernio_review_page:{acct}:{loc}:{rev}` is set post-publish. |

---

## 8. Rollback procedures

### 8.1 Quick disable (safe)

Set `ZERNIO_PUBLISHING_ENABLED=false` in prod env. Restart workers.

Effects:
- Webhook ingress returns 503; Zernio retries die.
- `worker/ingress/zernio/zernio.ts` short-circuits before parsing.
- `ResponsePublisherWorker` falls into the no-connection branch (response → `awaiting_owner_connect`); admin notified via dashboard banner.
- Existing `awaiting_owner_connect` responses stay there until flag re-enabled.

This is non-destructive and the recommended rollback for "ingest pipeline misbehaving but not catastrophic" scenarios.

### 8.2 Migration rollback (only if 029/030 broke prod)

Migrations 028 + 029 + 030 are idempotent on apply but not trivially reversible:

| Migration | Reversibility |
|---|---|
| 028 (zernio_backfill_runs table) | `DROP TABLE zernio_backfill_runs;` (loses backfill audit history) |
| 029 (drop awaiting_manual_post) | NOT REVERSIBLE — `responses_one_non_terminal_per_review` index would need to be dropped + recreated with the old predicate; the bulk UPDATE that flipped orphan rows to `failed` is not undoable |
| 030 (ingest dedup index) | `DROP INDEX job_outbox_ingest_zernio_review_inflight;` — webhook fan-out then loses dedup but still functions |

If migration 029's bulk UPDATE ran on rows you wanted to preserve, the rollback is a manual `UPDATE responses SET status='awaiting_manual_post' WHERE posting_error='manual_post_deprecated_2026_04'` — but only if the manual-post code is also restored, which is non-trivial. Don't apply 029 in prod without confirming `SELECT count(*) FROM responses WHERE status='awaiting_manual_post'` returns 0 first.

### 8.3 Code rollback

`git revert` the merge commit. The following must be redeployed in this order:

1. Vercel + Railway: revert deploy to pre-merge commit
2. Stripe webhook config: no change needed (Premium price doesn't break older code; older code just never serves the premium plan)
3. Zernio dashboard webhook URL: no change needed (URL is the same)
4. Migrations stay applied (rolling them back is per 8.2)

`SerpAPI ingestion` is gone; reverting brings it back, but `SerpAPI quota` may have been frozen during the gap. Check SerpAPI dashboard usage history.

---

## 9. Test artifacts

After running this runbook, file the results:

```
docs/zernio-ingestion-test-report-YYYY-MM-DD.md
```

Following the same format as `docs/zernio-test-report-2026-04-28.md` (the publishing-side QA report). Include:

- Date + environment (dev/staging/prod)
- Branch SHA tested
- §3 unit/integration test counts (expected vs actual)
- §5 staging smoke results (per scenario, pass/fail with notes)
- Any deviations from expected behavior
- Sentry events captured during the run
- Sign-off owner

---

## 10. Future work tracked elsewhere

The following are documented in CLAUDE.md residual risks and NOT covered by this runbook:

- Backfill gap-window uses `subscription_activated_at` not `connected_at` — proper fix needs schema change.
- 409 verifier still walks `cap` pages worst-case on cache miss — Zernio `getReview(id)` direct endpoint would close this fully.
- `subscription_status_changed_at` column for grace-period accuracy.
