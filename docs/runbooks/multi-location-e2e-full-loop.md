# Multi-Location E2E Full-Loop Sign-Off

**Status:** Manual · local · **NOT CI** · launch-gating sign-off
**Owner:** whoever runs the multi-location launch checklist
**Last run:** _TODO — first run pending (see Sign-Off Record below)_

This runbook exercises the **entire** RepWorth pipeline — Zernio webhook ingest →
AI draft → moderation → owner notification/approval → publish reply to Zernio —
end-to-end, for **two locations on one account**, with **no real Google Business
Profile**. It uses the in-repo fake Zernio fixture server (`e2e/fixtures/zernio-fixture-server.ts`),
the two-location seeder (`e2e/seed.ts`), and the signed-webhook script
(`scripts/zernio-fire-webhook.sh`) built in PR F.

It is the launch gate for the multi-location feature: until one clean two-location
loop is recorded below, the feature is not signed off.

---

## 1. Purpose & scope

`MOCK_EXTERNAL_APIS=true` cannot run the real loop — the ingest worker
short-circuits in mock mode. So this procedure runs with `MOCK_EXTERNAL_APIS=false`
and points the worker's Zernio client at the local fixture server
(`ZERNIO_API_BASE=<fixture url>`), which speaks the real Zernio HTTP contract over
an in-memory store. Every other dependency (Postgres, Redis, LLM, Stripe) is real
but in **test/sandbox** mode.

### What this proves
- **Per-location ingest routing** — each review's resource name
  (`accounts/{a}/locations/{loc}/reviews/{r}`) is parsed for its `{loc}` segment
  and the ingest worker **fails closed** unless it matches the seeded
  `zernio_location_id`. A two-location run proves reviews land on the correct
  location and never cross-route.
- **Two-location draft generation** — a draft is generated for a review on each
  location independently.
- **Approval → publish** — an approved draft drives a `publish_response` job whose
  Zernio `publish_reply` call is recorded by the fixture for **both** locations.

### What this does NOT prove (still "one careful first post in production")
- Real Google reply **propagation** (the reply actually appearing on the Google
  listing).
- The OAuth **consent / location-picker** flow against real Google.
- Real Google **error shapes** (quota, permission, transient 5xx) — the fixture
  returns success.

Those remain covered only by the discipline of one carefully-watched first
production post per newly-connected location.

---

## 2. Prerequisites — environment

The worker boots with `MOCK_EXTERNAL_APIS=false`, so `worker/config/startup-assert.ts`
requires the **full** credential set below. Use **test/sandbox** keys everywhere.

> Do NOT set `NODE_ENV=production` — `assertProductionMockModeEnv` and the live
> Stripe/Resend paths assume sandbox. Run with `NODE_ENV=development` (or unset).

### Local infrastructure
- **Postgres** — the dev/test database with ALL migrations applied, through the
  current head per `.claude/reference/migrations-log.md` (the log is the single
  owner of that number — do not trust a stale copy here).
- **Redis** — both the BullMQ **queue** (Railway-Redis-equivalent locally) and the
  **cache** (Upstash-equivalent locally). The worker needs the queue; rate-limit /
  cost-reserve needs the cache.

