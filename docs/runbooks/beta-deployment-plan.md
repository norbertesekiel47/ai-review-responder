# RepWorth — First Beta Deployment Plan

**Audience:** solo founder, first prod deploy. Friend's resort GBP is the
only live business in scope.

**Scope:** Vercel (UI) + Railway (worker) + Supabase prod + Upstash Redis,
running the Zernio ingestion path end-to-end. Self-serve signup, channels
(SMS / Telegram / WhatsApp), and Stripe billing are deferred — see §0.

**Source of truth:** this plan orchestrates existing runbooks. When a
section says "follow `docs/runbooks/foo.md` §X," do that — don't rewrite.

| Reference | Use for |
|---|---|
| `.claude/CLAUDE.md` | architectural invariants, env-var inventory, gotchas |
| `.env.example` | canonical env-var list with comments |
| `docs/runbooks/zernio-launch-runbook.md` | Zernio pre-flight + Phase 1 + finalize_unknown reconciliation |
| `docs/runbooks/zernio-ingestion-test-runbook.md` | webhook ingestion smoke tests |
| `docs/runbooks/smoke-test-checklist.md` | end-to-end happy-path template |
| `docs/runbooks/operational-runbook.md` | day-2 ops + incident response |
| `docs/runbooks/email-deliverability.md` | Resend domain warmup |
| `docs/zernio-ingestion-test-report-2026-05-01.md` | what's been verified locally; what's still blocked on real Zernio |

---

## §0. What's in this beta — and what isn't

### IN — must work

- **One business** (friend's resort), onboarded via admin (`/admin/businesses/new`).
- **Zernio ingestion + posting** (`ZERNIO_PUBLISHING_ENABLED=true`).
- **Email-only approval channel** (Resend → owner inbox).
- **Approval flow**: read-only shell, edit/regenerate, approve, publish via Zernio.
- **Subscription state set manually** (no Stripe — see "OFF" below).
- **Cost guard, outbox, watchdog, failover poller, archival, weekly/monthly digests** (everything code-complete in Sprints 1-6).

### OFF — explicitly disabled for beta

| Feature | Flag | Why off |
|---|---|---|
| Self-serve signup | `SELF_SERVE_SIGNUP_ENABLED=false` | Supabase custom SMTP not yet configured. Admin onboards the friend manually. |
| SMS channel | `CHANNELS_SMS_ENABLED=false` | 10DLC registration not done. |
| Telegram channel | `CHANNELS_TELEGRAM_ENABLED=false` | Bot not deployed; ⚠️ **dev .env.local has this true — flip it OFF in Railway**. |
| WhatsApp channel | `CHANNELS_WHATSAPP_ENABLED=false` | Meta verification + template approval not done. |
| Ranking tracking | `RANKING_TRACKING_ENABLED=false` | Feature not ready; SerpAPI cost. |
| Edit-existing-replies | `EDIT_EXISTING_REPLIES_ENABLED=false` | Migration 031 + feature in progress on different branch. |
| Stripe billing | _no flag — just don't trigger_ | One business, manually marked active via SQL. Skip Stripe webhook wiring entirely. |
| `MOCK_EXTERNAL_APIS` | **must be `false`** | Mock mode bypasses all third parties — would silently no-op real Zernio + Resend calls. |

### Branch state to ship

- Current: `feat/zernio-ingestion-replace-serpapi` — code-complete, mock smokes pass per `docs/zernio-ingestion-test-report-2026-05-01.md`.
- Action: merge to `main` before deploy. Vercel/Railway both build from `main`.
- Migration 031 (`edit_existing_replies`) is in the repo but **DO NOT apply it** in this deploy. It belongs to a feature not shipping in beta and needs `CONCURRENTLY` index builds (non-transactional execution).

---

## §1. Pre-deploy provisioning — start 48 h ahead of deploy day

DNS propagation is the long-pole item. Get it started first, do everything else while you wait.

### 1.1 Domain & DNS (T-48h)

- [ ] Pick the production domain. Suggested split:
  - `app.<yourdomain>` → Vercel (Next.js UI + `/approve/<token>` links)
  - `worker.<yourdomain>` → Railway (Fastify worker, all `/ingress/*` webhooks)
  - `<yourdomain>` (apex) → marketing/landing — point at Vercel too if same project
- [ ] Add `app.` and `worker.` CNAMEs in your DNS panel. Vercel and Railway will give you the target hostnames once you create the projects (§4.1, §5.1).
- [ ] If you don't have a domain yet, you can ship the first beta on the free `*.vercel.app` and `*.up.railway.app` subdomains — just be aware Resend domain verification (§1.2) requires a real domain you own.

### 1.2 Resend domain verification (T-48h — DNS lag is the long pole)

- [ ] Create Resend account, add your domain.
- [ ] Add the SPF, DKIM, DMARC records Resend gives you. **DNS verification can take 1–24 h.** Don't block on it — start it now.
- [ ] Once verified, set `RESEND_FROM_EMAIL` to a sender on that domain, e.g. `RepWorth <notifications@yourdomain.com>`.
- [ ] Generate the API key (`re_...`) → `RESEND_API_KEY`.
- [ ] Generate the webhook secret: `openssl rand -hex 32` → `RESEND_WEBHOOK_SECRET`. Don't configure the webhook URL yet — we don't have `WORKER_PUBLIC_URL` until §5.
- [ ] See `docs/runbooks/email-deliverability.md` for the warmup curve. For one business sending ~10 emails/week, you won't hit warmup ceilings, but read it anyway so you understand the bounce/complaint signals.

### 1.3 Supabase production project

- [ ] Create a **separate** Supabase project for prod. Do not share with dev — schema diffs and test data will haunt you.
- [ ] From Project Settings → Database, capture:
  - `DATABASE_URL` (direct, port 5432) — for transactional writes from Postgres.js
  - `DATABASE_POOL_URL` (Connection Pooler → Transaction mode, port 6543, includes `?pgbouncer=true`) — used by OutboxPoller's CTE
  - `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` (same value)
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable)
  - `SUPABASE_SERVICE_KEY` (server-only — never to browser)
