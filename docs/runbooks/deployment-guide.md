# RepWorth — Deployment, Staging & Promotion Guide

The single source for deploying RepWorth and running it across two environments.
Two parts:

- **Part I — Single-environment deployment recipe** (§0–§13). The step-by-step for
  standing up **one** environment (Vercel UI + Railway worker + Supabase + Redis
  + Stripe + webhooks) end-to-end. It's the same recipe you run for staging and for
  prod; §7–§10 also walk the careful onboarding of your first real customer.
- **Part II — Staging & production: two environments + promotion** (§II.1–§II.8).
  Applies Part I twice — staging first, then prod — and defines the ongoing
  Option-1 release loop.

> **Why one file:** Part II constantly references Part I's mechanical steps. Note
> that Part I's section numbers (esp. **§4.1, §5, §10.5, §12.5**) are referenced
> by `railway.toml` and `rollback.md` — they are stable anchors; don't renumber.

**Source of truth:** this guide orchestrates existing runbooks. When a section
says "follow `docs/runbooks/foo.md` §X," do that — don't rewrite. `.env.example`
is the canonical env-var list (overrides any inline list here).

## Decisions baked in (2026-05-29)

- **Option 1 — trunk-based + previews.** `main` is the source of truth; every PR
  gets an automatic Vercel preview URL; one **persistent staging environment**
  exists for full-stack/webhook testing; merging to `main` ships production.
- **Separate Supabase project for staging** — staging never shares a DB with prod.
- **One Railway project, two environments** (`production` + `staging`).
- **Redis is split** — the **BullMQ queue** runs on **Railway** (same project as the
  worker, reached over private networking, no public proxy → no egress); the
  **cache** stays on **Upstash** (TLS, Vercel-reachable). This replaces the original
  "two Upstash instances" and is the fix for the egress bill. Why, plus the IPv6
  `family: 0` code prerequisite: **§1.4**.

## Current cloud state (verified 2026-07-28)

**Staging is the only environment that actually runs.** Everything below from
2026-05-29 describes the pre-staging world and is kept for the reasoning, not as
current fact.

| | Staging | Production |
|---|---|---|
| Railway worker | `repworth-worker` **Online**, `repworth-worker-staging.up.railway.app` | `repworth-worker` **Offline** — never successfully deployed |
| Railway Redis (queue) | `redis` **Online** (private net, `?family=0`) | **none provisioned** |
| Worker env vars | full set | 35 vars, **missing** `SENTRY_DSN`, `ADMIN_NOTIFICATION_EMAIL`, `REDIS_QUEUE_URL`, `STRIPE_WEBHOOK_SECRET` |
| `NODE_ENV` | `production` (yes, really — see ADR 0013) | **unset** |
| `RAILWAY_ENVIRONMENT_NAME` | `staging` | `production` |
| Sentry project | `repworth-staging` | **none** — only one project exists org-wide |
| Sentry cron monitor | `health-alert-poller`, environment `staging`, ok | n/a |

**Consequence:** production is still a from-scratch stand-up, and it is a
*provisioning* job before it is a configuration job — see the dependency table in
§5.2 before touching variables. Prove everything on staging first, then clone.

## Historical cloud state (verified 2026-05-29)

- **Vercel — live.** Project `rep-worth` serves `https://repworth.net` (custom
  domain, Node 24). **Preview deployments already fire automatically** on every
  push — the per-PR-preview half of Option 1 already works. Caveats: it's on a
  personal **Hobby** account (non-commercial-use only; isolated per-env vars via
  Custom Environments need **Pro** — see §II.1).
- **Railway — worker NOT deployed.** One empty project, a `production` env, zero
  services. Nothing processes reviews / generates responses / receives webhooks
  in prod yet — `repworth.net` is a front-end with no backend behind it.

**Consequence:** this is a from-scratch worker stand-up, not "add staging to an
existing prod." So **build staging first** (Part II §II.2), prove the whole
pipeline with test creds, then **clone the proven config into production**
(Part II §II.4).

## Target topology

Two fully isolated slices of the *whole* stack. The only things they share are
the Git repo, `railway.toml`, and (optionally) the LLM API keys.

| Layer | Production | Staging | Isolation matters because… |
|---|---|---|---|
| Vercel (UI) | `main` → `repworth.net` | `staging` branch → `staging.repworth.net` (Custom Env) | per-env vars; previews are separate again |
| Railway worker | `production` env | `staging` env (same project) | own variables + deploy history |
| Postgres | prod Supabase project | **separate** staging Supabase project | staging migrations/test data must never touch prod |
| Redis (cache) | prod Upstash (TLS) | separate staging Upstash | Vercel-reachable; low volume (§1.4) |
| Redis (BullMQ queue) | **Railway Redis**, prod env (private net) | **Railway Redis**, staging env | colocated with the worker = no egress; per-env isolation means a staging worker can't touch the prod queue (§1.4) |
| Stripe / Resend / Zernio | **live** keys + webhooks → prod worker | **test/sandbox** keys + webhooks → staging worker | exercise real flows without charging cards, emailing real people, or posting to a real GBP |
| App / worker URLs | `repworth.net` / `worker.repworth.net` | `staging.repworth.net` / free `*.up.railway.app` | webhook signature bases + approval links must match |

## The Option-1 loop

```
                    ┌─────────────────────────── feature/* branch ──────────────────────────┐
                    │                                                                        │
   open PR ─────────▶ Vercel PREVIEW URL (auto, ephemeral)   ← quick FRONTEND check          │
                    │                                                                        │
   need full-stack? ─▶ push/merge into `staging` branch                                      │
                    │        └─▶ Vercel `staging` env  → staging.repworth.net                │
                    │        └─▶ Railway `staging` env → staging worker + test integrations  │
                    │            run §9 smoke as needed                                       │
                    │                                                                        │
   green? ──────────▶ merge the PR into `main`  ◀── THIS is promotion to prod ───────────────┘
                             └─▶ Vercel prod    → repworth.net
                             └─▶ Railway `production` env → prod worker + live integrations
                    then fast-forward `staging` back onto `main` so it never drifts
```

**Promotion rule:** code reaches production by **merging the PR into `main`** —
nothing else. The `staging` branch is an *integration anchor* for the persistent
staging environment, **not** a promotion gate. You never "merge staging → main."
A persistent staging env is needed (rather than relying only on per-PR previews)
because previews are frontend-only and ephemeral — they have no worker, no queue,
and no webhook endpoints, which is exactly what staging must exercise.

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

## Part I — Single-environment deployment recipe (the first production go-live)

> Part I stands up **one** environment end-to-end. You run it twice: first for
> **staging** with test credentials (Part II §II.2), then for **production** with
> live credentials (Part II §II.4). §7–§10 carry the deliberate "one careful first
> post" discipline for your first real customer's GBP — for staging, substitute a
> throwaway test business (Part II §II.2.8).

## §0. What this deployment includes — and what's intentionally off

### IN — live in production

- **Self-serve signup + Stripe billing** (the primary onboarding path). Owners
  register at `/signup`, confirm an emailed OTP, pick a tier, pay via a Stripe
  **Checkout Session**, then complete a profile/voice wizard. Gated by
  `SELF_SERVE_SIGNUP_ENABLED` (§7). Stripe **webhooks are wired** (§6.3).
- **Admin onboarding** (`/admin/businesses/new`) as a **secondary** path for
  internal / demo / manual provisioning (§7B).
- **Zernio ingestion + posting** (`ZERNIO_PUBLISHING_ENABLED=true`).
- **Email approval channel** (Resend → owner inbox): read-only shell, edit/
  regenerate, approve, publish via Zernio.
- **Cost guard, outbox, watchdog, failover poller, archival, weekly/monthly
  digests, multi-location billing** — all on `main`.

### OFF — disabled by flag (a launch decision, not a blocker)

| Feature | Flag | Status |
|---|---|---|
| Telegram channel | `CHANNELS_TELEGRAM_ENABLED=false` | code complete; ⚠️ dev `.env.local` may have this `true` — keep it **OFF** in Railway |
| WhatsApp channel | `CHANNELS_WHATSAPP_ENABLED=false` | code complete; **Meta verification + template already approved** — flip on when ready |
| Ranking tracking | `RANKING_TRACKING_ENABLED=false` | feature not ready; SerpAPI cost |
| Edit existing replies | `EDIT_REPLIES_ENABLED=false` | code complete on `main`; **sole gate** since #678 retired `PAST_REPLIES_VIEW_ENABLED` — the **Reviews list** now renders unconditionally, so this flag alone governs the live-Google mutation |
| Pre-pay demo lane | `ONBOARDING_DEMO_ENABLED=false` | code complete; pre-paywall demo preview + 3-step wizard |
| `MOCK_EXTERNAL_APIS` | **must be `false`** in any deployed env | mock mode no-ops real Zernio / Resend / Stripe |

> `SELF_SERVE_SIGNUP_ENABLED` itself defaults `false`. Its prerequisites — Supabase
> **custom SMTP** and the Stripe price IDs — **are configured**; flip it `true` when
> you're ready to open public signups (§4.2 lists the vars it then requires).

### Deploy from `main`

All features are merged to `main`; Vercel and Railway both build from it — there is
no feature branch to land first. Apply migrations **001→054** (§2).

---

## §1. Pre-deploy provisioning — start 48 h ahead of deploy day

DNS propagation is the long-pole item. Get it started first, do everything else while you wait.

### 1.1 Domain & DNS

`repworth.net` is already registered and **live on Vercel** — production UI serves
at the apex `https://repworth.net`. Production domain map:

  - `repworth.net` (apex) → Vercel (Next.js UI + `/approve/<token>` links)
  - `worker.repworth.net` → Railway (Fastify worker, all `/ingress/*` webhooks)
  - `staging.repworth.net` → Vercel `staging` env (Part II)

- [ ] Add the `worker.` CNAME in your DNS panel once the Railway project exists (§5)
      — Railway gives you the target hostname. The staging *worker* can use the free
      `*.up.railway.app` subdomain (no DNS needed).

### 1.2 Resend & Supabase SMTP (prod already configured)

The Resend domain is verified and **Supabase custom SMTP is already configured**
(host `smtp.resend.com`, port `465`, user `resend`, password = `RESEND_API_KEY`), so
owner-auth emails (signup OTP, reset, invite) send through Resend. For a **fresh**
environment (e.g. staging) you re-do this per project:

- [ ] Confirm/add the domain in Resend (SPF, DKIM, DMARC). On a brand-new domain, DNS verification can take 1–24 h.
- [ ] Set `RESEND_FROM_EMAIL` to a sender on that domain.
- [ ] `RESEND_API_KEY` (`re_…`); `RESEND_WEBHOOK_SECRET` (`openssl rand -hex 32`) — configure the webhook URL in §6 once `WORKER_PUBLIC_URL` exists.
- [ ] `docs/runbooks/email-deliverability.md` covers the warmup curve + bounce/complaint signals.