### Required env vars (worker)
| Var | Why | Value for this run |
|---|---|---|
| `MOCK_EXTERNAL_APIS` | turns the real ingest loop on | `false` |
| `ZERNIO_API_BASE` | points the Zernio client at the fixture server | the fixture `url` from step 4a, e.g. `http://127.0.0.1:<port>` |
| `ZERNIO_PUBLISHING_ENABLED` | enables the publish path (and its env assertions) | `true` |
| `ZERNIO_API_KEY` | required by `assertZernioPublishingEnv` (the fixture ignores the value) | any non-empty placeholder |
| `ZERNIO_WEBHOOK_SECRET` | HMAC secret the webhook script signs with and the ingress verifies | a ≥32-byte test secret (must match the script's `ZERNIO_WEBHOOK_SECRET`) |
| `WORKER_PUBLIC_URL` | required by `assertZernioPublishingEnv` | `http://127.0.0.1:3001` |
| `NEXT_PUBLIC_APP_URL` | required by `assertZernioPublishingEnv`; used in approval links | `http://localhost:3000` |
| `STRIPE_SECRET_KEY` | `assertStripeWorkerEnv` (fires with mocks off) | your Stripe **TEST** secret key |
| `STRIPE_WEBHOOK_SECRET` | `assertStripeWorkerEnv` | a Stripe test webhook secret |
| `STRIPE_PRICE_BASIC` | `assertStripeWorkerEnv` | a Stripe **test** price id |
| `STRIPE_PRICE_FOUNDING` | `assertStripeWorkerEnv` | a Stripe **test** price id |
| `STRIPE_PRICE_STANDARD` | `assertStripeWorkerEnv` | a Stripe **test** price id |
| `STRIPE_PRICE_PREMIUM` | `assertStripeWorkerEnv` | a Stripe **test** price id |
| `STRIPE_PRICE_STANDARD_OVERAGE` | `assertStripeWorkerEnv` | a Stripe **test** price id |
| `STRIPE_PRICE_PREMIUM_OVERAGE` | `assertStripeWorkerEnv` | a Stripe **test** price id |
| `STRIPE_PRICE_FOUNDERS_OVERAGE` | `assertStripeWorkerEnv` | a Stripe **test** price id |
| `OPENAI_API_KEY` | real draft generation (primary model `gpt-4o-mini-2024-07-18`) | a real key |
| `ANTHROPIC_API_KEY` | fallback model | a real key (optional if you accept no fallback) |
| `GLOBAL_DAILY_COST_LIMIT_CENTS` | platform cost circuit-breaker — keep it **low** | a few cents (e.g. `25`) — two `gpt-4o-mini` drafts cost a fraction of a cent |
| `DATABASE_POOL_URL` / `DATABASE_URL` | Postgres | your local dev DB URL |
| `ALLOW_E2E_DB_WRITES` | lets the seeder write outside `NODE_ENV=test` | `true` |

### Notification strategy (pick one)
The loop reaches `send_notification` after a draft is generated. Either:
- **(a) Resend test key** — set `RESEND_API_KEY` to a test key and let the
  notification send (to a test inbox), then click the approval link; **or**
- **(b) Approve via the dashboard / approval link directly** and accept that the
  `send_notification` outbox rows **fail** (expected — no real channel). The draft
  is still approvable from the dashboard or from a manually-constructed approval
  link. Treat failed `send_notification` rows as expected noise for this run.

---

## 3. Reviewer note — do not run in CI

This is a manual procedure. It spends real (tiny) LLM money and needs sandbox
Stripe/Zernio creds, so it never runs in CI. The CI lane covers the kit's
*contract* (the fixture review-name format, the mock-transport location count, the
seeder DB contract) via the vitest suite; only the live two-location loop is manual.

> **Coverage honesty:** the authenticated scenarios in `e2e/multi-location.spec.ts`
> are `test.fixme` until the session-cookie harness lands — a green
> `pnpm test:e2e` does NOT verify authenticated multi-location behavior. THIS
> runbook's recorded run is the launch-gating verification.

---

## 4. Procedure

All commands run from the repo root. Keep FOUR terminals: **A** (fixture server),
**B** (worker), **C** (control: seed + fire webhooks), **D** (Next.js app — the
dashboard and approval links in step 4f.3 are served by it; without it every
approval URL is connection-refused).

### 4a. Start the fixture server (terminal A)
The fixture implements the Zernio HTTP contract in memory. The committed
launcher starts it on an ephemeral port and prints the url:

```bash
pnpm exec tsx e2e/fixtures/serve.ts
# → prints e.g.  ZERNIO_API_BASE=http://127.0.0.1:54xxx
```

Export that URL as `ZERNIO_API_BASE` for the worker (terminal B) and the control
terminal (C). Reviews are seeded in step 4c via `POST /__control/reviews`;
recorded replies are readable at `GET /__control/replies` (step 4f.4) and
resettable between attempts with `DELETE /__control/replies`.

### 4b. Seed two locations (terminal C)
```bash
export TEST_DATABASE_POOL_URL="<your dev DB url>"
export DATABASE_POOL_URL="<your dev DB url>"
export DATABASE_URL="<your dev DB url>"
export ALLOW_E2E_DB_WRITES=true
```
```bash
# Same dynamic-import pattern as the §6 teardown — resolves against the repo
# cwd, so no throwaway launcher file is needed:
pnpm exec tsx -e "import('./e2e/seed').then(m => m.seedMultiLocationAccount()).then(s => { console.log(JSON.stringify(s, null, 2)); process.exit(0); })"
```
Capture from the output: `accountId`, `zernioAccountId`, `primaryZernioLocationId`,
`secondaryZernioLocationId`. (Each business already has a distinct
`google_place_id`; the primary is `is_primary=true`.)

### 4c. Seed one review per location into the fixture (terminal A's process)
The fixture's `list_reviews` for a location returns whatever you seeded for that
`zernio_location_id`. The review **`name` must carry the seeded
`zernio_location_id`** as its `{locationId}` segment (the `{accountId}` segment is
cosmetic — the ingest matches only on the location segment). Use `makeFixtureReview`
+ `seedReviews`, or POST to `/__control/reviews`:

```bash
# From terminal C, against the fixture url, for the PRIMARY location:
curl -sX POST "$ZERNIO_API_BASE/__control/reviews" -H 'content-type: application/json' \
  -d '{"locationId":"<primaryZernioLocationId>","reviews":[{
        "id":"rev-primary-1",
        "name":"accounts/fixture-account-1/locations/<primaryZernioLocationId>/reviews/rev-primary-1",
        "reviewer":{"displayName":"Pat","profilePhotoUrl":null,"isAnonymous":false},
        "rating":5,"starRating":"FIVE","comment":"Great service at the main shop!",
        "createTime":"2026-06-11T00:00:00Z","updateTime":"2026-06-11T00:00:00Z","reviewReply":null}]}'

# …and for the SECONDARY location (distinct review id + locationId segment):
curl -sX POST "$ZERNIO_API_BASE/__control/reviews" -H 'content-type: application/json' \
  -d '{"locationId":"<secondaryZernioLocationId>","reviews":[{
        "id":"rev-secondary-1",
        "name":"accounts/fixture-account-1/locations/<secondaryZernioLocationId>/reviews/rev-secondary-1",
        "reviewer":{"displayName":"Sam","profilePhotoUrl":null,"isAnonymous":false},
        "rating":4,"starRating":"FOUR","comment":"Solid second location.",
        "createTime":"2026-06-11T00:00:00Z","updateTime":"2026-06-11T00:00:00Z","reviewReply":null}]}'
```

### 4d. Boot the worker with mocks OFF (terminal B) and the app (terminal D)
Export every var from §2 (including `ZERNIO_API_BASE` from 4a), then:
```bash
MOCK_EXTERNAL_APIS=false NODE_ENV=development pnpm worker
```
Confirm it boots without a `[startup]` assertion error (a missing env var aborts
boot with the exact name). The worker now talks to the fixture for all Zernio calls.

In terminal D, start the Next.js app — it serves the dashboard and every approval
link at `NEXT_PUBLIC_APP_URL` (`http://localhost:3000`), which step 4f.3 depends on.
Point it at the SAME database the seeder wrote to:
```bash
pnpm dev
```

### 4e. Fire a signed per-location webhook for EACH location (terminal C)
`scripts/zernio-fire-webhook.sh` signs the body (HMAC-SHA256, `ZERNIO_WEBHOOK_SECRET`)
and POSTs a `review.new` to the worker's ingress (`WORKER_URL`, default
`http://127.0.0.1:3001/ingress/zernio`). Set `LOCATION_ID` so the review name
carries the right `zernio_location_id`, and pass the **Zernio account id** as the
first positional arg so the ingress scopes the fan-out to that account+location.

