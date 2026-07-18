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
| `DATABASE_URL` | Postgres connection string. **Historically labeled "PgBouncer pooled", but on staging this is the DIRECT :5432 route** (verified 2026-07-18): the pooled URL the worker actually runs on is `DATABASE_POOL_URL` (Supavisor transaction pooler, :6543). |
| | > ⚠️ Local `.env.local` must point these at a local Supabase stack (`supabase start`), never the prod/staging project ref (audit FIND-ENV, 2026-06-23). |
| `DB_POOL_MAX` | Optional, default `10`. Postgres.js per-process connection-pool ceiling (`src/lib/db/server.ts`). The default matches the Railway worker's needs; **set `3` on Vercel** (prod + staging Custom Env + preview) so each serverless instance stays small against the Supabase pooler's client-connection ceiling. The other pool bounds (`idle_timeout: 30`, `max_lifetime: 1800`, `connect_timeout: 10` — Postgres.js takes seconds) are fixed in code, deep-scan §3.5. |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (browser-safe) |
| `SUPABASE_SERVICE_KEY` | Server-only. NEVER expose to browser. |
| `REDIS_CACHE_URL` | Upstash Redis — cache instance (separate from queue) |
| `REDIS_QUEUE_URL` | Railway Redis — BullMQ queue instance, private net/per-env (separate from cache; see deployment-guide §1.4) |
| `OPENAI_API_KEY` | GPT-4o-mini (primary LLM) |
| `ANTHROPIC_API_KEY` | Claude Haiku fallback (`claude-haiku-4-5-20251001`) |
| `RESEND_API_KEY` | Transactional email + custom SMTP password |
| `NEXT_PUBLIC_APP_URL` | Full origin e.g. `https://repworth.app` |

---

## Development / Testing

| Var | Default | Notes |
|---|---|---|
| `MOCK_EXTERNAL_APIS` | `false` | `true` → bypass SerpAPI + LLM + Twilio/Telegram channel boot assertions. Uses `MockReviewSource` + `generateMockResponse`. |
| `MOCK_ZERNIO_LOCATION_COUNT` | `1` | Mock-mode only: number of deterministic locations (`mock-loc-1..n`) returned by the mock transport's `list_locations`, so the connect flow can simulate multi-location accounts. Clamped to 1–50. No effect when `MOCK_EXTERNAL_APIS=false`. |
| `TEST_DATABASE_POOL_URL` | — | E2E tests skip gracefully when unset. Set in CI for both the `test` (Vitest integration + live RLS audit) and `e2e` (Playwright) jobs, pointed at the postgres:16 service prepared by `.github/actions/test-db`. Local setup: `docs/runbooks/e2e-local-setup.md`. |
| `ALLOW_E2E_DB_WRITES` | — | Second half of `e2e/seed.ts`'s `isE2eConfigured` gate (Playwright doesn't run with `NODE_ENV=test`): `true` lets the seed helpers write to `TEST_DATABASE_POOL_URL`. Set only against disposable test databases — never dev/staging. CI's `e2e` job sets it. |
| `E2E_OWNER_EMAIL` | — | Confirmed owner login on the test Supabase, used by the owner-login E2E specs (`e2e/remaining-scenarios`, `e2e/edit-replies-runbook`). Specs skip when unset. Never hardcode in spec files. |
| `E2E_OWNER_PASSWORD` | — | Password for `E2E_OWNER_EMAIL`. Server/test-only; never committed. |
| `E2E_SUPABASE_URL` | — | Auth-harness (e2e/harness.ts) Supabase project URL — the STAGING project. With `E2E_SUPABASE_SERVICE_KEY`, enables the 4 base-tier auth-funnel specs. Never set in CI. |
| `E2E_SUPABASE_SERVICE_KEY` | — | Service-role key for the harness project (admin createUser/generateLink/deleteUser). Never committed, never in CI. |
| `E2E_AUTH_DEEP` | — | `true` opts into the 4 deep auth specs, which require `TEST_DATABASE_POOL_URL` = the staging Postgres (dual-client constraint). Seeds/cleans shared staging rows — deliberate local use only; see `docs/runbooks/e2e-local-setup.md#auth-harness`. |
| `E2E_DATABASE_URL` | — | Optional Postgres URL for the raw-`psql` E2E fixtures; falls back to `TEST_DATABASE_POOL_URL` when unset. |
| `FIXTURE_ACCOUNT_ID` | `fixture-account-1` | Test-only: Zernio account id the fake fixture-server launcher (`e2e/fixtures/serve.ts`) reports for its locations. Override to match the seeded `zernio_connections.zernio_account_id` in the multi-location full-loop runbook. Never read by production code. |

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
- all six Copilot/Autopilot `STRIPE_PRICE_*` variables listed under Stripe
- strict UTC `FOUNDING_DEADLINE` and the required positive Copilot/Autopilot
  cost ceilings
- Worker startup assertion fails without these.

