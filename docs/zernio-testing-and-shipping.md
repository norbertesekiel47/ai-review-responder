# Zernio Integration — Local Testing & Production Shipping Guide

This guide walks through (1) verifying the Zernio integration end-to-end on a local machine and (2) shipping it to production.

For the operational reconciliation procedure (how to resolve `finalize_unknown` incidents in production), see `docs/zernio-launch-runbook.md` — that is the runbook oncall should keep at hand. This document is the dev/QA + first-time-deploy guide.

---

## Part 1 — Local Testing

### 1.1 What you can and can't test locally

| Layer | Can test locally? | How |
|---|---|---|
| Type check + unit tests | ✅ Always | `pnpm tsc --noEmit && pnpm test` |
| Worker boot, env asserts | ✅ Always | `pnpm worker` |
| Connect flow (start → callback → select-location) | ✅ With `MOCK_EXTERNAL_APIS=true` | Manual flow described below |
| ResponsePublisher Zernio branch | ✅ With mock | Approve a response in admin → watch worker logs |
| Webhook ingress (`account.disconnected`) | ✅ With curl + HMAC sign | `bash scripts/zernio-fire-webhook.sh` |
| Real Zernio API roundtrips | ❌ Not without sandbox creds | Skip — Phase 1 pilot territory |
| Real OAuth provider redirect | ❌ Not without prod webhook + Zernio account | The mock skips this step |

### 1.2 Prerequisites

You need:

1. **Postgres** — Supabase project (recommended) or local Postgres 15+. **Migration 026 must be applied.**
2. **Redis** — local Docker (`docker run -d -p 6379:6379 redis:7-alpine`) or installed natively.
3. **Node 20 LTS + pnpm**.
4. **Two terminals** (or terminal multiplexer): one for `pnpm dev`, one for `pnpm worker`.

Optional but useful:
- `redis-cli` (`apt install redis-tools` / `brew install redis` / Windows: download from redis.io) — for inspecting connect-state Redis keys
- `psql` or the Supabase MCP — for verifying DB rows
- `jq` — for pretty-printing API responses

### 1.3 Environment variables (`.env.local`)

Add these to your existing `.env.local`. **Mock mode is the default for local dev** — it bypasses real Zernio API calls + LLM calls.

```bash
# Required to enable the integration
ZERNIO_PUBLISHING_ENABLED=true

# Required when the flag is on and MOCK_EXTERNAL_APIS != 'true'.
# In mock mode any non-empty value works (assertion checks presence, not validity).
ZERNIO_API_KEY=mock-key-anything
ZERNIO_WEBHOOK_SECRET=test-secret-32-bytes-minimum-zzz
WORKER_PUBLIC_URL=http://localhost:3001

# Optional — these have defaults. Override only if pointing at a sandbox.
# ZERNIO_API_BASE=https://zernio.com/api
# ZERNIO_PROFILE_ID_PREFIX=repworth-local-

# Bypass real Zernio + LLM. KEEP THIS ON for local dev.
MOCK_EXTERNAL_APIS=true

# Rest of your existing config (DB, Redis, Resend, etc.)
```

### 1.4 Start the stack

```bash
# Terminal 1 — Next.js
cd <worktree-path>
pnpm dev
# → http://localhost:3000

# Terminal 2 — Railway worker
pnpm worker
# → http://localhost:3001 (Fastify ingress + BullMQ workers)
```

**Sanity check the worker boot logs:**

```
[worker] Feature flags: SMS=off, Telegram=on, WhatsApp=off, SelfServeSignup=on, ZernioPublishing=on
{"msg":"Server listening at http://127.0.0.1:3001"}
[OutboxPoller] Starting (interval=30000ms, batch=50)
... (other pollers)
```

If you see `ZernioPublishing=off`, your `ZERNIO_PUBLISHING_ENABLED` isn't reaching the process. If you see `ZERNIO_API_KEY missing` and exit, mock mode isn't on.

### 1.5 Seed test data

If you don't already have a logged-in owner with an active business, do one of:

**Option A — Use the admin onboarding flow** (recommended):
1. Visit `http://localhost:3000/admin/login` and log in as admin.
2. Create a test business via `/admin/businesses/new` — set `subscription_status='active'` directly via SQL after onboarding (Stripe webhook is the normal path; for tests, shortcut it):
   ```sql
   UPDATE businesses SET subscription_status='active' WHERE id='<biz-id>';
   ```
3. Owner will receive an invite email (visible in Resend dashboard or via mock mode logs).