```bash
export ZERNIO_WEBHOOK_SECRET="<same secret the worker uses>"

# PRIMARY location:
LOCATION_ID="<primaryZernioLocationId>" REVIEW_ID="rev-primary-1" \
  bash scripts/zernio-fire-webhook.sh "<zernioAccountId>" review.new

# SECONDARY location:
LOCATION_ID="<secondaryZernioLocationId>" REVIEW_ID="rev-secondary-1" \
  bash scripts/zernio-fire-webhook.sh "<zernioAccountId>" review.new
```
A `200` from the ingress means the signature verified and the per-location fan-out
enqueued the ingest job.

### 4f. Observe the loop complete for BOTH locations
For each location, confirm the chain:
1. **Ingested** — a `reviews` row exists for the location's `business_id`
   (the ingest fetched the seeded review from the fixture and matched the location):
   ```sql
   SELECT b.display_label, r.id, r.rating
   FROM reviews r JOIN businesses b ON b.id = r.business_id
   WHERE b.account_id = '<accountId>'::uuid ORDER BY b.is_primary DESC;
   ```
2. **Drafted** — a `responses` row (status `pending_approval` / awaiting owner) for
   each review (worker logs: `[ResponseGeneratorWorker] … generated`).
3. **Approved** — approve each draft (Resend approval link, or the dashboard, or a
   manually-built approval link). After approval a `publish_response` job is
   enqueued.