**Supabase email template requirements:**
- Signup confirmation: `{{ .Token }}` (6-digit OTP) — NOT `{{ .ConfirmationURL }}`
- Reset password + Invite user: use `{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&amp;type=recovery|invite&amp;flow=owner&amp;next=/reset-password`
- `&amp;` required — unescaped `&` breaks `<a href>` attributes
- Custom SMTP: `smtp.resend.com:465`, username `resend`, password = `RESEND_API_KEY`

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
- `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_NUMBER` — format: `whatsapp:+<digits>` (assertion enforces format)
- `WHATSAPP_APPROVAL_TEMPLATE_SID` — Twilio Content SID for `repworth_approval_request_v1`
- `WHATSAPP_APPROVAL_URL_BASE` — must equal `NEXT_PUBLIC_APP_URL + '/approve/'` (assertion enforces equality)

**Optional (degrading) — NOT startup-required:**
- `WHATSAPP_AUTOPOST_TEMPLATE_SID` — Twilio Content SID for the auto-approved post
  FYI template `repworth_autopost_notice_v1` (Workstream B; see
  `docs/runbooks/whatsapp-templates.md`). **Deliberately absent from
  `assertChannelsWhatsAppEnv`** — its absence must NOT fail worker boot. When
  unset, the FYI dispatcher pre-filters WhatsApp (`skipped`, logged) and the
  WhatsApp channel's `sendAutoPostNotice` returns `{status:'skipped'}`; email +
  Telegram FYIs still send. Set on **both** Vercel and Railway once the Meta
  template clears, then the WhatsApp FYI activates with no code change. No
  `NEXT_PUBLIC_*` companion.
- `WHATSAPP_ESCALATION_TEMPLATE_SID` — Twilio Content SID for the Guardian
  escalation-notice template (WS3; see `docs/runbooks/whatsapp-templates.md`).
  Same posture as the autopost SID: **deliberately absent from
  `assertChannelsWhatsAppEnv`** — its absence must NOT fail worker boot. When
  unset, the escalation dispatcher (`worker/jobs/escalation-notice/dispatch.ts`)
  pre-filters WhatsApp (`skipped`, logged — no claim, no send) and the WhatsApp
  channel's `sendEscalationNotice` returns `{status:'skipped'}`; email +
  Telegram escalation notices still send. Worker-only (Railway); set it once the
  Meta template clears and WhatsApp escalation notices activate with no code
  change. No `NEXT_PUBLIC_*` companion.
- `WHATSAPP_PENDING_POST_TEMPLATE_SID` — Twilio Content SID for the WS4
  pending-post notice template ("auto-posts at HH:MM UTC — review or cancel";
  authoritative content + submission steps:
  `docs/runbooks/whatsapp-templates.md`, "Pending-post notice" section). Same
  posture as the two SIDs above: **deliberately absent from
  `assertChannelsWhatsAppEnv`** — its absence must NOT fail worker boot. When
  unset, the WhatsApp channel's `sendPendingPostNotice` returns
  `{status:'skipped'}` (fails closed; the dispatcher
  `worker/jobs/pending-post-notice/dispatch.ts` pre-filters and logs the
  skip); email + Telegram notices still send. Worker-only (Railway); set it
  once the Meta template clears and WhatsApp pending-post notices activate
  with no code change. Per-env SIDs (the URL button base must match the env's
  `NEXT_PUBLIC_APP_URL`). No `NEXT_PUBLIC_*` companion.
- `WHATSAPP_AUTONOMY_SUSPENDED_TEMPLATE_SID` — Twilio Content SID for the WS6
  account-level safety notice (`repworth_autonomy_suspended_v1`; authoritative
  body, button contract, and submission procedure in
  `docs/runbooks/whatsapp-templates.md`, "Autonomy-suspended notice"). It is
  **deliberately absent from `assertChannelsWhatsAppEnv`**: when unset,
  `autonomy-suspended-notice/dispatch.ts` skips WhatsApp cleanly without
  creating a delivery claim, while email and Telegram still send. Worker-only
  (Railway); use the environment-specific approved SID. No `NEXT_PUBLIC_*`
  companion.

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
  one-location accounts** (so a freshly-paid Copilot/Autopilot owner can add
  their second location).
- `shouldUseMultiLocationSettings(flag, count)` — true multi-location MODE
  (`count > 1`). Drives the switcher, aggregate scope, and the
  Voice/Notifications multi-loc content. `/settings/voice` stays gated on
  this; single-location Brand Voice links to `/settings#brand-voice`.
- `canAddLocationForAccount(flag, tier, status)` — eligibility (flag +
  `subscriptionGrantsFullAccess(status)` + launch-tier multi-location access).
  Both Copilot and Autopilot support paid extra locations; `trialing` retains
  full access.

Server-authoritative. Schema (migrations 034–041) ships on regardless
of the flag — flipping the flag only exposes the user surface. The
`accounts` table is populated for every business either way.