### 1.3 Supabase production project

> **Local dev DB must never be a deployed project.** `.env.local` `DATABASE_URL`,
> `DATABASE_POOL_URL`, and `NEXT_PUBLIC_SUPABASE_URL` must point at a local
> Supabase stack (`supabase start`), never at the prod or staging project ref.
> With `MOCK_EXTERNAL_APIS=false`, an unmocked `pnpm dev`/`pnpm worker`/seed
> reads AND writes whatever DB these resolve to. (Audit FIND-ENV, 2026-06-23.)

- [ ] Create a **separate** Supabase project for prod. Do not share with dev — schema diffs and test data will haunt you.
- [ ] From Project Settings → Database, capture:
  - `DATABASE_URL` (direct, port 5432) — for transactional writes from Postgres.js
  - `DATABASE_POOL_URL` (Connection Pooler → Transaction mode, port 6543, includes `?pgbouncer=true`) — used by OutboxPoller's CTE
  - `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` (same value)
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable)
  - `SUPABASE_SERVICE_KEY` (server-only — never to browser)
- [ ] Note the `statement_timeout` gotcha: pooler clamps at ~8s. The Postgres.js client overrides to 30s in `src/lib/db/server.ts`. No action needed — just don't accidentally bypass that client.

### 1.4 Redis — Railway for the queue (private networking), Upstash for the cache

> **Why this split — read first.** The original recipe ran **two Upstash
> instances**. BullMQ is relentlessly chatty — ~19 queues, each `Worker` holding
> blocking connections and polling **24/7 even when idle** — and Upstash bills
> **per-command *and* per-byte of egress**. With the worker on Railway and the
> queue on Upstash (two separate clouds), every poll crossed the public internet as
> metered egress. **That is what spiked the bill.** The cache, by contrast, is hit
> only when real work happens (cost-guard reserve/finalize, connect-flow CAS, rate
> limits) — low volume — and it must stay reachable from **Vercel**, which cannot
> join Railway's private network.
>
> | | Lives on | Worker reaches it via | Vercel reaches it via | Egress |
> |---|---|---|---|---|
> | **Queue** (BullMQ) | **Railway Redis** (same project+env as worker) | **private net** (`*.railway.internal`) | never — Vercel enqueues through the Postgres outbox, not BullMQ | **free** |
> | **Cache** | **Upstash** (TLS) | public TLS, low volume | public TLS | small |
>
> Moving the *queue* to Railway private networking removes essentially all the
> egress. The cache stays on Upstash because Railway's stock Redis image has **no
> TLS** — exposing it to Vercel over the TCP Proxy would send the Redis password in
> cleartext over the internet, and bill egress on top. (Going fully off Upstash
> would require a TLS-capable Redis for the cache — a separate decision, not needed
> for launch.)