4. **Published** — the fixture recorded a reply for each review. Check over HTTP:
   ```bash
   curl -s "$ZERNIO_API_BASE/__control/replies"
   # → {"publishedReplies":[{"reviewId":"rev-primary-1",...},{"reviewId":"rev-secondary-1",...}],"deletedReplies":[]}
   ```
   Two entries with the right `reviewId`s is the pass signal; the worker log line
   `[ResponsePublisherWorker] … published` and the `responses` rows advancing to
   posted corroborate it. (Re-running? `curl -X DELETE "$ZERNIO_API_BASE/__control/replies"` first.)

Both locations completing the chain independently — with no cross-routing — is the
pass condition.

---

## 5. Sign-Off Record

Fill this in **after** a clean run.

```
Multi-location two-location full-loop sign-off
Date:           ____________________
Operator:       ____________________
Commit / SHA:   ____________________

Primary location (zernio_location_id: __________________)
  [ ] review ingested
  [ ] draft generated
  [ ] draft approved
  [ ] publish_reply recorded by fixture

Secondary location (zernio_location_id: __________________)
  [ ] review ingested
  [ ] draft generated
  [ ] draft approved
  [ ] publish_reply recorded by fixture

No cross-routing observed (each review landed on its own location): [ ]
Deviations / notes: ___________________________________________________
```

> **TODO — first run pending.** This record is filled in by the operator who runs
> the loop with real test keys. The PR F kit (seeder, fixture server, webhook
> param, this runbook) is in place; the run itself is the launch-gating step.

---

## 6. Teardown
```bash
# Remove the seeded account + both businesses + both connections + enrollment:
pnpm exec tsx -e "import('./e2e/seed').then(m => m.cleanupMultiLocationAccount('<accountId>')).then(() => process.exit(0))"
```
- Stop the worker (terminal B, Ctrl-C), the app (terminal D, Ctrl-C), and the
  fixture server (terminal A, Ctrl-C — calls `server.stop()`).

The teardown removes the seeded account, both businesses + connections, the
enrollment, AND any `api_costs` rows the real draft generation wrote (their FKs
have no ON DELETE action, so they must go before the businesses delete — the
cleanup handles this).
