# Zernio Integration — Launch Runbook

This runbook walks through the operational launch of the Zernio (`zernio.com`) integration: pre-flight checks, the Phase 1 single-customer pilot, common errors and their causes, the `finalize_unknown` reconciliation procedure, and rollback steps.

If anything fails at any step, stop and investigate before continuing — the steps build on each other.

Audience: oncall engineer with no prior knowledge of the Zernio integration. Skim §1 first, then jump to whichever section matches the situation.

Spec of record: `docs/superpowers/specs/2026-04-27-zernio-integration-design.md`. CLAUDE.md (project root `.claude/CLAUDE.md`) carries the env-var inventory and migration index.

---

## 1. What Zernio is and where it sits

Zernio is a third-party Google Business Profile API broker. We use it for two things:

1. **Reply posting** — `ResponsePublisherWorker` calls `POST /v1/accounts/{accountId}/locations/{locationId}/reviews/{reviewId}/reply` on Zernio when a response transitions to `approved`.
2. **Disconnect notifications** — Zernio fires a webhook to `/ingress/zernio` when a Google account loses authorization.

Zernio does NOT replace SerpAPI for review **ingestion** in Phase 1 — SerpAPI polling continues to populate `reviews` rows. Phase 3 may swap ingestion to Zernio review events, but that is a separate spec.

The integration is **flag-gated** by `ZERNIO_PUBLISHING_ENABLED`. Default off. When off:

- Worker doesn't boot Zernio assertions.
- Connect routes return 404.
- Webhook ingress returns 503.
- ResponsePublisher falls through to the manual-post branch (existing behavior).

---

## 2. Pre-flight checklist

Do these in order. Each step has a verification you can run.

### 2.1 Zernio account setup (external, do once)

- [ ] Reseller terms of service confirmed in writing with Zernio sales.
- [ ] Zernio Accelerate plan activated on annual billing.
- [ ] Inbox add-on activated (required for reply posting).
- [ ] Production API key generated. Scope: a single workspace dedicated to RepWorth prod.
- [ ] Webhook signing secret generated: `openssl rand -hex 32`. 32 bytes = 64 hex chars.

### 2.2 Configure webhook in Zernio dashboard

- [ ] **Webhook URL**: `${WORKER_PUBLIC_URL}/ingress/zernio` — exact match including scheme + host + path. No trailing slash.
- [ ] **Signing secret**: paste the secret you generated in 2.1.
- [ ] **Subscribed events**:
  - `account.disconnected` (required — drives connection-lost emails)
  - `account.connected` (defensive drift detector — log only)
  - `webhook.test` (lets you fire test webhooks from the dashboard)
  - `review.new` and `review.updated` (optional — observability counters for Phase 3 readiness signal)

### 2.3 Set production env vars

In Railway (worker) and Vercel (Next.js) — both need them, since the connect routes run on Vercel and the webhook ingress runs on Railway:

```bash
ZERNIO_PUBLISHING_ENABLED=true
ZERNIO_API_KEY=<bearer token from Zernio dashboard>
ZERNIO_WEBHOOK_SECRET=<the 64-hex-char secret from 2.1>

# Optional — defaults shown
ZERNIO_PROFILE_ID_PREFIX=repworth-prod-
ZERNIO_API_BASE=https://zernio.com/api
```

Existing requirements (must already be set from prior sprints):

```bash
WORKER_PUBLIC_URL=https://worker.repworth.com   # no trailing slash, scheme matches Zernio dashboard
NEXT_PUBLIC_APP_URL=https://app.repworth.com    # no trailing slash
```

### 2.4 Run migration 026

You run this; the agent does NOT apply migrations to Supabase directly. Open Supabase SQL editor, paste the contents of `supabase/migrations/026_zernio_publishing.sql`, run.

Verify after:

```sql
-- The two new tables exist
SELECT to_regclass('public.zernio_connections') AS connections,
       to_regclass('public.zernio_finalize_incidents') AS incidents;
-- Expect both non-null.

-- responses.status is now TEXT (not the old enum)
SELECT data_type FROM information_schema.columns
WHERE table_name='responses' AND column_name='status';
-- Expect 'text'.

-- The 4 new indexes exist (names match migration 026 exactly)
SELECT indexname FROM pg_indexes
WHERE indexname IN (
  'responses_one_non_terminal_per_review',
  'idx_jo_publish_response_inflight',
  'notification_deliveries_owner_reconnect_dedup',
  'notification_deliveries_connection_lost_dedup'
);
-- Expect 4 rows.
```