**Option B — Use the self-serve signup flow:**
1. Visit `/signup`, complete the OTP + payment flow.
2. Use Stripe test card `4242 4242 4242 4242`.

Either way, end up with: a logged-in owner session at `/dashboard` for an `active` business with no `zernio_connections` row yet.

### 1.6 Test scenario A — Happy-path connect (mock mode)

This is the primary E2E test. It exercises start → callback → select-location → success.

#### A.1 Starting state assertions

Before clicking anything, verify:

```sql
-- No zernio connection yet
SELECT * FROM zernio_connections WHERE business_id = '<biz-id>';
-- → 0 rows

-- No finalize incidents
SELECT * FROM zernio_finalize_incidents WHERE business_id = '<biz-id>';
-- → 0 rows
```

```bash
redis-cli get "connect_pending:<biz-id>"
# → (nil)
```

#### A.2 Visit /dashboard

Should show the **`ConnectGoogleBanner` (blue)** with a "Connect" CTA — because `zernioConnection.status === 'none'`.

#### A.3 Click "Connect"

The button POSTs to `/api/zernio/connect/start`.

```bash
# (Equivalent curl, if you want to test the API directly with a session cookie copied from devtools:)
curl -X POST http://localhost:3000/api/zernio/connect/start \
  -H "Origin: http://localhost:3000" \
  -H "Content-Type: application/json" \
  -H "Cookie: <your-supabase-session-cookies>"
```

Expected response: `200 { "authUrl": "http://localhost:3000/__mock_oauth_complete" }`

The browser then navigates to `authUrl`. Since there's no `__mock_oauth_complete` page in the codebase, you'll get a 404. **That's expected** — in real flows Zernio would redirect you back to `/api/zernio/connect/callback?state=...&connect_token=...`.

#### A.4 Inspect Redis state

After /start succeeds, two Redis keys exist:

```bash
# Pending marker
redis-cli get "connect_pending:<biz-id>"
# → '{"flowId":"...","userId":"...","started_at":...,"status":"oauth_in_progress","profileId":"mock-profile-...","state":"<32-hex-state>"}'

# State blob (keyed by the state value)
redis-cli get "connect_state:<state-value>"
# → '{"businessId":"...","profileId":"mock-profile-...","userId":"...","createdAt":...}'

# Lock should be released (auto-expires in 30s anyway)
redis-cli get "connect_lock:<biz-id>"
# → (nil)  — released after /start succeeds
```

Copy the `state` value from the pending marker.

#### A.5 Simulate the callback

In a real flow, Zernio would redirect the browser to `/api/zernio/connect/callback?state=<state>&connect_token=<token>`. Simulate this:

```bash
# Use the state you copied. The connect_token can be anything in mock mode.
curl -i "http://localhost:3000/api/zernio/connect/callback?state=<state-value>&connect_token=mock-connect-token" \
  -c /tmp/zernio-cookies.txt
```

Expected: `302 Found`, `Location: /dashboard/connect/select-location`, `Set-Cookie: zernio_connect_session=<sessionId>.<hmac>; HttpOnly; ...`

The cookie is saved to `/tmp/zernio-cookies.txt`.

Verify side effects:

```bash
# State key was atomically claimed (GETDEL) → should now be gone
redis-cli get "connect_state:<state-value>"
# → (nil)

# A connect_locations key was written
redis-cli keys "connect_locations:*"
# → 1 key

redis-cli get "connect_locations:<sessionId>"
# → JSON blob with {"flowId","state","connect_token","profileId","businessId","userId","locations":[{"id":"mock-loc-1","name":"Mock Location","address":"123 Mock St"}]}
```

#### A.6 Visit the select-location page (browser)

Easier in the browser — visit `http://localhost:3000/dashboard/connect/select-location`. The page reads the `zernio_connect_session` cookie, fetches locations from Redis, and renders a radio-button form.

If you used curl + cookie file you can render it from CLI too:

```bash
curl -b /tmp/zernio-cookies.txt http://localhost:3000/dashboard/connect/select-location
# → Server-rendered HTML with the location list
```

Pick the mock location and submit. The form POSTs to `/api/zernio/connect/select-location`:

```bash
curl -i -X POST http://localhost:3000/api/zernio/connect/select-location \
  -H "Origin: http://localhost:3000" \
  -H "Content-Type: application/json" \
  -b /tmp/zernio-cookies.txt \
  -d '{"locationId":"mock-loc-1"}'
```

Expected: `200 { "ok": true }` + `Set-Cookie: zernio_connect_session=; Max-Age=0` (cookie cleared).

