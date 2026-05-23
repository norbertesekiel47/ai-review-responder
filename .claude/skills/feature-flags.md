---
name: feature-flags
description: Complete environment variable and feature flag reference for RepWorth. Read this before adding a new env var, debugging a missing config error, configuring a new deployment environment, or flipping a feature flag in production. Includes startup assertion behavior, flag dependencies, and flag-gating patterns.
---

# RepWorth — Environment Variables & Feature Flags

## Flag-Gating Pattern

All feature flags are **server-authoritative**. Browser learns flag state via
API responses (e.g. `zernioPublishingEnabled` field in the business-detail API).
Never use `NEXT_PUBLIC_*` companions for feature flags — ops state must not
leak to clients or be spoofable.

Worker startup assertions fail fast on missing required vars. This is
intentional — a misconfigured worker is worse than a crashed one.
`MOCK_EXTERNAL_APIS=true` bypasses most startup assertions for local dev.
Assertion source: `worker/config/startup-assert.ts`.

> **Worker file paths (as of 2026-05-05):** Worker class names below
> are stable; file paths changed during the worker reorg, and per PR
> #18 the BullMQ `'failed'` exhaustion handlers now live in dedicated
> `failed-hook.ts` modules colocated with their workers. For any
> worker mentioned, look at how it's imported in `worker/index.ts`
> (or read `docs/directory.md`). Quick map for things mentioned in
> this file:
> - `ResponsePublisherWorker` → `worker/jobs/publisher/ResponsePublisherWorker.ts`
>   - Final-attempt failure logic: `worker/jobs/publisher/failed-hook.ts` (`handlePublisherFailed`)
> - `ZernioReviewIngestWorker` → `worker/jobs/zernio/ZernioReviewIngestWorker.ts`
>   - Final-attempt failure logic: `worker/jobs/zernio/ingest-failed-hook.ts` (`handleIngestFailed`)
> - Zernio webhook handler: `worker/ingress/zernio/zernio.ts`
> - Zernio signature verifier: `worker/ingress/zernio/zernio-verify.ts`

---

## Core / Always Required

| Var | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string (PgBouncer pooled) |
| `DIRECT_URL` | Postgres direct connection (for migrations, bypasses PgBouncer) |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (browser-safe) |
| `SUPABASE_SERVICE_KEY` | Server-only. NEVER expose to browser. |
| `REDIS_CACHE_URL` | Upstash Redis — cache instance (separate from queue) |
| `REDIS_QUEUE_URL` | Upstash Redis — BullMQ queue instance (separate from cache) |
| `OPENAI_API_KEY` | GPT-4o-mini (primary LLM) |
| `ANTHROPIC_API_KEY` | Claude Haiku fallback (`claude-haiku-4-5-20251001`) |
| `RESEND_API_KEY` | Transactional email + custom SMTP password |
| `NEXT_PUBLIC_APP_URL` | Full origin e.g. `https://repworth.app` |

---

## Development / Testing

| Var | Default | Notes |
|---|---|---|
| `MOCK_EXTERNAL_APIS` | `false` | `true` → bypass SerpAPI + LLM + Twilio/Telegram channel boot assertions. Uses `MockReviewSource` + `generateMockResponse`. |
| `TEST_DATABASE_POOL_URL` | — | E2E tests skip gracefully when unset. |
| `CONTACT_NOTIFY_TO` | `norbertesekiel@gmail.com` | Overrides notification email for `/api/contact` submissions. |

---

## Feature Flags

### `SELF_SERVE_SIGNUP_ENABLED`

Gates owner self-serve signup/login/reset pages + APIs.
Admin surfaces (`/admin/login`, `/admin/forgot-password`, `/admin/reset-password`)
are NEVER gated.

**Required when on:**
- `REDIS_CACHE_URL`
- `NEXT_PUBLIC_APP_URL`
- `STRIPE_PAYMENT_LINK_STARTER` + `STRIPE_PAYMENT_LINK_PREMIUM`
- Worker startup assertion fails without these.

**Supabase email template requirements:**
- Signup confirmation: `{{ .Token }}` (6-digit OTP) — NOT `{{ .ConfirmationURL }}`
- Reset password + Invite user: use `{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&amp;type=recovery|invite&amp;flow=owner&amp;next=/reset-password`
- `&amp;` required — unescaped `&` breaks `<a href>` attributes
- Custom SMTP: `smtp.resend.com:465`, username `resend`, password = `RESEND_API_KEY`

---

### `CHANNELS_SMS_ENABLED`

Gates SMS factory, dispatcher, admin API routes, `SmsEnrollmentWidget`.