### 2.5 Restart worker; verify startup assertion

```bash
# Railway: trigger redeploy, watch logs for the assertion lines
# Local: pnpm worker
```

Expect log lines like:

```
[startup-assert] zernio: ZERNIO_API_KEY ✓
[startup-assert] zernio: ZERNIO_WEBHOOK_SECRET ✓
[startup-assert] zernio: WORKER_PUBLIC_URL ✓
[startup-assert] zernio: NEXT_PUBLIC_APP_URL ✓
```

If any are missing, the worker exits with code 1. Fix the env var, redeploy.

### 2.6 Fire test webhook

In the Zernio dashboard, click "Send test webhook" (event type `webhook.test`).

Verify in worker logs:

```
[ingress/zernio] webhook.test received eventId=<uuid>
[ingress/zernio] processed eventId=<uuid> in 12ms
```

Verify in DB:

```sql
SELECT id, source, event_type, status, created_at
FROM inbound_events
WHERE source='zernio'
ORDER BY created_at DESC
LIMIT 1;
-- Expect: status='processed', event_type='webhook.test', created_at within last minute.
```

If you get 401 `invalid_signature` or `invalid_signature_format`, see §5.

If you get 503 `feature_disabled`, the env var didn't propagate — re-check `ZERNIO_PUBLISHING_ENABLED=true` on Railway.

---

## 3. Phase 1 pilot — single-customer happy path

Once §2 passes, you're ready to onboard customer #1. Do these in this order.

### 3.1 Customer signs up + onboards (existing flow)

Customer #1 should already exist in `businesses` with `subscription_status='active'` and `place_id_verified=true`. They reach `/dashboard` and see the **"Connect Google Business"** banner (rendered by `src/components/dashboard/ConnectGoogleBanner.tsx`).

### 3.2 Customer clicks "Connect"

Flow: `/dashboard` banner → `/dashboard/connect` page → click "Connect with Google" → handoff to Zernio's hosted OAuth → Zernio redirects back to `/api/zernio/connect/callback?state=...&code=...`.

If Zernio attaches multiple Google locations to the new account, the customer is redirected to `/dashboard/connect/select-location` to pick one.

### 3.3 Verify the connection landed

```sql
SELECT id, business_id, zernio_profile_id, zernio_account_id,
       zernio_location_id, status, connected_at, last_error
FROM zernio_connections
WHERE business_id = '<customer-1-business-id>'
ORDER BY connected_at DESC
LIMIT 1;
-- Expect: status='active', last_error IS NULL,
--         zernio_account_id + zernio_location_id both populated.
```

The dashboard banner should disappear (the dashboard data API now returns `zernioConnection.status='active'`).

### 3.4 First post

Wait for SerpAPI polling to surface a new review (or trigger a manual `sync_reviews` outbox row from the admin job page). Generated response → owner approves → `ResponsePublisherWorker` runs.

Tail worker logs:

```
[ResponsePublisherWorker] business_id=<...> response_id=<...> branch=zernio
[zernio-publisher] postReply OK accountId=<...> locationId=<...> reviewId=<zernio-id> in 480ms
[ResponsePublisherWorker] response_id=<...> status=posted
```

Verify in DB:

```sql
SELECT id, status, posted_at, posting_attempts
FROM responses
WHERE id = '<response-id>';
-- Expect: status='posted', posted_at set, posting_attempts increased by 1.
```