#### A.7 Verify the success state

```sql
-- A zernio_connections row exists, status=active
SELECT id, business_id, status, zernio_account_id, zernio_location_id, connected_at
FROM zernio_connections
WHERE business_id = '<biz-id>';
-- → 1 row, status='active', connected_at=NOW()

-- A drain_pending_owner_connect outbox row was enqueued
SELECT id, topic, status, payload
FROM job_outbox
WHERE topic = 'drain_pending_owner_connect' AND aggregate_id = '<biz-id>'
ORDER BY created_at DESC LIMIT 1;
-- → 1 row, will be picked up by OutboxPoller within 30s
```

```bash
# Pending marker should be gone
redis-cli get "connect_pending:<biz-id>"
# → (nil)

# Locations blob should be gone
redis-cli keys "connect_locations:*"
# → empty
```

Visit `/dashboard` again — `ConnectGoogleBanner` should now return `null` (because `zernioConnection.status === 'active'`).

### 1.7 Test scenario B — Cancel mid-flow

After A.5 (callback completed) but BEFORE A.6 (location selected), the owner can cancel:

```bash
curl -X POST http://localhost:3000/api/zernio/connect/cancel \
  -H "Origin: http://localhost:3000" \
  -H "Cookie: <your-session>"
```

Expected: `200 { "cancelled": true, "reason": "flow_cancelled" }`