**Required when on:**
- `WORKER_PUBLIC_URL` — statusCallback base + Twilio signature verification. Must match Twilio console config exactly (scheme, host, no trailing slash).
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_MESSAGING_SERVICE_SID`
- `TWILIO_VERIFY_SERVICE_SID`

**Optional:**
- `SMS_DAILY_LIMIT_CENTS_PER_BUSINESS` (default: `10`)
- `SMS_DAILY_LIMIT_CENTS_GLOBAL` (default: `500`)

**Before flipping:** Register 10DLC with Twilio.

---

### `CHANNELS_TELEGRAM_ENABLED`

Gates Telegram factory, dispatcher, admin API routes, `TelegramEnrollmentWidget`.
Server-authoritative via `telegramEnabled` field in business-detail API.

**Required when on:**
- `TELEGRAM_BOT_TOKEN` — BotFather token for `@RepWorthBot`. Worker startup assertion enforces.
- `TELEGRAM_WEBHOOK_SECRET` — 32+ byte shared secret. Must match value passed to Telegram `setWebhook`. Rotate by updating both env var and re-calling `setWebhook` (Telegram retries 7× over 51h, brief 401 window tolerable).

**Optional:**
- `TELEGRAM_BOT_USERNAME` (default: `RepWorthBot`) — controls deep-link rendering (`https://t.me/<username>?start=<token>`)

**Before flipping:** Register prod `@RepWorthBot`, call `setWebhook` with correct URL and secret.

---

### `CHANNELS_WHATSAPP_ENABLED`

Gates WhatsApp factory, dispatcher, admin API routes (`WhatsAppEnrollmentWidget`),
AND owner self-service routes (`/api/dashboard/channels/whatsapp/{start,cancel,disable}`
+ `OwnerWhatsAppWidget` on `/settings/channels`). Worker startup assertion verifies
7 env vars + format checks.

**Set on BOTH platforms.** Next.js routes + the `/settings/channels` UI run on
**Vercel**; the worker runs on **Railway**. The flag + all WhatsApp env vars must
be set on both, or the owner UI stays hidden/404/503 while the worker is otherwise
ready. The single shared `whatsappEnvReady()` predicate (`src/app/api/admin/channels/whatsapp/_shared.ts`)
backs both the route guard and the UI `whatsappAvailable()` checks, so they can't
disagree on which env vars count (all 5, incl. `WHATSAPP_APPROVAL_URL_BASE`).

**Required when on:**
- `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` (shared with SMS if both enabled)
- `TWILIO_WHATSAPP_NUMBER` — format: `whatsapp:+<digits>` (assertion enforces format)
- `WHATSAPP_APPROVAL_TEMPLATE_SID` — Twilio Content SID for `repworth_approval_request_v1`
- `WHATSAPP_APPROVAL_URL_BASE` — must equal `NEXT_PUBLIC_APP_URL + '/approve/'` (assertion enforces equality)

**Before flipping:** Meta Business verification (2–4 week process) + WABA setup + Content template approval.

**Critical error handling note:** `TemplateConfigError` and `SessionWindowError`
leave channel enrollment `verified` UNCHANGED — these are ops failures, not
owner opt-outs. Do NOT flip enrollment status on these errors.

---

### `MULTI_LOCATION_ENABLED`

Gates the entire multi-location surface — add-location wizard,
`/api/locations/*` mutation routes, switcher dropdown, aggregate
dashboard scope, per-location voice / channel override settings,
admin CSV bulk import. When OFF, all multi-location routes return
404 and the UI behaves as the legacy single-location flow.