Open Google Maps for the business — the reply should appear under the review within ~1 minute (Google's own propagation delay; Zernio acks the post immediately).

### 3.5 Phase 1 monitoring (1-2 weeks)

Dashboard / SQL queries to watch:

```sql
-- Reply success rate over the last 24h
SELECT
  COUNT(*) FILTER (WHERE status='posted')::float /
    NULLIF(COUNT(*) FILTER (WHERE status IN ('posted','failed','awaiting_owner_connect')), 0) AS pct
FROM responses
WHERE updated_at > NOW() - INTERVAL '24 hours';
-- Target: 1.0 in Phase 1. Alert if < 0.95.

-- Connection drops
SELECT business_id, disconnect_reason, disconnected_at
FROM zernio_connections
WHERE disconnected_at > NOW() - INTERVAL '24 hours';
-- Target: 0. Alert if > 1/day.

-- Stuck responses awaiting reconnect
SELECT business_id, COUNT(*)
FROM responses
WHERE status='awaiting_owner_connect'
GROUP BY business_id
HAVING COUNT(*) > 5;
-- Target: empty. >5 per business → manual nudge.

-- Unresolved finalize_unknown incidents (see §6)
SELECT business_id, flow_id, finalize_unknown_at
FROM zernio_finalize_incidents
WHERE resolved_at IS NULL;
-- Target: empty. Any row → run §6 reconciliation.
```

Sentry tags to filter on: `zernio.error_class`, `zernio.outcome`. Alerts:

| Signal | Threshold | Action |
|---|---|---|
| `ZernioAuthError` rate | >1/h | email alert, investigate API key validity |
| `ZernioReviewNotFoundError` count | >0 in 24h | email alert, see §5 |
| Webhook signature failures | >0 in 1h | page (likely secret rotation drift) |
| `awaiting_owner_connect` per business | >5 | manual nudge to owner |
| `zernio_finalize_unknown` Sentry alert | any | run §6 reconciliation |

### 3.6 Exit criteria for Phase 1

Customer #1 has 5+ approved replies posted via Zernio, zero `ZernioReviewNotFoundError` occurrences, zero unresolved `zernio_finalize_incidents` rows, and the owner reports replies appearing on Google. Then expand to 5–10 customers (Phase 2; no code changes).

---

## 4. Admin monitoring of `awaiting_owner_connect`

The admin overview page exposes a column showing `awaiting_owner_connect` count per business. To check from SQL:

```sql
SELECT b.id AS business_id, b.name,
       COUNT(*) FILTER (WHERE r.status='awaiting_owner_connect') AS stuck,
       MAX(r.updated_at) FILTER (WHERE r.status='awaiting_owner_connect') AS oldest_stuck_at
FROM businesses b
LEFT JOIN responses r ON r.business_id = b.id
WHERE b.subscription_status='active'
GROUP BY b.id, b.name
HAVING COUNT(*) FILTER (WHERE r.status='awaiting_owner_connect') > 0
ORDER BY stuck DESC;
```

Stuck responses are not lost — when the owner reconnects via `/dashboard/connect`, `DrainOwnerConnectWorker` flips them back to `approved` and re-queues `publish_response` outbox rows. The drain is idempotent: replaying it is safe.

**Manual nudge procedure** (when an owner has >5 stuck responses for >48h):

1. Confirm the connection is actually broken: `SELECT status FROM zernio_connections WHERE business_id='<...>' AND status IN ('active','pending') ORDER BY connected_at DESC LIMIT 1;` — should be empty or `disconnected`.
2. If a `notification_deliveries` row for `owner_reconnect_required` exists in the last 7 days, the email already went. Check `owner_email_bounced` on the business — if true, call them.
3. Otherwise wait for the next dispatch (one per stuck response, deduped by `(response_id, template)`).

---

## 5. Common errors and their causes

### 5.1 Webhook ingress returns 401 `invalid_signature_format`

The `x-zernio-signature` header is missing or not 64 hex chars. Causes:

- A proxy (Cloudflare, Railway router) is rewriting headers. Verify `WORKER_PUBLIC_URL` points at the Railway service directly, not behind a stripping proxy.
- Zernio dashboard misconfigured — re-check the webhook URL ends in `/ingress/zernio` (no trailing slash) and HMAC scheme is sha256-hex.

### 5.2 Webhook ingress returns 401 `invalid_signature`

Header format is correct but HMAC doesn't match. Causes:

- `ZERNIO_WEBHOOK_SECRET` env value differs from the secret in the Zernio dashboard. Most common after secret rotation.
- A proxy is rewriting the body (e.g. re-pretty-printing JSON). The HMAC is computed over the EXACT raw bytes — any reformatting breaks it. We use `fastify-raw-body` for this reason; if you've fronted Railway with a different gateway, verify it preserves bodies byte-for-byte.

Fix: re-paste the secret from the Zernio dashboard into Railway env vars, redeploy. Zernio retries 7× over 51h, so a brief 401 window during rotation is tolerable.

### 5.3 `ZernioAuthError` during `postReply`

The Zernio API returned 401/403 on a reply attempt. Means: the underlying Google account on Zernio's side has been revoked (owner removed RepWorth's app from their Google permissions, or Zernio's broker auth token expired).

What the worker does automatically:

1. Single Postgres tx flips `zernio_connections.status='disconnected'` (with `disconnect_reason='auth_error_on_post'`) AND inserts `notify_owner_connection_lost` outbox row.
2. The current response transitions to `awaiting_owner_connect` (not `failed` — this is graceful degradation).
3. `OwnerEmailWorker` sends the `owner_connection_lost` email.

What you should NOT do: re-trigger the response manually until the owner reconnects. The drain handles it.

### 5.4 `ZernioReviewNotFoundError`

`POST .../reviews/{reviewId}/reply` returned 404 — Zernio doesn't see the review on its side. Causes:

- The reviewer edited the review between SerpAPI poll and our reply attempt. SerpAPI's synthetic `provider_review_id` (`SHA-256(reviewerName|date|profileUrl)`) no longer matches Zernio's view.
- The reviewer deleted the review entirely.
- A review-id translation cache miss (Phase 1 instrumentation tracks this).

What the worker does automatically: marks the response `failed` (status-guarded so a parallel terminal transition isn't stomped) and inserts a row into `review_exceptions` with `type = 'zernio_review_id_mismatch'` and `payload.error_meta.reason = 'no_field_match'` (or `'review_not_found_or_wrong_business'` for the rarer pre-Zernio case). A `notify_admin_review_exception` outbox row is enqueued so admin gets paged.

What you should do:
- Spot-check `SELECT * FROM review_exceptions WHERE type = 'zernio_review_id_mismatch' AND status = 'open' ORDER BY created_at DESC` weekly. If the rate exceeds 5% of `posted` responses in the same window, escalate — likely indicates SerpAPI text drift Zernio doesn't see, and Phase 3 (promote `review.new` webhooks to ingestion) becomes priority.
- For a one-off resolvable case where the reply is still appropriate, the admin can flip the response back via the legacy `awaiting_manual_post` escape hatch (`/admin/businesses/[id]` → mark a response for manual posting). That is NOT the worker's automatic path — it's a manual remediation step the admin invokes.

### 5.5 `finalize_unknown` Sentry alert

The `selectLocation` step (called from `/api/zernio/connect/select-location` or `/api/zernio/connect/callback` when Zernio returns a single location) timed out or returned 5xx after we'd already issued the request. We don't know whether Zernio committed the account on its side or not.

A row exists in `zernio_finalize_incidents` with `resolved_at IS NULL`. Run §6 reconciliation.

### 5.6 `ZernioRateLimitError` (429)

Zernio's API rate limit hit. Build tier is 600 req/min. Worker treats this as transient — BullMQ backoff retries. If sustained: investigate whether a polling loop is misbehaving, or upgrade the Zernio plan.

---

## 6. `finalize_unknown` reconciliation procedure

This is the most operationally complex flow in the integration. Follow it exactly.

**When triggered:**
- Sentry alert `zernio_finalize_unknown` fires, OR
- Cancel route returns 409 `finalize_unknown_admin_required` to a customer trying to retry, OR
- Routine query: `SELECT * FROM zernio_finalize_incidents WHERE resolved_at IS NULL;` returns rows.

**What it means:** during the connect flow, the worker called `selectLocation` on Zernio, the call did not return a definitive success/failure (timeout or 5xx after request was sent). We can't know whether Zernio committed an account record on its side. Until reconciled, the customer can't retry the connect flow (Redis pending marker is in `finalize_unknown` state).

### 6.1 Gather the inputs

From the alert OR the incident row, capture:

```sql
SELECT id, business_id, flow_id, zernio_profile_id, finalize_unknown_at,
       zernio_account_id, zernio_location_id, created_at, updated_at
FROM zernio_finalize_incidents
WHERE resolved_at IS NULL
ORDER BY finalize_unknown_at ASC;
```

(Migration 026 doesn't snapshot the failing Zernio response status/body on the incident row — the response details live in Sentry breadcrumbs from the `select-location` route, tagged with the same `flow_id`. Cross-reference there if you need the exact failure mode.)

You'll use `business_id`, `flow_id`, `zernio_profile_id`. Substitute these into the SQL templates below as `:business_id`, `:flow_id`, `:profile_id`.

### 6.2 Check Zernio's side

In the Zernio dashboard or via the API:

```bash
curl -H "Authorization: Bearer $ZERNIO_API_KEY" \
     "https://zernio.com/api/v1/profiles/<zernio_profile_id>/accounts"
```

Look at the response. Does an account exist for this profile?

### 6.3 Branch A — account exists on Zernio's side

Zernio committed before our request aborted. We need to attach the account to the business in our DB and resolve the incident. **The two writes must be in one transaction** so a partial reconciliation can't leave responses stuck forever.

Capture `accountId` and `locationId` from the Zernio listing. Run the probe query (in psql) to check whether an active row already exists:

```sql
BEGIN;

-- Try to insert; capture whether a row was actually written.
WITH ins AS (
  INSERT INTO zernio_connections (
    id, business_id, zernio_profile_id, zernio_account_id,
    zernio_location_id, status, connected_at
  ) VALUES (
    gen_random_uuid(), :business_id, :profile_id, :account_id,
    :location_id, 'active', NOW()
  )
  ON CONFLICT (business_id) WHERE status IN ('pending','active') DO NOTHING
  RETURNING id
)
SELECT (SELECT id FROM ins) AS inserted_id,
       (SELECT zernio_account_id FROM zernio_connections
          WHERE business_id = :business_id AND status = 'active'
          LIMIT 1) AS existing_account_id;
-- (Run this query, inspect the result. DO NOT COMMIT yet.)
```

Three sub-cases based on the result:

#### Sub-case A-1 — `inserted_id IS NOT NULL` (fresh row created)

Proceed with the drain + resolve in the SAME transaction. Without enqueuing `drain_pending_owner_connect` here, any responses already in `awaiting_owner_connect` would stay stuck forever.

```sql
-- Continuing in the same transaction:
INSERT INTO job_outbox (
  id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
) VALUES (
  gen_random_uuid(), 'drain_pending_owner_connect',
  'business', :business_id,
  jsonb_build_object('business_id', :business_id),
  0, 5
);

UPDATE zernio_finalize_incidents
SET resolved_at = NOW(),
    resolution = 'account_found',
    zernio_account_id = :account_id,
    zernio_location_id = :location_id,
    resolution_notes = 'reconciled — fresh row inserted, drain enqueued',
    updated_at = NOW()
WHERE business_id = :business_id AND resolved_at IS NULL;

COMMIT;
```

Then clear the Redis pending marker via Lua CAS (the helper `luaDeletePendingByFlowIdAnyStatus` is exported from `src/lib/zernio/connect-state.ts`). From a one-shot Node script:

```ts
import { redis } from '@/lib/db/redis';
import { luaDeletePendingByFlowIdAnyStatus } from '@/lib/zernio/connect-state';

await redis.eval(luaDeletePendingByFlowIdAnyStatus, 1,
                 `connect_pending:${BUSINESS_ID}`, FLOW_ID);
```

#### Sub-case A-2 — `inserted_id IS NULL` AND `existing_account_id = :account_id`

There's already an active row pointing at the SAME account — likely a previous reconciliation already ran, or a parallel auto-finalize succeeded. Just resolve the incident:

```sql
UPDATE zernio_finalize_incidents
SET resolved_at = NOW(),
    resolution = 'manual_admin_other',
    resolution_notes = 'pre-existing active row with same account_id',
    updated_at = NOW()
WHERE business_id = :business_id AND resolved_at IS NULL;
COMMIT;
```

Then clear the Redis pending marker (same Lua CAS as A-1).

#### Sub-case A-3 — `inserted_id IS NULL` AND `existing_account_id != :account_id`

There's an active row for a DIFFERENT account. **Hard conflict** — the recovered Zernio account is orphaned with respect to RepWorth. Do NOT resolve in-place. ROLLBACK and escalate:

```sql
ROLLBACK;
-- Then, separately:
-- (1) Verify with the customer which account they actually intended to connect.
-- (2) Either:
--     (a) The recovered account is the orphan: best-effort delete it on
--         Zernio's side, then resolve the incident with notes:
--           DELETE via: zernioClient.deleteAccount(:account_id)
--           UPDATE zernio_finalize_incidents
--             SET resolved_at=NOW(),
--                 resolution='manual_admin_other',
--                 resolution_notes='recovered account orphaned, deleted via Zernio API; existing active row retained'
--             WHERE business_id=:business_id AND resolved_at IS NULL;
--     (b) The existing row is wrong (rare — would mean the customer reconnected
--         to the wrong account earlier): replace the existing zernio_connections
--         row, delete its account at Zernio, insert the recovered one, resolve.
--         This is judgment-laden and high-risk — coordinate with engineering.
```

This branch is rare. When unsure, prefer option (a) — keeping the existing connection stable is safer than swapping it.

### 6.4 Branch B — no account exists on Zernio's side

Zernio did NOT commit. Our timeout was real — the request never reached completion. Update the incident with no-account outcome:

```sql
UPDATE zernio_finalize_incidents
SET resolved_at = NOW(),
    resolution = 'no_account',
    resolution_notes = 'Zernio confirms no account; owner can retry connect',
    updated_at = NOW()
WHERE business_id = :business_id AND resolved_at IS NULL;
```

Clear the Redis pending marker (same Lua CAS as Branch A). Owner restarts the flow normally.

### 6.5 Branch C — incident is stale (>24h old)

The Redis pending marker expired by TTL on its own. Just resolve the incident with audit notes:

```sql
UPDATE zernio_finalize_incidents
SET resolved_at = NOW(),
    resolution = 'manual_admin_other',
    resolution_notes = 'incident >24h old; pending marker expired by TTL; no further action needed',
    updated_at = NOW()
WHERE id = :incident_id;
```

No Redis action needed (key is gone).

### 6.6 After reconciliation

- Note the resolution in the Sentry alert thread.
- Add a one-line entry to the launch runbook log (this file's §8 below) with date + business_id + branch.
- Do NOT delete the `zernio_finalize_incidents` row. It's the durable audit trail.
- For Sub-case A-1, watch worker logs for `[DrainOwnerConnectWorker] business_id=<...> drained N responses` — confirm the drain ran.

---

## 7. Rollback procedure

### 7.1 Soft rollback (most common, <5 min)

Use this when Zernio is misbehaving but the integration is otherwise healthy — e.g. extended outage, pricing dispute, secret rotation gone wrong.

1. In Railway and Vercel, set `ZERNIO_PUBLISHING_ENABLED=false`.
2. Redeploy worker (Railway) and Next.js (Vercel).
3. Verify:
   - `/dashboard/connect` returns 404.
   - Webhook ingress at `/ingress/zernio` returns 503 `feature_disabled`.
   - `ResponsePublisherWorker` skips the Zernio branch — approved responses transition to `awaiting_manual_post` instead, falling through to the existing manual-post flow.
   - Already-`posted` responses stay posted (no rewind).
4. Existing `zernio_connections` rows remain `'active'`. They are inert when the flag is off — no API calls made.

If you want to force-disconnect every connection (e.g. legal/compliance):

```sql
UPDATE zernio_connections
SET status='disconnected',
    disconnect_reason='manual_admin',
    disconnected_at=NOW(),
    last_error='soft_rollback',
    last_error_at=NOW()
WHERE status IN ('pending','active');
```

This is destructive — owners will see the "Connect Google" banner again next time they visit the dashboard. Only do it if you genuinely want owners to re-consent.

### 7.2 Hard rollback (emergency, <30 min)

Use this when the integration code itself is the problem — a bug we shipped that's corrupting data.

1. Soft-rollback first (§7.1) to stop the bleeding.
2. Revert the integration PR via `git revert <merge-sha>` and force the worker + Vercel redeploy.
3. **Migration 026 stays applied.** It's purely additive — the new `zernio_*` tables become unused but harmless. No data loss. Do NOT reverse the migration; reversing would re-narrow `responses.status` and could fail on existing `awaiting_owner_connect` rows.
4. If `awaiting_owner_connect` responses exist in the wild post-rollback, they're effectively orphaned — admins should manually transition them to `approved` or `awaiting_manual_post`:

   ```sql
   UPDATE responses
   SET status='approved', updated_at=NOW()
   WHERE status='awaiting_owner_connect';
   ```

### 7.3 Rotating the webhook secret

1. Generate a new secret: `openssl rand -hex 32`.
2. Update in Zernio dashboard FIRST (so new webhooks use the new secret).
3. Update `ZERNIO_WEBHOOK_SECRET` in Railway env, redeploy.
4. There will be a brief 401 window between steps 2 and 3 — Zernio retries 7× over 51h, so retries cover this. Don't take more than a few minutes between the two updates.

---

## 8. Reconciliation log

Append one line per `finalize_unknown` reconciliation. Format:

```
- YYYY-MM-DD <name> business=<business_id> branch=<A-1|A-2|A-3|B|C> notes="..."
```

(Empty until the first incident.)

---

## 9. References

- Spec: `docs/superpowers/specs/2026-04-27-zernio-integration-design.md` (sections 5, 6, 8)
- Migration: `supabase/migrations/026_zernio_publishing.sql`
- CLAUDE.md: project-level `.claude/CLAUDE.md` — env-var inventory + status enum + migration index
- Webhook ingress source: `worker/ingress/zernio/zernio.ts` + `worker/ingress/zernio/zernio-verify.ts`
- Connect flow source: `src/app/(authenticated)/dashboard/connect/` + `src/app/api/zernio/connect/`
- Publisher branching source: `worker/jobs/publisher/ResponsePublisherWorker.ts` + `src/lib/publishing/zernio-publisher.ts`
- Drain worker: `worker/jobs/DrainOwnerConnectWorker.ts`
- Owner email worker: `worker/jobs/OwnerEmailWorker.ts`


---

## 10. Past Replies — view-only slice (feat/past-replies-view)

Shipped on branch `feat/past-replies-view` off `feat/zernio-ingestion-replace-serpapi`.
The full edit/regenerate/recovery feature (Zernio DELETE+POST orphan-marker
state machine) is parked on tag `wip/edit-existing-replies-zernio-v1` pending
direct GBP API approval — when GBP arrives, its single-PUT `updateReply`
makes the entire orphan-window machinery unnecessary. This view-only slice
solves the original Tanicia onboarding pain (8 silently-dropped replies)
without baking Zernio's API model into the product core.

**Two independent feature flags** (both default off):

- `EXTERNAL_REPLY_IMPORT_ENABLED` — gates the ingest writes path inside
  `reconcileExternallyAnsweredReview` (the two new branches that import
  previously-unseen / no-active external replies as `posted` responses).
- `PAST_REPLIES_VIEW_ENABLED` — gates the `/dashboard/past-replies` UI tab
  + the OwnerNav link.

Decoupling lets you start ingesting silently first, soak, then expose.

### 10.1 Pre-flight check (run BEFORE applying migration 031)

Migration 031 adds the partial unique index `responses_one_posted_per_review`
on `responses (review_id) WHERE status = 'posted'`. If duplicate `posted`
rows already exist, the CONCURRENTLY index build aborts mid-way and leaves
an INVALID index that requires `DROP INDEX` + retry.

```sql
SELECT review_id, count(*) FROM responses
  WHERE status = 'posted'
  GROUP BY review_id
  HAVING count(*) > 1;
-- expect: 0 rows. If non-empty, BLOCK migration; investigate the
-- duplicates before proceeding.
```

### 10.2 Apply migration 031

The file `supabase/migrations/031_edit_existing_replies.sql` mixes
transactional DDL with `CREATE INDEX CONCURRENTLY` — apply
non-transactionally (uncheck the single-tx box in the Supabase SQL editor).

Post-migration verification:

```sql
SELECT indexname, indisvalid FROM pg_indexes
  JOIN pg_class ON pg_class.relname = indexname
  JOIN pg_index ON pg_index.indexrelid = pg_class.oid
  WHERE indexname IN ('responses_one_posted_per_review',
                      'idx_reviews_business_review_date');
-- expect: indisvalid = true for both.
```

If `indisvalid=false`, CONCURRENTLY was interrupted: `DROP INDEX <name>;`
and re-run.

### 10.3 Phase A — code shipped, both flags OFF

Merge the branch with both `EXTERNAL_REPLY_IMPORT_ENABLED=false` AND
`PAST_REPLIES_VIEW_ENABLED=false`:

- `/dashboard/past-replies` returns 404. OwnerNav link hidden.
- `reconcileExternallyAnsweredReview` falls back to today's silent-no-op behavior.
- Soak ≥ 1 week. Watch for migration-related errors and verify the
  flag-OFF branches in staging.

### 10.4 Phase B1 — turn on import (UI still 404)

Set `EXTERNAL_REPLY_IMPORT_ENABLED=true` in production env (Vercel + Railway):

- Imported replies start getting ingested via every `review.updated` webhook
  + on next reconnect backfill.
- Dashboard "total responded" counts WILL rise for businesses with imported
  replies because imported `posted` rows are in `HANDLED_STATUSES`. Watch
  this in your Sentry / dashboards — you control when this lands by your
  flag-flip timing.
- UI is still 404; owners can't see what's been imported until B2.
- Soak as long as you want — usually 1–7 days is enough to confirm the
  count-shift is the only customer-visible effect.

### 10.5 Phase B2 — turn on view

Set `PAST_REPLIES_VIEW_ENABLED=true` in production env:

- `/dashboard/past-replies` page renders.
- OwnerNav link appears.
- Owners now see their full reply history, including imports.

### 10.6 Backfilling existing customers

Two retroactive paths (both require `EXTERNAL_REPLY_IMPORT_ENABLED=true`):

- **A — Opportunistic:** `ZernioReviewIngestWorker` runs on every
  `review.updated` webhook. With the import flag on, previously-unseen
  reviews that arrive already-replied get ingested. Eventually-consistent
  fill via natural webhook traffic. Zero ops overhead.

- **B — One-time admin script:** `pnpm tsx scripts/zernio-backfill-external-replies.ts <business-id>`
  walks Zernio for that business and ingests anything missing. Useful for
  VIPs who want immediate filling. Idempotent.

A full bulk re-walk on flag-flip is **explicitly NOT done** — it would
burn every business's Zernio quota at once.

### 10.7 Monitoring

| Metric | Threshold | Surface |
|---|---|---|
| `external_reply_ingested_count` distribution per `zernio_backfill_runs` | track | weekly internal review |
| Dashboard "total responded" count delta after Phase B1 | none | watch in product analytics |
| Errors in `reconcileExternallyAnsweredReview` (Sentry breadcrumbs) | any | review weekly |

### 10.8 Rollback

- **PAST_REPLIES_VIEW_ENABLED back to off** — instant. UI dies. Already-ingested rows stay in DB.
- **EXTERNAL_REPLY_IMPORT_ENABLED back to off** — instant. New imports stop. Already-ingested rows stay in DB.
- **Migration 031 rollback** — risky. The column + index are backward compatible (NULL-default, partial). If a genuine bug requires undo, write a forward migration to drop them; do NOT UN the original.

### 10.9 The parked edit feature

`feat/edit-existing-replies` (now tagged `wip/edit-existing-replies-zernio-v1`)
contains the full edit / regenerate / `/retry` / `/restore-original`
machinery and was code-complete + 6 review rounds before being parked.
Reviving it is a deliberate decision:

- **If direct GBP API arrives:** start a NEW branch
  `feat/edit-existing-replies-gbp` and copy the structural patterns from
  the parked tag (route shapes, drawer state machine modulo the recovery
  state, optimistic-concurrency snapshot). Build a GBP-native single-call
  edit publisher; skip the orphan-marker + DELETE+POST locked-tx + 409
  verifier entirely. ~75% of the parked code is reusable; the publisher /
  recovery / orphan-marker layer (~25%) gets dropped.

- **If you decide Zernio edit is worth shipping** (e.g. GBP timeline blows
  up to 18+ months): revive the parked branch as-is, run another review
  round on the residual hidden-draft regenerate-window orphan accepted in
  Round-4 M, file the ops ticket for the fresh-publish race documented in
  spec §4.5 (out-of-scope for that branch), and ship behind the original
  single `EDIT_EXISTING_REPLIES_ENABLED` flag.