**`family: 0` — already handled in code; you only append `?family=0` to the URL.**
Railway's private network is **IPv6-only**, and `ioredis`/BullMQ will not resolve
`*.railway.internal` without `family: 0` in the connection options (per Railway's
[library-configuration docs](https://docs.railway.com/networking/private-networking/library-configuration)).
This is already wired: `getRedisOptions()` (`worker/redis-connection.ts`) reads a
`?family=` query param off the Redis URL, so you only need to append `?family=0` to
`REDIS_QUEUE_URL` (vendor-neutral — local/Upstash unaffected). Without it the worker
boots but every BullMQ connection fails with `ENOTFOUND <svc>.railway.internal`. The
cache path stays on Upstash (public, dual-stack) and needs no `family` hint.

**Provision (per environment — do this during §5, after the Railway project exists):**

- [ ] In the **worker's** Railway project/environment: **+ New → Database → Add
      Redis**. One service, name it `redis`. It deploys from the stock `redis`
      Docker image with `noeviction` (Redis default) — keep that; it guarantees a
      full instance errors writes rather than silently evicting BullMQ jobs.
- [ ] **Disable its TCP Proxy** (Settings → Networking). The queue is reached
      **only** by the worker over private networking, so it needs no public
      endpoint — less attack surface, zero egress, no cleartext exposure.
- [ ] Use DB index **1** for the queue (matches `.env.example` / local dev where
      cache=`/0`, queue=`/1`). Only the queue lives here, so the index is cosmetic —
      keep `/1` for stack-wide consistency.

**Wire it (use Railway [reference variables](https://docs.railway.com/variables/reference)
so the URL survives a Redis re-provision):**

- [ ] **Worker `REDIS_QUEUE_URL`** — built from the Redis service's own vars
      (`REDISPASSWORD`, `RAILWAY_PRIVATE_DOMAIN`):
      ```
      REDIS_QUEUE_URL=redis://default:${{redis.REDISPASSWORD}}@${{redis.RAILWAY_PRIVATE_DOMAIN}}:6379/1?family=0
      ```
      Plain `redis://` — no TLS on the private network (Wireguard already encrypts
      it). `getRedisOptions()` branches on `rediss:` vs `redis:`, so this is correct.
- [ ] **Worker `REDIS_CACHE_URL`** — the **Upstash** cache URL (below). The worker
      uses the cache for cost guards + zernio-publisher; that traffic is per-work and
      small.
- [ ] **Vercel `REDIS_CACHE_URL`** — the **same** Upstash cache URL. Vercel needs
      only the cache (never the queue). Vercel needs **no** `REDIS_QUEUE_URL`.
- [ ] **Upstash cache instance** — one instance → `REDIS_CACHE_URL`
      (`rediss://default:<token>@<host>:6379/0`, TLS). If you use the Upstash REST
      `https://` host form, also set `REDIS_CACHE_TOKEN`; the `rediss://` form is
      simpler — prefer it. `REDIS_QUEUE_TOKEN` is unused (Railway needs no token).
- [ ] **Never** point the **worker's** queue URL at the Railway **public proxy**
      (`*.proxy.rlwy.net`) — that re-introduces the exact cross-cloud egress this
      section exists to kill. Worker → queue = private domain, always.

> **Watch in week 1:** Railway Redis memory (service → Metrics) — `noeviction` errors
> writes on a full instance rather than dropping jobs; for one business it sits
> near-empty. Upstash cache command count stays well under the free 10k/day tier now
> that the polling queue no longer lives there.

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
openssl rand -base64 32   # → SESSION_COOKIE_SECRET
openssl rand -base64 32   # → CSRF_SECRET
openssl rand -hex 32      # → IMPERSONATION_COOKIE_SECRET  (admin view-as; ≥32 chars)
```

> Do **not** generate `ENCRYPTION_KEY` / `ENCRYPTION_KEY_VERSION` — they are
> vestigial (no symmetric crypto exists; tokens are SHA-256 *hashed*). See
> `docs/eservices-variables.md`.

---

## §2. Database — apply migrations 001–054

> **Fresh environment (staging, or a prod that mirrors `main`)?** Apply the full set
> **001→054**. Migrations 018, 023, 026, 031, 065 build indexes `CONCURRENTLY` and must
> run **outside** a transaction; check `.claude/reference/migrations-log.md` for
> per-migration handling. See §II.2.1.

- [ ] In Supabase SQL editor, run each `supabase/migrations/0XX_*.sql` **in numeric order, 001→054**. Per CLAUDE.md / user feedback memory, Claude does not run these for you — you run them, in the editor, and check the result.
- [ ] **Non-transactional migrations:** 018, 023, 026, 031, and 065 use `CREATE INDEX CONCURRENTLY`, which **cannot** run inside a transaction block — run each of those on its own (not wrapped in `BEGIN/COMMIT`). See `.claude/reference/migrations-log.md` for per-migration handling.
- [ ] Pre-flight before 029 (idempotent — should be 0 in a fresh DB):
  ```sql
  SELECT COUNT(*) FROM responses WHERE status = 'awaiting_manual_post';
  -- expect: 0
  ```
- [ ] Verification queries after running all 54:
  ```sql
  -- All tables present
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
  ORDER BY table_name;
  -- expect: ~50 tables including reviews, responses, businesses, accounts, users,
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

### §2a. Applying new migrations after go-live — the standing procedure

There is deliberately **no migration runner** (deep-scan §3.8 — deferred until
manual application becomes error-prone; revisit if migration cadence or team
size grows). Every migration is applied by hand in the Supabase SQL editor,
following this procedure exactly:

1. **Read `.claude/reference/migrations-log.md` first** — it is authoritative
   for the current head, per-migration handling notes, and pre-flight checks.
2. **Numeric order, no gaps.** Apply `0XX_*.sql` files strictly in ascending
   order. Never skip ahead; never apply out of order.
3. **Both projects, staging first.** Every migration runs against the staging
   Supabase project, gets verified there, then runs against production —
   in lockstep. "Applied to prod, not staging" (or the reverse, left to
   linger) is a bug.
4. **`CREATE INDEX CONCURRENTLY` cannot run in a transaction.** Migrations
   containing it (018, 023, 026, 031, 065, and any future ones) carry a header
   warning and must be applied with the SQL editor's **"single transaction"
   box unchecked** (or each statement run individually). Convention going
   forward: CONCURRENTLY statements live in clearly-flagged **standalone**
   migration files (no mixed transactional DDL) — migration 065 is the
   template.
5. **If a CONCURRENTLY statement fails partway**, it can leave an `INVALID`
   index behind. Check and repair before re-running:
   ```sql
   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
   -- DROP INDEX <name>; then re-run the CREATE INDEX CONCURRENTLY statement
   ```
6. **Verify, then log.** Run the migration's verification query (or
   `pg_indexes`/`information_schema` spot-check) on each project, and confirm
   the migration has its entry in `.claude/reference/migrations-log.md`
   (the entry lands in the same PR as the migration file).

---

## §3. Code prep

- [ ] Deploy from `main` — all features are merged; there's no feature branch to land first. Run `pnpm test` on `main` before deploy (the full suite also gates CI on every PR).
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

Set in Project Settings → Environment Variables, scope **Production** (give the
`staging` Custom Environment its own set — Part II §II.3). Full per-var reference:
`.env.example` + `docs/eservices-variables.md`.

**Public (browser-safe):**
```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_APP_URL=https://repworth.net
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY    # PlaceAutocomplete in the onboarding wizard
NEXT_PUBLIC_SENTRY_DSN              # optional
```

**Server-only (Vercel routes: DB, auth, signup, Stripe Checkout):**
```
DATABASE_URL
DATABASE_POOL_URL
SUPABASE_URL
SUPABASE_SERVICE_KEY
REDIS_CACHE_URL                    # Upstash cache (TLS) — required when self-serve signup is on
SESSION_COOKIE_SECRET
CSRF_SECRET
IMPERSONATION_COOKIE_SECRET        # admin view-as
ADMIN_NOTIFICATION_EMAIL
RESEND_FROM_EMAIL
CONTACT_NOTIFY_TO                  # recommended — where /contact + lead emails land
WORKER_PUBLIC_URL=https://worker.repworth.net
SENTRY_DSN                         # optional
```

**Stripe (required when `SELF_SERVE_SIGNUP_ENABLED=true` — `/onboarding/pay` builds the Checkout Session):**
```
STRIPE_SECRET_KEY
STRIPE_PRICE_BASIC
STRIPE_PRICE_STANDARD
STRIPE_PRICE_STANDARD_OVERAGE
STRIPE_PRICE_PREMIUM
STRIPE_PRICE_PREMIUM_OVERAGE
STRIPE_PRICE_FOUNDING
STRIPE_PRICE_FOUNDERS_OVERAGE
```

**Flags:**
```
SELF_SERVE_SIGNUP_ENABLED=true     # the live onboarding path — set false to close signups
ZERNIO_PUBLISHING_ENABLED=true
MOCK_EXTERNAL_APIS=false
# MULTI_LOCATION_ENABLED, ONBOARDING_DEMO_ENABLED, … — server-authoritative; see .env.example
```

### 4.3 First deploy

- [ ] Click Deploy. Watch the build log for missing-env-var crashes.
- [ ] Confirm the domain resolves under Project → Settings → Domains (`repworth.net` is already attached in prod; for a fresh env attach `staging.repworth.net`).
- [ ] Smoke:
  ```
  curl -I https://repworth.net/
  # expect: 200 OK + security headers (Strict-Transport-Security, X-Content-Type-Options)
  ```
- [ ] Visit `/admin/login` — form renders; log in with the admin user from §2 → `/admin/overview`.
- [ ] If `SELF_SERVE_SIGNUP_ENABLED=true`: visit `/signup` — the form renders (a 404 means the flag is off).

---

## §5. Railway deploy (worker)

### 5.1 Create project

- [ ] In Railway, "New Project" → "Deploy from GitHub repo" → select repo + branch `main`.
- [ ] Service name: `repworth-worker` (or similar).
- [ ] **Start command:** `pnpm worker` (Settings → Service → Start Command).
- [ ] **Health check path:** `/api/health` (Settings → Networking → Health Check). Railway will probe this; 200 = ready.
- [ ] **Port:** Railway auto-injects `PORT`; the Fastify server reads it and binds `0.0.0.0:$PORT`. No action needed.
- [ ] Don't deploy yet — set env vars first.
> **Builder:** `railway.toml` pins **RAILPACK** (not Nixpacks). Nixpacks 1.41 installs
> `corepack@0.24.1`, which is incompatible with Node 24's vm API and crashes pnpm at
> `pnpm install` (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`). RAILPACK installs Node 24 +
> pnpm 11 via mise. The worker's `next build` is overridden to a no-op `buildCommand` —
> tsx runs `worker/index.ts` at runtime, so no build artifact is needed.

### 5.2 Railway env vars

Paste the entire block. Adjust values to match what you provisioned in §1.

> **Read before attempting a production worker deploy (state as of 2026-07-28).**
> The Railway **`production`** environment is missing four of the variables below:
> **`SENTRY_DSN`**, **`ADMIN_NOTIFICATION_EMAIL`**, **`REDIS_QUEUE_URL`** and
> **`STRIPE_WEBHOOK_SECRET`**. The production worker has never been successfully
> deployed, so nothing has been exercised against that variable set. These are
> **required and currently absent** — set them before the first prod deploy.
>
> Two of them are hard boot gates that will now actually fire. Until the
> #610/#611 deployment-lane fix, the boot gates keyed off `NODE_ENV`, which
> production Railway leaves **unset** — so `assertAlertSinkEnv` (`SENTRY_DSN`)
> and `assertAdminNotificationEmail` (`ADMIN_NOTIFICATION_EMAIL`) returned early
> and were inert in production. They now key off the deployment lane
> (`RAILWAY_ENVIRONMENT_NAME`, ADR 0013) and will refuse to start a production
> worker without those two values. That is the gates working, not a new defect —
> but it means a prod deploy attempted with today's variable set fails at boot.
>
> **Update 2026-08-10 — the boot-gate set is wider than the callout above.**
> `assertWorkerStartupEnv` (`worker/config/startup-assert.ts`) also
> hard-requires, outside mock mode: the full Stripe env
> (`assertStripeWorkerEnv` — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
> every `STRIPE_PRICE_*`) and both tier cost limits
> (`assertTierDailyCostLimitsConfigured` — `DAILY_COST_LIMIT_CENTS_COPILOT`/
> `_AUTOPILOT`). Consequence: the FIRST production worker deploy is only
> possible inside the WS8 cutover sequence, after live Prices + the webhook
> secret exist — ordering owned by
> `docs/runbooks/beta-production-standup.md` Phase D.
>
> `RAILWAY_ENVIRONMENT_NAME` itself needs no action: Railway injects it.
>
> **Two of the four cannot simply be "set" — the thing they point at does not
> exist yet** (verified against Railway and Sentry, 2026-07-28). Treating this as
> a four-variable config task will fail. The real dependency order:
>
> | # | Provision first | Then it yields | Who |
> |---|---|---|---|
> | 1 | A **production Sentry project**. Only `repworth-staging` exists today, so there is no correct DSN to paste — pointing prod at the staging project files production errors under a project named "staging". | `SENTRY_DSN` | you (team/alert routing is a judgement call) |
> | 2 | A **Redis service in the Railway `production` environment**. That env currently contains **only** `repworth-worker` (Offline) and **no database at all**; staging has `redis`. `REDIS_QUEUE_URL` is a Railway *reference* (`${{redis.…}}`), so with no `redis` service the reference cannot resolve. Delete its TCP proxy (private-net only) and keep **`?family=0`** — the Railway private network is IPv6-only and ioredis silently fails to connect without it. | `REDIS_QUEUE_URL` | provisioning step, incurs cost |
> | 3 | A **production Stripe webhook endpoint** pointed at the prod worker's `/ingress/stripe`. The signing secret is shown once, at creation. **Do not copy staging's** — a wrong secret fails signature verification silently. Keep the endpoint's API version in lockstep with the pinned `apiVersion` in `stripe-client.ts`. | `STRIPE_WEBHOOK_SECRET` | you (Stripe dashboard) |
> | 4 | A decision about who receives production alerts. | `ADMIN_NOTIFICATION_EMAIL` | you |
>
> Only after 1–4 does setting the variables and deploying make sense. The boot
> gates then either pass or fail loudly naming the missing variable **and its
> resolved lane** — which is the whole point of #611. Before this change a prod
> worker could start half-configured with paging silently inert.

**Database + Redis:** (split per §1.4 — queue on Railway private net, cache on Upstash)
```
DATABASE_URL=...
DATABASE_POOL_URL=...
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
REDIS_CACHE_URL=rediss://default:...@...upstash.io:6379/0                                                     # Upstash, TLS — cache only
REDIS_QUEUE_URL=redis://default:${{redis.REDISPASSWORD}}@${{redis.RAILWAY_PRIVATE_DOMAIN}}:6379/1?family=0    # Railway Redis, private net — queue
```
> `?family=0` is required (Railway private net is IPv6-only; needs the one-line
> `getRedisOptions()` change flagged in §1.4). Never point the worker's queue URL at
> the Railway public proxy — that's the egress trap. Vercel needs no `REDIS_QUEUE_URL`.

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

**Stripe (required when `SELF_SERVE_SIGNUP_ENABLED=true`):**
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=<from the Stripe endpoint you add in §6.3>
STRIPE_PRICE_BASIC=price_...
STRIPE_PRICE_STANDARD=price_...
STRIPE_PRICE_STANDARD_OVERAGE=price_...
STRIPE_PRICE_PREMIUM=price_...
STRIPE_PRICE_PREMIUM_OVERAGE=price_...
STRIPE_PRICE_FOUNDING=price_...
STRIPE_PRICE_FOUNDERS_OVERAGE=price_...
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

**Reviews (SerpAPI) — required; the worker imports it eagerly at boot:**
```
SERPAPI_API_KEY=...
```
> `src/lib/demos/fetch-reviews.ts` throws at **module load** when `MOCK_EXTERNAL_APIS=false`
> and this is unset — a hard boot failure, not a feature gate. The worker pulls it in via the
> onboarding-demo path; it's also used for Place-ID resolution, prefill, and `RankingTrackingWorker`.
> (See `.claude/reference/env-vars.md` → "Reviews (SerpAPI)".)

**App URLs:**
```
NEXT_PUBLIC_APP_URL=https://repworth.net
WORKER_PUBLIC_URL=https://worker.repworth.net     # no trailing slash, must match provider dashboards exactly
```

**Security:**
```
SESSION_COOKIE_SECRET=...
CSRF_SECRET=...
IMPERSONATION_COOKIE_SECRET=...   # admin view-as (≥32 chars)
```

**Feature flags:**
```
SELF_SERVE_SIGNUP_ENABLED=true     # live onboarding path (requires REDIS_CACHE_URL + all 7 STRIPE_PRICE_*)
CHANNELS_SMS_ENABLED=false
CHANNELS_TELEGRAM_ENABLED=false
CHANNELS_WHATSAPP_ENABLED=false    # code + Meta approval done; flip on when ready
RANKING_TRACKING_ENABLED=false
MOCK_EXTERNAL_APIS=false
```

**Observability — REQUIRED on any deployed lane (staging + production):**
```
SENTRY_DSN=...
```
> Not optional. `assertAlertSinkEnv` (`worker/config/startup-assert.ts`) is a hard
> boot gate on every deployed Railway lane — Sentry is the mandatory **non-email**
> P0/P1 paging sink (ADR 0005; wiring in `docs/runbooks/beta-launch-alerting.md`
> §1). **Currently absent in Railway `production`** — see the callout at the top
> of §5.2.

### 5.3 First deploy

- [ ] Push the deploy. Watch logs for the startup-assert lines:
  ```
  [startup-assert] zernio: ZERNIO_API_KEY ✓
  [startup-assert] zernio: ZERNIO_WEBHOOK_SECRET ✓
  [startup-assert] zernio: WORKER_PUBLIC_URL ✓
  [startup-assert] zernio: NEXT_PUBLIC_APP_URL ✓
  ```
  If any are missing, the worker exits with code 1. Fix the env var, redeploy.
- [ ] Add the custom domain (`worker.repworth.net`) under Settings → Networking. Wait for the cert.
- [ ] Smoke:
  ```
  curl https://worker.repworth.net/api/health
  # expect: {"status":"ok","timestamp":"..."}
  ```

---

## §6. Webhook wiring — only possible after §5 (URLs needed)

### 6.1 Resend webhook

- [ ] In Resend dashboard → Webhooks → Add endpoint.
- [ ] URL: `https://worker.repworth.net/ingress/resend`
- [ ] Signing secret: **Resend generates a Svix `whsec_…`** when you create the endpoint — copy it into the worker's `RESEND_WEBHOOK_SECRET` (NOT openssl/§1.2). Newer Resend has no per-endpoint "Send test"; fire the webhook by sending a real email (e.g. Resend API).
- [ ] Events: `email.delivered`, `email.bounced`, `email.complained`, `email.opened` (the worker handles these — see `worker/ingress/resend.ts`).
- [ ] Click "Send test" → check Railway logs for `[ingress/resend] processed`.

### 6.2 Zernio webhook

- [ ] In Zernio dashboard → Webhooks (per `zernio-launch-runbook.md` §2.2).
- [ ] URL: `https://worker.repworth.net/ingress/zernio` (exact, no trailing slash).
- [ ] Signing secret: paste `ZERNIO_WEBHOOK_SECRET` from §1.5.
- [ ] Subscribed events:
  - `account.disconnected` (required — drives connection-lost emails)
  - `account.connected` (defensive observability)
  - `webhook.test`
  - `review.new`, `review.updated` (required — these drive ingestion)
- [ ] Fire test webhook from Zernio dashboard. Verify in Railway logs: `[ingress/zernio] webhook.test received eventId=<uuid>`.
- [ ] Verify in Supabase:
  ```sql
  SELECT id, source, event_type, status, received_at
  FROM inbound_events
  WHERE source = 'zernio'
  ORDER BY received_at DESC LIMIT 1;
  -- expect: status='processed', event_type='webhook.test'
  ```

If you get 401 `invalid_signature`, see `zernio-launch-runbook.md` §5.1–5.2 — most common cause is webhook-secret mismatch between Zernio dashboard and Railway env.

### 6.3 Stripe webhook (required when self-serve signup is on)

- [ ] In Stripe dashboard → Developers → Webhooks → Add endpoint.
- [ ] URL: `https://worker.repworth.net/ingress/stripe`
- [ ] Copy the signing secret → set `STRIPE_WEBHOOK_SECRET` on the **worker** (§5.2).
- [ ] Subscribed events (handled in `worker/ingress/stripe.ts`):
  - `checkout.session.completed` — activates the account (`subscription_status='active'`, records `subscription_activated_at`)
  - `invoice.paid`, `invoice.payment_failed`
  - `customer.subscription.updated`, `customer.subscription.deleted`
- [ ] "Send test" `checkout.session.completed` → check Railway logs + verify the `accounts` row transitions. For staging, use Stripe **test mode** + the Stripe CLI (`stripe listen --forward-to <stagingWorker>/ingress/stripe`).

---

## §7. Onboarding your first customer

Two paths now exist — **self-serve is the live one**; admin is for internal/demo use.

### 7A. Self-serve signup (primary, live path)

With `SELF_SERVE_SIGNUP_ENABLED=true`, an owner onboards themselves end-to-end —
no admin action needed (`src/app/api/auth/*`, `src/app/onboarding/*`):

1. `/signup` → email + password → confirmation email with a 6-digit OTP.
2. `/signup/check-email` → enter the OTP (`/api/auth/verify-otp`).
3. `/onboarding/pay` → pick a tier → server builds a Stripe **Checkout Session** (`/api/onboarding/select-plan`) → Stripe-hosted payment.
4. Payment → `checkout.session.completed` webhook (§6.3) flips the `accounts` row to `subscription_status='active'` and records `subscription_activated_at`.
5. `/onboarding/business` → profile + brand-voice wizard → **Connect Google Business** (Zernio OAuth, §8) → `/dashboard`.

Tiers (`src/lib/accounts/tier-config.ts`): basic $29 (1 loc) · standard $79 (1 loc, +$25/loc) · premium $199 (5 loc, +$20/loc) · founders $19 (1 loc, +$25/loc). Billing parent = `accounts`; each location = a `businesses` row.

### 7B. Admin onboarding (secondary — internal / demo / manual)

For staff, demos, or a manually-provisioned customer, use `/admin/businesses/new`
(`/api/admin/businesses` → `onboardBusinessAsAdmin`). It creates the auth user
(pre-confirmed), the `users` + `accounts` + `businesses` rows, and emails an invite —
no OTP flow.

If you onboard a customer this way **without** taking payment, set the subscription
active manually so workers process it:
```sql
UPDATE accounts
SET subscription_status = 'active',
    subscription_activated_at = NOW(),
    stripe_customer_id = 'manual-no-stripe',
    updated_at = NOW()
WHERE id = '<account-id>';
```
(Verify: `SELECT id, subscription_status FROM accounts WHERE id = '...'`.) Self-serve
customers skip this — the Stripe webhook activates them. Confirm `place_id_verified
= true` on the location; if false, follow `operational-runbook.md` §A5.

⚠️ **Do NOT trigger the SerpAPI initial sync** — Zernio is the ingestion source. The first reviews arrive via Zernio backfill (§8) + steady-state webhooks. A stray `sync_reviews` outbox row will no-op or pull stale data — leave it alone.

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
| Worker health | `curl https://worker.repworth.net/api/health` | `{"status":"ok",...}` |
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
- [ ] Upstash **cache** command count (free tier 10K/day — comfortable now the BullMQ queue lives on Railway, not Upstash).
- [ ] Railway Redis (queue) **memory** in the service Metrics tab — `noeviction` means a full instance errors writes; for one business it stays near-empty.
- [ ] OpenAI / Anthropic spend trend.
- [ ] Zernio API rate limit headroom — Build tier is 600 req/min; one business won't approach this.
- [ ] `SELECT * FROM zernio_finalize_incidents WHERE resolved_at IS NULL` — must always be 0 rows. Any row → `zernio-launch-runbook.md` §6.

Per-customer issues: see `operational-runbook.md` §A1–A5.

---

## §12. Things you didn't ask about that matter

These are the items not covered above that I'd want to know before hitting deploy.

1. **Resend + Supabase SMTP are already configured for prod** (§1.2). For a **fresh** environment (e.g. staging) the domain's SPF/DKIM/DMARC records lag 1–24 h — add them first so the first approval email actually delivers.

2. **The friend's email might silently bounce.** Some corporate inboxes greylist new senders. Send a non-RepWorth test email from `notifications@yourdomain.com` to the friend's address before the smoke test, and ask him to confirm receipt + check spam.

3. **Mobile UX of the approval link.** The approval page targets <2s LCP and was tested at 283ms unthrottled (`smoke-test-checklist.md`). But test it on the friend's actual phone — slow 3G + a budget Android with battery saver can be 5x worse. He'll click on his phone, not desktop.

4. **Time zones for cron jobs.** Weekly digest fires Monday 8–9 AM **UTC**. Monthly impact fires the 1st 9–10 AM UTC. If the friend is in PST and you don't disable these (§10.6), he gets emails at midnight Sunday / 1 AM the 1st. Disabling is friendlier.

5. **Backups.** Supabase takes automatic daily physical backups (7 days on Pro); PITR is an add-on for to-the-second recovery. Restore procedure — the safe clone-to-new-project drill, the destructive in-place path, and integrity checks — is in **`pitr-restore-drill.md`**. Never run an in-place restore as a test on the prod project; drill via *Restore to a New Project*.

6. **Cost ceiling for first month.** With one business, ~$10/mo of OpenAI + Anthropic + Resend. Set OpenAI hard limit at $20 in their dashboard — it caps spend at the API level even if our cost guard breaks.

7. **Friend can't unsubscribe from approval emails by accident.** Approval emails don't include a List-Unsubscribe header (intentional — they're transactional, not marketing). But if the friend marks one as spam, his domain might start filtering all of them. Tell him in advance: "If a draft is bad, regenerate or edit — don't mark spam."

8. **Approval-link prefetch by email scanners.** GET is read-only by design (`approval-security.md`). Even if Gmail/Outlook prefetches the URL when opening the email, no state changes. Approval requires POST + device-cookie + CSRF. This is correct; don't worry about it. But it means: the friend MUST open the link from his phone (or any browser), not approve it from a click in the email preview pane.

9. **Stripe webhooks are wired (§6.3).** Self-serve customers get `subscription_activated_at` automatically from `checkout.session.completed`. Only the **admin-onboarded-without-payment** path (§7B) needs the manual SQL `UPDATE`. Anything keyed on that timestamp (engagement monitor, onboarding drip) fires from whatever set it; the onboarding drip fires day 1 / 7 / 30. Gate: `worker/background/schedulers/OnboardingDripScheduler.ts`.

10. **Migrations run 001→054, and five use `CONCURRENTLY`.** Migrations 018, 023, 026, 031, and 065 build indexes with `CREATE INDEX CONCURRENTLY`, which **must not** run inside a transaction block — apply each on its own. Do **not** stop at 030 (old beta scope); a current environment needs the full set. See `.claude/reference/migrations-log.md`.

11. **Everything is on `main`.** Vercel and Railway both deploy from `main`; there's no feature branch to merge first. Staging tracks the `staging` branch (Part II §II.5).

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

---

## Part II — Staging & production: two environments + promotion

Part I is the recipe for one environment. Part II applies it twice (staging
first, then prod) and adds the ongoing release loop. The orientation at the **top
of this guide** already covers the current cloud state, the target topology, the
Option-1 loop, and the "build staging first" sequencing — Part II is the
operational detail.

Cross-references: `rollback.md`, `smoke-test-checklist.md`, and
`security-scan-staging.md` are separate runbooks (not folded in here);
"§N" / "§N.M" without a "II" prefix means **Part I**.

## §II.1 Prerequisites & plan decisions (do these once)

- [ ] **Vercel Pro** (~$20/mo). Custom Environments with isolated per-env
      variables require Pro; Hobby only has Production/Preview/Development scopes
      and is non-commercial-use only. *Hobby fallback (not recommended):* assign
      `staging.repworth.net` to the `staging` branch under Settings → Domains and
      accept that Preview env vars are shared across all preview branches.
- [ ] **Railway** bills by usage and you'll run two always-on workers — enable
      **App Sleeping** on the *staging* worker (no real traffic, so idling is free
      money). Leave the production worker always-on.
- [ ] **DNS:** add a `staging` CNAME → Vercel (target shown when you attach the
      domain in §II.2.6). The staging *worker* can use the free Railway
      `*.up.railway.app` subdomain — no DNS needed for it.
- [ ] **Google Maps key** is referrer-locked: add `https://staging.repworth.net/*`
      to the existing `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`'s allowed referrers (or
      mint a separate staging key), or PlaceAutocomplete silently breaks on staging.

## §II.2 Build staging first (the tracer bullet)

Run **Part I** end-to-end with **test/sandbox** credentials. Below are only the
staging-specific deltas from Part I's prod recipe.

### §II.2.1 Staging Supabase — separate project
- Create a new project `repworth-staging`. Apply **all migrations `001`→`054`** in
  numeric order (Part I §2 shows the SQL-editor procedure + verification queries).
  Run the `CONCURRENTLY` migrations (018, 023, 026, 031, 065) **outside** a transaction;
  see `.claude/reference/migrations-log.md`.
- Capture `DATABASE_URL` (direct, 5432), `DATABASE_POOL_URL` (pooler, 6543,
  `?pgbouncer=true`), `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`. Seed a staging admin
  user (Part I §2 last step).

### §II.2.2 Staging Redis — Railway queue (staging env) + Upstash cache
- **Queue:** add a **Redis service to the Railway `staging` environment** (§1.4
  provisioning). Because Railway private networking is **per-environment isolated**,
  the staging worker physically cannot reach the prod queue — that isolation is now
  structural, not just a different URL. Wire `REDIS_QUEUE_URL` to its private domain
  with `?family=0`, TCP Proxy off.
- **Cache:** a **separate staging Upstash** instance → `REDIS_CACHE_URL`
  (`rediss://`, TLS). **Never** reuse the prod cache instance.

### §II.2.3 Staging integrations — test/sandbox mode
- **Stripe:** test-mode `STRIPE_SECRET_KEY` (`sk_test_…`); recreate the 7
  `STRIPE_PRICE_*` in test mode; the test `STRIPE_WEBHOOK_SECRET` comes from the
  staging endpoint in §II.2.7.
- **Resend:** a **staging sender** (separate verified subdomain) so staging mail
  can never reach a real customer; separate `RESEND_WEBHOOK_SECRET`.
- **Zernio:** sandbox `ZERNIO_API_KEY`, `ZERNIO_API_BASE` = sandbox base if Zernio
  provides one, and **`ZERNIO_PROFILE_ID_PREFIX=repworth-staging-`** — a hard
  requirement, not a nicety: it stops staging and prod colliding on Zernio profile
  names in the same workspace.
- **LLM:** reusing the prod `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` is fine if you
  set a **low** staging `GLOBAL_DAILY_COST_LIMIT_CENTS` (e.g. `200` = $2/day) as a
  circuit breaker. Separate keys give cleaner cost attribution.

### §II.2.4 Staging secrets — generate fresh (never reuse prod)
A leaked staging secret must never unlock a prod session/token:
```bash
openssl rand -base64 32  # SESSION_COOKIE_SECRET
openssl rand -base64 32  # CSRF_SECRET
openssl rand -hex 32     # IMPERSONATION_COOKIE_SECRET
```

### §II.2.5 Railway `staging` environment + worker
- In the Railway project, create a second environment named **`staging`**
  (`railway environment new staging`, or the dashboard).
- Deploy the worker into it from GitHub. `railway.toml` is shared across
  environments, so `startCommand = pnpm worker`, `healthcheckPath = /api/health`,
  and the `ON_FAILURE` restart policy already apply — you only set **variables**
  per environment.
- Point the staging env's deploy trigger at the **`staging` branch**.
- Generate a public domain (free `*.up.railway.app` is fine) → this is the staging
  `WORKER_PUBLIC_URL`.
- Deploy; confirm the `[startup-assert] … ✓` lines and
  `curl <stagingWorker>/api/health` → `{"status":"ok",…}`.

### §II.2.6 Vercel `staging` Custom Environment
- Create a Custom Environment `staging`, deploying from the **`staging` branch**,
  with its own variable set (the §II.3 matrix).
- Attach `staging.repworth.net` (+ the CNAME Vercel shows you).
- Set `NEXT_PUBLIC_APP_URL=https://staging.repworth.net` and
  `WORKER_PUBLIC_URL` to the staging worker URL.

### §II.2.7 Wire staging webhooks → the staging worker
Point each *test/sandbox* provider at the staging worker (Part I §6 = the exact
dashboard steps + verification queries): `<stagingWorker>/ingress/stripe`,
`/ingress/resend`, `/ingress/zernio`. Telegram / WhatsApp flags are OFF —
skip their ingress.

### §II.2.8 Prove the whole pipeline on staging
Run **Part I §9** (or `smoke-test-checklist.md`) end-to-end on staging with a
**throwaway test business** — never a real GBP: ingest → generate → moderate →
approval email → approve → publish to a sandbox/test location. When this is
green, staging is real and you're ready for §II.4.

## §II.3 Staging ↔ production env-var matrix (values that MUST differ)

Everything else from `.env.example` can hold the same shape; **these are wrong if
they ever match across environments.** Staging column → Vercel `staging` + Railway
`staging`; prod column → Vercel Production + Railway `production`.

| Var | Staging | Production |
|---|---|---|
| `DATABASE_URL` / `DATABASE_POOL_URL` | staging Supabase | prod Supabase |
| `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` | staging Supabase | prod Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_KEY` | staging Supabase | prod Supabase |
| `REDIS_CACHE_URL` | staging Upstash | prod Upstash |
| `REDIS_QUEUE_URL` | Railway Redis, `staging` env (private, `?family=0`) | Railway Redis, `production` env (private, `?family=0`) |
| `NEXT_PUBLIC_APP_URL` | `https://staging.repworth.net` | `https://repworth.net` |
| `WORKER_PUBLIC_URL` | staging worker URL | prod worker URL |
| `STRIPE_SECRET_KEY` | `sk_test_…` | `sk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | staging endpoint secret | prod endpoint secret |
| `STRIPE_PRICE_*` (×7) | **test-mode** price IDs | live price IDs |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | staging sender | prod sender |
| `RESEND_WEBHOOK_SECRET` | staging endpoint secret | prod endpoint secret |
| `ZERNIO_API_KEY` / `ZERNIO_WEBHOOK_SECRET` | sandbox + staging endpoint | live + prod endpoint |
| `ZERNIO_PROFILE_ID_PREFIX` | `repworth-staging-` | `repworth-prod-` (default) |
| `SESSION_COOKIE_SECRET`, `CSRF_SECRET`, `IMPERSONATION_COOKIE_SECRET` | fresh staging values | distinct prod values |
| `GLOBAL_DAILY_COST_LIMIT_CENTS` | low (e.g. `200`) | real ceiling |
| Sentry `environment` tag *(derived — see note)* | `staging` | `production` |
| `WHATSAPP_APPROVAL_URL_BASE` *(only if WhatsApp ever on)* | `https://staging.repworth.net/approve/` | `https://repworth.net/approve/` |

> The Sentry `environment` tag is **not an env var — do not set one.**
> `worker/sentry.ts` derives it from the deployment lane via `deploymentLane()`
> (`src/lib/config/deployment-lane.ts`), which reads Railway's injected
> `RAILWAY_ENVIRONMENT_NAME`. It used to be derived from `NODE_ENV` — which is
> `production` on staging — so every staging event was tagged `production`.
> That is #610; see ADR 0013. The row stays in this matrix because the *values*
> must still differ, and a matching pair is the symptom of the bug returning.

> `WHATSAPP_APPROVAL_URL_BASE` has a boot-time assertion that it equals
> `NEXT_PUBLIC_APP_URL + '/approve/'`. If you ever enable WhatsApp, a mismatched
> base = the worker refuses to start. It's off today; listed for completeness.

## §II.4 Clone staging → production

Once §II.2.8 is green, run **Part I once more** for the `production` environment,
swapping in **live** credentials and the prod column of §II.3:

- [ ] Production Supabase already backs `repworth.net`; apply any migrations it's
      behind on (compare its head to `054`), in numeric order.
- [ ] Railway `production` env: deploy the worker, set the prod variable set,
      attach `worker.repworth.net` (or keep the Railway subdomain).
      **First set the four variables the prod environment is missing today —
      `SENTRY_DSN`, `ADMIN_NOTIFICATION_EMAIL`, `REDIS_QUEUE_URL`,
      `STRIPE_WEBHOOK_SECRET` (§5.2 callout).** The first two are hard boot
      gates; a deploy without them fails at startup.
- [ ] Vercel Production: set `WORKER_PUBLIC_URL` to the prod worker; flip live keys.
- [ ] Re-point the **live** Stripe/Resend/Zernio webhooks at the **prod** worker
      (Part I §6). These are separate dashboard endpoints from the staging ones —
      staging webhooks stay pointed at the staging worker.
- [ ] Run Part I §7–§10 (onboard the first real business; the deliberate "one
      careful post" discipline §9.6 / §10) against production.

## §II.5 Ongoing workflow (the Option-1 loop)

1. **Branch** off `main`, build the feature, **open a PR.** Vercel posts a preview
   URL automatically — use it for a quick **frontend** review.
2. **Frontend-only change?** PR preview is enough → review → merge to `main`.
3. **Touches the worker, a webhook, a migration, or billing?** Get it onto the
   **`staging` branch** (`git push origin HEAD:staging`, or merge the feature
   branch into `staging`). Vercel + Railway redeploy staging; test the full flow on
   `staging.repworth.net` (run the relevant slice of §9).
   - New migration? Apply it to the **staging Supabase** first and verify there
     before it ever runs against prod.
4. **Green on staging?** Merge the **PR into `main`.** Vercel ships `repworth.net`;
   Railway `production` redeploys the worker. **This is the promotion.**
5. **Re-sync staging** so it never drifts:
   - **If staging was behind `main`** (e.g. a frontend-only change that skipped the
     step-3 side trip): `git checkout staging && git merge --ff-only main && git push`.
   - **If you pushed your feature to staging in step 3 and the PR was squash-merged**
     (the default), `staging` now holds your raw feature commits while `main` holds a
     single squashed commit — the two have **diverged**, so `--ff-only` aborts with
     *"Not possible to fast-forward."* Reset staging to match `main` instead:
     ```
     git fetch origin
     git checkout staging
     git reset --hard origin/main
     git push --force-with-lease origin staging
     ```
     This is safe because **staging is a disposable integration anchor, not a source
     of truth** — nothing of value lives only on staging, so realigning it to `main`
     loses nothing. After this, `staging == main` again and the next
     `git push origin HEAD:staging` fast-forwards cleanly.

**Two databases in lockstep:** every migration runs against **both** Supabase
projects, in numeric order, **staging first**. "Applied to staging, not yet prod"
is the normal mid-flight state; "applied to prod, not staging" is a bug to fix
immediately.

## §II.6 Promotion safety & rollback

- **Rollback** of either environment is owned by `rollback.md`. Vercel: instant
  redeploy/rollback to a previous deployment. Railway: redeploy a previous
  deployment for the affected environment.
- **Kill switch** (per env, independent): set `ZERNIO_PUBLISHING_ENABLED=false` on
  that environment's worker and redeploy — ingress returns 503 and the publisher
  stops calling Zernio (same switch as §10.5; already-posted replies stay posted).
- **Boot-prerequisite trap:** a missing required env var (e.g.
  `ADMIN_NOTIFICATION_EMAIL`, or any asserted secret) is a deterministic boot
  failure that exhausts `restartPolicyMaxRetries` and stays down. When a
  freshly-cloned environment won't boot, check the `[startup-assert]` lines first
  (`rollback.md §3`).
- **Never** cross webhook wires: a sandbox webhook → prod worker (or live → staging)
  fails closed with `401 invalid_signature` because secrets differ per env — but a
  crossed *Stripe live → staging* wire could mis-handle a real payment against test
  data. Re-verify the webhook → worker mapping after any URL change.

## §II.7 Cost & hygiene

- **Staging worker sleeps when idle** (§II.1) — wake it by hitting
  `staging.repworth.net` or `<stagingWorker>/api/health` before a test session.
- **Staging cost ceiling stays low** (`GLOBAL_DAILY_COST_LIMIT_CENTS` ≈ `200`).
- **Staging never emails real customers** — staging Resend sender + test data only.
  If you copy prod data into staging to debug, scrub real owner emails first.
- Two Supabase free projects are fine for staging + a small prod beta. The Upstash
  **cache** now stays well under the 10k-commands/day free tier — the chatty BullMQ
  **queue** moved to Railway (§1.4), so it no longer burns Upstash commands/egress.
  Watch Railway Redis **memory** (Metrics) instead; `noeviction` errors writes on a
  full instance rather than dropping jobs.
- Run `security-scan-staging.md` against `staging.repworth.net` once it's live —
  that's its intended target.

## §II.8 Staging sign-off

Staging is real when:
- [ ] §II.2.5 staging worker boots clean (`[startup-assert] … ✓`, `/api/health` 200)
- [ ] §II.2.7 all three test webhooks verified in staging logs + `inbound_events`
- [ ] §II.2.8 a full ingest → generate → approve → publish cycle completed on a
      sandbox location, charging no real card and emailing no real person
- [ ] §II.3 matrix double-checked: nothing shared that shouldn't be (especially the
      queue Redis URL and the four secrets)
- [ ] §II.5 loop walked once: a throwaway change rode feature → preview → staging →
      `main` → prod and you watched each hop deploy

---

# Part III — Launch execution checklist

Sequential, tickable version of the recipe above for **this** project's first real
launch — **staging first** (Part II §II.2), then **production** (§II.4).
`[YOU]` = needs a dashboard/login/secret/DNS · `[ME]` = Claude can run it via CLI ·
⏱ = has lag, start early.

**Concrete IDs:** prod Supabase `udeyaqnvpojbwgoaxwdg` · staging Supabase
`kubdiqdhqbhwmqfditeg` (both **Startups** org, **West US (Oregon)**) · domain
`repworth.net` · worker `worker.repworth.net` · staging `staging.repworth.net`.

## Phase 0 — Prerequisites ✅ (done 2026-05-30)
- [x] `[YOU]` Vercel **Pro** purchased
- [x] `[YOU]` Supabase CLI authenticated
- [x] CLIs authenticated: vercel · railway · gh · stripe (live + test)

## Phase 1 — Provision staging backing services (test/sandbox)
- [x] `[YOU]` ⏱ DNS: add `staging.repworth.net` CNAME → Vercel (target shown in Phase 3)
- [x] `[ME]` Staging Supabase project created — `RepWorth-staging` (Startups, Oregon, ref `kubdiqdhqbhwmqfditeg`) — *done 2026-05-30*
- [x] `[ME]` Apply migrations 001→054 to staging — *done 2026-05-30 (verified: 32 tables, RLS on 28)*
- [x] `[YOU]` Staging Supabase Auth: custom SMTP (`smtp.resend.com:465`, user `resend`, pass = staging `RESEND_API_KEY`) + signup confirmation template uses `{{ .Token }}`
- [x] `[YOU/ME]` Seed a staging admin user (`users` row linked to a Supabase Auth user)
- [x] `[YOU]` Staging Upstash **cache** instance → `REDIS_CACHE_URL` (`rediss://`, TLS)
- [x] `[ME]` Capture staging `DATABASE_POOL_URL` (Transaction pooler, 6543)
- [x] `[ME]` Create the 7 Stripe **test-mode** prices → `STRIPE_PRICE_*`
- [x] `[YOU]` Resend staging sender → `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_WEBHOOK_SECRET`
- [x] `[YOU]` Zernio sandbox → `ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET`; set `ZERNIO_PROFILE_ID_PREFIX=repworth-staging-`
- [x] `[YOU]` Google Maps: add `https://staging.repworth.net/*` to the key's referrer allowlist
- [x] `[ME]` Generate staging secrets: `SESSION_COOKIE_SECRET`, `CSRF_SECRET`, `IMPERSONATION_COOKIE_SECRET`

### Phase 1 — completed: record, learnings & carry-forward (2026-05-30)

**What was provisioned**
- **Staging Supabase** `RepWorth-staging` — Startups org, **West US (Oregon)**, ref `kubdiqdhqbhwmqfditeg`. All **54 migrations** applied via `psql` over the *direct* connection in session mode (so the `CONCURRENTLY` migrations 018/023/026/031 run); verified **32 public tables, RLS on 28**.
- **Auth keys rotated to the new system:** legacy `anon`/`service_role` JWTs **disabled** — this neutralized a staging service key that had leaked into a terminal transcript. Staging now uses **`sb_publishable_`** (anon) + **`sb_secret_`** (service). DB password, schema, and SMTP were untouched by the rotation.
- **Supabase Auth:** custom SMTP via Resend (`smtp.resend.com:465`, user `resend`); signup template `{{ .Token }}` (6-digit OTP); reset/invite `/api/auth/callback?…&amp;…` links; Site URL `https://staging.repworth.net`. Admin `users` row seeded (role `admin`, no `account_id`).
- **Redis:** cache on **Upstash** (`rediss://`). The BullMQ **queue** is Railway-side — created in Phase 2.
- **Stripe (TEST mode):** 4 products + **7 prices** created via CLI (Basic $29 · Standard $79 +$25/loc · Premium $199 +$20/loc · Founders $19 +$25/loc); `sk_test_…` secret.
- **Resend / Zernio / LLM / app secrets** — all generated **distinct from prod** (intentional isolation). Zernio is a **sandbox** key; `ZERNIO_PROFILE_ID_PREFIX=repworth-staging-`.

**Where the values live**
- All staging values are in **`.env.staging.local`** (gitignored via `.env*.local`), namespaced `STAGING_*`. Never committed; never pasted into chat. When wiring Railway/Vercel, map `STAGING_X` → `X`.

**Learnings / gotchas (also apply to prod in Phase 6)**
- **Supabase region is immutable after creation.** Slugs follow AWS: Oregon = `us-west-2` (NOT `us-west-1`, which is N. California). Get it right at create time. *(We had to delete + recreate.)*
- **Connection strings moved** behind the dashboard **"Connect"** button (not Settings → Database). Use the **Transaction pooler** (port 6543) string and **keep `?pgbouncer=true`** (psql rejects that param, but Postgres.js needs it).
- **Legacy keys can't be individually re-rolled** — you neutralize them by disabling legacy keys + moving to `sb_` keys. ⚠️ **Do NOT disable prod's legacy keys until the prod env is on `sb_` keys** (the live `repworth.net` deploy may still use them).
- **`ZERNIO_API_BASE` = `https://zernio.com/api`** (no `/v1`) — the client appends `/v1` per-endpoint, so the docs' `…/api/v1` base would double to `/v1/v1` → 404.
- **Resend webhook secret is a Svix `whsec_…`** value *from Resend* (created in Phase 4 with the endpoint) — **not** openssl-generated. *(Its Phase-1 checkbox covers only the API key + sender; the webhook secret is genuinely a Phase-4 item. Guide §1.2's "openssl" note is wrong — pending fix.)*
- **`.env` append hygiene:** ensure the file ends in a newline before appending, or the first appended line glues onto the previous entry (this bit `SESSION_COOKIE_SECRET` once — now fixed).

**How to start Phase 2 (Railway staging worker)**
1. Create a **`staging` git branch** from `main` and push it (Railway's staging env deploys from it).
2. Pick the Railway project — the empty auto-named **`soothing-luck`** (ideally rename to `repworth`) — and add a **`staging` environment**.
3. Add **Railway Redis** (the queue) to the staging env; **disable its TCP Proxy**; wire `REDIS_QUEUE_URL=redis://default:${{redis.REDISPASSWORD}}@${{redis.RAILWAY_PRIVATE_DOMAIN}}:6379/1?family=0`.
4. Create the **worker service** from the GitHub repo on the `staging` branch (`railway.toml` already sets `pnpm worker` + healthcheck `/api/health`).
5. Set all worker env vars from `.env.staging.local` (`STAGING_X` → `X`) + `NEXT_PUBLIC_APP_URL=https://staging.repworth.net`, `ZERNIO_PUBLISHING_ENABLED=true`, `SELF_SERVE_SIGNUP_ENABLED=true`, channels off, `MOCK_EXTERNAL_APIS=false`; then generate the worker domain → `WORKER_PUBLIC_URL`.
6. Deploy; confirm `[startup-assert] … ✓` and `/api/health` 200.

## Phase 2 — Deploy staging worker (Railway)
- [x] `[ME]` Create Railway `staging` environment
- [x] `[ME]` Add Railway **Redis** (queue) to staging env; disable its TCP Proxy
- [x] `[ME]` Create worker service from the GitHub repo, deploy branch = `staging`
- [x] `[ME]` Set staging worker env vars (+ `REDIS_QUEUE_URL=…?family=0`)
- [x] `[ME]` Generate worker public domain (`*.up.railway.app`) → staging `WORKER_PUBLIC_URL`
- [x] `[ME]` Deploy; verify boot + `/api/health` 200

### Phase 2 — completed: record, learnings & carry-forward (2026-05-31)

**What was provisioned**
- **Railway project `repworth`** (renamed from the auto-name `soothing-luck`) + a **`staging` environment**.
- **Redis queue** — Railway managed Redis, service named **`redis`** (lowercase, so the `${{redis.…}}` reference resolves), **TCP proxy deleted** (private-net only — closes the public-egress trap). Wired `REDIS_QUEUE_URL=redis://default:${{redis.REDISPASSWORD}}@${{redis.RAILWAY_PRIVATE_DOMAIN}}:6379/1?family=0` on the worker.
- **Worker service `repworth-worker`** — GitHub source `RepWorth/ai-review-responder`, deploy branch `staging`. Generated domain `https://repworth-worker-staging.up.railway.app` → `WORKER_PUBLIC_URL`.
- **38 env vars** mapped from `.env.staging.local` (`STAGING_*` → `X`) + flags (`NODE_ENV=production`, `ZERNIO_PUBLISHING_ENABLED=true`, `SELF_SERVE_SIGNUP_ENABLED=true`, channels off, `MOCK_EXTERNAL_APIS=false`). `STRIPE_WEBHOOK_SECRET` is a **placeholder** until Phase 4; `RESEND_WEBHOOK_SECRET` deferred to Phase 4 (neither is boot-required).
- **Verified:** deploy `SUCCESS`, `GET /api/health` → 200, all pollers started, Postgres + Redis connected (no ioredis errors in boot logs).

**Where the values live**
- Worker env vars are set **directly on the Railway `repworth` / `staging` service `repworth-worker`** (38 vars). The source secrets stay in **`.env.staging.local`** (gitignored, `STAGING_*`-namespaced) — map `STAGING_X` → `X` to re-apply. `REDIS_QUEUE_URL` is a Railway **reference** (`${{redis.…}}`), not a literal; `WORKER_PUBLIC_URL=https://repworth-worker-staging.up.railway.app`.
- `SERPAPI_API_KEY` lives in `.env.staging.local` as `STAGING_SERP_API_KEY` (rename → `STAGING_SERPAPI_API_KEY` for `set_staging_vars` mapper consistency). `STRIPE_WEBHOOK_SECRET` is a placeholder and `RESEND_WEBHOOK_SECRET` is unset — both get real values in Phase 4.

**Learnings / gotchas (these also bite prod in Phase 6)**
- **Builder must be RAILPACK, not NIXPACKS.** Nixpacks 1.41 hardcodes `npm i -g corepack@0.24.1`, incompatible with Node 24's vm API → `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` at `pnpm install`. RAILPACK installs Node 24 + pnpm 11 via mise. Pinned in `railway.toml` with a no-op `buildCommand` to skip the worker's unneeded `next build`.
- **`SERPAPI_API_KEY` is a hard boot requirement** (was missing from §5.2 — now added). `src/lib/demos/fetch-reviews.ts` throws at **module load** when `MOCK_EXTERNAL_APIS=false`; the worker imports it eagerly via the onboarding-demo path, so a missing key crashes boot even with demo/ranking flags off. *(Provisioned in `.env.staging.local` as `STAGING_SERP_API_KEY` → mapped to `SERPAPI_API_KEY`; rename the file key to `STAGING_SERPAPI_API_KEY` for `set_staging_vars` mapper consistency.)*
- **Private GitHub repo connection is dashboard-only.** CLI `railway add --repo` and the `githubRepos` API both return *Unauthorized* for a private org repo — the GitHub-App OAuth must be done in the Railway dashboard (Settings → Source). Everything else (`[ME]`) is CLI/API.
- **CI does not run on `staging` pushes** (workflow = `pull_request` + push to `main` only). Railway's "Wait for CI" proceeds when no check suite is pending, so it does **not** hang; direct staging commits are not CI-gated — rely on the PR's CI before promoting.
- **Set `WORKER_PUBLIC_URL` before the verifying deploy** (the Zernio boot assert needs it); generate the `*.up.railway.app` domain pre-deploy so the first build boots clean.

**How to start Phase 3 (Vercel staging UI)**
1. Create a Vercel **Custom Environment** `staging`, deploy branch = `staging`.
2. Set staging Vercel env vars (map from `.env.staging.local`): `NEXT_PUBLIC_APP_URL=https://staging.repworth.net`, `WORKER_PUBLIC_URL=https://repworth-worker-staging.up.railway.app`, staging Supabase (`NEXT_PUBLIC_SUPABASE_URL` + anon key), Stripe **test** secret key + 7 price IDs, `REDIS_CACHE_URL` (Upstash cache — Vercel needs **no** `REDIS_QUEUE_URL`), the session/CSRF/impersonation secrets, and flags (`SELF_SERVE_SIGNUP_ENABLED=true`, channels off).
3. Attach `staging.repworth.net` (add the CNAME from Phase 1).
4. Smoke: `/signup` + `/admin/login` render (a 404 on `/signup` means the flag is off).

**Then (Phase 4):** wire the staging webhooks — Stripe **test** / Resend / Zernio **sandbox** → the worker `/ingress/*` endpoints; that's where the real `STRIPE_WEBHOOK_SECRET` + `RESEND_WEBHOOK_SECRET` come from (replacing the Phase 2 placeholder/unset values).

## Phase 3 — Deploy staging UI (Vercel)
- [x] `[ME]` Create Vercel **Custom Environment** `staging`, deploy branch = `staging`
- [x] `[ME]` Set staging Vercel vars (app URL, worker URL, staging Supabase, Stripe test, `REDIS_CACHE_URL`, secrets, flags)
- [x] `[ME]` Attach `staging.repworth.net` (CNAME from Phase 1 — verified)
- [x] Smoke: `/signup` + `/admin/login` build-confirmed + serving (team-SSO gate; visual render verified in-browser)

### Phase 3 — completed: record, learnings & carry-forward (2026-05-31)

**What was provisioned**
- **Vercel `staging` Custom Environment** in project `rep-worth` (id `env_Xdvi79MDL9zMt5LmTMRLFSBBeKGT`), type `preview`, **branch-tracking `equals "staging"`**. Pro allows **1** custom env/project — now used.
- **28 env vars scoped to the `staging` custom env** (not Production/Preview): mapped `STAGING_X → X` from `.env.staging.local` + literals (`NEXT_PUBLIC_APP_URL=https://staging.repworth.net`, `WORKER_PUBLIC_URL=https://repworth-worker-staging.up.railway.app`, `SELF_SERVE_SIGNUP_ENABLED=true`, `ZERNIO_PUBLISHING_ENABLED=true`, `MOCK_EXTERNAL_APIS=false`). Includes `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` and `SERPAPI_API_KEY` (from `STAGING_SERP_API_KEY`).
- **`staging.repworth.net`** bound to the custom env via `customEnvironmentId` (**not** `gitBranch`), **verified** (Phase 1 CNAME). Git-sourced deploy of `staging` → `READY`; `✓ Compiled successfully`, `/signup` + `/admin/login` prerendered.

**Where the values live**
- Vercel vars are scoped to the **`staging` Custom Environment** — read with `vercel env pull --environment=staging`. Production's vars are a separate scope and were **not** touched. Source secrets stay in `.env.staging.local` (`STAGING_*`).

**Learnings / gotchas (also apply to prod in Phase 6)**
- **The Vercel CLI can't create a Custom Environment** (`vercel target` only lists) and **`vercel env add` via stdin stores EMPTY values in v54.6.1**. Use the REST API: create env → `POST /v9/projects/{id}/custom-environments` with `branchMatcher:{type:"equals",pattern:"staging"}`; set vars → `POST /v9/projects/{id}/env?upsert=true` with `target:[]` + `customEnvironmentIds:[envId]` (values in the JSON body, never argv).
- **The `staging` branch auto-deploys the Custom Environment.** A push to `staging` produces a git-sourced deploy to the custom env (`source:git`, `target:"staging"`) — verified 2026-06-02: every recent staging deploy is `src=git, target=staging` (checked via `GET /v6/deployments`). This was wired after the original "deferred" note (which had said custom envs deploy only to generic Preview). Since the **worker** also auto-deploys on push, a `staging` push now refreshes the **whole** staging stack — no explicit UI deploy step is required. To force a redeploy *without* a push (e.g. rebuild the same commit), call it explicitly: `POST /v13/deployments` with `target:"staging"` + `gitSource:{type:"github",repoId,ref:"staging"}`.
- **Bind the custom-env domain via `customEnvironmentId`, NOT `gitBranch`.** A `gitBranch`-attached domain serves the latest *generic Preview* build, which lacks the custom-env vars (`SELF_SERVE_SIGNUP_ENABLED` unset → `/signup` 404 — the bug we hit). `PATCH` the project domain to set `customEnvironmentId`; the alias attaches on the **next** custom-env deploy.
- **Staging is behind Vercel team-SSO.** `ssoProtection:"all_except_custom_domains"` exempts only the **production** domain, so `staging.repworth.net` returns the SSO gate (401) to anonymous requests — correct for a private staging env. Webhooks hit the **Railway worker** (unaffected); the Zernio OAuth callback is a browser redirect carrying the tester's Vercel session. For automated smoke, enable Protection-Bypass-for-Automation.

**How to start Phase 4 (wire staging webhooks → worker)**
1. **Stripe (TEST)** → add endpoint `https://repworth-worker-staging.up.railway.app/ingress/stripe` → copy the signing secret → set worker `STRIPE_WEBHOOK_SECRET` (replaces the Phase 2 placeholder).
2. **Resend (staging)** → add endpoint `https://repworth-worker-staging.up.railway.app/ingress/resend` → the Svix `whsec_…` → set worker `RESEND_WEBHOOK_SECRET`.
3. **Zernio (sandbox)** → add endpoint `https://repworth-worker-staging.up.railway.app/ingress/zernio`.
4. Redeploy the **worker** (Railway) so the new webhook secrets take effect, then send a test event from each provider and confirm `inbound_events` rows.

## Phase 4 — Wire staging webhooks → staging worker
- [x] `[YOU/ME]` Stripe **test** → `<stagingWorker>/ingress/stripe` → secret to worker `STRIPE_WEBHOOK_SECRET`
- [x] `[YOU/ME]` Resend **staging** → `<stagingWorker>/ingress/resend`
- [x] `[YOU]` Zernio **sandbox** → `<stagingWorker>/ingress/zernio`

### Phase 4 — completed: record, learnings & carry-forward (2026-05-31)

**What was provisioned**
- All three ingress webhooks point at the staging worker `https://repworth-worker-staging.up.railway.app/ingress/{stripe,resend,zernio}` and are **verified end-to-end** — `inbound_events` rows `processed`: `stripe`→`checkout.session.completed`, `resend`→`email.delivered`, `zernio`→`webhook.test`.
- Worker `STRIPE_WEBHOOK_SECRET` (real — replaced the Phase-2 placeholder) + `RESEND_WEBHOOK_SECRET` set; `ZERNIO_WEBHOOK_SECRET` confirmed matching the Zernio dashboard. Resend send→deliver→webhook confirmed against a real inbox.

**Where the values live**
- Webhook signing secrets live on the **Railway worker** (`STRIPE_/RESEND_/ZERNIO_WEBHOOK_SECRET`), mirrored in `.env.staging.local`. Stripe's endpoint is a CLI-created `we_…` (see learnings); Resend's secret is Svix-generated by Resend; Zernio's is the shared `test-…` sandbox secret.

**Learnings / gotchas (these also bite prod in Phase 6)**
- **NEVER put inline `# comments` on value lines in `.env*`.** dotenv-style parsers keep everything after `=`, so `KEY=secret # note` stores `secret # note`. This silently corrupted the cookie/CSRF/session secrets, `SERPAPI_API_KEY`, and `ZERNIO_API_KEY` on **both** the worker (Phase 2) and Vercel (Phase 3) — they don't fail boot (non-empty), so they'd surface as auth/CSRF/SerpAPI/publish failures mid-Phase-5. Detect with a `#`-in-value scan; re-sync from the cleaned file + redeploy both services.
- **Stripe renamed Webhooks → "Event destinations" / "Add destination."** A dashboard endpoint's signing secret is **not** API-retrievable after creation — recreate via `stripe webhook_endpoints create` (returns the secret), set it on the worker, and test with `stripe trigger checkout.session.completed`.
- **Resend has no per-endpoint "Send test"** (newer UI) — fire a webhook by sending a real email (Resend API). Its secret is **Svix-generated by Resend**, not openssl/§1.2 (§6.1 fixed).
- **The Zernio CLI has no webhook command** (scope: profiles/posts/inbox/analytics) — fire `webhook.test` from the Zernio dashboard.
- **`inbound_events` has no `created_at`** — use `received_at` / `processed_at` (§6.2 query fixed).

**How to start Phase 5 (prove end-to-end — the gate)**
1. Sanity (done): worker `/api/health` 200; each provider test → `inbound_events` row `processed`.
2. Full pipeline on a **throwaway test business**: `/signup` → Stripe **test-card** pay → `checkout.session.completed` activates the account → onboarding → connect Zernio sandbox → review ingest (`review.new`) → response generate → approval email (Resend) → approve → publish to a sandbox location.
3. Edge cases (§9.7): duplicate webhook (idempotency), expired approval token → 410, subscription guard, cost circuit.

## Phase 5 — Prove staging end-to-end (the gate)
- [x] Worker + ingress sanity (health; webhook "send test" → `inbound_events` rows)
- [x] Full pipeline on a **throwaway test business**: signup → test-card pay → onboarding → connect Zernio sandbox → ingest → generate → approval email → approve → publish to a sandbox location
- [x] Edge cases (§9.7): duplicate webhook, expired token → 410, subscription guard, cost circuit

### Phase 5 — completed: record, learnings & carry-forward (2026-05-31)

**What was proven**
- **Full pipeline ran clean end-to-end on a throwaway test business**: `/signup` → 6-digit OTP → Stripe **test-card** (`4242…`) checkout → `checkout.session.completed` flipped `accounts.subscription_status='active'` (`subscription_activated_at` set) → onboarding (demo lane, `ONBOARDING_DEMO_ENABLED=true`) → Zernio **sandbox** connect (`zernio_connections` active, both IDs populated) → backfill ingest → `generate_response` (OpenAI) → approval email (Resend, real inbox) → owner Approve → `ResponsePublisherWorker`. Each hop verified in Postgres + Railway logs.
- **§9.7 edge cases verified** (automated tests + live DB checks, no worker mutation): 106 automated tests green across all four mechanisms; subscription guard confirmed (`past_due`>7d/`cancelled`/`pending_payment`→skip publisher, generator-allowed for `pending_payment`, `active`→allow); expired-token→410 confirmed against a throwaway expired `approval_links` row (route's `expires_at <= NOW()` branch); duplicate-webhook idempotency via `claimInboundEvent` (`ON CONFLICT (external_event_key) DO NOTHING`); cost circuit via `withCostGuard` tests.

**Two real bugs found on staging and fixed (PR'd to `main`)**
1. **CSP blocked Google Maps Places.** The production CSP (`next.config.mjs`, now `src/lib/security/csp.mjs`) omitted the Maps hosts, so the onboarding `PlaceAutocompleteElement` couldn't load. Fixed in **two** passes — dev returns `''` so this only bites `NODE_ENV=production` (= staging/prod):
   - **#200**: `maps.googleapis.com` on `script-src` + `connect-src`, fonts/`maps.gstatic.com` on `style-src`/`font-src`, `blob:` on `img-src`. Also extracted the CSP into `src/lib/security/csp.mjs` (unit-testable) and added `**/*.mjs` to the eslint ignore (eslint-config-next + ESLint 10 hard-crashes on any `.mjs`).
   - **#203**: the `PlaceAutocompleteElement` makes its actual RPCs (`AutocompletePlaces`, `fetchFields`) to the **new Places API host `places.googleapis.com`**, not `maps.googleapis.com` — so it was still blocked after #200. Added `places.googleapis.com` to `connect-src` + dropped the invalid `o*.ingest.sentry.io` source (illegal partial-label wildcard the browser ignored; `*.sentry.io` covers ingest).
2. **Publisher false-positive on stale review id (#201).** `postReply` can return **2xx for a stale/phantom Zernio review id** while the reply never reaches Google; the publisher trusted that 2xx and marked the response `posted` — a silent false-positive (caught here: `status=posted`, nothing on Google, review absent from the live feed, `ZernioRecentReviewPoller` looping "external reply detected … no active responses"). Fix: after `postReply`, **`verifyOwnReplyAttached`** re-fetches the review and confirms OUR reply text is attached before reporting `posted`; otherwise it throws → existing failed-hook lands `status=failed` + `review_exception` + admin alert (loud, not silent). Reuses the 409-verifier page-cache + `canonicalizeReplyText`.

**Also fixed**: the Google Maps **API key referrer allowlist** needed `https://staging.repworth.net/*` added in Google Cloud Console (project `490954435940`, key `cc389070-…`) — a referrer block (`API_KEY_HTTP_REFERRER_BLOCKED`), not a CSP/code issue. **Prod (Phase 6) needs `https://repworth.net/*` on the same key.**

**Learnings / gotchas (these also apply to prod in Phase 6/7)**
- **CSP is `NODE_ENV=production`-only.** Dev returns `''`, so any CSP host gap is invisible locally and only surfaces on staging/prod. Maps needs `script-src`+`connect-src` for `maps.googleapis.com` AND `connect-src` for `places.googleapis.com` — the loader host and the RPC host are different.
- **Google Maps key referrer allowlist is per-environment.** Add each origin (`localhost`, staging, then prod apex) in GCP Console; the loader host being CSP-allowed is necessary but not sufficient — the key itself referrer-blocks.
- **`subscription_status` lives on BOTH `accounts` and `businesses`.** The publisher's subscription guard reads from the **account** (invariant #9). The §9.7 runbook SQL targeting `businesses` would test the wrong column — use `accounts` (+ `past_due_at` for the grace window).
- **`/api/approve` is behind Vercel team-SSO (401) on staging**, and approval tokens are SHA-256-only (invariant #5). The expired-token→410 path can't be curl-tested externally; verify the route's `expires_at <= NOW()` predicate against a throwaway `approval_links` row instead (clean it up after).
- **`inbound_events` dedup key is `external_event_key`** (UNIQUE), claimed via `ON CONFLICT DO NOTHING` + a 2-min reclaim window for crashed workers. No `provider_event_id`/`created_at` columns.
- **`ONBOARDING_DEMO_ENABLED=true` changes onboarding** to the 2-step demo lane (`/onboarding/start` + `/onboarding/demo`). It was enabled on staging in Phase 5; the legacy 3-step flow (runbook §7A) is the `=false` path. Decide deliberately per environment.

**Carry-forward to Phase 6 (prod)**
- Apply all three Phase-5 fixes — they're on `main` (#200, #201, #203). Production gets them automatically when `main` deploys.
- Add `https://repworth.net/*` to the Maps API key referrer allowlist **before** prod onboarding.
- The live cost-circuit exercise (set `GLOBAL_DAILY_COST_LIMIT_CENTS` low, redeploy, trigger generation, confirm `cost_limit_exceeded`, reset) was deferred on staging (needs worker redeploys) — run it once against prod or staging if you want the live signal; the code path is test-covered.

## Phase 6 — Build production (clone staging, live creds)
- [ ] `[YOU]` Prod Supabase (`udeyaqnvpojbwgoaxwdg`): check current head, apply any migrations through **054** (CONCURRENTLY ones individually)
- [ ] `[YOU]` Prod Upstash **cache** → `REDIS_CACHE_URL`
- [ ] `[ME]` Railway `production` env: add Railway Redis (queue), deploy worker, set **live** vars
- [ ] `[YOU]` ⏱ DNS: `worker.repworth.net` CNAME → Railway; attach in Railway Networking
- [ ] `[ME]` Vercel Production vars: `WORKER_PUBLIC_URL`, **live** Stripe (live keys + live price IDs), prod Supabase, `REDIS_CACHE_URL`, secrets, flags
- [ ] `[YOU]` Wire **live** webhooks → prod worker (Stripe / Resend / Zernio)
- [ ] `[ME]` Deploy prod worker; verify startup-assert + health

## Phase 7 — Go live (careful first customer)
- [ ] `[YOU]` OpenAI/Anthropic hard spend caps + prod `GLOBAL_DAILY_COST_LIMIT_CENTS`
- [ ] **Flip `SELF_SERVE_SIGNUP_ENABLED=true`** on Vercel + Railway prod — **only after** worker + webhooks are confirmed live
- [ ] First real customer: careful first-post discipline (§8–§10); kill switch (`ZERNIO_PUBLISHING_ENABLED=false`) ready

## Phase 8 — Ongoing (Option-1 loop)
- [ ] Wire the loop: feature branch → PR (Vercel preview) → push to `staging` branch (full-stack test) → merge PR to `main` (ships prod) → fast-forward `staging` onto `main`
- [ ] Migrations: apply to **staging Supabase first**, then prod
- [ ] Schedule a daily health check (§11)

## Critical ordering cautions
- Vercel Pro **before** the staging UI (Phase 3) ✅ · DNS early (⏱ items) ·
  **never flip `SELF_SERVE_SIGNUP_ENABLED=true` in prod before the worker + Stripe
  webhook are live** — that's the one mistake that takes real money and drops it ·
  staging uses **test/sandbox** keys only (Stripe test, Zernio sandbox, staging Resend).