**Three distinct gates (since PR #51 — do not collapse into one boolean):**
the flag is consumed through three helpers in
`src/lib/locations/multi-location-mode.ts`:
- `shouldShowLocationsSettings(flag)` — visibility. The Locations tab +
  `/settings/locations` now appear whenever the flag is ON, **even for
  one-location accounts** (so a freshly-paid Standard/Premium owner can add
  their second location).
- `shouldUseMultiLocationSettings(flag, count)` — true multi-location MODE
  (`count > 1`). Drives the switcher, aggregate scope, and the
  Voice/Notifications multi-loc content. `/settings/voice` stays gated on
  this; single-location Brand Voice links to `/settings#brand-voice`.
- `canAddLocationForAccount(flag, tier, status)` — eligibility (flag +
  `status === active` + `multiLocAllowed`). Basic resolves to a locked
  upgrade panel on `/settings/locations` (no add-location link, no API call).

Server-authoritative. Schema (migrations 034–041) ships on regardless
of the flag — flipping the flag only exposes the user surface. The
`accounts` table is populated for every business either way.

**Required when on:**
- `STRIPE_PRICE_STANDARD_OVERAGE`
- `STRIPE_PRICE_PREMIUM_OVERAGE`
- `STRIPE_PRICE_FOUNDERS_OVERAGE` (when founders tier is in use)
  Each is the Stripe Price ID for the per-extra-location overage line
  on the corresponding tier. The `UpdateStripeOverageWorker` reads
  these via `getOveragePriceId(tier)` and refuses to run otherwise.

**Tier configuration** (`src/lib/accounts/tier-config.ts`):

| Tier | Base | Included | Overage / extra | Multi-loc |
|---|---|---|---|---|
| basic | $29 | 1 | n/a | No |
| standard | $79 | 1 | $25 | Yes |
| premium | $199 | 5 | $20 | Yes |
| founders | $19 | 1 | $25 | Yes |

**Stripe model:** one subscription per account, two subscription
items — base price (qty 1) + overage price (qty = active locations
beyond included). Add/archive/reactivate go through the outbox →
`UpdateStripeOverageWorker`, which calls
`stripe.subscriptionItems.update/create` with idempotency keys keyed
on (account, item, quantity). NO Stripe Payment Links are used
anywhere in the multi-location flow — initial checkout uses
server-built Checkout Sessions instead.

**Channel cache:** every `channel_enrollments` write must call
`safeInvalidateChannelCache(accountId, context)` after the
transaction commits. This wraps `invalidateChannelCache` with a
`logger.warn('channel-cache-invalidate-failed', …)` fallback so
Redis hiccups are visible but do not roll back the enrollment
write. Never use the bare `.catch(() => {})` pattern that preceded
this — it silently masked TCPA-relevant cache staleness.

---

### `ZERNIO_PUBLISHING_ENABLED`

Single flag controlling BOTH publishing AND ingestion (no separate flags).
Gates:
- Connect routes (`start`/`callback`/`select-location`/`cancel`/`disconnect`)
- `ResponsePublisherWorker` Zernio publishing branch
- `worker/ingress/zernio/zernio` webhook handler
- Admin/dashboard Zernio panel CTAs

Server-authoritative. Browser learns state via `zernioPublishingEnabled` field
in business-detail API. No `NEXT_PUBLIC_*` companion.

**Required when on:**
- `ZERNIO_API_KEY` — worker startup assertion fails without it
- `ZERNIO_WEBHOOK_SECRET` — HMAC shared secret for `worker/ingress/zernio/zernio-verify.ts`. Must match Zernio dashboard config.

**Optional:**
- `ZERNIO_API_BASE` (default: `'https://zernio.com/api'`) — override for sandbox
- `ZERNIO_PROFILE_ID_PREFIX` (default: `'repworth-prod-'`) — prefixed onto Zernio profile names to prevent prod/staging/local collisions on same workspace
- `ZERNIO_INGEST_MAX_PAGES` (default: `4`, = 200 reviews) — caps `ZernioReviewIngestWorker`'s `listReviews` walk. Hitting cap with `nextPageToken` set → `review_exceptions type='zernio_pagination_cap_exhausted'` (distinct from durable `zernio_review_not_found`)

**Prod checklist:** Subscribe to Zernio Accelerate + Inbox add-on → set `ZERNIO_API_KEY` + `ZERNIO_WEBHOOK_SECRET` + `WORKER_PUBLIC_URL` → run migrations 026+028+029+030 in prod Supabase → configure webhook URL in Zernio dashboard pointing at `${WORKER_PUBLIC_URL}/ingress/zernio` → fire test webhook → flip flag → onboard pilot per `docs/zernio-launch-runbook.md`.

---

## Stripe

| Var | Notes |
|---|---|
| `STRIPE_SECRET_KEY` | Server-only Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification (Railway ingress) |
| `STRIPE_PAYMENT_LINK_STARTER` | Payment Link URL for Starter plan |
| `STRIPE_PAYMENT_LINK_PREMIUM` | Payment Link URL for Premium plan |
| `STRIPE_PRICE_STARTER` | Stripe Price ID for Starter |
| `STRIPE_PRICE_PREMIUM` | Stripe Price ID for Premium |

---

## Google Maps

| Var | Notes |
|---|---|
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Required for onboarding PlaceAutocomplete. Essentials tier (free). |

---

## Worker Infrastructure

| Var | Notes |
|---|---|
| `WORKER_PUBLIC_URL` | Public URL of Railway worker. Required when SMS enabled. Must match Twilio console exactly (scheme, host, no trailing slash). |
| `PORT` | Worker Fastify port (default: `3001`) |

---

## Poller Tuning (all optional)

| Var | Default | Notes |
|---|---|---|
| `ONBOARDING_DRIP_INTERVAL_MS` | 1h | Onboarding drip poller interval |
| `CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS` | 24h | Abandoned signup cleanup frequency |
| `CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE` | 100 | Rows per cleanup run |
| `EMAIL_CHANNEL_RECONCILE_INTERVAL_MS` | 10min | Reconcile poller for missed `channel_enrollments` rows |
| `EMAIL_CHANNEL_RECONCILE_BATCH_SIZE` | 100 | Rows per reconcile run |
| `EMAIL_CHANNEL_RECONCILE_DISABLED` | `false` | `true` → skip reconcile poller (mock mode auto-skips) |
| `NOTIFICATION_FAILOVER_DISABLED` | `false` | `true` → skip failover poller entirely (local dev / mock mode auto-skips; `RESEND_WEBHOOK_SECRET` no longer consulted when disabled) |
| `NOTIFICATION_FAILOVER_INTERVAL_MS` | 7200000 (2h) | Failover poller interval |

---

## Feature Flags — Off by Default

| Flag | Status | Prerequisite |
|---|---|---|
| `RANKING_TRACKING_ENABLED` | Off | Enable when ranking worker is ready |
| `SELF_SERVE_SIGNUP_ENABLED` | Off | Custom SMTP + Stripe payment links configured |
| `CHANNELS_SMS_ENABLED` | Off | 10DLC registration |
| `CHANNELS_TELEGRAM_ENABLED` | Off | Bot registered + setWebhook called |
| `CHANNELS_WHATSAPP_ENABLED` | Off | Meta verification + WABA + template approval |
| `ZERNIO_PUBLISHING_ENABLED` | **ON (prod, 2026-04-28)** | Migrations 026+028+029+030 applied |
| `EXTERNAL_REPLY_IMPORT_ENABLED` | Off (code-complete on `feat/past-replies-view`, 2026-05-02) | Migration 031 applied. Gates the import-on-ingestion writes path inside `reconcileExternallyAnsweredReview` — when off, today's silent-no-op behavior on previously-unseen / no-active-response external replies is preserved. When on, those replies get inserted as `posted` responses with `external_reply_ingested_at` set. **CAUTION:** flipping this on changes the dashboard "total responded" count for businesses with imported replies (imported `posted` rows are in `HANDLED_STATUSES`). The two-flag rollout is designed so you can soak this silently before turning on the UI. |
| `PAST_REPLIES_VIEW_ENABLED` | Off (code-complete on `feat/past-replies-view`, 2026-05-02) | Migration 031 applied + ≥ 1 week soak of `EXTERNAL_REPLY_IMPORT_ENABLED` recommended. Gates the `/dashboard/past-replies` page (returns 404 when off) and the `OwnerNav` "Past Replies" link (hidden when off). Server-authoritative; layout reads the env var and passes it as a prop to `OwnerNav`. NO `NEXT_PUBLIC_*` companion. Read-only feature — no edit / regenerate / publish actions. |
| ~~`EDIT_EXISTING_REPLIES_ENABLED`~~ | **PARKED** on tag `wip/edit-existing-replies-zernio-v1` | Original single-flag for the full edit / regenerate / publish / retry / restore-original feature. NOT shipped on main — superseded by the two-flag split above. Resurrect only if direct GBP API timeline blows up beyond ~12 months; otherwise rebuild against GBP's single-PUT model when GBP arrives. |
| `ONBOARDING_DEMO_ENABLED` | Off (PR #2 default) | Master flag for the pre-pay demo lane on `feat/pre-paywall-demo-pr2`. When ON: `/onboarding/start` (location capture) and `/onboarding/demo` (demo + paywall) become reachable, `/api/onboarding/business` switches to `BusinessOnboardingPostPaySchema` (rejects location fields), and the wizard becomes 2-step (Profile + Voice). When OFF: those routes 404 and the legacy 3-step wizard runs. Migration 032 must be applied either way. |
| `ONBOARDING_DEMO_DAILY_CENTS` | `1000` ($10/day) | Global daily cost ceiling for the onboarding demo lane. Override at runtime via Redis key `cost:onboarding-demo:override:cents`. Each demo reserves 20¢ pessimistically; the worker reconciles to actual spend (~3¢). |
| `ONBOARDING_DEMO_STAFF_EMAILS_CSV` | unset | Phase 3 staff allowlist for soft-launch. Comma-separated owner emails permitted to reach `/onboarding/start` while the flag is on for the rest of the world. Removed at Phase 4 (full GA). |

---

## Docs

- `NEXT_PUBLIC_DOCS_BASE_URL` — optional. Makes `/admin/runbook` doc names
  clickable links. Leave unset to disable links.