**Required when on:** `STRIPE_PRICE_COPILOT_OVERAGE` and
`STRIPE_PRICE_AUTOPILOT_OVERAGE`. `UpdateStripeOverageWorker` resolves them
through the variant-aware Price map and refuses to run when configuration is
missing.

**Tier configuration** (`src/lib/accounts/tier-config.ts`):

| Tier | Base | Included | Overage / extra | Multi-loc |
|---|---|---|---|---|
| Copilot list / founding | $29 / $19 | 1 | $15 | Yes |
| Autopilot list / founding | $69 / $49 | 1 | $20 | Yes |

Source of truth: `src/lib/accounts/tier-config.ts`. New-account and tier-change
writes resolve `(subscription_tier, price_variant)` once, then persist the
complete snapshot. Billing reads `accounts.locations_included`,
`accounts.locations_overage_price_cents`, and `accounts.base_price_cents`; it
never re-derives historical charges from the live registry (invariant #9a).

**Price-change procedure** (new customers pay new prices; existing customers keep theirs — grandfathered):

1. Create a **new** Stripe Price (Prices are immutable — you never edit
   `unit_amount`) with the new amount (+ `tax_behavior='exclusive'` if Tax is
   on). Leave every outgoing overage Price active.
2. Prepare one release that adds the outgoing Price ID to the typed
   `RETAINED_STRIPE_PRICE_HISTORY` registry in
   `src/lib/payments/price-tier-map.ts` (including base/overage kind, tier, and
   base variant; overage entries also record immutable `unitAmountCents`) and
   updates `TIER_CONFIG` to the new cents. Do not serve billing traffic from a
   mixed old-code/new-env or new-code/old-env state.
3. Quiesce Checkout, tier changes, and overage workers for the target
   environment. Drain in-flight billing mutations before changing code or env.
4. While quiesced, point the appropriate `STRIPE_PRICE_*` env var to the new ID
   and deploy the prepared release. Wait for old instances to drain completely.
   Never rotate all environments as one unverified action.
5. Still quiesced, run `pnpm verify:stripe-prices`. It verifies all six live
   Prices plus every retained overage Price (active, exact recorded cents, USD,
   monthly interval, and Tax shape). Any mismatch is a hard no-resume blocker.
6. Resume billing only after parity passes; repeat staging first, then
   production.
7. Existing customers are unaffected (grandfathered via the stored `accounts`
   snapshot); only new signups + tier-changers get the new price. Repricing
   *existing* customers is a separate cohort migration + ARL §17602(g)
   fee-change notice (out of scope).

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
| `STRIPE_PRICE_COPILOT_LIST` | Immutable USD monthly Copilot list base Price; exactly 2900 cents |
| `STRIPE_PRICE_COPILOT_FOUNDING` | Immutable USD monthly Copilot founding base Price; exactly 1900 cents |
| `STRIPE_PRICE_AUTOPILOT_LIST` | Immutable USD monthly Autopilot list base Price; exactly 6900 cents |
| `STRIPE_PRICE_AUTOPILOT_FOUNDING` | Immutable USD monthly Autopilot founding base Price; exactly 4900 cents |
| `STRIPE_PRICE_COPILOT_OVERAGE` | Immutable USD monthly Copilot extra-location Price; exactly 1500 cents |
| `STRIPE_PRICE_AUTOPILOT_OVERAGE` | Immutable USD monthly Autopilot extra-location Price; exactly 2000 cents |
| `FOUNDING_DEADLINE` | Exact launch value `2027-01-01T00:00:00Z`. Parsed as strict UTC; founding eligibility is exactly `now() < deadline`. Missing/malformed fails closed to list pricing and emits an operational alert. |

All six launch IDs are required, unique, active, USD, and monthly recurring.
When `STRIPE_TAX_ENABLED=true`, their `tax_behavior` must be `exclusive`.
`pnpm verify:stripe-prices` validates that provider shape without checking an
invented metadata convention. Existing Prices are immutable: any commercial
price change creates a new Stripe Price, while every still-referenced ID remains
resolvable.

During the WS8 rollback window, deployment configuration must also retain these
seven old Price IDs, although strict WS8 runtime code does not read them:
`STRIPE_PRICE_BASIC`, `STRIPE_PRICE_FOUNDING`,
`STRIPE_PRICE_FOUNDERS_OVERAGE`, `STRIPE_PRICE_STANDARD`,
`STRIPE_PRICE_STANDARD_OVERAGE`, `STRIPE_PRICE_PREMIUM`, and
`STRIPE_PRICE_PREMIUM_OVERAGE`. The provider-wide
`pnpm ws8:stripe-preflight` command reads this retained set only to identify and
block open legacy-Price Checkout Sessions. Remove them only after the rollback
window closes. The only executable cutover order and rollback boundaries are in
[`docs/runbooks/ws8-tier-cutover.md`](../../docs/runbooks/ws8-tier-cutover.md).

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
| `WORKER_PUBLIC_URL` | Public URL of Railway worker. Required for Twilio webhook signature verification. Must match Twilio console exactly (scheme, host, no trailing slash). This is the single canonical worker-URL var — the older `WORKER_SERVICE_URL` was **retired** in PR #186 (deduped into `WORKER_PUBLIC_URL`). |
| `WORKER_INTERNAL_SECRET` | **Server-only** (NOT `NEXT_PUBLIC`). Shared bearer secret the admin jobs panel (`/api/admin/jobs`) sends when fetching the worker's `GET /internal/queue-health` endpoint for per-queue depth (#408 — Vercel can't reach Railway Redis directly, invariant #1). Compared in constant time (`crypto.timingSafeEqual`); never logged. **Optional and NOT boot-asserted** on either platform — when unset the worker endpoint returns `503 {disabled:true}` and the panel degrades to `queueHealth:{unavailable:true}` (queue depth only; the Postgres-backed outbox/failed-job panels are unaffected). Set the **SAME** value on BOTH the Vercel project and the Railway worker, per env, to enable live depth. Generate with `openssl rand -hex 32`. |
| `PORT` | Worker Fastify port (default: `3001`) |
| `WORKER_SHUTDOWN_GRACE_MS` | Optional, default `25_000`. Graceful-shutdown watchdog deadline (`worker/shutdown.ts`, deep-scan §5.4): if `worker.close()` wedges on a hung outbound call, the process force-exits within this window instead of waiting for Railway's SIGKILL (which would lose the analytics/Sentry flush). Size it **inside** the Railway SIGTERM→SIGKILL window (~30s); non-numeric/≤0 values fall back to `25_000`. |

---

## Retired / vestigial (do not re-add)

Confirmed unused by the 2026-05-29 codebase scan (PR #186) and **commented out / removed** from `.env.example`. Re-introducing them is a smell — check `docs/eservices-variables.md` §2 first.

| Var | Why retired |
|---|---|
| `ENCRYPTION_KEY` / `ENCRYPTION_KEY_VERSION` | Vestigial. RepWorth's token security model is **SHA-256 hashing, not symmetric encryption** (approval tokens stored as hashes — invariant #5); no code reads these. Commented out in `.env.example`. |
| `WORKER_SERVICE_URL` | Superseded by `WORKER_PUBLIC_URL` (see Worker Infrastructure above). |
| `ADMIN_API_KEY` | Removed earlier (PR #154). `/api/admin/*` uses `requireRole(request, 'admin')`, not a static key. |

---

## Cost Ceilings

Daily LLM/external spend caps enforced by the cost-guard (`src/lib/costs/tracker.ts`).
A reservation precedes every LLM call, so these caps are spend-safe; **exceeding a
cap is TERMINAL** (the draft is dropped) and now also emits a Sentry alert
(`cost_event:limit_exceeded`, from `generate-draft.ts`) so dropped paid work is
never silent (beta-launch gate B3). WS8 requires explicit operator-approved,
positive-integer per-tier values before strict code boots; there are no legacy
tier mappings and no invented defaults.

| Var | Default | Notes |
|---|---|---|
| `GLOBAL_DAILY_COST_LIMIT_CENTS` | `10000` ($100/day) | Platform-wide shared daily ceiling, checked against the 15¢ pessimistic reserve. A single fairness-free counter — size it well above plausible concurrent fleet reserves (re-dimensioning / non-terminal redesign tracked in the worker-scaling backlog). |
| `DAILY_COST_LIMIT_CENTS_COPILOT` | **Required; no default** | Positive-integer per-account Copilot ceiling. `price_variant` does not change it. Missing/malformed configuration fails the owning worker/server config gate. |
| `DAILY_COST_LIMIT_CENTS_AUTOPILOT` | **Required; no default** | Positive-integer per-account Autopilot ceiling. Operator supplies the amount; do not derive it from an old tier. |

(The onboarding-demo lane has its own separate ceiling — see `ONBOARDING_DEMO_DAILY_CENTS` below.)

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
| `ZERNIO_RECENT_REVIEW_POLL_MAX_CONNECTIONS` | 100 | `ZernioRecentReviewPoller` per-cycle connection cap (deep-scan §3.7). An in-memory `business_id` keyset cursor rotates through all active connections across cycles, wrapping at the end; a worker restart restarts the rotation. (Replaces the removed `ZERNIO_RECENT_REVIEW_POLL_BATCH_SIZE` load-page size.) |
| `ZERNIO_RECENT_REVIEW_POLL_CONCURRENCY` | 3 | Bounded fan-out: connections polled against Zernio in parallel per cycle (pages within a connection stay serial). |
| `ZERNIO_RECENT_REVIEW_POLL_DEADLINE_MS` | 60000 (1min) | Per-cycle deadline: past it no new connection is dispatched (in-flight finish); deferred count is warn-logged and those connections lead the next cycle. Also sizes the poll-cycle **watchdog** (= deadline + 60s in-flight-drain buffer), which `withTimeout`-bounds the whole cycle so a stale-pooled-connection hang can't pin `isPolling` forever. Keep it so deadline+drain stays **below** `ZERNIO_RECENT_REVIEW_POLL_INTERVAL_MS` (5min default) — a watchdog longer than the interval burns a whole extra recovery cycle. Lowered 240000→60000 (PR #412 follow-up) for faster hang recovery; a cycle finishes in seconds at current scale so dispatch is unaffected. |
| `OUTBOX_POLL_INTERVAL_MS` | 5000 (5s) | `OutboxPoller` tick cadence. Lowered 30000→5000 (100-business perf pass, 2026-07-16): the claim query is a cheap indexed `FOR UPDATE SKIP LOCKED` scan, and 5s cuts ~12.5s median pure-wait per outbox hop (×4 hops webhook→ingest→generate→notify). |
| `OUTBOX_WATCHDOG_STALE_MS` | 900000 (15min) | Age after which a row stuck in `dispatched` (worker crashed / retries exhausted mid-outage) is re-pended (or dead-lettered past `max_attempts`) by the `OutboxPoller` watchdog. Lowered from the historical hardcoded 1h so a provider outage that outlasts BullMQ's in-band retries stalls affected rows ≤15min, not 1h. Values `<60000` fall back to the default. Keep it above the longest legitimate job runtime — the only near-miss is the initial Zernio backfill, which is idempotent, so a rare re-dispatch is wasteful, not harmful. |
| `OUTBOX_DISPATCH_TIMEOUT_MS` | 10000 (10s) | Per-row deadline on the BullMQ enqueue in `OutboxPoller` (`withTimeout` around `queue.add`). The queue connection uses `maxRetriesPerRequest: null`, so an unreachable **Railway Redis** otherwise parks `queue.add` forever in ioredis' offline command queue — the exact failure that silently stalled the staging outbox (2026-06-15). On timeout the row follows the normal dispatch-failure path (re-pended if attempts remain, dead-lettered once exhausted). Values `<1000` fall back to the default. |
| `OUTBOX_POLL_MAX_CYCLE_MS` | `max(4× OUTBOX_POLL_INTERVAL_MS, 60000)` (120s default) | Self-recovery backstop for the `OutboxPoller` overlap guard. A cycle in flight longer than this is assumed wedged: it is logged at **error** (`exceeded max duration`) and a fresh cycle supersedes it, so no single hung `await` can kill the dispatcher until a process restart. Concurrent cycles are safe (claims use `FOR UPDATE SKIP LOCKED`; every dispatch UPDATE is attempt-scoped). Values `<1000` fall back to the default. |
| `HEALTH_ALERT_POLL_INTERVAL_MS` | 300000 (5min) | `HealthAlertPoller` cadence (beta-launch gate A). Read-only probe for silent pipeline failure / dropped paid work → Sentry (non-email). **Requires `SENTRY_DSN` in production** (`assertAlertSinkEnv` — boot fails without it). |
| `JUDGE_POLL_INTERVAL_MS` | 60000 (1min) | `JudgeSweepPoller` cadence. Parsed with `parseInt`; a positive parsed millisecond value is accepted, while invalid, zero, or negative values fall back to 60s. The poller itself remains inert unless server-only `JUDGE_ENABLED=true`. |
| `GOVERNOR_INTERVAL_MS` | 900000 (15min) | `AutonomyGovernorScheduler` cadence. Parsed with `parseInt`; a positive parsed millisecond value is accepted, while invalid, zero, or negative values fall back to 15min. The scheduler itself remains inert unless server-only `GOVERNOR_ENABLED=true`. |
| `HEALTH_ALERT_PENDING_AGE_S` · `_STALE_DISPATCHING_S` · `_FAILED_WINDOW_S` · `_FAILED_THRESHOLD` · `_FLAGGED_OPEN_THRESHOLD` · `_ZERO_DELIVERY_WINDOW_S` | 900 · 600 · 3600 · 0 · 5 · 3600 | Per-signal thresholds — see `docs/runbooks/beta-launch-alerting.md` §5. |
| `HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD` | 1500 | Per-table pending-row **backlog depth** (`job_outbox`, `analytics_events`) above which HealthAlertPoller emits a `warning` (`backlog_depth:<table>`). Sized to the #474 Capacity target. Optional/defaulted (invalid/negative → 1500). Also surfaced (uncounted-alert) as the `backlog` key on `GET /internal/queue-health`. |
| `HEALTH_ALERT_MONITOR_SLUG` | `health-alert-poller` | Sentry Cron monitor slug for the probe's dead-man heartbeat (alerts if the probe stops checking in). |
| `EMAIL_SEND_TIMEOUT_MS` | 10000 (10s) | Per-send Resend timeout enforced by the `sendEmail` chokepoint (`src/lib/notifications/email/send-email.ts`). A hung send must not head-of-line-block the concurrency-1 notification worker. |

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
| `SELF_SERVE_SIGNUP_ENABLED` | Off | Custom SMTP + six Stripe Prices + required deadline/cost configuration |
| `MFA_ENFORCEMENT_ENABLED` | Off (Wave 2, PR #87) | Master kill-switch for blocking MFA enforcement. **Off** = enrollment UI is live and AAL2 is still hard-required at the sensitive API routes (grant-extension, impersonation start/end/view), but the proxy does NOT redirect normal page navigation to `/mfa/challenge`. Flip **on** only after owner/admin regression tests pass. NB: MFA *unenroll* always requires a current AAL2 session regardless of this flag (server-enforced via `/api/auth/mfa/challenge` action `unenroll`). |
| `CHANNELS_TELEGRAM_ENABLED` | Off | Bot registered + setWebhook called |
| `CHANNELS_WHATSAPP_ENABLED` | Off | Meta verification + WABA + template approval |
| `ZERNIO_PUBLISHING_ENABLED` | **ON (prod, 2026-04-28)** | Migrations 026+028+029+030 applied |
| `AUTO_APPROVAL_ENABLED` | Off | Server-only kill switch for the auto-approval runtime path. `false`/unset means generated drafts stay on normal owner review; any unposted `approval_method='auto_policy'` publish job is downgraded back to `pending_approval` and not posted. `true` permits auto-approval only for `live_ingest_new` v1 jobs that pass current review hash, active location/connection, subscription, policy threshold, and provider moderation gates. **WS4 (spec §2.12): the flag now ALSO governs the whole veto-window lane** — candidate evaluation, the delayed `publish_response` enqueue (`available_at = NOW() + veto_window_minutes`), the `pending_post_notice` send-time re-check (`PendingPostNoticeWorker` completes without sending when off), and the publisher's downgrade backstop (which also catches responses caught mid-window by a kill-switch flip). No new WS4 flags — everything rides this one. Worker startup rejects non-`true`/`false` configured values. No `NEXT_PUBLIC_*` companion. |
| `AUTOPILOT_PURCHASABLE` | Off | Server-only commercial and policy-expansion gate. Effective purchasability is exactly this flag **AND** `autoApprovalRuntimeEnabled()`; closing either side blocks new Autopilot Checkout and autonomy-expanding trust-dial edits, while contractions remain allowed. Keep `false` throughout the WS8 data/code cutover. Independent authorization to set `true` requires WS4/migration 074 live, WS6/migration 076 live, WS7 eval green, documented cadence limits, and `AUTO_APPROVAL_ENABLED=true`; the composed runtime remains the live backstop. No `NEXT_PUBLIC_*` companion. |
| `JUDGE_ENABLED` | Off | **Server-only WS6 safety kill switch**, read through `readFlag` by `judgeEnabled()`. `false`/unset stops the judge sweep and JudgeWorker before work; the publisher also treats the judge as unavailable and downgrades every unposted `auto_policy` response to owner review. Therefore `AUTO_APPROVAL_ENABLED=true` **requires** `JUDGE_ENABLED=true` for auto-posting to proceed. Worker startup accepts only exact `true`/`false`. No `NEXT_PUBLIC_*` companion. Roll out staging first after migration 076: enable `JUDGE_ENABLED` with `GOVERNOR_ENABLED`, smoke an auto-post→verdict and forced-flag suspension→admin-unsuspend drill, then leave production off until the ordered Autopilot go-live flip (`TRIAGE_ENABLED` → `ESCALATION_ENABLED` → WS6 flags with `AUTO_APPROVAL_ENABLED`). |
| `GOVERNOR_ENABLED` | Off | **Server-only WS6 scheduler kill switch**, read through `readFlag` by `governorEnabled()`. `false`/unset stops the account-level autonomy governor; it does not resume suspended policies. Worker startup accepts only exact `true`/`false`. No `NEXT_PUBLIC_*` companion. Enable in staging together with `JUDGE_ENABLED` after migration 076 and the suspension drill; keep production off until the same ordered Autopilot go-live flip. |
| `AUTO_APPROVAL_PROVIDER_MODERATION_READY` | Off | Server-only ops readiness marker after target-environment provider moderation validation. This does not by itself enable runtime auto-approval; `OPENAI_MODERATION_ENABLED=true` and a clean provider result are runtime gates, while this marker gates settings expansion/readiness. Worker startup rejects non-`true`/`false` configured values. No `NEXT_PUBLIC_*` companion. |
| `ACCOUNT_OFFBOARDING_ENABLED` | Off | Server-only kill switch for owner offboarding. Leave off until the full 7-PR sequence lands and the staging dry-run passes. `true` is the only enabling value; worker startup rejects non-`true`/`false` configured values. No `NEXT_PUBLIC_*` companion. Browser surfaces learn offboarding state through authenticated server responses only. |
| `STRIPE_TAX_ENABLED` | Off | Server-only. When `true`, checkout sessions enable `automatic_tax`, require a billing address, and collect tax IDs. Requires Stripe Tax enabled in the dashboard + `tax_behavior` on every Price first (enabling it before that makes `sessions.create` throw). Worker startup rejects non-`true`/`false` configured values. No `NEXT_PUBLIC_*` companion. |
| `ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS` | unset | **Staging / non-prod only.** Server-only shortener for the 30-day `delete_data` purge window so the staging dry-run does not block on the real wait. `getAccountOffboardingPurgeWindowOverrideMs()` returns `null` (refuses the override) when `NODE_ENV=production` **or** `VERCEL_ENV=production`, so it can never shorten the purge window in production. Never exposed to browser code; intentionally absent from `.env.example` so it is not mistaken for a normal var. Sibling poller tuning vars `ACCOUNT_OFFBOARDING_PURGE_INTERVAL_MS` (default 60000) and `ACCOUNT_OFFBOARDING_PURGE_BATCH_SIZE` (default 25, capped 100) are optional and safe in any env. The T-3d purge-reminder poller has the same optional tuning pair: `ACCOUNT_OFFBOARDING_PURGE_REMINDER_INTERVAL_MS` (default 60000) and `ACCOUNT_OFFBOARDING_PURGE_REMINDER_BATCH_SIZE` (default 25, capped 100). |
| `ACCOUNT_OFFBOARDING_TEARDOWN_MAX_RETRIES` / `…_TEARDOWN_RETRY_COOLDOWN_MS` | **12 / 300000** (5 min) | Caps for `TeardownRetryPoller`: a `failed` / `failed_step='teardown'` row is re-driven back to `tearing_down` up to MAX_RETRIES (code default **12**), after the per-attempt cooldown (default **5 min**), then left `failed` for an operator. Optional; safe in any env. (The 2026-06-08 dry-run lowered these to `3 / 60000` to exercise the cap quickly — those are NOT the defaults.) The other recovery/timing pollers share optional interval/batch tuning, all defaulting to **60000 ms / 25** except teardown-retry's batch of **10**: `ACCOUNT_OFFBOARDING_ACCESS_END_INTERVAL_MS` / `…_ACCESS_END_BATCH_SIZE`, `…_REACTIVATION_RESET_INTERVAL_MS` / `…_REACTIVATION_RESET_BATCH_SIZE` (releases a stale `reactivation_claimed_at` older than 5 min so a crashed reactivation is never stranded mid-reversal), and `…_TEARDOWN_RETRY_INTERVAL_MS` / `…_TEARDOWN_RETRY_BATCH_SIZE`. |
| `EXTERNAL_REPLY_IMPORT_ENABLED` | Off (code-complete on `feat/past-replies-view`, 2026-05-02) | Migration 031 applied. Gates the import-on-ingestion writes path inside `reconcileExternallyAnsweredReview` — when off, today's silent-no-op behavior on previously-unseen / no-active-response external replies is preserved. When on, those replies get inserted as `posted` responses with `external_reply_ingested_at` set. **CAUTION:** flipping this on changes the dashboard "total responded" count for businesses with imported replies (imported `posted` rows are in `HANDLED_STATUSES`). The two-flag rollout is designed so you can soak this silently before turning on the UI. |
| `PAST_REPLIES_VIEW_ENABLED` | Off (code-complete on `feat/past-replies-view`, 2026-05-02) | Migration 031 applied + ≥ 1 week soak of `EXTERNAL_REPLY_IMPORT_ENABLED` recommended. Gates the `/dashboard/past-replies` page (returns 404 when off) and the `OwnerNav` "Past Replies" link (hidden when off). Server-authoritative; layout reads the env var and passes it as a prop to `OwnerNav`. NO `NEXT_PUBLIC_*` companion. Read-only feature — no edit / regenerate / publish actions. |
| `EDIT_REPLIES_ENABLED` | Off (code-complete, PR #56, 2026-05-23/27) | Migration 031 applied + `PAST_REPLIES_VIEW_ENABLED=true` (every edit route checks BOTH flags — `src/app/api/dashboard/past-replies/_shared/edit-reply-request.ts`). Gates owner editing of already-posted replies: the 7 `/api/dashboard/past-replies/*` edit routes (draft manual/regenerate → PATCH/DELETE → publish, plus `/retry` and `/restore-original` recovery; all return 503 `feature_disabled` when off), the Edit UI in `PastRepliesClient`, AND the publisher's DELETE-then-POST edit branch + failed-hook orphan conversion (`worker/jobs/publisher/ResponsePublisherWorker.ts`, `failed-hook.ts`). **Read by BOTH Next.js and the worker — set it in both places.** When off, publisher behavior is byte-for-byte the POST-only path. Server-authoritative; no `NEXT_PUBLIC_*` companion. |
| ~~`EDIT_EXISTING_REPLIES_ENABLED`~~ | **PARKED** on tag `wip/edit-existing-replies-zernio-v1` | Original single-flag for the full edit / regenerate / publish / retry / restore-original feature. NOT shipped on main — superseded by the two-flag split above. Resurrect only if direct GBP API timeline blows up beyond ~12 months; otherwise rebuild against GBP's single-PUT model when GBP arrives. |
| `ONBOARDING_DEMO_ENABLED` | Off (PR #2 default) | Master flag for the pre-pay demo lane on `feat/pre-paywall-demo-pr2`. When ON: `/onboarding/start` (location capture) and `/onboarding/demo` (demo + paywall) become reachable, `/api/onboarding/business` switches to `BusinessOnboardingPostPaySchema` (rejects location fields), and the wizard becomes 2-step (Profile + Voice). When OFF: those routes 404 and the legacy 3-step wizard runs. Migration 032 must be applied either way. |
| `ONBOARDING_DEMO_DAILY_CENTS` | `1000` ($10/day) | Global daily cost ceiling for the onboarding demo lane. Override at runtime via Redis key `cost:onboarding-demo:override:cents`. Each demo reserves 20¢ pessimistically; the worker reconciles to actual spend (~3¢). |
| `ONBOARDING_DEMO_STAFF_EMAILS_CSV` | unset | Phase 3 staff allowlist for soft-launch. Comma-separated owner emails permitted to reach `/onboarding/start` while the flag is on for the rest of the world. Removed at Phase 4 (full GA). |
| `TRIAL_ENABLED` | **Off** | Card-up-front, Stripe-native 30-day free trial (migration 069). Server-authoritative; **no `NEXT_PUBLIC_*` companion** (inv #13). When `true` AND the account is a self-serve `pending_payment` account (eligibility per the trial spec §0.2), both self-serve checkout entry points (`/api/billing/checkout`, `/api/onboarding/select-plan`) pass `trial: true` to `createCheckoutSession`, which adds `subscription_data.trial_period_days = TRIAL_PERIOD_DAYS`. Stripe charges **$0 now** and the resulting subscription comes back `status='trialing'`, which `checkout.session.completed` projects to the new explicit `'trialing'` account status via the single applier (`worker/ingress/stripe/apply-subscription-state.ts`). `'trialing'` is treated like `'active'` for entitlement everywhere EXCEPT recurring paid ranking tracking (SerpAPI) which stays active-only. Conversion `trialing→active` fires from `customer.subscription.updated` (status='active') only — the $0 trial-start invoice does NOT convert. Cancel-during-trial runs through existing offboarding `cancel_at_period_end`. The landing hero CTA becomes "Start your N-day free trial" only when this AND `SELF_SERVE_SIGNUP_ENABLED` are on. Reconcile poller has scoped corrective authority for stuck trialing rows. Worker startup does not hard-require it (default-off, additive). |
| `TRIAL_PERIOD_DAYS` | `30` | Trial length in days passed as `subscription_data.trial_period_days`. Parsed by `resolveTrialPeriodDays()` in `src/lib/payments/create-checkout-session.ts` (non-numeric/≤0 → falls back to 30). Also drives the landing hero CTA copy and the dashboard "N days left" banner (the banner computes days from the account's stored `trial_ends_at`, not this var). No effect unless `TRIAL_ENABLED=true`. |
| `TRIAGE_ENABLED` | Off | WS2 Guardian triage kill switch. Server-only boolean read via `readFlag` (accessor `triageEnabled()` in `src/lib/reviews/flags.ts`); default off/unset. Gates the triage phase in `ResponseGeneratorWorker`: one ~200-max-token `gpt-4o-mini-2024-07-18` call (Anthropic fallback) per NON-POSITIVE review (≤3★ or unrated), cost-guarded, recorded as endpoint `review-triage` in `api_costs`. **Operational coupling:** disabling `TRIAGE_ENABLED` also disables the auto-approval triage veto for newly ingested reviews (untriaged rows carry nulls → the two triage gates pass) — review `AUTO_APPROVAL_ENABLED` posture when flipping it off; already-triaged rows keep their persisted veto facts. Rollout: staging first, then prod, per spec §5 (`docs/superpowers/specs/2026-07-07-ws2-triage-design.md`). No `NEXT_PUBLIC_*` companion. |
| `ESCALATION_ENABLED` | Off | WS3 Guardian escalation kill switch. Server-only boolean read via `readFlag` (accessor `escalationEnabled()` in `src/lib/escalations/flags.ts`); default off/unset. Read by the **worker** at two points: the RAISE gate in `persistTriage` (`src/lib/reviews/triage.ts` — gates `raiseEscalation`: `review_escalations` row + `review_escalated` outcome + `escalation_raised` step + `escalation_notice` outbox enqueue, one tx) and the SEND gate in `EscalationNoticeWorker` (`worker/jobs/escalation-notice/`). **Operational coupling:** inert without `TRIAGE_ENABLED` — no triage runs means no `escalate`/`respond_and_escalate` classifications are ever written, so nothing can raise. **Kill-switch semantics:** flipping off stops new raises AND outbound notice sends (in-flight `escalation_notice` jobs skip at send time); already-raised escalations stay visible and actionable on the dashboard (acknowledge/resolve are NOT flag-gated). Rollout: staging first, then prod, per spec §5 (`docs/superpowers/specs/2026-07-07-ws3-guardian-escalation-design.md`; migration 073 applied first). No `NEXT_PUBLIC_*` companion. |

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