- [ ] Note the `statement_timeout` gotcha: pooler clamps at ~8s. The Postgres.js client overrides to 30s in `src/lib/db/server.ts`. No action needed — just don't accidentally bypass that client.

### 1.4 Upstash Redis × 2

You need **two logically separate Redis instances** — one for cache, one for BullMQ.

- [ ] Create cache instance → `REDIS_CACHE_URL` (`rediss://default:<token>@<host>:6379`). Use TLS in prod.
- [ ] Create queue instance → `REDIS_QUEUE_URL` (same format).
- [ ] If using Upstash REST URLs (https://) instead of `rediss://`, also set `REDIS_CACHE_TOKEN` / `REDIS_QUEUE_TOKEN`. The `rediss://` form is simpler — prefer it.
- [ ] Note free tier: 10,000 commands/day per instance. For one business this is fine but BullMQ does background polling; watch the quota in week 1.

### 1.5 Zernio API access

- [ ] Confirm Zernio reseller agreement + Accelerate plan + **Inbox add-on** (required for reply posting — see `zernio-launch-runbook.md` §2.1).
- [ ] Generate prod API key → `ZERNIO_API_KEY`.
- [ ] Generate webhook secret: `openssl rand -hex 32` → `ZERNIO_WEBHOOK_SECRET`.
- [ ] Don't configure the Zernio webhook URL yet — we'll do that in §6 after Railway is up.

### 1.6 LLM billing

- [ ] OpenAI: add a payment method. Trial credits ($5) burn fast and silently roll back to "no key" — `docs/runbooks/smoke-test-checklist.md` notes a real run where OpenAI silently fell back to Anthropic for 25 calls because the key was non-functional. Verify the key works with a curl before you trust it in prod.
- [ ] Anthropic: add a payment method. The fallback model is `claude-haiku-4-5-20251001` (NOT `claude-3-5-haiku-latest` — that's 404 per CLAUDE.md gotchas).
- [ ] Set per-business + global daily cost ceilings (defaults: founding 500¢/day, global 10000¢/day). For first beta you can lower the global to e.g. $5/day as a circuit breaker — there's only one business, you should never approach that.

### 1.7 Sentry (recommended, optional)

- [ ] One project for Node (worker) + one for Next.js (browser+SSR), or a single combined project.
- [ ] `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`. `SENTRY_AUTH_TOKEN` only needed if you want source-map uploads in CI.

### 1.8 Generate app secrets

```bash
# 32-byte hex (64 chars) — for token encryption
openssl rand -hex 32   # → ENCRYPTION_KEY
# 32+ char random strings — for cookie + CSRF signing
openssl rand -base64 32   # → SESSION_COOKIE_SECRET
openssl rand -base64 32   # → CSRF_SECRET
```

`ENCRYPTION_KEY_VERSION=1`.

---

## §2. Database — apply migrations 001–030

- [ ] In Supabase prod SQL editor, run each `supabase/migrations/0XX_*.sql` **in numeric order**. Per CLAUDE.md / user feedback memory, Claude does not run these for you — you run them, in the editor, and check the result.
- [ ] **Skip 031** (`031_edit_existing_replies.sql`) — out of scope, requires non-transactional execution.
- [ ] Pre-flight before 029 (idempotent — should be 0 in a fresh DB):
  ```sql
  SELECT COUNT(*) FROM responses WHERE status = 'awaiting_manual_post';
  -- expect: 0
  ```
- [ ] Verification queries after running all 30:
  ```sql
  -- All tables present
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
  ORDER BY table_name;
  -- expect: ~30 tables including reviews, responses, businesses, users,
  --         job_outbox, approval_links, approval_audit_log, zernio_connections,
  --         zernio_backfill_runs, zernio_finalize_incidents,
  --         channel_enrollments, notification_deliveries, etc.

  -- Migration 030 dedup index (most recent guard)
  SELECT indexname FROM pg_indexes
  WHERE indexname = 'job_outbox_ingest_zernio_review_inflight';
  -- expect: 1 row

  -- Migration 029 cleared the deprecated status from the predicate
  SELECT pg_get_indexdef(indexrelid)
  FROM pg_index pgi
  JOIN pg_class pc ON pc.oid = pgi.indexrelid
  WHERE pc.relname = 'responses_one_non_terminal_per_review';
  -- expect: predicate excludes 'awaiting_manual_post'
  ```

- [ ] Seed admin user — create one via Supabase Auth (Authentication → Users → Add user, email/password), then link it to a `users` row:
  ```sql
  INSERT INTO users (id, email, name, role, auth_id)
  VALUES (gen_random_uuid(), 'norbertesekiel@gmail.com', 'Norbert',
          'admin', '<auth-user-uuid-from-supabase-auth>');
  ```
  (See `docs/runbooks/personal_testing.md` §4 for the auth-id linking step.)

---

## §3. Code prep

- [ ] Merge `feat/zernio-ingestion-replace-serpapi` → `main`. Run `pnpm test` once on main before deploy — expect ~1707 passing per the test report.
- [ ] `pnpm build` locally to catch any prod-build-only issues (Next.js sometimes fails on env vars referenced at build time but not provided).
- [ ] Confirm `package.json` scripts that prod will run: `pnpm build`, `pnpm start` (Vercel), `pnpm worker` (Railway). No build step for the worker — `tsx` transpiles on the fly.

---

## §4. Vercel deploy (UI)

### 4.1 Create project

- [ ] In Vercel, "New Project" → import the GitHub repo → branch `main`.
- [ ] Framework preset: Next.js (auto-detected).
- [ ] Build command: default (`pnpm build`).
- [ ] Output: default.
- [ ] Don't deploy yet — set env vars first.

### 4.2 Vercel env vars

Set these in Project Settings → Environment Variables, scope **Production** (and **Preview** if you want preview deploys to use prod creds — usually no, keep previews on dev DB).

**Public (browser-safe):**
```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_APP_URL=https://app.<yourdomain>
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY    # optional — only needed for PlaceAutocomplete on /signup
NEXT_PUBLIC_SENTRY_DSN              # optional
```

**Server-only (Vercel API routes need DB + auth):**
```
DATABASE_URL
DATABASE_POOL_URL
SUPABASE_URL
SUPABASE_SERVICE_KEY
SESSION_COOKIE_SECRET
CSRF_SECRET
ENCRYPTION_KEY
ENCRYPTION_KEY_VERSION=1
ADMIN_NOTIFICATION_EMAIL
RESEND_FROM_EMAIL
ADMIN_API_KEY                      # set to a random 32-char string for prod
SENTRY_DSN                         # optional
WORKER_SERVICE_URL=https://worker.<yourdomain>   # for Vercel → Railway calls
```

**Feature flags (explicit OFF):**
```
SELF_SERVE_SIGNUP_ENABLED=false
ZERNIO_PUBLISHING_ENABLED=true
MOCK_EXTERNAL_APIS=false
```

### 4.3 First deploy

- [ ] Click Deploy. Watch the build log for missing-env-var crashes.
- [ ] Add the custom domain (`app.<yourdomain>`) under Project → Settings → Domains. Vercel will give you the CNAME target — confirm DNS resolves.
- [ ] Smoke:
  ```
  curl -I https://app.<yourdomain>/
  # expect: 200 OK + security headers (Strict-Transport-Security, X-Content-Type-Options)
  ```
- [ ] Visit `/admin/login` in browser — form renders.
- [ ] Log in with the admin user from §2. Land on `/admin/overview`. Empty state OK.

---

## §5. Railway deploy (worker)

### 5.1 Create project

- [ ] In Railway, "New Project" → "Deploy from GitHub repo" → select repo + branch `main`.
- [ ] Service name: `repworth-worker` (or similar).
- [ ] **Start command:** `pnpm worker` (Settings → Service → Start Command).
- [ ] **Health check path:** `/api/health` (Settings → Networking → Health Check). Railway will probe this; 200 = ready.
- [ ] **Port:** Railway auto-injects `PORT`; the Fastify server reads it and binds `0.0.0.0:$PORT`. No action needed.
- [ ] Don't deploy yet — set env vars first.

### 5.2 Railway env vars

Paste the entire block. Adjust values to match what you provisioned in §1.

**Database + Redis:**
```
DATABASE_URL=...
DATABASE_POOL_URL=...
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
REDIS_CACHE_URL=rediss://default:...@...:6379
REDIS_QUEUE_URL=rediss://default:...@...:6379
```

**LLM:**
```
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-api03-...
```

**Email:**
```
RESEND_API_KEY=re_...
RESEND_WEBHOOK_SECRET=<the 64-hex secret from §1.2>
RESEND_FROM_EMAIL=RepWorth <notifications@yourdomain.com>
ADMIN_NOTIFICATION_EMAIL=norbertesekiel@gmail.com
```

**Zernio:**
```
ZERNIO_PUBLISHING_ENABLED=true
ZERNIO_API_KEY=...
ZERNIO_WEBHOOK_SECRET=<the 64-hex secret from §1.5>
# Optional — defaults are fine
# ZERNIO_API_BASE=https://zernio.com/api
# ZERNIO_PROFILE_ID_PREFIX=repworth-prod-
# ZERNIO_INGEST_MAX_PAGES=4
```

**App URLs:**
```
NEXT_PUBLIC_APP_URL=https://app.<yourdomain>
WORKER_PUBLIC_URL=https://worker.<yourdomain>     # no trailing slash, must match Zernio dashboard exactly
```

**Security:**
```
SESSION_COOKIE_SECRET=...
CSRF_SECRET=...
ENCRYPTION_KEY=...
ENCRYPTION_KEY_VERSION=1
```

**Feature flags — explicit OFF for everything not shipping:**
```
SELF_SERVE_SIGNUP_ENABLED=false
CHANNELS_SMS_ENABLED=false
CHANNELS_TELEGRAM_ENABLED=false
CHANNELS_WHATSAPP_ENABLED=false
RANKING_TRACKING_ENABLED=false
MOCK_EXTERNAL_APIS=false
```

**Observability (optional):**
```
SENTRY_DSN=...
```

### 5.3 First deploy

- [ ] Push the deploy. Watch logs for the startup-assert lines:
  ```
  [startup-assert] zernio: ZERNIO_API_KEY ✓
  [startup-assert] zernio: ZERNIO_WEBHOOK_SECRET ✓
  [startup-assert] zernio: WORKER_PUBLIC_URL ✓
  [startup-assert] zernio: NEXT_PUBLIC_APP_URL ✓
  ```
  If any are missing, the worker exits with code 1. Fix the env var, redeploy.
- [ ] Add the custom domain (`worker.<yourdomain>`) under Settings → Networking. Wait for the cert.
- [ ] Smoke:
  ```
  curl https://worker.<yourdomain>/api/health
  # expect: {"status":"ok","timestamp":"..."}
  ```

---

## §6. Webhook wiring — only possible after §5 (URLs needed)

### 6.1 Resend webhook

- [ ] In Resend dashboard → Webhooks → Add endpoint.
- [ ] URL: `https://worker.<yourdomain>/ingress/resend`
- [ ] Signing secret: paste `RESEND_WEBHOOK_SECRET` from §1.2.
- [ ] Events: `email.delivered`, `email.bounced`, `email.complained`, `email.opened` (the worker handles these — see `worker/ingress/resend.ts`).
- [ ] Click "Send test" → check Railway logs for `[ingress/resend] processed`.

### 6.2 Zernio webhook

- [ ] In Zernio dashboard → Webhooks (per `zernio-launch-runbook.md` §2.2).
- [ ] URL: `https://worker.<yourdomain>/ingress/zernio` (exact, no trailing slash).
- [ ] Signing secret: paste `ZERNIO_WEBHOOK_SECRET` from §1.5.
- [ ] Subscribed events:
  - `account.disconnected` (required — drives connection-lost emails)
  - `account.connected` (defensive observability)
  - `webhook.test`
  - `review.new`, `review.updated` (required — these drive ingestion)
- [ ] Fire test webhook from Zernio dashboard. Verify in Railway logs: `[ingress/zernio] webhook.test received eventId=<uuid>`.
- [ ] Verify in Supabase:
  ```sql
  SELECT id, source, event_type, status, created_at
  FROM inbound_events
  WHERE source = 'zernio'
  ORDER BY created_at DESC LIMIT 1;
  -- expect: status='processed', event_type='webhook.test'
  ```

If you get 401 `invalid_signature`, see `zernio-launch-runbook.md` §5.1–5.2 — most common cause is webhook-secret mismatch between Zernio dashboard and Railway env.

---

## §7. Onboard the friend's resort — admin path, no Stripe

This is the deliberate detour around the self-serve signup flow.

- [ ] In browser, log in as admin → `/admin/businesses/new`.
- [ ] Fill the form. Use PlaceAutocomplete to pick the resort if you have `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` set; otherwise paste the Google Maps URL.
- [ ] Owner email: **friend's email** (he'll receive approval emails).
- [ ] Tone, products/services, staff names, highlight facts, avoid facts: gather from the friend in advance.
- [ ] Subscription tier: founding (cosmetic for beta — billing isn't wired).
- [ ] Submit. The form will try to redirect to a Stripe Payment Link — **ignore it / close the tab**. We're skipping payment.

- [ ] Manually mark the business active so workers process it (no Stripe webhook):
  ```sql
  UPDATE businesses
  SET subscription_status = 'active',
      subscription_activated_at = NOW(),
      stripe_customer_id = 'manual-beta-no-stripe',
      updated_at = NOW()
  WHERE id = '<the-business-id>';
  ```
  (Verify with `SELECT id, name, subscription_status FROM businesses WHERE id = '...'`)

- [ ] Confirm `place_id_verified = true`. If false, follow `operational-runbook.md` §A5 — the cleanest fix is to re-onboard via PlaceAutocomplete.

⚠️ **Do NOT trigger the SerpAPI initial sync** — Zernio replaces SerpAPI as the ingestion source for this beta. The first batch of reviews will come in via Zernio backfill (§8) and steady-state webhooks. If you have a `sync_reviews` outbox row queued from onboarding, it'll either no-op or pull stale data — leave it alone.

---

## §8. Connect Zernio to the friend's GBP

This is where you start touching the real Google business. Move slowly.

- [ ] Tell the friend in advance: "I'm about to connect RepWorth to your GBP. Please don't reply to or edit any reviews on Google Maps for the next 2 hours."
- [ ] Visit `/dashboard` as the owner (or impersonate via admin). See the "Connect Google Business" banner.
- [ ] Click Connect → handoff to Zernio's hosted OAuth → friend authorizes the resort's Google account → redirects back to `/api/zernio/connect/callback`.
- [ ] If multi-location, pick the resort location at `/dashboard/connect/select-location`.
- [ ] Verify in Supabase:
  ```sql
  SELECT id, business_id, status, zernio_account_id, zernio_location_id,
         connected_at, last_error
  FROM zernio_connections
  WHERE business_id = '<resort-business-id>'
  ORDER BY connected_at DESC LIMIT 1;
  -- expect: status='active', last_error IS NULL, both zernio IDs populated
  ```
- [ ] If `zernio_finalize_incidents` has any unresolved row for this business, follow `zernio-launch-runbook.md` §6 reconciliation. **Do not proceed past this step until the incident is resolved.**

---

## §9. Smoke tests — read-only first, then write

The core principle: **everything below approval click is reversible. Approval click is the line in the sand.** Walk up to it, verify the world looks right, then take exactly one deliberate step across.

### 9.1 Worker + ingress sanity (5 min, zero blast radius)

| Test | How | Pass |
|---|---|---|
| Worker health | `curl https://worker.<yourdomain>/api/health` | `{"status":"ok",...}` |
| Resend webhook | "Send test" in Resend dashboard | Railway log: `[ingress/resend] processed`; `inbound_events` row with `source='resend'`, `status='processed'` |
| Zernio webhook | "Send test" in Zernio dashboard | Railway log: `[ingress/zernio] webhook.test received`; `inbound_events` row with `source='zernio'`, `event_type='webhook.test'` |
| Sentry wiring | trigger any handled error (e.g. visit `/api/admin/overview` without session) | error appears in Sentry within 30s |

### 9.2 Initial backfill (read-only — Zernio fetches existing reviews)

This pulls existing reviews from the resort's GBP into our DB. **No reviews are posted; nothing is sent to the friend's customers.** Worst case: we generate AI drafts that sit unapproved.

- [ ] Wait ~30s after §8 connect (the connect callback enqueues the backfill outbox row).
- [ ] Watch Railway logs: `[ZernioBackfillWorker] business_id=<...>` followed by per-page `listReviews` calls.
- [ ] Verify reviews landed:
  ```sql
  SELECT COUNT(*) AS reviews,
         COUNT(*) FILTER (WHERE has_owner_reply = true) AS already_replied
  FROM reviews
  WHERE business_id = '<resort-business-id>';
  ```
- [ ] Verify backfill summary:
  ```sql
  SELECT * FROM zernio_backfill_runs
  WHERE business_id = '<resort-business-id>';
  -- expect: completed_at set, processed_count > 0
  --         older_skipped_count may be > 0 (capped by tier)
  ```
- [ ] Verify drafts started:
  ```sql
  SELECT status, COUNT(*) FROM responses
  WHERE business_id = '<resort-business-id>'
  GROUP BY status;
  -- expect: a mix of pending_approval (drafts being generated) and possibly
  --         awaiting_owner_connect / posted depending on resort state
  ```

### 9.3 Cost & rate sanity (5 min)

- [ ] `/admin/costs` → today's total should reflect the backfill (small — typically <$0.50 for a resort with a few dozen reviews).
- [ ] `/admin/jobs` → no `failed` outbox rows. Pending should drain to 0 within a few minutes.
- [ ] Check OpenAI dashboard → calls registered. If 0, OpenAI key is silently broken (known prior failure mode — see `smoke-test-checklist.md` note 1) and Anthropic is doing all the work. Fix the key before continuing.

### 9.4 Approval email arrives (the friend's inbox)

- [ ] Pick one pending-approval response (any of them). Confirm the friend got the approval email — text the friend to ask.
- [ ] Friend forwards you the email or screenshots it (don't ask him to click anything yet).
- [ ] Verify on your end:
  ```sql
  SELECT response_id, channel, sent_at, delivered_at, failed_at, failure_reason
  FROM notification_deliveries
  WHERE business_id = '<resort-business-id>'
  ORDER BY sent_at DESC LIMIT 5;
  -- expect: sent_at populated; delivered_at populated within a few minutes once
  --         Resend webhook fires
  ```

### 9.5 Approval page renders — DO NOT CLICK APPROVE YET

- [ ] On YOUR phone (not the friend's), open the approval link from one of the emails the friend forwards you.
- [ ] Verify the page renders the read-only shell: business name, review excerpt, draft response, expiry countdown.
- [ ] Verify in DB an `approval_audit_log` entry was written for the GET (action: `viewed` or similar).
- [ ] Verify the page does NOT auto-approve, auto-edit, or auto-anything. (Per `approval-security.md`, GET is read-only by design — email scanners that prefetch the URL would otherwise hijack the session.)
- [ ] **Close the tab.** Do not click any button.

### 9.6 The line in the sand — one deliberate post

This is the only step that touches the live GBP. Pick the conditions deliberately.

**Pre-conditions, all required:**
- Friend explicitly agrees to a public test response on a specific review.
- Pick a review that is at least 6 months old AND already has an owner reply OR is uncontroversial (4–5 star). Avoid recent reviews and any negative reviews — those are too high-stakes for a smoke test.
- Friend can monitor his GBP for the next hour and confirm visually.

**Procedure:**
- [ ] Generate a fresh approval link for that specific review (regenerate from the dashboard if needed — old emails will be revoked, so this is safe).
- [ ] On your phone, open the link, read the draft carefully. Edit if it's off-tone.
- [ ] Click **Approve**.
- [ ] Watch Railway logs in real time:
  ```
  [ResponsePublisherWorker] business_id=<...> response_id=<...> branch=zernio
  [zernio-publisher] postReply OK accountId=<...> in <ms>
  [ResponsePublisherWorker] response_id=<...> status=posted
  ```
- [ ] Verify DB:
  ```sql
  SELECT id, status, posted_at, posting_attempts
  FROM responses WHERE id = '<response-id>';
  -- expect: status='posted', posted_at set
  ```
- [ ] Friend opens his GBP on Google Maps within ~1 min. Reply should appear under the review.
- [ ] If something looks wrong, the response was already posted to Google — you cannot "undo" via the app. The friend can delete the reply manually in his GBP UI. Don't panic.

### 9.7 Edge-case smoke tests (after §9.6 succeeds)

These verify the safety machinery you'll never want to trip in prod.

| Test | How | Pass |
|---|---|---|
| Duplicate Zernio webhook | Replay the same event ID via Zernio dashboard | Second call returns `{"received":true,"duplicate":true}`; no new outbox rows; verified in `docs/zernio-ingestion-test-report-2026-05-01.md` §4.2 |
| Expired token → 410 | `UPDATE approval_links SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = '<some-link>'`, then open the URL | Page shows "expired"; no DB writes |
| Subscription guard | `UPDATE businesses SET subscription_status='past_due' WHERE id = '<resort>'`, generate a new approval, click approve | Publisher skips per CLAUDE.md §subscription guard. Reset to `active` after. |
| Cost circuit | Set `GLOBAL_DAILY_COST_LIMIT_CENTS=10` (10¢) on Railway, redeploy, regenerate a few times | `ResponseGeneratorWorker` fails with `cost_limit_exceeded` in `last_error`. Reset env var after. |
| Outbox watchdog | Manually `UPDATE job_outbox SET status='dispatched', updated_at = NOW() - INTERVAL '2 hours' WHERE id='<some-pending>'` | Within next OutboxPoller tick: row resets to `pending` (if attempts < max) or transitions to `failed` |

Don't run all of these on the friend's resort. Some can be exercised on a throwaway test business in dev — you've already done the equivalents per the local test report.

---

## §10. Friend's GBP guardrails — read this twice

These are not technical, they are operational discipline.

1. **The architecture makes auto-posting impossible.** Per CLAUDE.md invariant: there is no code path from generation to posting without an explicit approval click. Believe this. The risk is not the code; the risk is you accidentally clicking Approve on the wrong review.

2. **Two-person rule for the first post.** Don't approve anything live without the friend explicitly saying "yes, post that one." Screenshot the draft and send it before clicking.

3. **Pick the test review deliberately.** Old, uncontroversial, ideally 4-5 stars. Never use the test post on a customer who recently visited — they'll see it and form a real opinion of his business.

4. **Tell the friend when you're testing.** Specifically: "From X PM to Y PM I might post one reply on review #N. Please don't reply to or edit anything else during that window — it'll confuse the diagnostics."

5. **Have the kill switch ready.** If anything looks wrong, set `ZERNIO_PUBLISHING_ENABLED=false` in Railway and redeploy. Worker reboots; webhook ingress returns 503; ResponsePublisher stops calling Zernio. Already-posted replies stay posted (no rewind), but no new posts go out. See `zernio-launch-runbook.md` §7.1 for the soft-rollback details.

6. **Don't enable ranking tracking, weekly summary, or onboarding drips with the friend's business.** They send emails to him on schedules he didn't sign up for. To suppress: leave `RANKING_TRACKING_ENABLED=false`; for weekly/monthly digests, run:
   ```sql
   UPDATE businesses
   SET weekly_summary_enabled = false,
       monthly_impact_enabled = false
   WHERE id = '<resort-business-id>';
   ```
   (Owner can also self-toggle on `/settings`, but proactively turning them off is friendlier.)

---

## §11. Day-2 monitoring — first week

Daily, 2 minutes:
- [ ] `/admin/overview` — System Health card all green (Pending outbox <50, Failed jobs = 0, Notification failures 24h = 0).
- [ ] `/admin/costs` — daily total < your global ceiling.
- [ ] `/admin/notifications` — every approval email shows `delivered_at` within ~5 min of `sent_at`. If `delivered_at` stays NULL, Resend webhook isn't firing — check Resend dashboard.
- [ ] Sentry — any errors? Triage. Cost-related errors (`cost_limit_exceeded`) are signal, not noise.

Weekly:
- [ ] Resend domain reputation, bounce rate <2%.
- [ ] Upstash Redis quota (10K commands/day per instance on free tier — BullMQ polling adds up).
- [ ] OpenAI / Anthropic spend trend.
- [ ] Zernio API rate limit headroom — Build tier is 600 req/min; one business won't approach this.
- [ ] `SELECT * FROM zernio_finalize_incidents WHERE resolved_at IS NULL` — must always be 0 rows. Any row → `zernio-launch-runbook.md` §6.

Per-customer issues: see `operational-runbook.md` §A1–A5.

---

## §12. Things you didn't ask about that matter

These are the items not covered above that I'd want to know before hitting deploy.

1. **Resend domain verification has DNS lag.** Add the records 24–48 h before you plan to deploy. If you skip this, your first approval email won't reach the friend, and you'll burn an hour figuring out why.

2. **The friend's email might silently bounce.** Some corporate inboxes greylist new senders. Send a non-RepWorth test email from `notifications@yourdomain.com` to the friend's address before the smoke test, and ask him to confirm receipt + check spam.

3. **Mobile UX of the approval link.** The approval page targets <2s LCP and was tested at 283ms unthrottled (`smoke-test-checklist.md`). But test it on the friend's actual phone — slow 3G + a budget Android with battery saver can be 5x worse. He'll click on his phone, not desktop.

4. **Time zones for cron jobs.** Weekly digest fires Monday 8–9 AM **UTC**. Monthly impact fires the 1st 9–10 AM UTC. If the friend is in PST and you don't disable these (§10.6), he gets emails at midnight Sunday / 1 AM the 1st. Disabling is friendlier.

5. **Backups.** Supabase free tier has 7 days of automatic daily backups. That's fine for a beta. Know how to restore (Supabase dashboard → Database → Backups). Do not test restore on the prod project.

6. **Cost ceiling for first month.** With one business, ~$10/mo of OpenAI + Anthropic + Resend. Set OpenAI hard limit at $20 in their dashboard — it caps spend at the API level even if our cost guard breaks.

7. **Friend can't unsubscribe from approval emails by accident.** Approval emails don't include a List-Unsubscribe header (intentional — they're transactional, not marketing). But if the friend marks one as spam, his domain might start filtering all of them. Tell him in advance: "If a draft is bad, regenerate or edit — don't mark spam."

8. **Approval-link prefetch by email scanners.** GET is read-only by design (`approval-security.md`). Even if Gmail/Outlook prefetches the URL when opening the email, no state changes. Approval requires POST + device-cookie + CSRF. This is correct; don't worry about it. But it means: the friend MUST open the link from his phone (or any browser), not approve it from a click in the email preview pane.

9. **You will not have working Stripe webhooks in beta.** Anything in the code that depends on `subscription_activated_at` (engagement monitor, onboarding drip) gets that timestamp from your manual SQL UPDATE in §7. Onboarding drip will fire day 1 / 7 / 30 from that timestamp — disable it for the friend if you don't want him to get nudge emails:
   ```sql
   -- find what onboarding drip checks (likely a per-business flag or a "system" sender opt-out)
   ```
   Cross-reference `worker/background/schedulers/OnboardingDripScheduler.ts` for the exact gate. If you don't want to dig: just leave it. Three friendly nudge emails on days 1/7/30 won't hurt.

10. **Migration 031 is in the repo and you're skipping it.** Don't accidentally run it. If someone (you, in 2 weeks, having forgotten) executes "all migrations," 031 will try to do `CREATE INDEX CONCURRENTLY` inside a transaction and either fail or silently degrade. Apply migrations one at a time, by number, and stop at 030.

11. **The branch is not yet merged to main.** Currently the working branch is `feat/zernio-ingestion-replace-serpapi`. Vercel and Railway both deploy from `main` by default. Either change the deploy branch (works but means future hotfixes need to land on the long-lived feature branch) or merge to main first (cleaner). Recommend: merge to main once you've decided to deploy.

12. **You'll want to /loop or /schedule a recurring health check.** After this deploys, ask Claude Code to schedule a recurring agent that runs the §11 daily checklist as a script (each morning, query `/admin/overview` API, post any anomalies to your inbox). This is a clean "set and forget" — see the `schedule` skill.

---

## §13. Sign-off

Before you go to bed on deploy day:
- [ ] §9.1 worker + ingress smoke pass
- [ ] §9.2 initial backfill processed at least 1 review
- [ ] §9.5 approval email landed in friend's inbox; you opened the link from your phone; page rendered correctly
- [ ] §9.6 ONE deliberate post landed on the friend's GBP and the friend confirmed visually
- [ ] §11 daily monitoring routine bookmarked
- [ ] Kill switch (§10.5) tested at least mentally — you know exactly what env var to flip and where

If all six are checked, you're shipped.
