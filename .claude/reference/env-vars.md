# RepWorth — Environment Variables & Feature Flags

> **Canonical catalogue (since 2026-05-29, PR #186):** `docs/eservices-variables.md`
> maps every external service RepWorth integrates with and indexes the **full**
> env-var inventory (cross-checked against `.env.example` — that pass found 34
> missing real vars + 3 vestigial). `.env.example` is the copy-paste template;
> **this file owns deep per-flag *behavior*** (don't duplicate the flat inventory
> here). Read the catalogue for "does var X exist / which service uses it"; read
> this file for "what does flag X do when I flip it".

## Flag-Gating Pattern

All feature flags are **server-authoritative**. Browser learns flag state via
API responses (e.g. `zernioPublishingEnabled` field in the business-detail API).
Never use `NEXT_PUBLIC_*` companions for feature flags — ops state must not
leak to clients or be spoofable.

Worker startup assertions fail fast on missing required vars. This is
intentional — a misconfigured worker is worse than a crashed one.
`MOCK_EXTERNAL_APIS=true` bypasses most startup assertions for local dev.
Assertion source: `worker/config/startup-assert.ts`.

> **CI env block (since 2026-05-24):** `.github/workflows/ci.yml` runs the
> `lint`/`typecheck`/`test`/`build` gate with a **secret-free** env block —
> localhost service URLs + valid-length dummy secrets, no production
> credentials. **`MOCK_EXTERNAL_APIS` is `false` in CI** (NOT `true`): the test
> suite expects it off and flips it to `'true'` per-test only where it exercises
> the mock path (e.g. `src/lib/zernio/client/transport.ts`). Setting it globally
> `true` breaks the Zernio real-path tests — see `lab-notes.md` (2026-05-24). DB
> integration + Playwright e2e are not gated yet (need `TEST_DATABASE_POOL_URL`).

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

---

## Notifications, Deliverability & Observability

| Var | Platform | Required? | Notes |
|---|---|---|---|
| `CONTACT_NOTIFY_TO` | Vercel | Recommended (prod) | Recipient for `/api/contact`, `/api/demo-request`, `/api/lead-intake` notification emails. No personal default: resolves via `resolveContactNotifyTo()` (`src/lib/notifications/contact-notify.ts`) → `CONTACT_NOTIFY_TO` → `RESEND_FROM_EMAIL` mailbox → `noreply@repworth.net`, with a Sentry error (`contact_notify_to_unset`) **and** `console.warn` on fallback. |
| `ADMIN_NOTIFICATION_EMAIL` | Railway | **Yes (prod)** | Recipient for admin exception / failover / engagement alerts. Worker boot **hard-asserts** this in production (`assertAdminNotificationEmail` in `worker/config/startup-assert.ts`); the worker refuses to start without it. Per-site runtime guards remain as defense-in-depth. |
| `LIST_UNSUBSCRIBE_URL` | Railway | Recommended (prod) | **HTTPS one-click** unsubscribe endpoint in the marketing `List-Unsubscribe` header (`src/lib/notifications/email/headers.ts`). Only when this is set does the header emit the https URL **plus** `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058 — Gmail/Outlook bulk-sender one-click). Unset → only the `mailto:` fallback is sent (no one-click), which weakens compliance. Documented in `.env.example` since PR #186. |
| `LIST_UNSUBSCRIBE_EMAIL` | Railway | Recommended (prod) | `mailto:` fallback recipient in the marketing `List-Unsubscribe` header (`src/lib/notifications/email/headers.ts`). Unset → falls back to the `RESEND_FROM_EMAIL` mailbox; worker boot warns in production (`warnMissingProductionEnv`). Without a working mailbox AND no `LIST_UNSUBSCRIBE_URL`, marketing emails fail Gmail/Outlook bulk-sender compliance (falls back to a non-functional `example.com` mailbox). |
| `SENTRY_DSN` | Vercel + Railway | Recommended (prod) | Server-side Sentry DSN (`src/instrumentation.ts`, `worker/sentry.ts`). Unset → Sentry silently no-ops; both boots warn in production (`warnMissingProductionEnv` on the worker, `register()` on Next.js). |
| `NEXT_PUBLIC_SENTRY_DSN` | Vercel | Recommended (prod) | Browser-side Sentry DSN (same value as `SENTRY_DSN`). Intentionally public. |

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

Source of truth: `src/lib/accounts/tier-config.ts` (`TIER_CONFIG`). Values above verified against the live file (2026-05-27). Note: billing snapshot reads `accounts.locations_included` and `accounts.locations_overage_price_cents` (stored, grandfathered) — not live `TIER_CONFIG` — except for base price, which has no stored column yet.

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

## Product Analytics (PostHog) — since 2026-05-24

| Var | Default | Notes |
|---|---|---|
| `POSTHOG_API_KEY` | — (unset) | PostHog Cloud project key. **Optional** — when unset, `src/lib/analytics/posthog.ts` is a no-op, so local dev / tests / `next build` need no analytics secret. Worker/server-only (`posthog-node`); never expose a `NEXT_PUBLIC_*` companion. |
| `POSTHOG_HOST` | `https://us.i.posthog.com` | PostHog ingestion host. Override for the EU region. |

Analytics is **best-effort**: a capture/flush failure must never block
publishing, owner approvals, or outbox completion. The worker flushes pending
events on graceful shutdown (`shutdownAnalytics()` in `worker/index.ts`,
guarded so a flush failure can't skip DB teardown). First event wired:
`activation_completed` on the publisher posted-transition paths
(`worker/jobs/publisher/activation.ts`). Not a feature flag — gated purely by
key presence.

**Wave 2 first-party analytics queue (PR #87, migration 046).** Browser/Next.js
code never calls PostHog. Client intent events POST to `/api/analytics/enqueue`
(same-origin, anon-rate-limited, gated to `CLIENT_ENQUEUEABLE_EVENT_NAMES`);
durable server events insert into `analytics_events` directly; the
`AnalyticsDispatchPoller` (Railway) claims rows and ships them to PostHog. Key
behavior: **unconfigured PostHog (`POSTHOG_API_KEY` unset) is a clean no-op** —
the poller early-returns and never claims rows, so nothing is dropped and the
queue is fully recoverable once a key is added (config/transient failures defer
without consuming the retry budget; only real per-event errors exhaust
`max_attempts`). `flush`-before-`completed`, so a row marked done was actually
sent. Tuning: `ANALYTICS_DISPATCH_*` under Poller Tuning below.

---

## Google Maps

| Var | Notes |
|---|---|
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Required for onboarding PlaceAutocomplete. Essentials tier (free). |

---

## Reviews (SerpAPI)

| Var | Default | Notes |
|---|---|---|
| `SERPAPI_API_KEY` | — | Required in prod for SerpAPI review/ranking data: onboarding demo review fetch (`src/lib/demos/fetch-reviews.ts`), Place-ID resolution (`src/lib/reviews/place-id-resolver.ts`), onboarding review **prefill** (`src/lib/reviews/serpapi-prefill.ts`), and the Railway `RankingTrackingWorker`. Used on **both** Next.js (prefill/place-id) and the worker (ranking). `MOCK_EXTERNAL_APIS=true` bypasses it locally (`MockReviewSource`). |
| `SERPAPI_TIMEOUT_MS` | `10000` | Optional per-call timeout for the prefill path (`serpapi-prefill.ts`, floored at 1ms). |

---

## Worker Infrastructure

| Var | Notes |
|---|---|
| `WORKER_PUBLIC_URL` | Public URL of Railway worker. Required when SMS enabled. Must match Twilio console exactly (scheme, host, no trailing slash). This is the single canonical worker-URL var — the older `WORKER_SERVICE_URL` was **retired** in PR #186 (deduped into `WORKER_PUBLIC_URL`). |
| `PORT` | Worker Fastify port (default: `3001`) |

---

## Retired / vestigial (do not re-add)

Confirmed unused by the 2026-05-29 codebase scan (PR #186) and **commented out / removed** from `.env.example`. Re-introducing them is a smell — check `docs/eservices-variables.md` §2 first.

| Var | Why retired |
|---|---|
| `ENCRYPTION_KEY` / `ENCRYPTION_KEY_VERSION` | Vestigial. RepWorth's token security model is **SHA-256 hashing, not symmetric encryption** (approval tokens stored as hashes — invariant #5); no code reads these. Commented out in `.env.example`. |
| `WORKER_SERVICE_URL` | Superseded by `WORKER_PUBLIC_URL` (see Worker Infrastructure above). |
| `ADMIN_API_KEY` | Removed earlier (PR #154). `/api/admin/*` uses `requireRole(request, 'admin')`, not a static key. |

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
| `STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS` | 3600000 (1h) | `StripeLocationsReconcilePoller` cadence. Wave 1 (PR #85) expanded it from location-count drift to full subscription + upcoming-invoice reconciliation (missing/duplicate/status/price/quantity/invoice drift → Sentry, never auto-corrects). |
| `STRIPE_LOCATIONS_RECONCILE_DISABLED` | `false` | `true` → skip the billing reconcile poller (mock mode auto-skips) |
| `ANALYTICS_DISPATCH_POLL_INTERVAL_MS` | 30000 (30s) | `AnalyticsDispatchPoller` cadence (Wave 2). Rejects non-numeric/unit-suffixed values (`'30s'` → falls back to default). |
| `ANALYTICS_DISPATCH_BATCH_SIZE` | 50 | Rows claimed per dispatch pass (clamped 1–250). |

> **Wave 1 launch-risk controls are unconditional — no kill-switch (since 2026-05-25, PR #85):**
> the **PHI scanner** on Zernio ingest (`src/lib/security/phi-scanner.ts` →
> blocks before persistence on every ingest path) and the **approval audit
> snapshot** (`response_text_at_approval`) are always-on by design — there is no
> env flag to disable them, because they are launch-risk guardrails (PHI leakage,
> dispute evidence), not optional features. PostHog remains gated by
> `POSTHOG_API_KEY` (see Product Analytics above) and is NOT yet listed as a live
> sub-processor until that key is confirmed in prod.

---

## Feature Flags — Off by Default

| Flag | Status | Prerequisite |
|---|---|---|
| `RANKING_TRACKING_ENABLED` | Off | Enable when ranking worker is ready |
| `SELF_SERVE_SIGNUP_ENABLED` | Off | Custom SMTP + Stripe payment links configured |
| `MFA_ENFORCEMENT_ENABLED` | Off (Wave 2, PR #87) | Master kill-switch for blocking MFA enforcement. **Off** = enrollment UI is live and AAL2 is still hard-required at the sensitive API routes (grant-extension, impersonation start/end/view), but the proxy does NOT redirect normal page navigation to `/mfa/challenge`. Flip **on** only after owner/admin regression tests pass. NB: MFA *unenroll* always requires a current AAL2 session regardless of this flag (server-enforced via `/api/auth/mfa/challenge` action `unenroll`). |
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

## Wave 2 secrets (PR #87)

| Var | Default | Notes |
|---|---|---|
| `IMPERSONATION_COOKIE_SECRET` | — (unset) | HMAC-SHA256 signing secret for the admin view-as session cookie (`rw_impersonation`). **Required for admin impersonation** and validated at use: must be **≥ 32 chars** or `assertImpersonationCookieConfigured()` throws (the start route fails closed). Generate with `openssl rand -hex 32`. Not a `NEXT_PUBLIC_*` var. |

---

## Wave 3 flags & config (PRs 1–6)

| Var | Default | Notes |
|---|---|---|
| `OPENAI_MODERATION_ENABLED` | **Off** | Gates the OpenAI Moderation **provider** layer in `src/lib/moderation/moderate.ts`. When unset/not `'true'`, only the local regex rules (`output-filter.ts`) run. When `'true'`, `moderateResponse` also calls `client.moderations.create({ model: 'omni-moderation-latest' })` and merges (provider flag → `high`). **Fail-open by design:** a provider error falls back to the local decision and is recorded as `openai_moderation: 'error'` — it never throws and never silently approves. Worker-only (never called from Vercel). Turning it on in prod is an external gate; tune thresholds against real samples first. |
| `LOG_SERVICE` | `worker` | Optional. Sets the `service` field on the JSON structured log lines (`src/lib/shared/logger.ts`). Leave unset for the worker; set to `web` (or a more specific name) where another process emits logs. Cosmetic — affects log labelling only. |

Not a flag, but related: structured logging (`createWorkerLogger`) and the
`AsyncLocalStorage` log context are always on (no flag) — see
`src/lib/shared/{logger,log-context}.ts`. The `flagged_responses` hold + admin
disposition (`/admin/flagged`) are also unconditional, not flag-gated. The only
Wave 3 behavior behind a flag is the optional OpenAI moderation layer above.

**PRs 4–6 added NO new feature flags** (none required):
- **PR 4 — eval harness (`tests/llm-eval/*`).** Offline scoring is keyless and
  always available (`pnpm eval:llm`). The optional `--live` mode is gated by the
  *presence of a provider key* (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`), not by
  a feature flag — no key → it errors loudly rather than silently skipping.
- **PR 5a — review sentiment.** Deterministic, always-on at ingest (no flag);
  `sentiment_source` is the forward-compat seam for a later classifier.
- **PR 5b — customer KPIs (`GET /api/dashboard/kpis`).** Always-on for entitled
  owners; the per-location-vs-aggregate split reuses the existing
  `MULTI_LOCATION_ENABLED` flag (same `scope=all` semantics as `/api/dashboard`).
- **PR 6 — finance margin signals (`/admin/costs`).** Admin-only, always-on; no
  flag. Turning OpenAI Moderation on / wiring ProfitWell etc. remain external
  (non-flag) gates.

## Docs

- `NEXT_PUBLIC_DOCS_BASE_URL` — optional. Makes `/admin/runbook` doc names
  clickable links. Leave unset to disable links.