Verify:
- `connect_pending:<biz-id>` is gone
- `connect_state:<state>` is gone (already cleared by callback's GETDEL)
- No `zernio_connections` row was created
- The user is back to "Connect" banner state

If the user tries to cancel during `finalizing` (between Lua CAS to finalizing and Zernio's response):
- Returns `409 finalize_in_progress` — owner waits.

If during `finalize_unknown`:
- Returns `409 finalize_unknown_admin_required` — admin must resolve via the runbook.

### 1.8 Test scenario C — Disconnect

After completing A (active connection):

```bash
# Owner disconnect (no body needed for owner role)
curl -X POST http://localhost:3000/api/zernio/disconnect \
  -H "Origin: http://localhost:3000" \
  -H "Cookie: <owner-session>"
```

Expected: `200 { "ok": true }`. DB row updated to `status='disconnected'`, `disconnect_reason='manual_owner'`, `disconnected_at=NOW()`.

Admin disconnect (with `businessId` in body):

```bash
curl -X POST http://localhost:3000/api/zernio/disconnect \
  -H "Origin: http://localhost:3000" \
  -H "Cookie: <admin-session>" \
  -H "Content-Type: application/json" \
  -d '{"businessId":"<biz-id>"}'
```

→ same outcome but `disconnect_reason='manual_admin'`.

`/dashboard` banner switches to **orange "Reconnect"** state.

### 1.9 Test scenario D — Full publishing pipeline

This is the highest-confidence test: a review goes from SerpAPI ingestion → response generation → owner approval → Zernio post.

**Setup:** start with an active Zernio connection (from scenario A).

1. Trigger a review sync (or seed a review directly):
   ```sql
   INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name,
     provider_location_name, reviewer_name, review_text, star_rating, review_date,
     review_content_hash, language)
   VALUES (
     gen_random_uuid(), '<biz-id>', 'serpapi_poll', 'mock-rev-1',
     'serpapi://mock/reviews/mock-rev-1', 'serpapi://mock',
     'Test Reviewer', 'Great service!', 5, NOW(),
     'mock-hash', 'en'
   );
   ```
2. Enqueue a generate_response outbox row, OR just generate via the admin UI.
3. After generation, response status is `pending_approval`.
4. Owner approves via the approval link (or admin UI).
5. ResponsePublisherWorker picks up the publish_response outbox row.
6. **Watch worker logs** — you should see:
   ```
   [ResponsePublisherWorker] response <id> business <biz-id> attempt 1
   [ResponsePublisherWorker] mock-mode listAllReviews returned 0 reviews → ZernioReviewNotFoundError
   ```
   In mock mode, `listAllReviews` returns an empty array, so `lookupZernioReviewId` throws `ZernioReviewNotFoundError`. This routes to the **review-not-found branch**: response → `failed`, review_exception inserted.

To exercise the **success branch** in mock mode, you need to monkey-patch the mock to return a matching review. Two options:

- **Option 1 (recommended for QA):** temporarily edit `src/lib/zernio/client.ts` `mockResponse` for `list_reviews` to return a single review whose fields match what `lookupZernioReviewId` expects:
  ```typescript
  case 'list_reviews':
    return { reviews: [{
      id: 'zernio-mock-rev-1',
      reviewer: { displayName: 'Test Reviewer', isAnonymous: false, profilePhotoUrl: null },
      rating: 5,
      starRating: 'FIVE',
      comment: 'Great service!',
      createTime: new Date().toISOString(),
      updateTime: new Date().toISOString(),
      reviewReply: null,
    }], nextPageToken: undefined } as unknown as T;
  ```
  Re-run worker. Now the publisher matches the review, calls `mockResponse('publish_reply')` which returns `{comment: 'mock reply', updateTime: ...}`, and updates `responses.status='posted'`.

- **Option 2:** write a vitest integration test that stubs Zernio responses inline. Faster iteration, no temp file edits. Examples in `worker/__tests__/ResponsePublisherWorker.test.ts`.

### 1.10 Test scenario E — Webhook ingress (`account.disconnected`)

This tests the Railway worker's ability to handle Zernio's webhook for revoked accounts.

Use this helper bash script (save as `scripts/zernio-fire-webhook.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail
SECRET="${ZERNIO_WEBHOOK_SECRET:-test-secret-32-bytes-minimum-zzz}"
ACCOUNT_ID="${1:-mock-account-1}"
EVENT_ID="evt-$(date +%s)-$RANDOM"

BODY='{"id":"'"$EVENT_ID"'","event":"account.disconnected","accountId":"'"$ACCOUNT_ID"'","reason":"user_revoked"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

curl -i -X POST http://localhost:3001/ingress/zernio \
  -H "Content-Type: application/json" \
  -H "x-zernio-signature: $SIG" \
  -H "x-zernio-event-id: $EVENT_ID" \
  -d "$BODY"
```

Run:

```bash
chmod +x scripts/zernio-fire-webhook.sh
./scripts/zernio-fire-webhook.sh <account-id-from-zernio_connections>
```

Expected: `200 { "ok": true }` (or `200 { duplicate: true }` on retry).

Verify side effects:

```sql
-- The connection should be flipped to disconnected
SELECT status, disconnect_reason, last_error, last_error_at
FROM zernio_connections
WHERE zernio_account_id = '<account-id>';
-- → status='disconnected', disconnect_reason='webhook_event'

-- A notify_owner_connection_lost outbox row was enqueued
SELECT topic, status, payload FROM job_outbox
WHERE topic = 'notify_owner_connection_lost' AND aggregate_id = '<biz-id>'
ORDER BY created_at DESC LIMIT 1;
-- → 1 row

-- inbound_events row marked processed
SELECT provider, event_id, status FROM inbound_events
WHERE event_id = '<evt-id>';
-- → status='processed'
```

Test the **invalid signature** path:

```bash
curl -i -X POST http://localhost:3001/ingress/zernio \
  -H "Content-Type: application/json" \
  -H "x-zernio-signature: 0000000000000000000000000000000000000000000000000000000000000000" \
  -H "x-zernio-event-id: evt-bad" \
  -d '{"event":"webhook.test"}'
# → 401 invalid_signature
```

Test the **flag-off** path:

```bash
# Restart worker with ZERNIO_PUBLISHING_ENABLED=false
curl -i -X POST http://localhost:3001/ingress/zernio -d '{}'
# → 503 feature_disabled
```

### 1.11 Test scenario F — finalize_unknown

This is the trickiest path. To trigger it locally, you need to make `zernioClient.selectLocation` throw a `ZernioTransientError`. Easiest is to temporarily edit `mockResponse` for `select_location`:

```typescript
case 'select_location':
  throw new (await import('./errors')).ZernioTransientError('http_500', { mocked: true });
```

Then run scenario A through step A.6 (submit location). The select-location route catches the transient error, takes the **outcome-unknown branch**:

1. Lua CAS pending marker `finalizing → finalize_unknown` (with `finalize_unknown_at`)
2. INSERT into `zernio_finalize_incidents` (the partial unique index ensures idempotency)
3. Sentry alert (you'll see this in the dev console)
4. `409 finalize_unknown_admin_required` returned to the form

Verify:

```sql
SELECT id, business_id, finalize_unknown_at, resolved_at
FROM zernio_finalize_incidents
WHERE business_id = '<biz-id>';
-- → 1 row, resolved_at IS NULL
```

```bash
redis-cli get "connect_pending:<biz-id>"
# → marker with status=finalize_unknown
```

`/dashboard` banner switches to **yellow "manual review"** state.
`/dashboard/connect` shows the "Connection requires manual review" panel; no buttons.

To resolve, follow `docs/zernio-launch-runbook.md` § 6 (the reconciliation procedure).

### 1.12 Useful inspection queries

```sql
-- Snapshot of all Zernio state for a business
SELECT
  (SELECT row_to_json(c) FROM (SELECT * FROM zernio_connections WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1) c) AS connection,
  (SELECT json_agg(row_to_json(i)) FROM zernio_finalize_incidents i WHERE business_id = $1 AND resolved_at IS NULL) AS unresolved_incidents,
  (SELECT COUNT(*) FROM responses WHERE business_id = $1 AND status = 'awaiting_owner_connect') AS pending_responses;
```

```bash
# All Zernio Redis keys for a business
redis-cli --scan --pattern "connect_*" | grep <biz-id>
redis-cli --scan --pattern "zernio_*"
```

### 1.13 Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm worker` exits with `Missing required env vars: ZERNIO_API_KEY` | Flag on, mock off, no key set | Set `MOCK_EXTERNAL_APIS=true` OR provide a dummy `ZERNIO_API_KEY` |
| `/api/zernio/connect/start` returns 503 | `ZERNIO_PUBLISHING_ENABLED` unset / false | Set to `true` and restart `pnpm dev` |
| `/api/zernio/connect/start` returns 429 `connect_in_progress` | A previous flow left a Redis lock (auto-expires in 30s) | Wait 30s OR `redis-cli del "connect_lock:<biz-id>"` |
| Callback redirects to `/dashboard/connect?error=state_expired` | The state key TTL (15min) elapsed OR was already claimed | Restart from `/start` |
| Banner doesn't update after a state change | React Query cache | Refresh page; or invalidate `dashboardData` cache |
| Worker logs `ECONNREFUSED 127.0.0.1:6379` | Local Redis isn't running | `docker run -d -p 6379:6379 redis:7-alpine` |
| Tests hang on `pnpm test` | Vitest workers can't reach Redis/Postgres | Make sure dependencies are up; some tests use real DB via `TEST_DATABASE_POOL_URL` |
| `pnpm lint` errors with "Plugin @next/next was conflicted" | Running ESLint inside a worktree under the parent repo | Lint from the parent worktree path or ignore — `pnpm tsc` and `pnpm test` are the binding gates |

### 1.14 Test checklist before merging

Run this list end-to-end before opening a PR:

- [ ] `pnpm tsc --noEmit` — clean
- [ ] `pnpm test` — all green
- [ ] `pnpm worker` boots with `ZernioPublishing=on` (mock mode)
- [ ] Scenario A (happy-path connect) — completes, `zernio_connections` row exists, banner gone
- [ ] Scenario B (cancel) — 200 cancelled, no DB row created
- [ ] Scenario C (disconnect) — DB row flipped, banner shows reconnect
- [ ] Scenario D (publishing pipeline) — review-not-found path observed in worker logs
- [ ] Scenario E (webhook account.disconnected) — DB flipped + outbox row enqueued
- [ ] Scenario F (finalize_unknown) — incident row created, banner shows yellow
- [ ] Manually toggle `ZERNIO_PUBLISHING_ENABLED=false` and verify all 5 routes return 503

---

## Part 2 — Production Shipping

### 2.1 Pre-flight checklist

Before merging the PR or flipping the flag in prod, complete every item.

#### Zernio account setup

- [ ] Sign up at https://zernio.com and verify the account
- [ ] Subscribe to **Accelerate plan**
- [ ] Add the **Inbox add-on** (required for `gmb-reviews` API access)
- [ ] In the Zernio dashboard, navigate to API settings:
  - [ ] Generate `ZERNIO_API_KEY` — copy to a password manager
  - [ ] Generate `ZERNIO_WEBHOOK_SECRET` — copy to a password manager
- [ ] Configure the webhook in the Zernio dashboard:
  - URL: `https://<WORKER_PUBLIC_URL>/ingress/zernio` (e.g. `https://repworth-worker.up.railway.app/ingress/zernio`)
  - Subscribed events:
    - [x] `account.disconnected` (required — graceful degradation)
    - [x] `webhook.test` (required — for verification)
    - [ ] `account.connected` (optional — defensive log only)
    - [ ] `review.new` (optional — Phase 3 readiness; just increments a counter)
    - [ ] `review.updated` (optional — same)
- [ ] Click **"Send test webhook"** in the Zernio dashboard
  - It will fire `webhook.test` to your endpoint. Once your code is deployed (next steps), you should see `200 OK` in the Zernio webhook log.

#### Production env vars

In your Railway project (worker) AND your Vercel project (Next.js), add:

| Var | Where | Value |
|---|---|---|
| `ZERNIO_PUBLISHING_ENABLED` | Both | `false` initially — flip to `true` AFTER smoke tests |
| `ZERNIO_API_KEY` | Both | from Zernio dashboard |
| `ZERNIO_WEBHOOK_SECRET` | Worker only | from Zernio dashboard |
| `WORKER_PUBLIC_URL` | Worker | the public Railway URL of the worker (e.g. `https://repworth-worker.up.railway.app`) — must match the URL configured in Zernio dashboard exactly |
| `ZERNIO_PROFILE_ID_PREFIX` | Both (optional) | default `repworth-prod-`; override if you want stricter isolation |

> **Important**: `MOCK_EXTERNAL_APIS` must NOT be set in prod (or set to anything other than `true`). The worker startup assertion only bypasses Zernio env-var requirements when this flag is on.

#### Migration

- [ ] Run `supabase/migrations/026_zernio_publishing.sql` in the **production** Supabase SQL editor.
- [ ] Verify with:
  ```sql
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN ('zernio_connections', 'zernio_finalize_incidents');
  -- Expect 2 rows.
  ```
- [ ] Verify the `responses` widening took:
  ```sql
  SELECT data_type, character_maximum_length FROM information_schema.columns
  WHERE table_name = 'responses' AND column_name = 'status';
  -- Expect: data_type='text', character_maximum_length=NULL
  ```

> **Lock note:** the `ALTER TABLE responses ALTER COLUMN status TYPE TEXT` takes a brief `ACCESS EXCLUSIVE` lock on the `responses` table. Run during a low-traffic window. Typical duration: <1s on RepWorth-sized data.

### 2.2 Pre-deploy in staging (if available)

If you have a staging Railway + Vercel + Supabase project:

1. Run migration 026 on staging DB.
2. Set staging env vars with `ZERNIO_PUBLISHING_ENABLED=true` and a sandbox Zernio account if Zernio offers one (otherwise use the prod Zernio account in dry-run mode).
3. Deploy.
4. Walk through the same 6 local test scenarios on staging.
5. Verify Sentry receives errors as expected (trigger `finalize_unknown` deliberately and confirm the alert).

If you don't have staging, the fallback is: deploy with the flag OFF first, smoke-test, then flip.

### 2.3 Deploy

```bash
# From the local feature branch (after tests + code review pass)
git checkout main
git pull
git merge --no-ff feat/zernio-integration
git push origin main
```

Or merge the PR via GitHub UI.

Vercel and Railway will auto-deploy on push. Watch the deploy logs:

- **Vercel**: confirm the new routes appear in the build output (`/api/zernio/connect/start`, `/dashboard/connect`, etc.)
- **Railway worker**: watch boot logs for:
  ```
  [worker] Feature flags: ..., ZernioPublishing=off
  ```
  (The flag is OFF so the assertion is skipped — that's expected for the first deploy.)

### 2.4 Smoke-test prod with flag OFF

The flag-gates ensure the integration is dormant. Verify:

- [ ] `curl -i https://<app-url>/api/zernio/connect/start` → `503 feature_disabled`
- [ ] `curl -i https://<worker-url>/ingress/zernio -X POST -d '{}'` → `503 feature_disabled`
- [ ] `/dashboard` for any owner: ConnectGoogleBanner is **NOT** shown (because `zernioConnection.status === 'none'` and the page only renders the banner when status is non-active... wait, the banner shows for `'none'` too — it shows a "Connect" CTA. **This is the user-facing change of merging this branch even with the flag off.** If you want to keep the banner hidden until flag-on, conditionally hide it in `DashboardContent.tsx` based on a `NEXT_PUBLIC_ZERNIO_PUBLISHING_ENABLED` flag, or accept that owners will see "Connect Google Business" CTAs that 503 when clicked.)

> **Decision point**: do you want owners to see the "Connect" banner before the integration is live? The current code shows the banner as soon as the migration is applied (because `zernioConnection.status` defaults to `'none'`). If you prefer to hide it, add a `NEXT_PUBLIC_ZERNIO_PUBLISHING_ENABLED` flag and gate the banner render in `DashboardContent.tsx`. This is a small follow-up commit.

### 2.5 Flip the flag

Once you're satisfied with the deploy:

1. In **Railway worker** project settings → set `ZERNIO_PUBLISHING_ENABLED=true` → trigger redeploy.
2. Watch boot logs:
   ```
   [worker] Feature flags: ..., ZernioPublishing=on
   ```
   The startup assertion will now fail-fast if `ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET`, `WORKER_PUBLIC_URL`, or `NEXT_PUBLIC_APP_URL` are missing.
3. In **Vercel** project settings → set `ZERNIO_PUBLISHING_ENABLED=true` → trigger redeploy.
4. Verify:
   - [ ] `curl -i https://<app-url>/api/zernio/connect/start` → `401 unauthorized` (instead of 503 — meaning the route is alive and now demands a session cookie)
   - [ ] In the Zernio dashboard, click **"Resend test webhook"** → check Railway logs for `200` on `/ingress/zernio`. The body should match `{ "event": "webhook.test" }` and `inbound_events` will get a row.

### 2.6 Phase 1 pilot — first customer

Pick one cooperative customer for a 1–2 week pilot. **Do not roll out broadly until pilot succeeds.**

#### Day 0 — onboarding

1. Customer logs into `/dashboard`.
2. Customer sees the **blue "Connect Google Business"** banner.
3. Customer clicks **"Connect"** → redirected to Zernio's OAuth provider → grants Google Business Profile access → redirected back to `/dashboard/connect/select-location`.
4. Customer picks their location → submits → redirected to `/dashboard`.
5. **You verify** in the admin panel:
   - `/admin/businesses/<id>` shows a **Zernio Connection** panel with `status='active'`, recent `connected_at`.
   - `zernio_connections` DB row exists with valid `zernio_account_id` and `zernio_location_id`.

#### Days 1–14 — monitoring

Daily checks:

- [ ] **Admin overview** — confirm the new "Reconnect" column shows `0` for the pilot customer (no responses stuck in `awaiting_owner_connect`).
- [ ] **Sentry** — filter for `Zernio*` errors. Triage anything that appears.
- [ ] **`/admin/businesses/<id>`** — Zernio panel shows no `last_error`, no unresolved finalize incidents.
- [ ] **DB query** — count posted responses via Zernio:
  ```sql
  SELECT COUNT(*) FROM responses
  WHERE business_id = '<pilot-biz>' AND status = 'posted'
    AND posted_at > NOW() - INTERVAL '24 hours';
  ```
  Compare against `reviews` ingested in the same window.

Weekly checks:

- [ ] Customer satisfaction — does the customer report any issues?
- [ ] Cost — Zernio's billing dashboard. Verify it tracks roughly with response volume.
- [ ] Webhook health — Zernio's dashboard usually has a webhook delivery log; check for any failed deliveries.

If anything looks off:

- [ ] Soft rollback: set `ZERNIO_PUBLISHING_ENABLED=false`. The integration goes dormant. Existing posted responses stay; new responses still flow but go to the legacy path (or `awaiting_owner_connect` if you don't want any backsliding — verify the no-connection branch behavior).

### 2.7 Common production issues + first response

| Symptom | First-response action |
|---|---|
| Sentry: spike in `ZernioTransientError` | Check Zernio's status page. If their API is degraded, responses will queue and retry; no urgent action. If their API is fine, check Railway worker network. |
| Sentry: `ZernioReviewNotFoundError` for many reviews | Likely Zernio's review listing is stale. Check the cache TTL on `zernio_review_map:*` Redis keys — if hits, invalidate; if misses, the review may have been edited or deleted on Google's side. Convert to admin exception manually. |
| Webhook returns 401 invalid_signature | Verify `ZERNIO_WEBHOOK_SECRET` env var matches what's in the Zernio dashboard exactly. Common cause: trailing whitespace or quoting issues. |
| `zernio_finalize_incidents` row appears | **Run the reconciliation procedure** in `docs/zernio-launch-runbook.md` § 6. This blocks new connect attempts for the affected business until resolved. |
| Customer reports "I clicked Connect but nothing happened" | Check browser console for JS errors. Most likely: pop-up blocker on `window.location.href` redirect, or session expired between dashboard load and click. |
| Worker fails to boot after env var change | Most likely `assertZernioPublishingEnv()` caught a missing var. Read the boot logs — error message names the missing var explicitly. |

### 2.8 Rollout to all customers

After 2 weeks of clean pilot:

1. No code changes needed — the integration is already live for everyone (the flag is global, not per-business).
2. Send a notification email to all customers: "Your Google Business posting just got faster — connect once and we'll handle the rest." Link to `/dashboard/connect`.
3. Monitor the admin overview "Reconnect" column for the next 2 weeks. A spike in `awaiting_owner_connect` may indicate a Zernio outage or a customer-side OAuth issue.

### 2.9 Rollback procedures

#### Soft rollback (most common — flag flip)

```
Set ZERNIO_PUBLISHING_ENABLED=false in Railway and Vercel → redeploy.
```

Effects:
- All `/api/zernio/*` routes return `503 feature_disabled`
- `/ingress/zernio` returns `503` (Zernio will retry but eventually mark the webhook unhealthy — clean it up by removing the webhook subscription in Zernio's dashboard if rolling back permanently)
- Worker startup assertion still requires the env vars to be present, but doesn't run the gated logic
- Existing `zernio_connections` rows stay `'active'` but no new posts attempt to flow through Zernio
- ResponsePublisher's connection lookup will still find active rows, but if you also unset env vars the actual API calls will fail. Cleanest fallback: set the flag to false AND `UPDATE zernio_connections SET status='disconnected', disconnect_reason='manual_admin' WHERE status='active';` to force responses into the no-connection branch (which transitions to `awaiting_owner_connect`).

#### Hard rollback (revert code)

```bash
# Revert the merge commit
git revert -m 1 <merge-sha>
git push
```

Effects:
- Code paths gone, all routes 404
- Migration 026 stays applied (the new tables become unused but harmless — no data loss)
- Existing `zernio_connections` and `zernio_finalize_incidents` rows persist as historical record
- Workers auto-restart with the reverted code

After hard rollback you can drop the unused tables with another migration if you want, but it's safe to leave them.

#### Webhook secret rotation

If `ZERNIO_WEBHOOK_SECRET` is exposed:

1. In Zernio dashboard → regenerate the webhook secret. Note the new value.
2. **Within the rotation grace period** (Zernio docs say what this is — typically 5–10 minutes during which both old and new secrets are valid):
   - Update Railway env var
   - Trigger redeploy (or restart worker)
3. Verify with a test webhook from Zernio's dashboard that signature verification still passes.

### 2.10 What's next after rollout

Per `docs/Implementation_Phases_SerpAPI_First.md` § 5 and the spec § 6.4 — Phase 3 unlocks:

- Switch review ingestion source from SerpAPI to Zernio (`review.new` / `review.updated` webhooks already wired as a counter; promote them to outbox events)
- Decommission SerpAPI polling for businesses with active Zernio connections
- Adjust the cost dashboard accordingly

This is a separate sprint and is NOT part of the Phase 0 scope.

---

## Appendix — Quick reference

### Endpoints

| Route | Method | Purpose |
|---|---|---|
| `/api/zernio/connect/start` | POST | Owner initiates connect; returns `authUrl` |
| `/api/zernio/connect/callback` | GET | Zernio redirect target after OAuth; sets cookie |
| `/api/zernio/connect/select-location` | POST | Owner picks location; finalizes connection |
| `/api/zernio/connect/cancel` | POST | Owner cancels in-flight flow |
| `/api/zernio/disconnect` | POST | Owner or admin disconnects an active connection |
| `<worker>/ingress/zernio` | POST | Webhook ingress (HMAC-verified) |

### Redis keys

| Key | TTL | Purpose |
|---|---|---|
| `connect_pending:{businessId}` | 900s | Pending marker for in-flight connect flow |
| `connect_state:{state}` | 900s | OAuth state blob (consumed atomically by callback) |
| `connect_locations:{sessionId}` | 900s | Location list returned by Zernio post-callback |
| `connect_lock:{businessId}` | 30s | Two-layer concurrency lock for `/start` |
| `connect_finalize:{sessionId}` | 60s | Finalize lock for `/select-location` |
| `zernio_review_map:{businessId}:{ourReviewId}` | 86400s | Cache of our-review-id → Zernio-review-id |
| `zernio_event_seen:{event}:{date}` | (no TTL) | Phase 3 readiness counter |

### Tables

| Table | Purpose |
|---|---|
| `zernio_connections` | Per-business connection state (active/pending/disconnected) |
| `zernio_finalize_incidents` | Durable record of unknown-outcome selectLocation calls |

### Status enum (`responses.status`)

```
'pending_approval' | 'approved' | 'edited' | 'superseded'
| 'awaiting_manual_post' | 'awaiting_owner_connect' | 'posted' | 'failed'
```

`awaiting_owner_connect` is the new state added by this integration. `DrainOwnerConnectWorker` re-enqueues responses in this state when a connection is restored.
